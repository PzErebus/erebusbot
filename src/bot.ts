/// <reference types="@cloudflare/workers-types" />

import type { Env, TelegramUpdate, TelegramMessage, TelegramCallbackQuery, TelegramUser } from './types';
import { OptimizedDatabase, createOptimizedDb } from './db-optimized';
import { MemoryCache } from './cache';
import { createLogger } from './logger';


const log = createLogger('bot');

const globalCache = new MemoryCache(60);
const updateDeduplication = new Set<number>();
const MAX_DEDUP_SIZE = 10000;
/** 轮询模式下已消费到的 Telegram update_id（+1 存），落 pm_settings 表 */
const POLL_OFFSET_KEY = 'tg_poll_offset';
/** 收发模式开关：'webhook' = Telegram 主动推送（轮询让位）；空/其他 = getUpdates 轮询 */
const POLL_MODE_KEY = 'poll_mode';

// ============ 反垃圾：滑动窗口限流 + 广告特征识别 ============
/** 统计窗口与阈值（模块级常量，Bot 侧所有 isolate 共用同一套规则） */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MSGS = 5;
/** 管理员告警节流：同一用户 10 分钟内最多提醒一次，防刷屏式告警 */
const SPAM_NOTIFY_COOLDOWN_MS = 10 * 60_000;

/** 每用户消息时间戳滑动窗口（内存态，isolate 回收重置可接受——只影响窗口起点） */
const rateWindows = new Map<number, number[]>();
/** 每用户累计超限次数 */
const rateViolations = new Map<number, number>();
/** 每用户上次管理员告警时间 */
const spamNotifyAt = new Map<number, number>();

/**
 * 滑动窗口限流检查。
 * 返回 allowed=false 时消息应被静默拦截（不回复用户，避免给刷屏者喂反馈）。
 * （export 仅为测试可达）
 */
export function checkRateLimit(userId: number, now = Date.now()): { allowed: boolean; violations: number } {
  let stamps = rateWindows.get(userId);
  if (!stamps) {
    stamps = [];
    rateWindows.set(userId, stamps);
  }
  while (stamps.length > 0 && now - stamps[0] > RATE_WINDOW_MS) stamps.shift();
  if (stamps.length >= RATE_MAX_MSGS) {
    const violations = (rateViolations.get(userId) || 0) + 1;
    rateViolations.set(userId, violations);
    return { allowed: false, violations };
  }
  stamps.push(now);
  return { allowed: true, violations: rateViolations.get(userId) || 0 };
}

/** 广告特征规则：命中任意一条即判定为广告。宁可少杀，误报可控为先。 */
const AD_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /博彩|赌博|赌场|六合彩|时时彩|澳门在线|网投|下注|返水/i, label: '博彩' },
  { re: /刷单|兼职群|点赞刷量|涨粉|代刷|引流推广|接单平台/i, label: '刷量兼职' },
  { re: /招代理|代理加盟|招募合伙人|一条龙服务|专业代开|代开发票/i, label: '招代理' },
  { re: /免费领|免费领取|扫码领取|红包码|优惠码|口令红包|现金红包/i, label: '诱导领取' },
  { re: /贷款|空放|私借|下款|额度秒批|无视征信/i, label: '贷款' },
  { re: /微信[\s:：]*(购买|出售|出收)|出微信|收微信|买号|卖号/i, label: '账号交易' },
  { re: /(?:加|联系|搜)(?:我)?(?:微信|vx|VX|V信|威信|扣扣|QQ)(?![a-z])/i, label: '引流联系方式' },
  { re: /(?:qq|扣扣|Q群|群)\s*[:：]?\s*\d{5,12}\b/i, label: 'QQ号引流' },
  { re: /t\.me\/\+?[A-Za-z0-9_]{5,}|telegram\.me\/\+?[A-Za-z0-9_]{5,}|joinchat/i, label: '拉群外链' },
  { re: /(.)\1{12,}/, label: '字符刷屏' },
];

/** 广告判定：返回命中的规则标签，未命中返回 null（export 仅为测试可达） */
export function matchAd(text: string): string | null {
  for (const { re, label } of AD_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

/** 清空反垃圾内存状态（测试隔离用；生产环境无需调用） */
export function resetAntiSpamState(): void {
  rateWindows.clear();
  rateViolations.clear();
  spamNotifyAt.clear();
}

/** 版本号单一来源：index.ts 的 /version 端点与 help 面板共用 */
export const BOT_VERSION = '202610021015';

function fire<T>(p: Promise<T>): void { p.catch(() => {}); }

function createDb(env: Env): OptimizedDatabase {
  return createOptimizedDb(env, globalCache);
}

export function escapeHtml(text: string): string {
  if (!text) return '';
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 38) result += '&amp;';
    else if (c === 60) result += '&lt;';
    else if (c === 62) result += '&gt;';
    else if (c === 34) result += '&quot;';
    else if (c === 39) result += '&#039;';
    else result += text[i];
  }
  return result;
}

export function getUserName(user: TelegramUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || `User ${user.id}`;
}

export function getContent(msg: TelegramMessage): { type: string; text: string } {
  let type = 'text';
  if (msg.video) type = 'video';
  else if (msg.photo) type = 'photo';
  else if (msg.sticker) type = 'sticker';
  else if (msg.voice) type = 'voice';
  else if (msg.audio) type = 'audio';
  else if (msg.document) type = 'document';
  const text = msg.text || msg.caption || `[${type}]`;
  return { type, text };
}

function mk(...rows: Array<Array<{ text: string; callback_data?: string }>>): string {
  return JSON.stringify({ inline_keyboard: rows });
}

type KbRow = Array<{ text: string; callback_data?: string }>;

// ============ 面板/回调通用工具 ============
// 以下工具函数收编了原先散落在 30+ 个按钮 handler 里的重复逻辑：
// 截断、时间格式化、用户名回退、回调参数解析、分页导航行。

/** 截断文本并加省略号（原先 `s.length > n ? s.substring(0, n) + '...' : s` 重复 12+ 处） */
function trunc(s: string, n: number): string {
  return s.length > n ? s.substring(0, n) + '…' : s;
}

/** 上海时区时间（原 8 处重复的 toLocaleString 配置） */
const TIME_OPTS: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Shanghai' };

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', { ...TIME_OPTS, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtClock(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', { ...TIME_OPTS, hour: '2-digit', minute: '2-digit' });
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { ...TIME_OPTS, month: 'numeric', day: 'numeric' });
}

/** pm_users 行的展示名回退（原先 `first_name || username || 'User'+id` 重复 15+ 处） */
interface NamedRow { first_name?: string | null; username?: string | null }
function displayName(u: NamedRow | null | undefined, id?: number): string {
  if (!u) return id !== undefined ? `User${id}` : '未知用户';
  return u.first_name || u.username || (id !== undefined ? `User${id}` : '未知用户');
}

/** 短名字（按钮文案用）：展示名再截断 */
function shortName(u: NamedRow | null | undefined, id: number, n = 10): string {
  return trunc(displayName(u, id), n);
}

/**
 * 解析 `prefix_<id>` / `prefix_<id>_<page>` 形式回调数据里的数字参数。
 * 原先 `parseInt(ctx.data.split('_')[N], 10)` 重复 20+ 处，且各自处理 NaN 的姿势不一。
 * 解析失败返回 0（配合各 handler 的 `id > 0` 校验）。
 */
function cbNum(data: string, index: number): number {
  const v = parseInt(data.split('_')[index], 10);
  return Number.isNaN(v) ? 0 : v;
}

/** 分页导航行：上一页/下一页按需出现，都没有则返回 undefined */
function navRow(prefix: string, page: number, hasMore: boolean): KbRow | undefined {
  const row: KbRow = [];
  if (page > 0) row.push({ text: '◀ 上一页', callback_data: `${prefix}${page - 1}` });
  if (hasMore) row.push({ text: '▶ 下一页', callback_data: `${prefix}${page + 1}` });
  return row.length > 0 ? row : undefined;
}

const PAGE_SIZE = 5;

/** 通用分页切片 */
function pageSlice<T>(items: T[], page: number, size = PAGE_SIZE): { rows: T[]; hasMore: boolean; totalPages: number } {
  const start = page * size;
  return {
    rows: items.slice(start, start + size),
    hasMore: start + size < items.length,
    totalPages: Math.max(1, Math.ceil(items.length / size))
  };
}

// ============ UI v3 设计语言 ============
// 统一视觉规范：标题 → 重分隔线 → 「▸ 小节」→ 紧凑信息行 → 斜体提示。
// 弃用旧版 ╔══╗/┌─┐ 盒子字符（宽度随内容漂移、对不齐）。

const DIV = '━━━━━━━━━━━━━━━━━━';

/** 面板头：加粗标题 + 可选副标题 + 分隔线 */
function head(title: string, sub?: string): string {
  return `<b>${title}</b>` + (sub ? `\n<i>${sub}</i>` : '') + `\n${DIV}`;
}

/** 小节标题行 */
function sec(name: string): string {
  return `\n<b>▸ ${name}</b>`;
}

/** 底部斜体提示行 */
function tip(s: string): string {
  return `\n\n<i>💡 ${s}</i>`;
}

const ADMIN_KB = {
  reply: (userId: number) => mk(
    [{ text: '🚫 封禁', callback_data: `ban_${userId}` }]
  )
};

/**
 * 数据库实例与初始化状态提升到模块级（按 env 缓存）。
 *
 * 原因：`createBot()` 每次请求都会调用，而 `OptimizedDatabase.initialized` 是实例字段，
 * 若 db 与初始化标记留在 createBot 的闭包里，就等于每次请求都新建实例、
 * 再重跑一遍建表 DDL —— 13 条 `CREATE TABLE IF NOT EXISTS` + 8 条 `CREATE INDEX`
 * + 5 条 `ALTER TABLE` 试探，实测固定多花 ~0.7s，是交互延迟的大头。
 * 提到模块级后，DDL 每个 isolate 只跑一次。
 */
interface DbEntry {
  db: OptimizedDatabase;
  initPromise: Promise<void> | null;
  /** 完成后必须保持为 true——若把 initPromise 置回 null，下一个请求会再跑一遍建表 DDL */
  initialized: boolean;
}

const dbRegistry = new WeakMap<Env, DbEntry>();

function acquireDb(env: Env): DbEntry {
  let entry = dbRegistry.get(env);
  if (!entry) {
    entry = { db: createDb(env), initPromise: null, initialized: false };
    dbRegistry.set(env, entry);
  }
  return entry;
}

function getDb(env: Env): OptimizedDatabase {
  return acquireDb(env).db;
}

async function ensureDbInitialized(env: Env): Promise<void> {
  const entry = acquireDb(env);
  if (entry.initPromise) {
    await entry.initPromise;
    return;
  }
  if (entry.initialized) return;
  entry.initialized = true;
  entry.initPromise = entry.db.init().catch((err) => {
    // 失败要放开标记，否则整条 isolate 内后续请求都不再重试初始化
    entry.initialized = false;
    log.error('Database init error', { error: err });
  });
  await entry.initPromise;
}

// ============ 待处理消息与内存统计（模块级） ============
// 关键：这两份状态绝不能放进 createBot 闭包——webhook 每个请求都会 createBot()，
// 闭包内状态等于每个请求都清零，「待处理」永远显示 0、pm_reply 清 pending 空转。
// 与 dbRegistry 同理提到模块级，一个 isolate 内跨请求共享。
interface PendingMessage {
  id: number;
  user_id: number;
  content: string;
  created_at: number;
  first_name: string | null;
  username: string | null;
  priority: 'normal' | 'urgent' | 'low';
}
const pendingMessagesCache = new MemoryCache();
const pendingMessageIds: number[] = [];
let pendingMessageIdCounter = 1;

function addPendingMessage(msg: PendingMessage): void {
  pendingMessagesCache.set(`pm:${msg.id}`, msg, 86400);
  pendingMessageIds.push(msg.id);
}

function getPendingMessage(id: number): PendingMessage | undefined {
  return pendingMessagesCache.get<PendingMessage>(`pm:${id}`);
}

function deletePendingMessage(id: number): boolean {
  const key = `pm:${id}`;
  const exists = pendingMessagesCache.has(key);
  if (exists) {
    pendingMessagesCache.delete(key);
    const idx = pendingMessageIds.indexOf(id);
    if (idx !== -1) pendingMessageIds.splice(idx, 1);
  }
  return exists;
}

function getAllPendingMessages(): PendingMessage[] {
  const messages: PendingMessage[] = [];
  const now = Date.now();
  for (const id of pendingMessageIds) {
    const msg = pendingMessagesCache.get<PendingMessage>(`pm:${id}`);
    if (msg && now <= msg.created_at + 86400 * 1000) {
      messages.push(msg);
    }
  }
  return messages;
}

function getPendingMessageCount(): number {
  return pendingMessageIds.length;
}

const messageStats = {
  totalMessages: 0,
  todayMessages: 0,
  todayActiveUsers: new Set<number>(),
  lastResetDate: new Date().toDateString()
};

function resetDailyStatsIfNeeded() {
  const today = new Date().toDateString();
  if (messageStats.lastResetDate !== today) {
    messageStats.todayMessages = 0;
    messageStats.todayActiveUsers.clear();
    messageStats.lastResetDate = today;
  }
}

function recordMessageStat(userId: number) {
  resetDailyStatsIfNeeded();
  messageStats.totalMessages++;
  messageStats.todayMessages++;
  messageStats.todayActiveUsers.add(userId);
}

