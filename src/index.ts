/// <reference types="@cloudflare/workers-types" />

import type { Env, TelegramUpdate } from './types';
import { createBot } from './bot';
import { createOptimizedDb } from './db-optimized';
import { MemoryCache } from './cache';
import { authenticateAdminRequest, checkRateLimit, createAuthHeaders, createUnauthorizedResponse, createRateLimitResponse } from './auth';
import { generateCSPHeaders, generateCORSHeaders, handleCORSOptionsRequest, createSafeResponse, generateSecurityHeaders } from './security';
import { DASHBOARD_HTML } from './dashboard';
import { createLogger } from './logger';

const log = createLogger('api');

const VERSION = '202605182039';
const apiCache = new MemoryCache(60);

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

    if (env.ENVIRONMENT === 'development') {
      const debugResult = await handleDebugEndpoints(request, env, path);
      if (debugResult) {
        return debugResult;
      }
    }

    // Admin Dashboard - Web UI（需要认证）
    if (path === '/admin' || path === '/admin/') {
      const auth = await authenticateAdminRequest(request, env);
      if (!auth.success) {
        return createUnauthorizedResponse(auth.error);
      }
      
      // 速率限制检查
      const rateLimit = await checkRateLimit(auth.userId || 'admin', 'admin_dashboard', env, 100, 60);
      if (!rateLimit.allowed) {
        return createRateLimitResponse(rateLimit.resetTime - Math.floor(Date.now() / 1000));
      }
      
      return serveAdminDashboard();
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
