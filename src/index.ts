/// <reference types="@cloudflare/workers-types" />

import type { Env, TelegramUpdate } from './types';
import { createBot } from './bot';
import { createOptimizedDb } from './db-optimized';
import { MemoryCache } from './cache';
import { authenticateAdminRequest, checkRateLimit, createAuthHeaders, createUnauthorizedResponse, createRateLimitResponse, issueAdminToken, secureEqual } from './auth';
import { generateCSPHeaders, generateCORSHeaders, handleCORSOptionsRequest, createSafeResponse, generateSecurityHeaders } from './security';
import { DASHBOARD_HTML } from './dashboard';
import { createLogger } from './logger';

const log = createLogger('api');

const VERSION = '202605182048';
const apiCache = new MemoryCache(60);

// 轮询的实际执行器（互斥锁也在这里）：Cron 与手动触发 /cron/poll 共用
import { runPoll } from './poll';
export { runPoll };
// 轮询器 Durable Object：Cron 最小粒度 1 分钟太慢，真正的高频轮询由它的 alarm 承担
export { PollerDO } from './poller';

/**
 * 取 PollerDO 的 stub。
 * 当前 wrangler 把 DO 绑定暴露成 DurableObjectNamespace（get(idFromName(name)) 拿 stub），
 * 旧版可能是 Fetcher（直接 fetch）。两种都兼容，避免版本差异把看门狗打断。
 */
type PollerStub = { fetch: (url: string, init?: RequestInit) => Promise<Response> };

type PollerNamespace = {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  get?: (id: unknown) => PollerStub;
  idFromName?: (name: string) => unknown;
};

function getPollerStub(env: Env): PollerStub | null {
  const ns = env.POLLER as unknown as PollerNamespace | undefined;
  if (!ns) return null;

  // 关键：DO 命名空间的方法必须以「方法形式」调用（ns.get(...)），
  // 单独取出来当函数调用会抛 Illegal invocation。所以统一用箭头函数包一层转发。
  if (typeof ns.fetch === 'function') {
    return { fetch: (url, init) => ns.fetch!(url, init) };
  }
  if (typeof ns.get === 'function' && typeof ns.idFromName === 'function') {
    return { fetch: (url, init) => ns.get!(ns.idFromName!('default')).fetch(url, init) };
  }
  return null;
}

/**
 * Cron 只做看门狗：唤醒 PollerDO 对齐闹钟。
 * DO 万一失效，退回直接轮询一次，宁可慢也不静默失联。
 */