export function createBot(env: Env) {
  const db = getDb(env);
  const ADMIN_IDS = new Set<number>(
    (env.ADMIN_USER_ID || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
  );
  const TOKEN = env.BOT_TOKEN;

  if (!TOKEN) {
    log.error('BOT_TOKEN is not set');
  }

  function isAdmin(userId: number): boolean {
    return ADMIN_IDS.has(userId);
  }

  function getPrimaryAdminId(): number {
    return ADMIN_IDS.values().next().value || 0;
  }

  async function api<T = unknown>(method: string, body: Record<string, unknown>, token?: string, retries = 3): Promise<T | null> {
    const botToken = token || TOKEN;
    const startedAt = Date.now();
    // 单次 Telegram 往返超过 300ms 记一条：判断「点击按钮慢」卡在 Telegram 还是本地的必要埋点
    const done = <R>(result: R): R => {
      const durationMs = Date.now() - startedAt;
      if (durationMs >= 300) log.info('Telegram API slow', { method, durationMs });
      return result;
    };
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok && r.status === 429) {
          const retryAfter = parseInt(r.headers.get('Retry-After') || '1', 10);
          if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            continue;
          }
        }
        const d = (await r.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };
        if (!d.ok) {
          if (d.error_code && d.error_code >= 400 && d.error_code < 500 && d.error_code !== 429) {
            log.error('API client error', { method, code: d.error_code, description: d.description });
            return done(null);
          }
          log.error('API error on retry', { method, attempt, retries, description: d.description });
          if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 8000)));
            continue;
          }
          return done(null);
        }
        return done(d.result || null);
      } catch (e) {
        log.error('API exception on retry', { method, attempt, retries, error: e });
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 8000)));
          continue;
        }
        return done(null);
      }
    }
    return null;
  }

  async function sendMsg(chatId: number, text: string, extra?: Record<string, unknown>, token?: string): Promise<TelegramMessage | null> {
    return await api<TelegramMessage>('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra }, token);
  }

  async function editMsg(chatId: number, messageId: number, text: string, extra?: Record<string, unknown>): Promise<TelegramMessage | null> {
    return await api<TelegramMessage>('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });
  }

  async function editOrSend(chatId: number, text: string, extra?: Record<string, unknown>, messageId?: number): Promise<TelegramMessage | null> {
    if (messageId) {
      const result = await editMsg(chatId, messageId, text, extra);
      if (result) return result;
    }
    return await sendMsg(chatId, text, extra);
  }

  async function answerCb(queryId: string, text?: string, showAlert = false): Promise<void> {
    await api('answerCallbackQuery', { callback_query_id: queryId, text, show_alert: showAlert });
  }

  // ============ 回调 handler 通用包装 ============

  /**
   * 统一错误兜底：原先 25+ 处 `try { ... } catch { await editOrSend(..., '❌ xx失败') }`
   * 逐个手写且文案各异。包一层后每个 handler 只写 happy path，异常统一落兜底面板。
   */
  function guard(fallback: string): <T>(p: Promise<T>) => Promise<T | null> {
    return async <T,>(p: Promise<T>): Promise<T | null> => {
      try {
        return await p;
      } catch (e) {
        log.error('Callback handler failed', { fallback, error: e });
        return null;
      }
    };
  }

  /** 兜底文案展示：guard 捕获后调用 */
  async function showFail(chatId: number, messageId: number | undefined, what: string): Promise<void> {
    await editOrSend(chatId, `❌ ${what}失败，请稍后重试`, {
      reply_markup: mk([{ text: '🏠 主页', callback_data: 'admin_back' }])
    }, messageId);
  }

  /**
   * 「进入输入会话」模板：原先 8 处重复 —— setUserSession → 提示文案 → 取消按钮。
   * 所有依赖管理员后续输入的功能（欢迎语/自动回复/黑名单/定时消息/工作时间等）都走这里。
   */
  async function promptInput(
    ctx: CbContext,
    action: string,
    title: string,
    body: string,
    cancelTo: string,
    sessionData: Record<string, unknown> = {}
  ): Promise<void> {
    const ok = await guard('promptInput')(db.setUserSession(ctx.userId, action, JSON.stringify(sessionData)));
    if (ok === null) { await showFail(ctx.chatId, ctx.msgId, '操作'); return; }
    await editOrSend(ctx.chatId,
      `${head(title)}\n\n${body}`, {
      // 取消必须走 cancel_to_ 路由：既清掉刚建的 session，又跳回目标面板。
      // 之前取消只跳面板不清 session，残留 30 分钟——期间管理员发任何文本
      // 都会被当成这次会话的输入吞掉（比如误存成欢迎语）。
      reply_markup: mk([{ text: '❌ 取消', callback_data: `cancel_to_${cancelTo}` }])
    }, ctx.msgId);
  }

  /** 通用格式化输入提示体：格式说明 + 示例 */
  function inputFormat(lines: Array<[string, string]>): string {
    return lines.map(([fmt, example]) => `请按以下格式输入：\n<code>${fmt}</code>\n\n示例:\n<code>${example}</code>`).join('\n\n');
  }

  /**
   * 垃圾消息违规处理：审计落库 + 节流告警管理员（附封禁快捷按钮）。
   * 频率超限对用户完全静默；广告命中回复与黑名单一致的提示语，不暴露拦截原因。
   */
  async function handleSpamViolation(
    user: NonNullable<TelegramMessage['from']>,
    kind: 'rate' | 'ad',
    violations: number,
    adLabel?: string
  ): Promise<void> {
    const reason = kind === 'rate' ? `刷屏（10秒内超${RATE_MAX_MSGS}条，累计超限${violations}次）` : `广告特征：${adLabel}`;
    // 审计与告警都不阻塞主流程
    fire(db.addAuditLog(user.id, 'spam_blocked', 'user', String(user.id), reason));
    const now = Date.now();
    if (now - (spamNotifyAt.get(user.id) || 0) > SPAM_NOTIFY_COOLDOWN_MS) {
      spamNotifyAt.set(user.id, now);
      const total = rateViolations.get(user.id) || 0;
      const adminId = getPrimaryAdminId();
      if (!adminId) return;
      await sendMsg(adminId,
        `🛡️ <b>垃圾消息已拦截</b>\n\n` +
        `👤 ${escapeHtml(getUserName(user))}  <code>${user.id}</code>\n` +
        `📌 原因：${escapeHtml(reason)}\n` +
        `📊 该用户累计超限：${total} 次`,
        { reply_markup: mk([
          { text: '🚫 封禁', callback_data: `ban_pm_${user.id}` },
          { text: '👥 详情', callback_data: `pm_user_${user.id}` }
        ]) }
      ).catch(e => log.error('Spam notify failed', { error: e }));
    }
  }

  // ============ User Message Handler ============
  async function handleUserMessage(msg: TelegramMessage): Promise<void> {
    const user = msg.from!;
    const chatId = msg.chat.id;
    const adminId = getPrimaryAdminId();

    // 并行执行：保存用户和检查封禁状态
    const [_, isBlocked] = await Promise.all([
      db.saveUser(user.id, user.username, user.first_name, user.last_name).catch(e => {
        log.error('Error saving user', { error: e });
        return null;
      }),
      db.isUserBlocked(user.id).catch(e => {
        log.error('Error checking blocked', { error: e });
        return false;
      })
    ]);

    if (isBlocked) {
      await sendMsg(chatId, '❌ 你已被封禁，无法发送消息。');
      return;
    }

    const text = msg.text?.trim() || '';

    if (text === '/start') {
      // 使用缓存获取欢迎语
      const welcomeMsg = await db.getSetting('welcome_message').catch(() => null) || '👋 你好！请发送消息，我会转发给管理员。';
      await sendMsg(chatId, welcomeMsg);
      return;
    }
    if (text === '/help') {
      await sendMsg(chatId, '💬 发送任意消息，我会将其转发给管理员。\n📋 管理员回复后，你会收到消息。');
      return;
    }

    if (text && text !== '/start' && text !== '/help') {
      const [blacklistResult, autoReply, isWorkHours] = await Promise.all([
        db.checkBlacklist(text).catch(e => {
          log.error('Error checking blacklist', { error: e });
          return { matched: false };
        }),
        db.checkAutoReply(text).catch(e => {
          log.error('Error checking auto reply', { error: e });
          return null;
        }),
        db.isWorkHours().catch(e => {
          log.error('Error checking work hours', { error: e });
          return true;
        })
      ]);

      if (blacklistResult.matched) {
        await sendMsg(chatId, '⚠️ 您的消息包含敏感内容，无法发送。');
        return;
      }

      // 反垃圾第一道：滑动窗口限流——超限静默拦截，不回复（回复只会给刷屏者喂反馈）
      const rate = checkRateLimit(user.id);
      if (!rate.allowed) {
        await handleSpamViolation(user, 'rate', rate.violations);
        return;
      }

      // 反垃圾第二道：广告特征识别——提示语与黑名单一致，不暴露具体拦截原因
      const adLabel = matchAd(text);
      if (adLabel) {
        await handleSpamViolation(user, 'ad', 0, adLabel);
        await sendMsg(chatId, '⚠️ 您的消息包含敏感内容，无法发送。');
        return;
      }

      if (!isWorkHours) {
        const offHoursMsg = await db.getOffHoursMessage().catch(() => null) || '⏰ 非工作时间，请稍后再试。';
        await sendMsg(chatId, offHoursMsg);
        return;
      }

      if (autoReply) {
        const { type: contentType, text: content } = getContent(msg);
        const timeStr = fmtClock(Math.floor(Date.now() / 1000));
        const forwardText = `📨 <b>新消息</b> 🤖<i>(已自动回复)</i>\n\n` +
          `👤 ${escapeHtml(getUserName(user))}  <code>${user.id}</code>\n` +
          `🕐 ${timeStr}` + (contentType !== 'sticker' ? `  📋 ${contentType}` : '') + `\n\n` +
          `${escapeHtml(content)}`;
        const [, forwardResult] = await Promise.all([
          sendMsg(chatId, autoReply),
          sendMsg(adminId, forwardText, { reply_markup: ADMIN_KB.reply(user.id) })
        ]);
        if (forwardResult) recordMessageStat(user.id);
        return;
      }
    }

    const { type: contentType, text: content } = getContent(msg);
    const timeStr = fmtClock(Math.floor(Date.now() / 1000));

    const headerText = `📨 <b>新消息</b>\n\n` +
      `👤 ${escapeHtml(getUserName(user))}  <code>${user.id}</code>\n` +
      `🕐 ${timeStr}` + (contentType !== 'sticker' ? `  📋 ${contentType}` : '');

    const replyMarkup = ADMIN_KB.reply(user.id);

    let sentMsg: TelegramMessage | null = null;

    if (contentType === 'photo' && msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      sentMsg = await api<TelegramMessage>('sendPhoto', {
        chat_id: adminId,
        photo: photo.file_id,
        caption: headerText + (content ? `\n\n${escapeHtml(content)}` : ''),
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } else if (contentType === 'sticker' && msg.sticker) {
      const textMsg = await sendMsg(adminId, headerText);
      sentMsg = await api<TelegramMessage>('sendSticker', {
        chat_id: adminId,
        sticker: msg.sticker.file_id,
        reply_markup: replyMarkup
      });
      const mappingTasks: Promise<void>[] = [];
      if (textMsg) {
        mappingTasks.push(db.savePmMessageMapping(user.id, msg.message_id, textMsg.message_id).catch(() => {}));
      }
      if (sentMsg) {
        mappingTasks.push(db.savePmMessageMapping(user.id, msg.message_id, sentMsg.message_id).catch(() => {}));
      }
      await Promise.all(mappingTasks);
    } else if (contentType === 'video' && msg.video) {
      sentMsg = await api<TelegramMessage>('sendVideo', {
        chat_id: adminId,
        video: msg.video.file_id,
        caption: headerText + (content ? `\n\n${escapeHtml(content)}` : ''),
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } else if (contentType === 'voice' && msg.voice) {
      sentMsg = await api<TelegramMessage>('sendVoice', {
        chat_id: adminId,
        voice: msg.voice.file_id,
        caption: headerText,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } else if (contentType === 'audio' && msg.audio) {
      sentMsg = await api<TelegramMessage>('sendAudio', {
        chat_id: adminId,
        audio: msg.audio.file_id,
        caption: headerText + (content ? `\n\n${escapeHtml(content)}` : ''),
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } else if (contentType === 'document' && msg.document) {
      sentMsg = await api<TelegramMessage>('sendDocument', {
        chat_id: adminId,
        document: msg.document.file_id,
        caption: headerText + (content ? `\n\n${escapeHtml(content)}` : ''),
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } else {
      sentMsg = await sendMsg(adminId, headerText + `\n\n${escapeHtml(content)}`, { reply_markup: replyMarkup });
    }

    if (sentMsg) {
      recordMessageStat(user.id);
      const pendingMsg: PendingMessage = {
        id: pendingMessageIdCounter++,
        user_id: user.id,
        content: content,
        created_at: Math.floor(Date.now() / 1000),
        first_name: user.first_name || null,
        username: user.username || null,
        priority: 'normal'
      };
      addPendingMessage(pendingMsg);
      const fileId = contentType === 'photo' ? msg.photo?.[msg.photo.length - 1]?.file_id
        : contentType === 'video' ? msg.video?.file_id
        : contentType === 'voice' ? msg.voice?.file_id
        : contentType === 'audio' ? msg.audio?.file_id
        : contentType === 'document' ? msg.document?.file_id
        : undefined;
      const tasks: Promise<unknown>[] = [
        db.saveMessage(user.id, 'in', contentType, content, fileId, msg.message_id, sentMsg.message_id).catch(e => {
          log.error('Error saving incoming message', { error: e });
        }),
      ];
      if (contentType !== 'sticker') {
        tasks.push(db.savePmMessageMapping(user.id, msg.message_id, sentMsg.message_id).catch(() => {}));
      }
      await Promise.all(tasks);
      await sendMsg(chatId, '✅ 消息已发送给管理员，请耐心等待回复。');
    } else {
      await sendMsg(chatId, '❌ 发送失败，请稍后重试。');
    }
  }

  const SESSION_HANDLERS: Record<string, (text: string, chatId: number, userId: number) => Promise<void>> = {
    async pm_reply(text, chatId, userId) {
      const session = await db.getUserSession(userId);
      if (!session) return;
      const sessionData = JSON.parse(session.data);
      const targetUserId = sessionData.targetUserId;
      const sentMsg = await sendMsg(targetUserId, `💬 <b>管理员回复</b>\n\n${escapeHtml(text)}`);
      if (sentMsg) {
        for (const m of getAllPendingMessages()) {
          if (m.user_id === targetUserId) deletePendingMessage(m.id);
        }
        await db.markMessagesAsRead(targetUserId).catch(() => {});
        const userName = await db.getPmUser(targetUserId);
        const name = userName?.first_name || userName?.username || `用户${targetUserId}`;
        await sendMsg(chatId, `✅ 已回复 ${escapeHtml(name)} (ID: <code>${targetUserId}</code>)`);
        await db.saveMessage(targetUserId, 'out', 'text', text, undefined, undefined, sentMsg.message_id).catch(() => {});
        await db.addAuditLog(userId, 'reply', 'user', String(targetUserId), text.substring(0, 200)).catch(() => {});
      } else {
        await sendMsg(chatId, '❌ 发送失败');
      }
      fire(db.clearUserSession(userId));
    },

    async pm_broadcast(text, chatId, userId) {
      try {
        const users = await db.getPmUsers(1000);
        const CONCURRENCY = 10;
        let successCount = 0;
        let failCount = 0;
        const broadcastText = `📢 <b>广播消息</b>\n\n${escapeHtml(text)}`;

        for (let i = 0; i < users.length; i += CONCURRENCY) {
          const batch = users.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(user => sendMsg(user.user_id, broadcastText))
          );
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value) successCount++; else failCount++;
          }
        }
        await sendMsg(chatId, `✅ 广播完成\n👥 ${users.length}  ✅ ${successCount}  ❌ ${failCount}`);
      } catch (e) {
        log.error('Broadcast error', { error: e });
        await sendMsg(chatId, '❌ 广播失败');
      }
      fire(db.clearUserSession(userId));
    },

    async pm_set_welcome(text, chatId, userId) {
      try {
        await db.updateSetting('welcome_message', text);
        await sendMsg(chatId, `✅ 欢迎语已更新\n\n${escapeHtml(text)}`);
      } catch { await sendMsg(chatId, '❌ 设置失败'); }
      fire(db.clearUserSession(userId));
    },

    async add_auto_reply(text, chatId, userId) {
      try {
        const parts = text.split('|');
        if (parts.length >= 3) {
          const keyword = parts[0].trim();
          const replyText = parts[1].trim();
          const matchType = parts[2].trim().toLowerCase();
          if (!keyword || !replyText) {
            await sendMsg(chatId, '❌ 关键词和回复内容不能为空，请重新输入：');
            return;
          }
          if (!['exact', 'contains', 'regex'].includes(matchType)) {
            await sendMsg(chatId, '❌ 匹配类型必须是 exact/contains/regex，请重新输入：');
            return;
          }
          const replyId = await db.addAutoReply(keyword, replyText, matchType);
          await sendMsg(chatId, `✅ 自动回复规则已添加（ID: ${replyId}）\n\n关键词: ${escapeHtml(keyword)}\n匹配类型: ${matchType}`);
          await showAutoReplies(chatId);
        } else {
          await sendMsg(chatId, '❌ 格式错误，请使用格式：关键词|回复内容|匹配类型');
        }
      } catch { await sendMsg(chatId, '❌ 添加失败，请检查格式后重试'); }
      fire(db.clearUserSession(userId));
    },

    async add_blacklist(text, chatId, userId) {
      try {
        const parts = text.split('|');
        if (parts.length >= 2) {
          const keyword = parts[0].trim();
          const type = parts[1]?.trim().toLowerCase() || 'normal';
          const reason = parts[2]?.trim();
          if (!keyword) {
            await sendMsg(chatId, '❌ 关键词不能为空，请重新输入：');
            return;
          }
          const isRegex = type === 'regex';
          const kwId = await db.addBlacklistKeyword(keyword, isRegex, reason);
          await sendMsg(chatId, `✅ 黑名单关键词已添加（ID: ${kwId}）\n\n关键词: ${escapeHtml(keyword)}\n类型: ${isRegex ? '正则' : '普通'}`);
          await showBlacklistKeywords(chatId);
        } else {
          await sendMsg(chatId, '❌ 格式错误，请使用格式：关键词|类型|原因(可选)');
        }
      } catch { await sendMsg(chatId, '❌ 添加失败，请检查格式后重试'); }
      fire(db.clearUserSession(userId));
    },

    async set_work_hours_time(text, chatId, userId) {
      try {
        const match = text.match(/^(\d{1,2})-(\d{1,2})$/);
        if (match) {
          const startHour = parseInt(match[1], 10);
          const endHour = parseInt(match[2], 10);
          if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23 || startHour === endHour) {
            await sendMsg(chatId, '❌ 时间必须在 0-23 之间且不能相同，请重新输入：');
            return;
          }
          const setting = await db.getWorkHoursSetting();
          const offHoursMessage = setting?.offHoursMessage || '⏰ 非工作时间，请稍后再试。';
          await db.setWorkHoursSetting(true, startHour, endHour, offHoursMessage);
          await sendMsg(chatId, `✅ 工时已设置 ${String(startHour).padStart(2, '0')}:00-${String(endHour).padStart(2, '0')}:00`);
          await showWorkHoursSettings(chatId);
        } else {
          await sendMsg(chatId, '❌ 格式错误，请使用: 开始-结束 (如 9-18)');
        }
      } catch { await sendMsg(chatId, '❌ 设置失败'); }
      fire(db.clearUserSession(userId));
    },

    async set_off_hours_msg(text, chatId, userId) {
      try {
        const setting = await db.getWorkHoursSetting();
        const startHour = setting?.startHour || 9;
        const endHour = setting?.endHour || 18;
        await db.setWorkHoursSetting(true, startHour, endHour, text);
        await sendMsg(chatId, `✅ 非工时回复已更新\n\n${escapeHtml(text.substring(0, 200))}${text.length > 200 ? '...' : ''}`);
        await showWorkHoursSettings(chatId);
      } catch { await sendMsg(chatId, '❌ 设置失败'); }
      fire(db.clearUserSession(userId));
    },

    async set_user_tags(text, chatId, userId) {
      try {
        const session = await db.getUserSession(userId);
        if (!session) return;
        const data = JSON.parse(session.data);
        await db.setUserTags(data.targetUserId, text);
        await sendMsg(chatId, `✅ 标签已更新\n\n${escapeHtml(text.substring(0, 200))}${text.length > 200 ? '...' : ''}`);
        await showPmUserDetails(chatId, data.targetUserId, undefined, userId);
      } catch { await sendMsg(chatId, '❌ 设置失败'); }
      fire(db.clearUserSession(userId));
    },

    async set_user_notes(text, chatId, userId) {
      try {
        const session = await db.getUserSession(userId);
        if (!session) return;
        const data = JSON.parse(session.data);
        await db.setUserNotes(data.targetUserId, text);
        await sendMsg(chatId, `✅ 备注已更新`);
        await showPmUserDetails(chatId, data.targetUserId, undefined, userId);
      } catch { await sendMsg(chatId, '❌ 设置失败'); }
      fire(db.clearUserSession(userId));
    },

    async add_quick_reply(text, chatId, userId) {
      try {
        const parts = text.split('|');
        if (parts.length >= 2) {
          const title = parts[0].trim();
          const content = parts[1].trim();
          const category = parts[2]?.trim() || 'general';
          if (!title || !content) {
            await sendMsg(chatId, '❌ 标题和内容不能为空，请重新输入：');
            return;
          }
          await db.addQuickReply(title, content, category);
          await sendMsg(chatId, `✅ 快捷回复已添加 ${escapeHtml(title)}`);
          await showQuickReplies(chatId);
        } else {
          await sendMsg(chatId, '❌ 格式错误，请使用: 标题|内容|分类(可选)');
        }
      } catch { await sendMsg(chatId, '❌ 添加失败'); }
      fire(db.clearUserSession(userId));
    },

    async add_scheduled_msg(text, chatId, userId) {
      try {
        const session = await db.getUserSession(userId);
        if (!session) return;
        const data = JSON.parse(session.data);
        const targetUserId = data.targetUserId || null;
        const delayMinutes = parseInt(text, 10);
        if (isNaN(delayMinutes) || delayMinutes <= 0) {
          await sendMsg(chatId, '❌ 请输入有效的分钟数（正整数）：');
          return;
        }
        const scheduledAt = Math.floor(Date.now() / 1000) + delayMinutes * 60;
        const content = data.content || text;
        await db.addScheduledMessage(targetUserId, content, 'text', null, scheduledAt);
        const target = targetUserId ? `用户 ${targetUserId}` : '所有用户';
        await sendMsg(chatId, `✅ 定时消息已创建\n\n📤 目标: ${target}\n⏰ 延迟: ${delayMinutes} 分钟后发送\n📝 内容: ${escapeHtml(content.substring(0, 50))}${content.length > 50 ? '...' : ''}`);
        await showScheduledMessages(chatId);
      } catch { await sendMsg(chatId, '❌ 设置失败'); }
      fire(db.clearUserSession(userId));
    },

    async schedule_content(text, chatId, userId) {
      try {
        const session = await db.getUserSession(userId);
        if (!session) return;
        const data = JSON.parse(session.data);
        await db.setUserSession(userId, 'add_scheduled_msg', JSON.stringify({ targetUserId: data.targetUserId, content: text }));
        await sendMsg(chatId, '✅ 内容已保存，请输入延迟发送的分钟数：', {
          reply_markup: mk([{ text: '❌ 取消', callback_data: 'scheduled' }])
        });
      } catch { await sendMsg(chatId, '❌ 设置失败'); }
    },

    async ban_reason(text, chatId, userId) {
      try {
        const session = await db.getUserSession(userId);
        if (!session) return;
        const data = JSON.parse(session.data);
        await db.blockUser(data.targetUserId);
        try { await sendMsg(data.targetUserId, `🚫 您已被管理员封禁，无法继续发送消息。原因: ${escapeHtml(text)}`); } catch { }
        await sendMsg(chatId, `🚫 已封禁用户 ${data.targetUserId}\n📝 原因: ${escapeHtml(text)}`);
      } catch { await sendMsg(chatId, '❌ 封禁失败'); }
      fire(db.clearUserSession(userId));
    }
  };

  async function handleAdminMessage(msg: TelegramMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from!.id;
    const text = msg.text?.trim() || '';

    try {
      const session = await db.getUserSession(userId);
      if (session && SESSION_HANDLERS[session.action]) {
        await SESSION_HANDLERS[session.action](text, chatId, userId);
        return;
      }
    } catch (e) {
      log.error('Error checking session', { error: e });
    }

    if (text === '/start' || text === '/menu') {
      await showAdminPanel(chatId);
      return;
    }
    if (text === '/help') {
      await sendMsg(chatId, '管理员命令:\n/start - 打开管理面板\n/help - 显示帮助\n/stats - 查看统计');
      return;
    }
    if (text === '/stats') {
      await showPmStats(chatId, msg.message_id);
      return;
    }
    await showAdminPanel(chatId);
  }

  async function handleAdminReply(msg: TelegramMessage): Promise<void> {
    const adminId = msg.chat.id;
    const replyToMsg = msg.reply_to_message!;
    const mapping = await db.getPmMessageMapping(replyToMsg.message_id);
    if (!mapping) {
      await sendMsg(adminId, '❌ 无法找到对应的用户，请使用回复功能或点击消息下方的按钮。');
      return;
    }
    const userId = mapping.user_id;
    const content = msg.text || msg.caption || '[无文本内容]';
    const { type: replyType } = getContent(msg);

    const replyMarkup = JSON.stringify({
      inline_keyboard: [[
        { text: '👍', callback_data: `rate_${msg.message_id}_1` },
        { text: '👎', callback_data: `rate_${msg.message_id}_-1` }
      ]]
    });

    let sentMsg: TelegramMessage | null = null;
    const caption = `💬 <b>管理员回复</b>${content !== '[无文本内容]' ? '\n\n' + escapeHtml(content) : ''}`;

    if (replyType === 'photo' && msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      sentMsg = await api<TelegramMessage>('sendPhoto', {
        chat_id: userId,
        photo: photo.file_id,
        caption: caption,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } else if (replyType === 'video' && msg.video) {
      sentMsg = await api<TelegramMessage>('sendVideo', {
        chat_id: userId,
        video: msg.video.file_id,
        caption: caption,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } else if (replyType === 'voice' && msg.voice) {
      sentMsg = await api<TelegramMessage>('sendVoice', {
        chat_id: userId,
        voice: msg.voice.file_id,
        caption: caption,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } else if (replyType === 'audio' && msg.audio) {
      sentMsg = await api<TelegramMessage>('sendAudio', {
        chat_id: userId,
        audio: msg.audio.file_id,
        caption: caption,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } else if (replyType === 'document' && msg.document) {
      sentMsg = await api<TelegramMessage>('sendDocument', {
        chat_id: userId,
        document: msg.document.file_id,
        caption: caption,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } else if (replyType === 'sticker' && msg.sticker) {
      // 先发说明文本，再发真实贴纸（之前这里只发文本，贴纸本体被丢弃）
      const textMsg = await sendMsg(userId, caption);
      sentMsg = await api<TelegramMessage>('sendSticker', {
        chat_id: userId,
        sticker: msg.sticker.file_id,
        reply_markup: replyMarkup
      });
      if (!sentMsg && textMsg) sentMsg = textMsg;
    } else {
      sentMsg = await sendMsg(userId, caption, { reply_markup: replyMarkup });
    }

    if (sentMsg) {
      for (const m of getAllPendingMessages()) {
        if (m.user_id === userId) deletePendingMessage(m.id);
      }
      const userName = await db.getPmUser(userId);
      const name = userName?.first_name || userName?.username || `用户${userId}`;
      const fileId = replyType === 'photo' ? msg.photo?.[msg.photo.length - 1]?.file_id
        : replyType === 'video' ? msg.video?.file_id
        : replyType === 'voice' ? msg.voice?.file_id
        : replyType === 'audio' ? msg.audio?.file_id
        : replyType === 'document' ? msg.document?.file_id
        : undefined;
      await Promise.all([
        db.markMessagesAsRead(userId).catch(() => {}),
        db.saveMessage(userId, 'out', replyType, content, fileId, undefined, sentMsg.message_id).catch(() => {}),
        db.addAuditLog(adminId, 'reply', 'user', String(userId), content.substring(0, 200)).catch(() => {}),
      ]);
      await sendMsg(adminId, `✅ 已回复 ${escapeHtml(name)} (ID: <code>${userId}</code>)`);
    } else {
      await sendMsg(adminId, '❌ 发送失败');
    }
  }

  // ============ UI Display Functions ============

  /** 主面板：状态总览 + 四大功能中心（消息/用户/自动化/系统）+ 快捷直达 */
  async function showAdminPanel(chatId: number, messageId?: number): Promise<void> {
    try {
      let stats = { totalUsers: 0, totalMessages: 0, todayMessages: 0, blockedUsers: 0 };
      let unreadCount = 0;
      try {
        [stats, unreadCount] = await Promise.all([
          db.getPmStats(),
          db.getUnreadMessageCount(),
        ]);
      } catch (e) {
        log.error('Stats error in admin panel', { error: e });
      }
      const pendingCount = getPendingMessageCount();

      const text = head('🛠 管理中心', 'ErebusBot 私聊中继') +
        `\n\n👥 用户 <b>${stats.totalUsers}</b> · 📨 待处理 <b>${pendingCount}</b>` +
        `\n🔔 未读 <b>${unreadCount}</b> · 🚫 封禁 <b>${stats.blockedUsers}</b>` +
        `\n🟢 系统运行正常 · v${BOT_VERSION}` +
        tip('点击下方按钮进入各功能中心');

      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: `📨 消息中心${pendingCount > 0 ? ` (${pendingCount})` : ''}`, callback_data: 'hub_msgs' }, { text: '👥 用户中心', callback_data: 'hub_users' }],
          [{ text: '🤖 自动化', callback_data: 'hub_auto' }, { text: '⚙️ 系统', callback_data: 'hub_sys' }],
          [{ text: '📊 数据统计', callback_data: 'stats' }, { text: '❓ 帮助', callback_data: 'help' }]
        )
      }, messageId);
    } catch (e) {
      log.error('Fatal error in admin panel', { error: e });
      await editOrSend(chatId, '⚠️ 面板加载失败', undefined, messageId);
    }
  }

  // ---- 四大功能中心 ----

  async function showMsgHub(chatId: number, messageId?: number): Promise<void> {
    try {
      const unreadCount = await db.getUnreadMessageCount().catch(() => 0);
      const pendingCount = getPendingMessageCount();
      const text = head('📨 消息中心') +
        `\n\n📨 待处理 <b>${pendingCount}</b> 条 · 🔵 未读 <b>${unreadCount}</b> 条` +
        tip('待处理为最近 24 小时内转发的消息');
      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: `📨 待处理消息 (${pendingCount})`, callback_data: 'pending_messages' }],
          [{ text: `🔵 未读消息 (${unreadCount})`, callback_data: 'unread_messages' }],
          [{ text: '📊 数据统计', callback_data: 'stats' }],
          [{ text: '🏠 主页', callback_data: 'admin_back' }]
        )
      }, messageId);
    } catch (e) {
      log.error('Error showing msg hub', { error: e });
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showUserHub(chatId: number, messageId?: number): Promise<void> {
    try {
      const [userCount, blocked] = await Promise.all([
        db.getPmUserCount().catch(() => 0),
        db.getBlockedPmUsers().catch(() => [])
      ]);
      const text = head('👥 用户中心') +
        `\n\n👥 共 <b>${userCount}</b> 位用户 · 🚫 封禁 <b>${blocked.length}</b> 位` +
        tip('支持标签/备注/封禁与对话历史管理');
      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: '👥 用户列表', callback_data: 'user_list' }],
          [{ text: `🚫 封禁列表 (${blocked.length})`, callback_data: 'ban_list' }],
          [{ text: '📢 群发消息', callback_data: 'broadcast' }],
          [{ text: '🏠 主页', callback_data: 'admin_back' }]
        )
      }, messageId);
    } catch (e) {
      log.error('Error showing user hub', { error: e });
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showAutoHub(chatId: number, messageId?: number): Promise<void> {
    try {
      const [autoReplies, quickReplies, scheduled, workHours] = await Promise.all([
        db.getAutoReplies().catch(() => []),
        db.getQuickReplies().catch(() => []),
        db.getAllScheduledMessages().catch(() => []),
        db.getWorkHoursSetting().catch(() => null)
      ]);
      const pendingScheduled = scheduled.filter(m => !m.is_sent).length;
      const workStatus = workHours?.enabled
        ? `🟢 ${String(workHours.startHour).padStart(2, '0')}:00-${String(workHours.endHour).padStart(2, '0')}:00`
        : '⚪ 未开启';
      const text = head('🤖 自动化') +
        sec('规则状态') +
        `\n🤖 自动回复 <b>${autoReplies.length}</b> 条 · ⚡ 快捷回复 <b>${quickReplies.length}</b> 条` +
        `\n⏰ 定时待发 <b>${pendingScheduled}</b> 条 · 🕐 工作时间 ${workStatus}` +
        tip('匹配关键词自动回复、预设模板与定时发送');
      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: `🤖 自动回复 (${autoReplies.length})`, callback_data: 'auto_replies' }, { text: `⚡ 快捷回复 (${quickReplies.length})`, callback_data: 'quick_replies' }],
          [{ text: `⏰ 定时消息 (${pendingScheduled})`, callback_data: 'scheduled' }, { text: '🕐 工作时间', callback_data: 'work_hours' }],
          [{ text: '🏠 主页', callback_data: 'admin_back' }]
        )
      }, messageId);
    } catch (e) {
      log.error('Error showing auto hub', { error: e });
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showSysHub(chatId: number, messageId?: number): Promise<void> {
    try {
      const keywords = await db.getBlacklistKeywords().catch(() => []);
      const kwActive = keywords.filter(k => k.is_enabled).length;
      const text = head('⚙️ 系统') +
        `\n\n🔒 过滤规则 <b>${keywords.length}</b> 条（启用 ${kwActive}）` +
        tip('欢迎语、消息过滤、审计与数据备份');
      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: '⚙️ 基础设置', callback_data: 'settings' }, { text: `🔒 消息过滤 (${keywords.length})`, callback_data: 'msg_filter' }],
          [{ text: '📝 审计日志', callback_data: 'audit_log' }, { text: '💾 数据备份', callback_data: 'backup' }],
          [{ text: '🏠 主页', callback_data: 'admin_back' }]
        )
      }, messageId);
    } catch (e) {
      log.error('Error showing sys hub', { error: e });
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showPendingMessages(chatId: number, messageId?: number): Promise<void> {
    try {
      const messages = getAllPendingMessages().sort((a, b) => b.created_at - a.created_at).slice(0, 10);
      const pendingCount = getPendingMessageCount();
      const unreadMessages = await db.getUnreadMessages(20);
      const unreadCount = unreadMessages.length;

      let text = head('📨 待处理消息',
        `待处理 ${pendingCount} 条 · 未读 ${unreadCount} 条`);

      if (messages.length === 0 && unreadMessages.length === 0) {
        text += `\n\n<i>🎉 暂无待处理和未读消息</i>`;
      } else {
        if (unreadMessages.length > 0) {
          text += sec(`未读消息`);
          for (let i = 0; i < Math.min(unreadMessages.length, 5); i++) {
            const msg = unreadMessages[i];
            const name = msg.first_name || msg.username || `User${msg.user_id}`;
            text += `\n${i + 1}. 👤 ${escapeHtml(name)} · ${fmtClock(msg.created_at)}\n   ${escapeHtml(trunc(msg.content, 30))}`;
          }
          if (unreadMessages.length > 5) {
            text += `\n<i>…还有 ${unreadMessages.length - 5} 条</i>`;
          }
        }
        if (messages.length > 0) {
          text += sec(`拦截消息`);
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const name = msg.first_name || msg.username || `User${msg.user_id}`;
            const priorityIcon = msg.priority === 'urgent' ? '🔴' : msg.priority === 'low' ? '⚪' : '🟡';
            text += `\n${i + 1}. ${priorityIcon} ${escapeHtml(name)} · ${fmtTime(msg.created_at)}\n   ${escapeHtml(trunc(msg.content, 30))}`;
          }
        }
      }

      const keyboard: KbRow[] = [];
      if (messages.length > 0) {
        for (const msg of messages) {
          const name = (msg.first_name || msg.username || `U${msg.user_id}`).substring(0, 8);
          keyboard.push([
            { text: `👤 ${name}`, callback_data: `pm_user_${msg.user_id}` },
            { text: '🚫 忽略', callback_data: `ignore_msg_${msg.id}` }
          ]);
        }
      }
      if (unreadMessages.length > 0) {
        keyboard.push([{ text: `🔵 查看全部未读 (${unreadMessages.length})`, callback_data: 'unread_messages' }]);
      }
      keyboard.push([{ text: '🔙 消息中心', callback_data: 'hub_msgs' }, { text: '🏠 主页', callback_data: 'admin_back' }]);
      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      log.error('Error showing pending messages', { error: e });
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showUnreadMessages(chatId: number, messageId?: number): Promise<void> {
    try {
      const messages = await db.getUnreadMessages(30);
      const unreadCount = messages.length;

      let text = head('🔵 未读消息', `共 ${unreadCount} 条`);

      if (messages.length === 0) {
        text += `\n\n<i>🎉 暂无未读消息</i>`;
      } else {
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const name = msg.first_name || msg.username || `User${msg.user_id}`;
          text += `\n${i + 1}. 👤 ${escapeHtml(name)} · ${fmtTime(msg.created_at)}\n   ${escapeHtml(trunc(msg.content, 40))}`;
        }
      }

      const keyboard: KbRow[] = [];
      if (messages.length > 0) {
        // 每个用户取其最新一条未读做按钮名（find 拿不到时跳过，不用非空断言）
        const seen = new Set<number>();
        let row: KbRow = [];
        for (const msg of messages) {
          if (seen.has(msg.user_id)) continue;
          seen.add(msg.user_id);
          if (keyboard.length >= 5) break;
          row.push({ text: `👤 ${shortName(msg, msg.user_id)}`, callback_data: `pm_user_${msg.user_id}` });
          if (row.length === 2) { keyboard.push(row); row = []; }
        }
        if (row.length > 0) keyboard.push(row);
        if (seen.size > Math.min(keyboard.length * 2, 10)) {
          keyboard.push([{ text: `... 还有 ${seen.size} 位用户`, callback_data: 'user_list' }]);
        }
      }
      keyboard.push([{ text: '🔵 全部标为已读', callback_data: 'mark_all_read' }]);
      keyboard.push([{ text: '🔙 消息中心', callback_data: 'hub_msgs' }, { text: '🏠 主页', callback_data: 'admin_back' }]);
      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      log.error('Error showing unread messages', { error: e });
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showPmUserList(chatId: number, page: number, messageId?: number): Promise<void> {
    try {
      const users = await db.getPmUsers(100);
      const { rows: pageUsers, hasMore, totalPages } = pageSlice(users, page);
      const start = page * PAGE_SIZE;

      let text = head('👥 用户列表', `共 ${users.length} 位 · 第 ${page + 1}/${totalPages} 页`);

      if (pageUsers.length === 0) {
        text += `\n\n<i>暂无用户</i>`;
      } else {
        for (let i = 0; i < pageUsers.length; i++) {
          const user = pageUsers[i];
          const lastActive = user.last_message_at ? fmtDate(user.last_message_at) : '无记录';
          text += `\n${start + i + 1}. <b>${escapeHtml(displayName(user, user.user_id))}</b>\n   🆔 <code>${user.user_id}</code> · 活跃 ${lastActive}`;
        }
      }

      const keyboard: KbRow[] = [];
      // 两列排布用户按钮，减少滚动长度
      let row: KbRow = [];
      for (const user of pageUsers) {
        row.push({ text: `👤 ${shortName(user, user.user_id, 10)}`, callback_data: `pm_user_${user.user_id}` });
        if (row.length === 2) { keyboard.push(row); row = []; }
      }
      if (row.length > 0) keyboard.push(row);
      const nav = navRow('pm_user_list_', page, hasMore);
      if (nav) keyboard.push(nav);
      keyboard.push([{ text: '🚫 封禁列表', callback_data: 'ban_list' }]);
      keyboard.push([{ text: '🔙 用户中心', callback_data: 'hub_users' }, { text: '🏠 主页', callback_data: 'admin_back' }]);
      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      log.error('Error showing user list', { error: e });
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showPmUserDetails(chatId: number, targetUserId: number, messageId?: number, adminId?: number): Promise<void> {
    try {
      // 用户、封禁状态、管理员会话三者互不依赖，一次性并行取
      const [user, isBlocked, activeSession] = await Promise.all([
        db.getPmUser(targetUserId),
        db.isUserBlocked(targetUserId),
        adminId ? db.getUserSession(adminId).catch(() => null) : Promise.resolve(null)
      ]);
      if (!user) {
        await editOrSend(chatId, `❌ 未找到用户 <code>${targetUserId}</code>`, undefined, messageId);
        return;
      }

      const name = displayName(user, targetUserId);
      const createdDate = fmtDate(user.created_at);
      const lastActive = user.last_message_at ? fmtDate(user.last_message_at) : '无记录';

      const tags = user.tags || '';
      const notes = user.notes || '';

      const text = head('👤 用户详情', isBlocked ? '🚫 已封禁' : '🟢 正常') +
        `\n\n👤 <b>${escapeHtml(name)}</b>${user.username ? ` (@${user.username})` : ''}` +
        `\n🆔 <code>${user.user_id}</code>` +
        sec('活动') +
        `\n📅 注册 ${createdDate} · 🕐 活跃 ${lastActive}` +
        sec('标签 / 备注') +
        `\n🏷️ ${tags ? escapeHtml(tags) : '<i>无</i>'}` +
        `\n📝 ${notes ? escapeHtml(trunc(notes, 80)) : '<i>无</i>'}`;

      const statusText = isBlocked ? '✅ 解封用户' : '🚫 封禁用户';
      const statusAction = isBlocked ? `unban_pm_${targetUserId}` : `ban_pm_${targetUserId}`;

      const keyboard: KbRow[] = [];

      if (activeSession?.action === 'pm_reply') {
        try {
          const sd = JSON.parse(activeSession.data);
          if (sd.quickReplyContent) {
            keyboard.push([{ text: '⚡ 发送快捷回复', callback_data: `reply_${targetUserId}` }]);
            keyboard.push([{ text: '❌ 取消', callback_data: 'cancel_session' }]);
          } else {
            keyboard.push([{ text: '✉️ 回复用户', callback_data: `reply_${targetUserId}` }]);
          }
        } catch {
          keyboard.push([{ text: '✉️ 回复用户', callback_data: `reply_${targetUserId}` }]);
        }
      } else if (activeSession?.action === 'schedule_content') {
        keyboard.push([{ text: '⏰ 发送定时消息', callback_data: `scheduled_user_${targetUserId}` }]);
        keyboard.push([{ text: '❌ 取消', callback_data: 'cancel_session' }]);
      } else {
        keyboard.push([{ text: '✉️ 回复用户', callback_data: `reply_${targetUserId}` }]);
      }

      keyboard.push([{ text: '🏷️ 标签', callback_data: `set_tags_${targetUserId}` }, { text: '📝 备注', callback_data: `set_notes_${targetUserId}` }]);
      keyboard.push([{ text: '📜 历史', callback_data: `msg_history_${targetUserId}` }, { text: '✅ 已读', callback_data: `mark_read_${targetUserId}` }]);
      keyboard.push([{ text: statusText, callback_data: statusAction }]);
      keyboard.push([{ text: '🔙 用户列表', callback_data: 'user_list' }, { text: '🏠 主页', callback_data: 'admin_back' }]);

      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      log.error('Error showing user details', { error: e });
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showPmStats(chatId: number, messageId?: number): Promise<void> {
    try {
      resetDailyStatsIfNeeded();
      let totalUsers = 0;
      let blockedUsers = 0;
      try {
        const stats = await db.getPmStats();
        totalUsers = stats.totalUsers;
        blockedUsers = stats.blockedUsers;
      } catch (e) {
        log.error('Stats query error', { error: e });
      }
      const avgPerUser = totalUsers > 0 ? Math.round(messageStats.totalMessages / totalUsers * 10) / 10 : 0;

      const text = head('📊 数据统计') +
        sec('用户') +
        `\n👥 总数 <b>${totalUsers}</b> · 🟢 今日活跃 <b>${messageStats.todayActiveUsers.size}</b>` +
        `\n🚫 封禁 <b>${blockedUsers}</b> · 📊 人均消息 <b>${avgPerUser}</b>` +
        sec('消息') +
        `\n📨 今日 <b>${messageStats.todayMessages}</b> · 💬 累计 <b>${messageStats.totalMessages}</b>` +
        tip('统计数据为内存缓存，重启后归零');

      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: '✅ 标记全部已读', callback_data: 'mark_all_read' }],
          [{ text: '🔙 消息中心', callback_data: 'hub_msgs' }, { text: '🏠 主页', callback_data: 'admin_back' }]
        )
      }, messageId);
    } catch (e) {
      log.error('Error showing stats', { error: e });
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function startPmBroadcast(chatId: number, userId: number, messageId?: number): Promise<void> {
    try {
      // 计数与会话写入互不依赖，并行执行
      const [userCount] = await Promise.all([
        db.getPmUserCount(),
        db.setUserSession(userId, 'pm_broadcast', '{}')
      ]);
      await editOrSend(chatId,
        head('📢 群发消息') +
        `\n\n👥 目标 <b>${userCount}</b> 位用户` +
        `\n📝 支持 HTML / 纯文本` +
        tip('请直接输入广播内容'), {
        reply_markup: mk([{ text: '❌ 取消', callback_data: 'hub_users' }])
      }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 启动失败', undefined, messageId);
    }
  }

  async function showPmBanList(chatId: number, messageId?: number): Promise<void> {
    try {
      let users: Array<{ user_id: number; username: string | null; first_name: string | null }> = [];
      try { users = await db.getBlockedPmUsers(); } catch (e) { log.error('Query error in ban list', { error: e }); }

      let text = head('🚫 封禁列表', `共 ${users.length} 人`);

      if (users.length === 0) {
        text += `\n\n<i>🎉 暂无封禁用户</i>`;
      } else {
        for (let i = 0; i < users.length; i++) {
          const user = users[i];
          text += `\n${i + 1}. 🚫 <b>${escapeHtml(displayName(user, user.user_id))}</b>\n   🆔 <code>${user.user_id}</code>`;
        }
        if (users.length > 10) text += `\n<i>…仅显示前 10 人</i>`;
      }

      const keyboard: KbRow[] = [];
      // 两列解封按钮
      let row: KbRow = [];
      for (const user of users.slice(0, 6)) {
        row.push({ text: `✅ ${shortName(user, user.user_id, 10)}`, callback_data: `unban_pm_${user.user_id}` });
        if (row.length === 2) { keyboard.push(row); row = []; }
      }
      if (row.length > 0) keyboard.push(row);
      if (users.length > 6) {
        keyboard.push([{ text: `... 还有 ${users.length - 6} 人可解封，请从用户列表操作`, callback_data: 'user_list' }]);
      }
      keyboard.push([{ text: '🔙 用户中心', callback_data: 'hub_users' }, { text: '🏠 主页', callback_data: 'admin_back' }]);
      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showPmSettings(chatId: number, messageId?: number): Promise<void> {
    try {
      let welcomeMsg = '';
      try { welcomeMsg = await db.getSetting('welcome_message') || ''; } catch { }

      const text = head('⚙️ 基础设置') +
        sec('欢迎语') +
        (welcomeMsg
          ? `\n${escapeHtml(welcomeMsg.substring(0, 60))}${welcomeMsg.length > 60 ? '…' : ''}`
          : `\n⚠️ <i>未设置（使用默认值）</i>`) +
        sec('系统') +
        `\n🌐 语言: 中文 · 🟢 状态: 运行中 · 📦 v${BOT_VERSION}`;

      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: '✏️ 修改欢迎语', callback_data: 'pm_set_welcome' }, { text: '🔄 重置默认', callback_data: 'pm_reset_welcome' }],
          [{ text: '🔙 系统', callback_data: 'hub_sys' }, { text: '🏠 主页', callback_data: 'admin_back' }]
        )
      }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showMessageFilter(chatId: number, messageId?: number): Promise<void> {
    try {
      const keywords = await db.getBlacklistKeywords();
      const kwActive = keywords.filter(k => k.is_enabled).length;

      const text = head('🛡️ 消息过滤') +
        `\n\n🔒 过滤规则 <b>${keywords.length}</b> 条（启用 ${kwActive}）` +
        tip('按关键词或正则匹配，命中即拦截用户消息');

      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: '🔒 关键词规则', callback_data: 'blacklist' }],
          [{ text: '🔙 系统', callback_data: 'hub_sys' }, { text: '🏠 主页', callback_data: 'admin_back' }]
        )
      }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showReplyManagement(chatId: number, messageId?: number): Promise<void> {
    try {
      // 两个列表互不依赖，并行取
      const [autoReplies, quickReplies] = await Promise.all([
        db.getAutoReplies(),
        db.getQuickReplies()
      ]);
      const autoActive = autoReplies.filter(r => r.is_enabled).length;

      const text = head('💬 回复管理') +
        sec('自动回复') +
        `\n🤖 规则 <b>${autoReplies.length}</b> 条（启用 ${autoActive}）\n<i>用户消息命中关键词时自动回复</i>` +
        sec('快捷回复') +
        `\n⚡ 模板 <b>${quickReplies.length}</b> 条\n<i>管理员一键发送预设回复</i>`;

      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: `🤖 自动回复 (${autoReplies.length})`, callback_data: 'auto_replies' }, { text: `⚡ 快捷回复 (${quickReplies.length})`, callback_data: 'quick_replies' }],
          [{ text: '🔙 自动化', callback_data: 'hub_auto' }, { text: '🏠 主页', callback_data: 'admin_back' }]
        )
      }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showAutoReplies(chatId: number, page: number = 0, messageId?: number): Promise<void> {
    try {
      const replies = await db.getAutoReplies();
      const { rows: pageReplies, hasMore, totalPages } = pageSlice(replies, page);
      const start = page * PAGE_SIZE;

      let text = head('🤖 自动回复', `共 ${replies.length} 条 · 第 ${page + 1}/${totalPages} 页`);
      if (pageReplies.length === 0) {
        text += `\n\n<i>暂无自动回复规则</i>`;
      } else {
        for (let i = 0; i < pageReplies.length; i++) {
          const reply = pageReplies[i];
          const matchTypeText = reply.match_type === 'exact' ? '精确' : reply.match_type === 'regex' ? '正则' : '包含';
          text += `\n${start + i + 1}. ${reply.is_enabled ? '🟢' : '⏸️'} <b>${escapeHtml(reply.keyword)}</b> [${matchTypeText}]\n   💬 ${escapeHtml(trunc(reply.reply_text, 30))}`;
        }
      }

      const keyboard: KbRow[] = [];
      let row: KbRow = [];
      for (const reply of pageReplies) {
        const statusIcon = reply.is_enabled ? '⏸️' : '✅';
        row.push({ text: `${statusIcon} ${trunc(reply.keyword, 8)}`, callback_data: `auto_reply_${reply.id}` });
        if (row.length === 2) { keyboard.push(row); row = []; }
      }
      if (row.length > 0) keyboard.push(row);
      keyboard.push([{ text: '➕ 添加规则', callback_data: 'add_auto_reply' }]);
      const nav = navRow('auto_replies_', page, hasMore);
      if (nav) keyboard.push(nav);
      keyboard.push([{ text: '🔙 回复管理', callback_data: 'reply_mgmt' }, { text: '🏠 主页', callback_data: 'admin_back' }]);
      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showBlacklistKeywords(chatId: number, page: number = 0, messageId?: number): Promise<void> {
    try {
      const keywords = await db.getBlacklistKeywords();
      const { rows: pageKeywords, hasMore, totalPages } = pageSlice(keywords, page);
      const start = page * PAGE_SIZE;

      let text = head('🔒 黑名单关键词', `共 ${keywords.length} 条 · 第 ${page + 1}/${totalPages} 页`);
      if (pageKeywords.length === 0) {
        text += `\n\n<i>暂无黑名单关键词</i>`;
      } else {
        for (let i = 0; i < pageKeywords.length; i++) {
          const kw = pageKeywords[i];
          text += `\n${start + i + 1}. ${kw.is_enabled ? '🟢' : '⏸️'} <b>${escapeHtml(kw.keyword)}</b> [${kw.is_regex ? '正则' : '普通'}]${kw.reason ? `\n   📝 ${escapeHtml(kw.reason)}` : ''}`;
        }
      }

      const keyboard: KbRow[] = [];
      let row: KbRow = [];
      for (const kw of pageKeywords) {
        const statusIcon = kw.is_enabled ? '⏸️' : '✅';
        row.push({ text: `${statusIcon} ${trunc(kw.keyword, 8)}`, callback_data: `blacklist_${kw.id}` });
        if (row.length === 2) { keyboard.push(row); row = []; }
      }
      if (row.length > 0) keyboard.push(row);
      keyboard.push([{ text: '➕ 添加关键词', callback_data: 'add_blacklist' }]);
      const nav = navRow('blacklist_page_', page, hasMore);
      if (nav) keyboard.push(nav);
      keyboard.push([{ text: '🔙 消息过滤', callback_data: 'msg_filter' }, { text: '🏠 主页', callback_data: 'admin_back' }]);
      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showWorkHoursSettings(chatId: number, messageId?: number): Promise<void> {
    try {
      const setting = await db.getWorkHoursSetting();
      const text = head('🕐 工作时间') +
        sec('当前配置') +
        (!setting || !setting.enabled
          ? `\n⚪ 未开启\n<i>开启后，非工作时间自动回复用户</i>`
          : `\n🟢 已开启 · ${String(setting.startHour).padStart(2, '0')}:00 - ${String(setting.endHour).padStart(2, '0')}:00` +
            `\n\n💬 非工作时间回复:\n${escapeHtml(setting.offHoursMessage || '默认提示')}`);

      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: setting?.enabled ? '🔴 关闭' : '✅ 开启', callback_data: 'toggle_work_hours' }, { text: '🕐 设置时间', callback_data: 'set_work_hours_time' }],
          [{ text: '📝 设置回复语', callback_data: 'set_off_hours_msg' }],
          [{ text: '🔙 自动化', callback_data: 'hub_auto' }, { text: '🏠 主页', callback_data: 'admin_back' }]
        )
      }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showMessageHistory(chatId: number, targetUserId: number, page: number = 0, messageId?: number): Promise<void> {
    try {
      const pageSize = 10;
      // 消息与用户信息互不依赖，并行取（原先串行白等一个 D1 往返）
      const [messages, user] = await Promise.all([
        db.getMessageHistory(targetUserId, pageSize, page * pageSize),
        db.getPmUser(targetUserId)
      ]);
      const name = displayName(user, targetUserId);

      let text = head('📜 对话历史', name);
      if (messages.length === 0) {
        text += `\n\n<i>暂无消息记录</i>`;
      } else {
        for (const msg of messages) {
          const dir = msg.direction === 'in' ? '👤 用户' : '🤖 管理员';
          const readIcon = msg.direction === 'in' && !msg.is_read ? ' 🔵' : '';
          const ratingIcon = msg.rating === 1 ? ' 👍' : msg.rating === -1 ? ' 👎' : '';
          text += `\n${dir} · ${fmtTime(msg.created_at)}${readIcon}${ratingIcon}\n   ${escapeHtml(trunc(msg.content, 40))}`;
        }
      }

      const keyboard: KbRow[] = [];
      const nav = navRow(`msg_history_${targetUserId}_`, page, messages.length === pageSize);
      if (nav) keyboard.push(nav);
      keyboard.push([{ text: '🔙 返回用户', callback_data: `pm_user_${targetUserId}` }, { text: '🏠 主页', callback_data: 'admin_back' }]);

      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      log.error('Error showing message history', { error: e });
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showQuickReplies(chatId: number, messageId?: number, page = 0): Promise<void> {
    try {
      const replies = await db.getQuickReplies();
      const { rows: pageReplies, hasMore, totalPages } = pageSlice(replies, page);
      const start = page * PAGE_SIZE;
      let text = head('⚡ 快捷回复', `共 ${replies.length} 条 · ${page + 1}/${totalPages}`);
      if (replies.length === 0) {
        text += `\n\n<i>暂无快捷回复，点击下方「添加」创建</i>`;
      } else {
        for (let i = 0; i < pageReplies.length; i++) {
          const r = pageReplies[i];
          text += `\n${start + i + 1}. ⚡ <b>${escapeHtml(r.title)}</b>\n   ${escapeHtml(trunc(r.content, 35))}`;
        }
      }

      const keyboard: KbRow[] = [];
      for (const r of pageReplies) {
        keyboard.push([
          { text: `⚡ ${trunc(r.title, 12)}`, callback_data: `use_quick_${r.id}` },
          { text: '🗑️', callback_data: `delete_quick_${r.id}` }
        ]);
      }
      keyboard.push([{ text: '➕ 添加', callback_data: 'add_quick_reply' }]);
      const nav = navRow('quick_replies_page_', page, hasMore);
      if (nav) keyboard.push(nav);
      keyboard.push([{ text: '🔙 回复管理', callback_data: 'reply_mgmt' }, { text: '🏠 主页', callback_data: 'admin_back' }]);

      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      log.error('Error showing quick replies', { error: e });
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showScheduledMessages(chatId: number, messageId?: number): Promise<void> {
    try {
      const messages = await db.getAllScheduledMessages();
      const pending = messages.filter(m => !m.is_sent).length;
      let text = head('⏰ 定时消息', `共 ${messages.length} 条 · 待发送 ${pending} 条`);
      if (messages.length === 0) {
        text += `\n\n<i>暂无定时消息，点击下方按钮创建</i>`;
      } else {
        for (const msg of messages.slice(0, 10)) {
          const time = fmtTime(msg.scheduled_at);
          const status = msg.is_sent ? '✅ 已发送' : '⏳ 待发送';
          const target = msg.user_id ? `用户 <code>${msg.user_id}</code>` : '📢 所有人';
          text += `\n${status} · 🎯 ${target}\n   🕐 ${time} · ${escapeHtml(trunc(msg.content, 25))}`;
        }
        if (messages.length > 10) text += `\n<i>…仅显示前 10 条</i>`;
      }

      const keyboard: KbRow[] = [];
      keyboard.push([{ text: '📢 群发所有人', callback_data: 'new_scheduled_all' }, { text: '👤 发给指定用户', callback_data: 'user_list' }]);
      for (const msg of messages.filter(m => !m.is_sent).slice(0, 3)) {
        const target = msg.user_id ? `用户${msg.user_id}` : '所有人';
        keyboard.push([{ text: `🗑️ 删除: ${target}`, callback_data: `del_scheduled_${msg.id}` }]);
      }
      keyboard.push([{ text: '🔙 自动化', callback_data: 'hub_auto' }, { text: '🏠 主页', callback_data: 'admin_back' }]);
      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showAuditLog(chatId: number, messageId?: number): Promise<void> {
    try {
      const logs = await db.getAuditLogs(20);
      let text = head('📝 审计日志', `最近 ${logs.length} 条`);
      if (logs.length === 0) {
        text += `\n\n<i>暂无操作记录</i>`;
      } else {
        for (const entry of logs.slice(0, 15)) {
          text += `\n🕐 ${fmtTime(entry.created_at)} · <b>${escapeHtml(entry.action)}</b>${entry.target_id ? ` → ${escapeHtml(entry.target_id)}` : ''}`;
        }
      }

      await editOrSend(chatId, text, {
        reply_markup: mk([{ text: '🔙 系统', callback_data: 'hub_sys' }, { text: '🏠 主页', callback_data: 'admin_back' }])
      }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showBackupPanel(chatId: number, messageId?: number): Promise<void> {
    try {
      const stats = await db.getPmStats();
      const text = head('💾 数据备份') +
        `\n\n👥 用户 <b>${stats.totalUsers}</b> · 💬 消息 <b>${stats.totalMessages}</b> · 🚫 封禁 <b>${stats.blockedUsers}</b>` +
        tip('点击下方按钮导出数据');

      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: '📥 导出JSON', callback_data: 'export_json' }],
          [{ text: '🔙 系统', callback_data: 'hub_sys' }, { text: '🏠 主页', callback_data: 'admin_back' }]
        )
      }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  // ============ Callback Handler ============
  type CbContext = { chatId: number; userId: number; msgId: number | undefined; data: string };
  type CbHandler = (ctx: CbContext) => Promise<void>;

  const CALLBACK_EXACT = new Map<string, CbHandler>([
    ['cancel_session', async (ctx) => { fire(db.clearUserSession(ctx.userId)); await editOrSend(ctx.chatId, '❌ 已取消', { reply_markup: mk([{ text: '🏠 主页', callback_data: 'admin_back' }]) }, ctx.msgId); }],
    ['user_list', async (ctx) => { await showPmUserList(ctx.chatId, 0, ctx.msgId); }],
    ['stats', async (ctx) => { await showPmStats(ctx.chatId, ctx.msgId); }],
    ['broadcast', async (ctx) => { await startPmBroadcast(ctx.chatId, ctx.userId, ctx.msgId); }],
    ['ban_list', async (ctx) => { await showPmBanList(ctx.chatId, ctx.msgId); }],
    ['settings', async (ctx) => { await showPmSettings(ctx.chatId, ctx.msgId); }],
    ['pending_messages', async (ctx) => { await showPendingMessages(ctx.chatId, ctx.msgId); }],
    ['msg_filter', async (ctx) => { await showMessageFilter(ctx.chatId, ctx.msgId); }],
    ['reply_mgmt', async (ctx) => { await showReplyManagement(ctx.chatId, ctx.msgId); }],
    ['auto_replies', async (ctx) => { await showAutoReplies(ctx.chatId, 0, ctx.msgId); }],
    ['blacklist', async (ctx) => { await showBlacklistKeywords(ctx.chatId, 0, ctx.msgId); }],
    ['work_hours', async (ctx) => { await showWorkHoursSettings(ctx.chatId, ctx.msgId); }],
    ['help', async (ctx) => {
      const helpText = head('❓ 使用帮助', `版本 v${BOT_VERSION}`) +
        sec('功能导航') +
        '\n📨 <b>消息中心</b> — 待处理 / 未读 / 统计' +
        '\n👥 <b>用户中心</b> — 用户 / 封禁 / 群发' +
        '\n🤖 <b>自动化</b> — 自动回复 / 快捷回复 / 定时' +
        '\n⚙️ <b>系统</b> — 设置 / 过滤 / 审计 / 备份' +
        sec('日常操作') +
        '\n• 点击按钮即可在窗口内切换面板' +
        '\n• <b>回复</b>用户转发的消息即可直接回复对方' +
        '\n• 用户详情支持标签 / 备注 / 历史 / 封禁' +
        sec('提示') +
        '\n• 消息面板内的「忽略」不会删除消息记录' +
        '\n• 输入会话中随时点「取消」退出';
      await editOrSend(ctx.chatId, helpText, { reply_markup: mk([{ text: '🏠 主页', callback_data: 'admin_back' }]) }, ctx.msgId);
    }],
    ['admin_back', async (ctx) => { await showAdminPanel(ctx.chatId, ctx.msgId); }],
    ['back_to_admin', async (ctx) => { await showAdminPanel(ctx.chatId, ctx.msgId); }],
    ['hub_msgs', async (ctx) => { await showMsgHub(ctx.chatId, ctx.msgId); }],
    ['hub_users', async (ctx) => { await showUserHub(ctx.chatId, ctx.msgId); }],
    ['hub_auto', async (ctx) => { await showAutoHub(ctx.chatId, ctx.msgId); }],
    ['hub_sys', async (ctx) => { await showSysHub(ctx.chatId, ctx.msgId); }],
    ['add_auto_reply', async (ctx) => {
      await promptInput(ctx, 'add_auto_reply', '添加自动回复',
        `${inputFormat([['关键词|回复内容|匹配类型', '你好|你好！有什么可以帮您的？|exact']])}\n\n匹配类型: <b>exact</b>(精确) / <b>contains</b>(包含) / <b>regex</b>(正则)`,
        'auto_replies');
    }],
    ['add_blacklist', async (ctx) => {
      await promptInput(ctx, 'add_blacklist', '添加黑名单关键词',
        `${inputFormat([['关键词|类型|原因(可选)', '广告|normal|垃圾广告信息']])}\n\n类型: <b>normal</b>(普通) / <b>regex</b>(正则)`,
        'blacklist');
    }],
    ['toggle_work_hours', async (ctx) => {
      const setting = await guard('toggle_work_hours')(db.getWorkHoursSetting());
      if (setting === null) { await showFail(ctx.chatId, ctx.msgId, '操作'); return; }
      const newState = !(setting?.enabled || false);
      const done = await guard('toggle_work_hours')(
        newState ? db.setWorkHoursSetting(true, 9, 18, '⏰ 非工作时间，请稍后再试。') : db.setWorkHoursSetting(false, 9, 18, '')
      );
      if (done === null) { await showFail(ctx.chatId, ctx.msgId, '操作'); return; }
      await showWorkHoursSettings(ctx.chatId, ctx.msgId);
    }],
    ['set_work_hours_time', async (ctx) => {
      await promptInput(ctx, 'set_work_hours_time', '设置工作时间',
        inputFormat([['开始时间-结束时间', '9-18 (9:00-18:00)']]) + '\n<code>8-22</code> (8:00-22:00)',
        'work_hours');
    }],
    ['set_off_hours_msg', async (ctx) => {
      await promptInput(ctx, 'set_off_hours_msg', '设置非工作时间消息',
        '请输入非工作时间要显示的消息：\n\n支持 HTML 格式', 'work_hours');
    }],
    ['pm_set_welcome', async (ctx) => {
      await promptInput(ctx, 'pm_set_welcome', '修改欢迎语', '请输入新的欢迎消息：', 'settings');
    }],
    ['pm_reset_welcome', async (ctx) => {
      const ok = await guard('pm_reset_welcome')(db.updateSetting('welcome_message', ''));
      if (ok === null) { await showFail(ctx.chatId, ctx.msgId, '重置'); return; }
      await showPmSettings(ctx.chatId, ctx.msgId);
    }],
    ['quick_replies', async (ctx) => { await showQuickReplies(ctx.chatId, ctx.msgId); }],
    ['add_quick_reply', async (ctx) => {
      await promptInput(ctx, 'add_quick_reply', '添加快捷回复',
        inputFormat([['标题|内容|分类(可选)', '问候|你好！有什么可以帮您的？|general']]),
        'quick_replies');
    }],
    ['scheduled', async (ctx) => { await showScheduledMessages(ctx.chatId, ctx.msgId); }],
    ['new_scheduled_all', async (ctx) => {
      await promptInput(ctx, 'schedule_content', '新建定时消息', '请输入要发送的内容：', 'scheduled', { targetUserId: null });
    }],
    ['audit_log', async (ctx) => { await showAuditLog(ctx.chatId, ctx.msgId); }],
    ['backup', async (ctx) => { await showBackupPanel(ctx.chatId, ctx.msgId); }],
    ['export_json', async (ctx) => {
      const data = await guard('export_json')(db.exportAllData());
      if (data === null) { await showFail(ctx.chatId, ctx.msgId, '导出'); return; }
      const json = JSON.stringify(data, null, 2);
      const truncated = json.length > 3500 ? json.substring(0, 3500) + '\n\n... (数据过大，已截断)' : json;
      await editOrSend(ctx.chatId, head('📥 数据导出') + `\n\n<code>${escapeHtml(truncated)}</code>`, {
        reply_markup: mk([{ text: '🔙 数据备份', callback_data: 'backup' }, { text: '🏠 主页', callback_data: 'admin_back' }])
      }, ctx.msgId);
      // 审计日志与用户看到的导出结果无关，异步落库不阻塞回包
      fire(db.addAuditLog(ctx.userId, 'export_data', 'system', 'all', 'JSON export'));
    }],
    ['mark_all_read', async (ctx) => {
      const ok = await guard('mark_all_read')(db.markAllMessagesAsRead());
      if (ok === null) { await showFail(ctx.chatId, ctx.msgId, '操作'); return; }
      await showPmStats(ctx.chatId, ctx.msgId);
    }],
    ['unread_messages', async (ctx) => { await showUnreadMessages(ctx.chatId, ctx.msgId); }],
    ['noop', async () => { /* 占位按钮：仅消除转圈动画（handleCallback 已统一 answer） */ }],
  ]);

  const CALLBACK_PREFIX: Array<{ prefix: string; handler: CbHandler }> = [
    { prefix: 'cancel_to_', handler: async (ctx) => {
      // 取消输入会话：先清 session（防残留吞文本），再跳回 cancelTo 指向的面板
      const target = ctx.data.slice('cancel_to_'.length);
      fire(db.clearUserSession(ctx.userId));
      const panelHandler = CALLBACK_EXACT.get(target);
      if (panelHandler) { await panelHandler(ctx); return; }
      await editOrSend(ctx.chatId, '❌ 已取消', undefined, ctx.msgId);
    } },
    { prefix: 'pm_user_list_', handler: async (ctx) => { await showPmUserList(ctx.chatId, cbNum(ctx.data, 3), ctx.msgId); } },
    { prefix: 'ignore_msg_', handler: async (ctx) => {
      deletePendingMessage(cbNum(ctx.data, 2));
      await editOrSend(ctx.chatId, '✅ 已忽略该消息', { reply_markup: mk([{ text: '◀ 返回待处理', callback_data: 'pending_messages' }]) }, ctx.msgId);
    }},
    { prefix: 'auto_replies_', handler: async (ctx) => { await showAutoReplies(ctx.chatId, cbNum(ctx.data, 2), ctx.msgId); } },
    { prefix: 'quick_replies_page_', handler: async (ctx) => { await showQuickReplies(ctx.chatId, ctx.msgId, cbNum(ctx.data, 2)); } },
    { prefix: 'blacklist_page_', handler: async (ctx) => { await showBlacklistKeywords(ctx.chatId, cbNum(ctx.data, 2), ctx.msgId); } },
    { prefix: 'auto_reply_', handler: async (ctx) => {
      const replyId = cbNum(ctx.data, 2);
      if (replyId <= 0) return;
      const reply = await guard('auto_reply_detail')(db.getAutoReply(replyId));
      if (reply === null) { await showFail(ctx.chatId, ctx.msgId, '加载'); return; }
      if (!reply) { await editOrSend(ctx.chatId, '❌ 规则不存在', undefined, ctx.msgId); return; }
      await editOrSend(ctx.chatId,
        head('🤖 自动回复规则') +
        '\n\n🔑 <b>关键词:</b> ' + escapeHtml(reply.keyword) +
        '\n📝 <b>回复内容:</b>\n' + escapeHtml(reply.reply_text) +
        '\n📋 <b>匹配类型:</b> ' + reply.match_type +
        '\n状态: ' + (reply.is_enabled ? '🟢 已启用' : '⏸️ 已禁用'), {
          reply_markup: mk([{ text: reply.is_enabled ? '⏸️ 禁用' : '✅ 启用', callback_data: 'toggle_auto_reply_' + replyId }, { text: '🗑️ 删除', callback_data: 'delete_auto_reply_' + replyId }], [{ text: '◀ 返回列表', callback_data: 'auto_replies' }])
        }, ctx.msgId);
    }},
    { prefix: 'toggle_auto_reply_', handler: async (ctx) => {
      const replyId = cbNum(ctx.data, 3);
      if (replyId <= 0) return;
      // 原子翻转：一条 SQL 完成读取+取反+写回，替代原先的全表拉取→find→写回
      // 返回 null 表示记录不存在或查询失败（false 是「翻成禁用」的正常结果）
      const newState = await guard('toggle_auto_reply')(db.flipAutoReply(replyId));
      if (newState === null) { await editOrSend(ctx.chatId, '❌ 规则不存在或已删除', undefined, ctx.msgId); return; }
      await showAutoReplies(ctx.chatId, 0, ctx.msgId);
    }},
    { prefix: 'delete_auto_reply_', handler: async (ctx) => {
      const replyId = cbNum(ctx.data, 3);
      if (replyId <= 0) return;
      const ok = await guard('delete_auto_reply')(db.deleteAutoReply(replyId));
      if (ok === null) { await showFail(ctx.chatId, ctx.msgId, '删除'); return; }
      await showAutoReplies(ctx.chatId, 0, ctx.msgId);
    }},
    { prefix: 'blacklist_', handler: async (ctx) => {
      const kwId = cbNum(ctx.data, 1);
      if (kwId <= 0) return;
      const kw = await guard('blacklist_detail')(db.getBlacklistKeyword(kwId));
      if (kw === null) { await showFail(ctx.chatId, ctx.msgId, '加载'); return; }
      if (!kw) { await editOrSend(ctx.chatId, '❌ 关键词不存在', undefined, ctx.msgId); return; }
      await editOrSend(ctx.chatId,
        head('🔒 黑名单关键词') +
        '\n\n🔑 <b>关键词:</b> ' + escapeHtml(kw.keyword) +
        '\n📋 <b>类型:</b> ' + (kw.is_regex ? '正则' : '普通') +
        (kw.reason ? '\n📝 <b>原因:</b> ' + escapeHtml(kw.reason) : '') +
        '\n状态: ' + (kw.is_enabled ? '🟢 已启用' : '⏸️ 已禁用'), {
        reply_markup: mk(
          [{ text: kw.is_enabled ? '⏸️ 禁用' : '✅ 启用', callback_data: 'toggle_blacklist_' + kwId }, { text: '🗑️ 删除', callback_data: 'delete_blacklist_' + kwId }],
          [{ text: '◀ 返回列表', callback_data: 'blacklist' }]
        )
      }, ctx.msgId);
    }},
    { prefix: 'toggle_blacklist_', handler: async (ctx) => {
      const kwId = cbNum(ctx.data, 2);
      if (kwId <= 0) return;
      const newState = await guard('toggle_blacklist')(db.flipBlacklistKeyword(kwId));
      if (newState === null) { await editOrSend(ctx.chatId, '❌ 关键词不存在或已删除', undefined, ctx.msgId); return; }
      await showBlacklistKeywords(ctx.chatId, 0, ctx.msgId);
    }},
    { prefix: 'delete_blacklist_', handler: async (ctx) => {
      const kwId = cbNum(ctx.data, 2);
      if (kwId <= 0) return;
      const ok = await guard('delete_blacklist')(db.deleteBlacklistKeyword(kwId));
      if (ok === null) { await showFail(ctx.chatId, ctx.msgId, '删除'); return; }
      await showBlacklistKeywords(ctx.chatId, 0, ctx.msgId);
    }},
    { prefix: 'pm_user_', handler: async (ctx) => {
      const targetUserId = cbNum(ctx.data, 2);
      if (targetUserId <= 0) return;
      const ok = await guard('pm_user_detail')(showPmUserDetails(ctx.chatId, targetUserId, ctx.msgId, ctx.userId));
      if (ok === null) { await showFail(ctx.chatId, ctx.msgId, '加载用户详情'); }
    }},
    { prefix: 'unban_pm_', handler: async (ctx) => {
      const targetUserId = cbNum(ctx.data, 2);
      if (targetUserId <= 0) return;
      const ok = await guard('unban_pm')(db.unblockPmUser(targetUserId));
      if (ok === null) { await showFail(ctx.chatId, ctx.msgId, '解封'); return; }
      await showPmBanList(ctx.chatId, ctx.msgId);
    }},
    { prefix: 'reply_', handler: async (ctx) => {
      const targetUserId = cbNum(ctx.data, 1);
      if (targetUserId <= 0) return;
      const existingSession = await guard('reply_session')(db.getUserSession(ctx.userId));
      if (existingSession === null) { await showFail(ctx.chatId, ctx.msgId, '回复'); return; }
      let quickReplyContent: string | null = null;
      if (existingSession?.action === 'pm_reply') {
        try { const d = JSON.parse(existingSession.data); quickReplyContent = d.quickReplyContent || null; } catch { }
      }
      if (!quickReplyContent) {
        const ok = await guard('reply_setup')(db.setUserSession(ctx.userId, 'pm_reply', JSON.stringify({ targetUserId })));
        if (ok === null) { await showFail(ctx.chatId, ctx.msgId, '回复'); return; }
        await editOrSend(ctx.chatId, '✉️ 正在回复用户 (ID: ' + targetUserId + ')\n\n请直接发送消息，我会转发给该用户：', {
          reply_markup: mk([{ text: '❌ 取消', callback_data: `pm_user_${targetUserId}` }])
        }, ctx.msgId);
        return;
      }
      // 快捷回复直发路径
      const sentMsg = await sendMsg(targetUserId, `💬 <b>管理员回复</b>\n\n${escapeHtml(quickReplyContent)}`);
      if (!sentMsg) { await editOrSend(ctx.chatId, '❌ 发送失败', undefined, ctx.msgId); return; }
      const [user] = await Promise.all([
        db.getPmUser(targetUserId).catch(() => null),
        // 落库三件事互不依赖，也和取用户名并行；审计日志异步不阻塞
        db.markMessagesAsRead(targetUserId).catch(() => {}),
        db.saveMessage(targetUserId, 'out', 'text', quickReplyContent, undefined, undefined, sentMsg.message_id).catch(() => {})
      ]);
      fire(db.addAuditLog(ctx.userId, 'quick_reply', 'user', String(targetUserId), quickReplyContent.substring(0, 200)));
      await editOrSend(ctx.chatId, `✅ 已回复 ${escapeHtml(displayName(user, targetUserId))} (ID: <code>${targetUserId}</code>)`, undefined, ctx.msgId);
      fire(db.clearUserSession(ctx.userId));
    }},
    { prefix: 'ban_pm_', handler: async (ctx) => {
      const targetUserId = cbNum(ctx.data, 2);
      if (targetUserId <= 0) return;
      // 封禁与取用户名互不依赖，并行执行
      const [name] = await Promise.all([
        db.getPmUser(targetUserId).then(u => displayName(u, targetUserId)).catch(() => `User${targetUserId}`),
        db.blockUser(targetUserId)
      ]);
      // 通知管理员、刷新详情、通知用户三者并行（通知失败不影响刷新）
      await Promise.all([
        sendMsg(ctx.chatId, '🚫 <b>' + escapeHtml(name) + '</b> (ID: <code>' + targetUserId + '</code>) 已被封禁').catch(() => null),
        showPmUserDetails(ctx.chatId, targetUserId, ctx.msgId, ctx.userId),
        sendMsg(targetUserId, '🚫 您已被封禁，无法发送消息。如有疑问请联系管理员。').catch(() => null)
      ]);
    }},
    { prefix: 'ban_', handler: async (ctx) => {
      const targetUserId = cbNum(ctx.data, 1);
      if (targetUserId <= 0) return;
      const [name] = await Promise.all([
        db.getPmUser(targetUserId).then(u => displayName(u, targetUserId)).catch(() => `User${targetUserId}`),
        db.blockUser(targetUserId)
      ]);
      // 通知用户与管理员回包并行
      await Promise.all([
        sendMsg(targetUserId, '🚫 您已被管理员封禁，无法继续发送消息。如有疑问请联系管理员。').catch(() => null),
        editOrSend(ctx.chatId, `🚫 <b>${escapeHtml(name)}</b> <code>${targetUserId}</code> 已封禁`, {
          reply_markup: mk([{ text: '🏠 主页', callback_data: 'admin_back' }])
        }, ctx.msgId)
      ]);
    }},
    { prefix: 'set_tags_', handler: async (ctx) => {
      const targetUserId = cbNum(ctx.data, 2);
      if (targetUserId <= 0) return;
      // 会话写入与当前标签查询互不依赖，并行执行
      const [session, currentTags] = await Promise.all([
        db.setUserSession(ctx.userId, 'set_user_tags', JSON.stringify({ targetUserId })).catch(() => null),
        db.getUserTags(targetUserId).catch(() => '')
      ]);
      if (session === null) { await showFail(ctx.chatId, ctx.msgId, '操作'); return; }
      await editOrSend(ctx.chatId, `🏷️ 设置用户 ${targetUserId} 的标签\n\n当前: ${currentTags || '无'}\n\n请输入新标签（多个用逗号分隔）：`, {
        reply_markup: mk([{ text: '❌ 取消', callback_data: `pm_user_${targetUserId}` }])
      }, ctx.msgId);
    }},
    { prefix: 'set_notes_', handler: async (ctx) => {
      const targetUserId = cbNum(ctx.data, 2);
      if (targetUserId <= 0) return;
      const [session, currentNotes] = await Promise.all([
        db.setUserSession(ctx.userId, 'set_user_notes', JSON.stringify({ targetUserId })).catch(() => null),
        db.getUserNotes(targetUserId).catch(() => '')
      ]);
      if (session === null) { await showFail(ctx.chatId, ctx.msgId, '操作'); return; }
      await editOrSend(ctx.chatId, `📝 设置用户 ${targetUserId} 的备注\n\n当前: ${currentNotes || '无'}\n\n请输入新备注：`, {
        reply_markup: mk([{ text: '❌ 取消', callback_data: `pm_user_${targetUserId}` }])
      }, ctx.msgId);
    }},
    { prefix: 'msg_history_', handler: async (ctx) => {
      const parts = ctx.data.split('_');
      const targetUserId = cbNum(ctx.data, 2);
      const page = parts.length > 3 ? cbNum(ctx.data, 3) : 0;
      if (targetUserId <= 0) return;
      await showMessageHistory(ctx.chatId, targetUserId, page, ctx.msgId);
    }},
    { prefix: 'mark_read_', handler: async (ctx) => {
      const targetUserId = cbNum(ctx.data, 2);
      if (targetUserId <= 0) return;
      const ok = await guard('mark_read')(db.markMessagesAsRead(targetUserId));
      if (ok === null) { await showFail(ctx.chatId, ctx.msgId, '操作'); return; }
      // 直接刷新详情页——旧版先编辑一条"已标记"提示再被详情页覆盖，白做一次 Telegram 往返
      await showPmUserDetails(ctx.chatId, targetUserId, ctx.msgId, ctx.userId);
    }},
    { prefix: 'use_quick_', handler: async (ctx) => {
      const replyId = cbNum(ctx.data, 2);
      if (replyId <= 0) return;
      const reply = await guard('use_quick')(db.getQuickReply(replyId));
      if (reply === null) { await showFail(ctx.chatId, ctx.msgId, '操作'); return; }
      if (!reply) { await editOrSend(ctx.chatId, '❌ 快捷回复不存在', undefined, ctx.msgId); return; }
      const ok = await guard('use_quick_session')(
        db.setUserSession(ctx.userId, 'pm_reply', JSON.stringify({ targetUserId: null, quickReplyContent: reply.content }))
      );
      if (ok === null) { await showFail(ctx.chatId, ctx.msgId, '操作'); return; }
      await showPmUserList(ctx.chatId, 0, ctx.msgId);
    }},
    { prefix: 'delete_quick_', handler: async (ctx) => {
      const replyId = cbNum(ctx.data, 2);
      if (replyId <= 0) return;
      const ok = await guard('delete_quick')(db.deleteQuickReply(replyId));
      if (ok === null) { await showFail(ctx.chatId, ctx.msgId, '删除'); return; }
      await showQuickReplies(ctx.chatId, ctx.msgId);
    }},
    { prefix: 'scheduled_user_', handler: async (ctx) => {
      const targetUserId = cbNum(ctx.data, 2);
      if (targetUserId <= 0) return;
      await promptInput(ctx, 'schedule_content', '定时消息',
        `🎯 目标用户: <code>${targetUserId}</code>\n\n请输入要发送的内容：`,
        'scheduled', { targetUserId });
    }},
    { prefix: 'del_scheduled_', handler: async (ctx) => {
      const msgId = cbNum(ctx.data, 2);
      if (msgId <= 0) return;
      const ok = await guard('del_scheduled')(db.deleteScheduledMessage(msgId));
      if (ok === null) { await showFail(ctx.chatId, ctx.msgId, '删除'); return; }
      await showScheduledMessages(ctx.chatId, ctx.msgId);
    }},
  ];

  async function handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const userId = query.from.id;
    const chatId = query.message?.chat.id;
    const data = query.data || '';
    const msgId = query.message?.message_id;

    if (!chatId) return;

    if (data.startsWith('rate_')) {
      const parts = data.split('_');
      const messageId = parseInt(parts[1], 10);
      const rating = parseInt(parts[2], 10);
      if (!isNaN(messageId) && (rating === 1 || rating === -1)) {
        try {
          await db.rateMessage(messageId, rating);
          const emoji = rating === 1 ? '👍' : '👎';
          try {
            await api('editMessageReplyMarkup', {
              chat_id: chatId,
              message_id: msgId,
              reply_markup: JSON.stringify({
                inline_keyboard: [[{ text: `${emoji} 已评价`, callback_data: 'rated' }]]
              })
            });
          } catch { }
          try { await answerCb(query.id, '感谢您的反馈！'); } catch { }
        } catch {
          try { await answerCb(query.id, '评价失败'); } catch { }
        }
      }
      return;
    }

    if (!isAdmin(userId)) return;

    // answerCallbackQuery 只负责消掉客户端的转圈动画，与面板渲染互不依赖。
    // 之前先 await 它再干活，每次点击白等一个 Telegram 往返（~300ms）；
    // 改成并发触发，点击到面板刷新的耗时直接少这一截。
    fire(answerCb(query.id).catch(() => { }));

    const ctx: CbContext = { chatId, userId, msgId, data };

    const exactHandler = CALLBACK_EXACT.get(data);
    if (exactHandler) {
      await exactHandler(ctx);
      return;
    }

    for (const route of CALLBACK_PREFIX) {
      if (data.startsWith(route.prefix)) {
        await route.handler(ctx);
        return;
      }
    }
  }

  // ============ Update Dispatcher ============
  // 与去重解耦：webhook 用内存去重，轮询用 Telegram 的 offset 持久化去重
  async function dispatchUpdate(update: TelegramUpdate): Promise<void> {
    if (!update.message && !update.callback_query) return;

    try {
      if (update.message) {
        const msg = update.message;
        const userId = msg.from!.id;
        const text = msg.text?.trim() || '';

        await ensureDbInitialized(env);

        if (isAdmin(userId)) {
          if (text === '/start' || text === '/menu') {
            await showAdminPanel(msg.chat.id);
            return;
          }
          if (msg.reply_to_message) {
            await handleAdminReply(msg);
          } else {
            await handleAdminMessage(msg);
          }
        } else {
          await handleUserMessage(msg);
        }
      } else if (update.callback_query) {
        await handleCallback(update.callback_query);
      }
    } catch (e) {
      log.error('Handle update error', { error: e });
    }
  }

  // ============ Main Update Handler (webhook) ============
  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!update.update_id) return;
    if (updateDeduplication.size >= MAX_DEDUP_SIZE) updateDeduplication.clear();
    if (updateDeduplication.has(update.update_id)) return;
    updateDeduplication.add(update.update_id);

    await dispatchUpdate(update);
  }

  // ============ Polling Mode ============
  // 用途：Telegram 不接受解析到 198.18.0.0/15（CF 保留 anycast 段）的 webhook 地址，
  // 此时改用 getUpdates 轮询，彻底绕开「必须有域名」的限制。
  // 2026-10-01：已有自定义域名，切换为 Webhook 推送模式（Telegram 主动推送，零拾取延迟）。
  // 轮询保留为回滚备份：把 pm_settings.poll_mode 改回非 'webhook'（或删掉该行）并 deleteWebhook 即可恢复。
  async function handlePoll(timeoutSeconds = 10): Promise<{ fetched: number; skipped?: boolean }> {
    await ensureDbInitialized(env);

    // Webhook 模式下轮询让位：继续 getUpdates 只会撞 409 空转。
    // getSetting 有 300s 缓存，切换后最多多跑 5 分钟空轮询属预期。
    if ((await db.getSetting(POLL_MODE_KEY)) === 'webhook') {
      return { fetched: 0, skipped: true };
    }

    const lastOffset = parseInt((await db.getSetting(POLL_OFFSET_KEY)) || '0', 10) || 0;
    let fetched = 0;

    try {
      // timeout 必须小于轮询间隔，否则本次长连接还没返回，下一次轮询就撞上 409。
      const timeout = Math.max(1, Math.min(timeoutSeconds, 60));
      const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${lastOffset + 1}` +
        `&timeout=${timeout}&allowed_updates=${encodeURIComponent('["message","edited_message","callback_query"]')}`;
      const r = await fetch(url, { method: 'POST' });
      const data = await r.json() as { ok?: boolean; result?: TelegramUpdate[]; description?: string };

      if (!r.ok || !data.ok) {
        // 409 Conflict = 已有另一个 getUpdates 长连接（Cron 与手动触发撞车）。
        // 此时必须原样返回、不能推进 offset，让下一轮接着拉。
        const desc = data.description || '';
        if (r.status === 409 || /conflict/i.test(desc) || /terminated by other getUpdates/i.test(desc)) {
          log.warn('getUpdates conflict, skip this round', { status: r.status, description: desc });
          return { fetched, skipped: true };
        }
        log.error('getUpdates failed', { status: r.status, description: desc });
        return { fetched };
      }

      const updates = (data.result || []).slice().sort((a, b) => a.update_id - b.update_id);
      if (!updates.length) return { fetched };

      for (const u of updates) {
        // Bot 自己发出的消息同样会出现在 getUpdates 结果里，
        // 不过滤会被当成「来自管理员的新消息」再次转发，形成死循环刷屏。
        if (u.message?.from?.is_bot || u.callback_query?.from?.is_bot) continue;

        fetched++;
        try {
          await dispatchUpdate(u);
        } catch (e) {
          // 单条失败不能中断整批，否则 offset 不前进会反复重试同一条
          log.error('Poll dispatch error', { update_id: u.update_id, error: e });
        }
      }

      const maxId = updates[updates.length - 1].update_id;
      await db.updateSetting(POLL_OFFSET_KEY, String(maxId + 1));
    } catch (e) {
      log.error('Poll failed', { error: e });
    }

    return { fetched };
  }

  // ============ 定时消息发送器 ============
  /**
   * 扫描到期的待发定时消息并投递。
   * 只由 PollerDO 的 alarm（DO 单实例、闹钟不并发）每轮调用一次——
   * webhook 路径绝不调用，避免同一条消息被多次发送。
   * user_id 为空表示广播给全部用户（每批并发 10）。
   * 投递失败也标记已发送（记日志+审计），防止永久重试刷爆；失败数体现在审计里。
   */
  async function processScheduledMessages(): Promise<{ scanned: number; sent: number; failed: number }> {
    const due = (await db.getPendingScheduledMessages().catch(e => {
      log.error('Error fetching scheduled messages', { error: e });
      return null;
    })) || [];
    if (due.length === 0) return { scanned: 0, sent: 0, failed: 0 };

    let sent = 0;
    let failed = 0;
    for (const m of due) {
      try {
        if (m.user_id) {
          const ok = await sendMsg(m.user_id, escapeHtml(m.content));
          if (ok) sent++; else failed++;
        } else {
          const users = await db.getPmUsers(1000);
          const CONCURRENCY = 10;
          for (let i = 0; i < users.length; i += CONCURRENCY) {
            const results = await Promise.allSettled(
              users.slice(i, i + CONCURRENCY).map(u => sendMsg(u.user_id, escapeHtml(m.content)))
            );
            for (const r of results) {
              if (r.status === 'fulfilled' && r.value) sent++; else failed++;
            }
          }
        }
      } catch (e) {
        log.error('Scheduled message dispatch error', { id: m.id, error: e });
        failed++;
      }
      await db.markScheduledMessageSent(m.id).catch(() => {});
    }
    log.info('Scheduled messages dispatched', { count: due.length, sent, failed });
    fire(db.addAuditLog(getPrimaryAdminId(), 'scheduled_send', 'system', 'batch', `${due.length} 条：成功 ${sent}，失败 ${failed}`));
    return { scanned: due.length, sent, failed };
  }

  return { handleUpdate, handlePoll, processScheduledMessages };
}