async function wakePoller(env: Env): Promise<void> {
  try {
    const stub = getPollerStub(env);
    if (!stub) throw new Error('POLLER stub unavailable');
    const res = await stub.fetch('https://poller.internal/nudge', { method: 'POST' });
    if (!res.ok) throw new Error(`nudge failed: ${res.status}`);
    return;
  } catch (e) {
    log.warn('PollerDO nudge failed, fallback to direct poll', { error: e });
    await runPoll(env, 'cron-fallback');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

    if (request.method === 'OPTIONS') {
      return handleCORSOptionsRequest(env.CORS_ALLOWED_ORIGIN);
    }

    // 根路径 - 返回服务信息
    if (path === '/' || path === '') {
      return new Response('ErebusBot - Telegram PM Bot Service\n\nEndpoints:\n- /health - Health check\n- /webhook - Bot webhook\n- /admin - Admin dashboard', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          ...generateSecurityHeaders()
        }
      });
    }

    // 健康检查（公开端点）
    if (path === '/health') {
      return new Response('OK', {
        status: 200,
        headers: generateSecurityHeaders()
      });
    }

    // 版本信息（公开端点，但不暴露敏感配置）
    if (path === '/version') {
      return createSafeResponse({
        version: VERSION,
        name: 'ErebusBot',
        environment: env.ENVIRONMENT || 'production'
      });
    }

    if (path === '/webhook') {
      // 允许 HEAD 请求（用于健康检查）
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers: generateSecurityHeaders() });
      }
      // 允许 GET 请求返回信息
      if (request.method === 'GET') {
        return new Response('ErebusBot Webhook - Send POST requests with Telegram updates', {
          status: 200,
          headers: generateSecurityHeaders()
        });
      }
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: generateSecurityHeaders()
        });
      }

      try {
        const body = await request.text();

        if (env.WEBHOOK_SECRET) {
          const receivedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
          if (receivedSecret !== env.WEBHOOK_SECRET) {
            log.warn('Webhook secret token mismatch', { ip: clientIP });
            return new Response('Unauthorized', { status: 401, headers: generateSecurityHeaders() });
          }
        }

        const update = JSON.parse(body) as TelegramUpdate;

        const bot = createBot(env);
        await bot.handleUpdate(update);

        return new Response('OK', { headers: generateSecurityHeaders() });
      } catch (e) {
        log.error('Webhook error', { error: e });
        return new Response('OK', {
          status: 200,
          headers: generateSecurityHeaders()
        });
      }
    }

    // 轮询入口：由 wrangler.toml 的 crons 每分钟触发
    // 在 Telegram 拒绝 webhook 地址（例如 Cloudflare 保留段 IP）时作为替代接收方式
    if (path === '/cron/poll' || path === '/cron/poll/') {
      return createSafeResponse(await runPoll(env, 'http'));
    }

    // 轮询器状态（运维自检用：确认 DO 闹钟链还活着）
    if (path === '/poll-state') {
      if (!env.POLLER) {
        return createSafeResponse({ ok: false, error: 'POLLER binding missing' }, 500);
      }
      // 绑定形态自检：不同 wrangler 版本下 DO 绑定的形状不同，先把失败原因打清楚
      const probe = env.POLLER as unknown as {
        fetch?: unknown;
        get?: unknown;
        idFromName?: unknown;
      };
      const shape = {
        fetch: probe.fetch === undefined ? 'undefined' : 'defined',
        get: probe.get === undefined ? 'undefined' : 'defined',
        idFromName: probe.idFromName === undefined ? 'undefined' : 'defined'
      };
      const stub = getPollerStub(env);
      if (!stub) {
        log.warn('POLLER stub unavailable', { shape });
        return createSafeResponse({ ok: false, error: 'POLLER stub unavailable', shape }, 500);
      }
      const res = await stub.fetch('https://poller.internal/status');
      const body = (await res.text()).replace('}{', `,"bindingShape":${JSON.stringify(shape)}}{`);
      return new Response(body, { status: res.status, headers: generateSecurityHeaders() });
    }

    if (env.ENVIRONMENT === 'development') {
      const debugResult = await handleDebugEndpoints(request, env, path);
      if (debugResult) {
        return debugResult;
      }
    }

    // Admin Dashboard - Web UI
    // 页面本身是静态资源（不含任何凭据/数据），未认证时也下发，
    // 由前端展示登录浮层；所有数据接口仍强制鉴权。
    if (path === '/admin' || path === '/admin/') {
      const auth = await authenticateAdminRequest(request, env);

      // 页面访问限速（防止未认证状态下被高频抓取）
      const pageLimit = await checkRateLimit(`page:${clientIP}`, 'admin_dashboard', env, 100, 60);
      if (!pageLimit.allowed) {
        return createRateLimitResponse(pageLimit.resetTime - Math.floor(Date.now() / 1000));
      }

      if (!auth.success) {
        return serveAdminDashboard();
      }

      // 速率限制检查
      const rateLimit = await checkRateLimit(auth.userId || 'admin', 'admin_dashboard', env, 100, 60);
      if (!rateLimit.allowed) {
        return createRateLimitResponse(rateLimit.resetTime - Math.floor(Date.now() / 1000));
      }

      return serveAdminDashboard();
    }

    // 登录端点：用 ADMIN_API_KEY 换一张管理员会话 JWT（免认证，但限速）
    if (path === '/admin/api/auth/login') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', ...generateSecurityHeaders() }
        });
      }
      return handleAdminLogin(request, env, clientIP);
    }

    // Admin API端点（需要认证）
    if (path.startsWith('/admin/api/')) {
      // 认证检查
      const auth = await authenticateAdminRequest(request, env);
      if (!auth.success) {
        return createUnauthorizedResponse(auth.error);
      }

      // 速率限制检查
      const rateLimit = await checkRateLimit(auth.userId || 'admin', 'admin_api', env, 200, 60);
      if (!rateLimit.allowed) {
        return createRateLimitResponse(rateLimit.resetTime - Math.floor(Date.now() / 1000));
      }

      // 路由到具体的API处理函数
      const headers = {
        ...createAuthHeaders(rateLimit.remaining, rateLimit.resetTime),
        ...generateCORSHeaders(env.CORS_ALLOWED_ORIGIN)
      };

      if (path === '/admin/api/stats') {
        return handleAdminApiStats(request, env, headers);
      }

      if (path === '/admin/api/users') {
        return handleAdminApiUsers(request, env, headers);
      }

      if (path === '/admin/api/messages') {
        return handleAdminApiMessages(request, env, headers);
      }

      if (path === '/admin/api/search') {
        return handleAdminApiSearch(request, env, headers);
      }

      if (path === '/admin/api/export') {
        return handleAdminApiExport(request, env, headers);
      }

      if (path === '/admin/api/audit') {
        return handleAdminApiAudit(request, env, headers);
      }

      if (path === '/admin/api/scheduled') {
        return handleAdminApiScheduled(request, env, headers);
      }

      if (path === '/admin/api/quick-replies') {
        return handleAdminApiQuickReplies(request, env, headers);
      }

      return createSafeResponse({ error: 'API endpoint not found' }, 404, headers);
    }

    // 性能指标端点（需要认证）
    if (path === '/metrics') {
      const auth = await authenticateAdminRequest(request, env);
      if (!auth.success) {
        return createUnauthorizedResponse();
      }

      return createSafeResponse({
        message: 'Performance monitoring disabled',
        timestamp: Date.now()
      });
    }

    // 404
    return new Response('Not Found', { 
      status: 404,
      headers: generateSecurityHeaders()
    });
  },

  // Cloudflare Cron 触发器（wrangler.toml 的 [triggers] crons）调用的就是这里。
  // 少了这个导出，配了 crons 也不会有任何轮询执行——消息会一直卡在 Telegram 服务端。
  // 这里只唤醒 PollerDO（1 分钟一次的兜底），高频轮询在 DO 的 alarm 里跑。
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await wakePoller(env);
  },
};

// 开发环境调试端点
async function handleDebugEndpoints(request: Request, env: Env, path: string): Promise<Response | null> {
  // 所有调试端点都需要管理员认证
  const auth = await authenticateAdminRequest(request, env);
  if (!auth.success) {
    return null; // 不处理，让主逻辑返回404
  }

  if (path === '/debug') {
    try {
      const url = new URL(request.url);
      const chatId = parseInt(url.searchParams.get('chat_id') || env.ADMIN_USER_ID || '0', 10);
      const text = url.searchParams.get('text') || '/start';
      
      const fakeUpdate: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: {
            id: chatId,
            is_bot: false,
            first_name: 'Test',
            username: 'testuser'
          },
          chat: {
            id: chatId,
            type: 'private'
          },
          date: Math.floor(Date.now() / 1000),
          text: text
        }
      };
      
      const bot = createBot(env);
      await bot.handleUpdate(fakeUpdate);
      
      return createSafeResponse({ success: true, message: 'Debug update processed' });
    } catch (e) {
      return createSafeResponse({ error: String(e) }, 500);
    }
  }

  return null;
}

// 登录端点：校验 ADMIN_API_KEY，签发管理员会话 JWT
async function handleAdminLogin(request: Request, env: Env, clientIP: string): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    ...generateSecurityHeaders(),
    ...generateCORSHeaders(env.CORS_ALLOWED_ORIGIN)
  };

  if (!env.ADMIN_API_KEY) {
    return new Response(JSON.stringify({ error: 'Admin authentication not configured' }), {
      status: 503,
      headers
    });
  }

  // 暴力破解防护：同一 IP 10 分钟内最多 10 次
  const rateLimit = await checkRateLimit(`login:${clientIP}`, 'admin_login', env, 10, 600);
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({ error: 'Too many login attempts, please retry later' }), {
      status: 429,
      headers: { ...headers, ...createAuthHeaders(0, rateLimit.resetTime - Math.floor(Date.now() / 1000)) }
    });
  }

  const authHeader = request.headers.get('Authorization');
  const providedKey = request.headers.get('X-API-Key')
    || (authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : '')
    || '';

  if (!providedKey || !(await secureEqual(providedKey, env.ADMIN_API_KEY))) {
    log.warn('Admin login failed: invalid credentials', { ip: clientIP });
    return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
      status: 401,
      headers: { ...headers, ...createAuthHeaders(rateLimit.remaining, 0), 'WWW-Authenticate': 'Bearer' }
    });
  }

  try {
    const token = await issueAdminToken(env, 'system');
    log.info('Admin login succeeded', { ip: clientIP });
    return new Response(
      JSON.stringify({ token, tokenType: 'Bearer', expiresIn: 12 * 3600 }),
      { status: 200, headers: { ...headers, ...createAuthHeaders(rateLimit.remaining, 0) } }
    );
  } catch (error) {
    log.error('Admin login failed to sign token', { error });
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers });
  }
}

// Admin Dashboard HTML（安全的版本，使用DOM操作而非innerHTML）
function serveAdminDashboard(): Response {
  return new Response(DASHBOARD_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...generateCSPHeaders()
    }
  });
}

// Admin API - Get stats
async function handleAdminApiStats(request: Request, env: Env, headers: HeadersInit): Promise<Response> {
  try {
    const db = createOptimizedDb(env, apiCache);
    const stats = await db.getPmStats();

    return createSafeResponse({
      totalUsers: stats.totalUsers || 0,
      totalMessages: stats.totalMessages || 0,
      todayMessages: stats.todayMessages || 0,
      blockedUsers: stats.blockedUsers || 0
    }, 200, headers);
  } catch (error) {
    log.error('Stats API error', { error });
    return createSafeResponse({ error: 'Internal server error' }, 500, headers);
  }
}

// Admin API - Get users
async function handleAdminApiUsers(request: Request, env: Env, headers: HeadersInit): Promise<Response> {
  try {
    const db = createOptimizedDb(env, apiCache);
    const users = await db.getPmUsers(1000);

    return createSafeResponse({
      users: users.map((u: { user_id: number; username: string | null; first_name: string | null; is_blocked: boolean; created_at: number; last_message_at: number | null }) => ({
        user_id: u.user_id,
        username: u.username,
        first_name: u.first_name,
        is_blocked: u.is_blocked,
        created_at: u.created_at,
        last_message_at: u.last_message_at
      }))
    }, 200, headers);
  } catch (error) {
    log.error('Users API error', { error });
    return createSafeResponse({ error: 'Internal server error' }, 500, headers);
  }
}

// Admin API - Get messages
async function handleAdminApiMessages(request: Request, env: Env, headers: HeadersInit): Promise<Response> {
  try {
    const db = createOptimizedDb(env, apiCache);
    const stats = await db.getPmStats();
    const unreadCount = await db.getUnreadMessageCount();

    return createSafeResponse({
      stats: {
        total: stats.totalMessages || 0,
        today: stats.todayMessages || 0,
        blockedUsers: stats.blockedUsers || 0,
        unread: unreadCount
      },
      messages: []
    }, 200, headers);
  } catch (error) {
    log.error('Messages API error', { error });
    return createSafeResponse({ error: 'Internal server error' }, 500, headers);
  }
}

async function handleAdminApiSearch(request: Request, env: Env, headers: HeadersInit): Promise<Response> {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') || '';
    if (!query || query.length < 2) {
      return createSafeResponse({ error: 'Query must be at least 2 characters' }, 400, headers);
    }
    const db = createOptimizedDb(env, apiCache);
    const results = await db.searchMessages(query, 50);
    return createSafeResponse({ query, results, count: results.length }, 200, headers);
  } catch (error) {
    log.error('Search API error', { error });
    return createSafeResponse({ error: 'Internal server error' }, 500, headers);
  }
}

async function handleAdminApiExport(request: Request, env: Env, headers: HeadersInit): Promise<Response> {
  try {
    const db = createOptimizedDb(env, apiCache);
    const data = await db.exportAllData();
    return createSafeResponse(data, 200, headers);
  } catch (error) {
    log.error('Export API error', { error });
    return createSafeResponse({ error: 'Internal server error' }, 500, headers);
  }
}

async function handleAdminApiAudit(request: Request, env: Env, headers: HeadersInit): Promise<Response> {
  try {
    const db = createOptimizedDb(env, apiCache);
    const logs = await db.getAuditLogs(100);
    return createSafeResponse({ logs }, 200, headers);
  } catch (error) {
    log.error('Audit API error', { error });
    return createSafeResponse({ error: 'Internal server error' }, 500, headers);
  }
}

async function handleAdminApiScheduled(request: Request, env: Env, headers: HeadersInit): Promise<Response> {
  try {
    const db = createOptimizedDb(env, apiCache);
    const messages = await db.getAllScheduledMessages();
    return createSafeResponse({ messages }, 200, headers);
  } catch (error) {
    log.error('Scheduled API error', { error });
    return createSafeResponse({ error: 'Internal server error' }, 500, headers);
  }
}

async function handleAdminApiQuickReplies(request: Request, env: Env, headers: HeadersInit): Promise<Response> {
  try {
    const db = createOptimizedDb(env, apiCache);
    const replies = await db.getQuickReplies();
    return createSafeResponse({ replies }, 200, headers);
  } catch (error) {
    log.error('Quick replies API error', { error });
    return createSafeResponse({ error: 'Internal server error' }, 500, headers);
  }
}
