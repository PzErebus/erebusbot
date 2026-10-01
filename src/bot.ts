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

/** 版本号单一来源：index.ts 的 /version 端点与 help 面板共用 */
export const BOT_VERSION = '202605182048';

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
      `<b>╔══ ${title} ══╗</b>\n\n${body}`, {
      reply_markup: mk([{ text: '❌ 取消', callback_data: cancelTo }])
    }, ctx.msgId);
  }

  /** 通用格式化输入提示体：格式说明 + 示例 */
  function inputFormat(lines: Array<[string, string]>): string {
    return lines.map(([fmt, example]) => `请按以下格式输入：\n<code>${fmt}</code>\n\n示例:\n<code>${example}</code>`).join('\n\n');
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
    } else if (replyType === 'sticker') {
      sentMsg = await sendMsg(userId, caption, { reply_markup: replyMarkup });
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
      const allPending = getAllPendingMessages();
      const urgentCount = allPending.filter(m => m.priority === 'urgent').length;

      const text = `<b>╔══ 管理面板 ══╗</b>\n\n` +
        `┌─ 系统状态 ─┐\n` +
        `│ ✅ 运行正常\n` +
        `│ 👥 用户 ${stats.totalUsers}\n` +
        `│ 📨 待处理 ${pendingCount} 条${urgentCount > 0 ? ` 🔴${urgentCount}紧急` : ''}\n` +
        `│ 🔔 未读 ${unreadCount} 条\n` +
        `└───────────┘\n\n` +
        `<i>请选择下方功能</i>`;

      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: '👥 用户管理', callback_data: 'user_list' }, { text: `📨 待处理${pendingCount > 0 ? ` (${pendingCount})` : ''}`, callback_data: 'pending_messages' }],
          [{ text: '📊 数据统计', callback_data: 'stats' }, { text: '💬 回复管理', callback_data: 'reply_mgmt' }],
          [{ text: '🛡️ 消息过滤', callback_data: 'msg_filter' }, { text: '📢 群发消息', callback_data: 'broadcast' }],
          [{ text: '⚙️ 基础设置', callback_data: 'settings' }, { text: '🕐 工作时间', callback_data: 'work_hours' }],
          [{ text: '⏰ 定时消息', callback_data: 'scheduled' }, { text: '📝 审计日志', callback_data: 'audit_log' }],
          [{ text: '💾 数据备份', callback_data: 'backup' }, { text: '📖 使用帮助', callback_data: 'help' }]
        )
      }, messageId);
    } catch (e) {
      log.error('Fatal error in admin panel', { error: e });
      await editOrSend(chatId, '⚠️ 面板加载失败', undefined, messageId);
    }
  }

  async function showPendingMessages(chatId: number, messageId?: number): Promise<void> {
    try {
      const messages = getAllPendingMessages().sort((a, b) => b.created_at - a.created_at).slice(0, 10);
      const pendingCount = getPendingMessageCount();
      const unreadMessages = await db.getUnreadMessages(20);
      const unreadCount = unreadMessages.length;

      let text = `<b>╔══ 待处理消息 ══╗</b>\n`;
      text += `📨 待处理 ${pendingCount} 条  🔵 未读 ${unreadCount} 条\n\n`;

      if (messages.length === 0 && unreadMessages.length === 0) {
        text += `<i>暂无待处理和未读消息</i>`;
      } else {
        if (unreadMessages.length > 0) {
          text += `┌─ 🔵 未读消息 ─────┐\n`;
          for (let i = 0; i < Math.min(unreadMessages.length, 5); i++) {
            const msg = unreadMessages[i];
            const name = msg.first_name || msg.username || `User${msg.user_id}`;
            const time = fmtClock(msg.created_at);
            const content = msg.content.length > 25 ? msg.content.substring(0, 25) + '...' : msg.content;
            text += `│ 👤 ${escapeHtml(name)}\n│ 🕐 ${time}  📝 ${escapeHtml(content)}\n`;
          }
          if (unreadMessages.length > 5) {
            text += `│ ... 还有 ${unreadMessages.length - 5} 条\n`;
          }
          text += `└─────────────────┘\n\n`;
        }

        if (messages.length > 0) {
          text += `┌─ ⏳ 拦截消息 ─────┐\n`;
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const name = msg.first_name || msg.username || `User${msg.user_id}`;
            const time = fmtTime(msg.created_at);
            const content = msg.content.length > 25 ? msg.content.substring(0, 25) + '...' : msg.content;
            const priorityIcon = msg.priority === 'urgent' ? '🔴' : msg.priority === 'low' ? '⚪' : '🟡';
            text += `│ ${priorityIcon} ${escapeHtml(name)}\n│ 🕐 ${time}\n│ 📝 ${escapeHtml(content)}\n`;
          }
          text += `└─────────────────┘`;
        }
      }

      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      if (unreadMessages.length > 0) {
        keyboard.push([{ text: `🔵 查看全部未读 (${unreadMessages.length})`, callback_data: 'unread_messages' }]);
      }
      if (messages.length > 0) {
        for (const msg of messages) {
          const name = (msg.first_name || msg.username || `U${msg.user_id}`).substring(0, 8);
          keyboard.push([
            { text: `👤 ${name}`, callback_data: `pm_user_${msg.user_id}` },
            { text: '🚫 忽略', callback_data: `ignore_msg_${msg.id}` }
          ]);
        }
      }
      keyboard.push([{ text: '🏠 主页', callback_data: 'admin_back' }]);
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

      let text = `<b>╔══ 未读消息 ══╗</b>  ${unreadCount} 条\n\n`;

      if (messages.length === 0) {
        text += `<i>暂无未读消息</i>`;
      } else {
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const name = msg.first_name || msg.username || `User${msg.user_id}`;
          const time = fmtTime(msg.created_at);
          const content = msg.content.length > 40 ? msg.content.substring(0, 40) + '...' : msg.content;
          text += `┌─ ${i + 1}. 👤 ${escapeHtml(name)}\n│ 🕐 ${time}\n│ 📝 ${escapeHtml(content)}\n└───────────┘\n`;
        }
      }

      const keyboard: KbRow[] = [];
      if (messages.length > 0) {
        // 每个用户取其最新一条未读做按钮名（find 拿不到时跳过，不用非空断言）
        const seen = new Set<number>();
        for (const msg of messages) {
          if (seen.has(msg.user_id)) continue;
          seen.add(msg.user_id);
          if (keyboard.length >= 5) break;
          keyboard.push([{ text: `👤 ${shortName(msg, msg.user_id)}`, callback_data: `pm_user_${msg.user_id}` }]);
        }
        if (seen.size > keyboard.length) {
          keyboard.push([{ text: `... 还有 ${seen.size - keyboard.length} 位用户`, callback_data: 'user_list' }]);
        }
      }
      keyboard.push([{ text: '🔵 全部标为已读', callback_data: 'mark_all_read' }]);
      keyboard.push([{ text: '◀ 返回', callback_data: 'pending_messages' }, { text: '🏠 主页', callback_data: 'admin_back' }]);
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

      let text = `<b>╔══ 用户管理 ══╗</b>  ${page + 1}/${totalPages}\n\n`;
      if (pageUsers.length === 0) {
        text += `<i>暂无用户</i>`;
      } else {
        for (let i = 0; i < pageUsers.length; i++) {
          const user = pageUsers[i];
          const lastActive = user.last_message_at ? fmtDate(user.last_message_at) : '无';
          text += `┌─ ${start + i + 1}. 👤 <b>${escapeHtml(displayName(user, user.user_id))}</b>\n│ 🆔 <code>${user.user_id}</code>\n│ 🕐 ${lastActive}\n└───────────┘\n`;
        }
      }

      const keyboard: KbRow[] = [];
      for (const user of pageUsers) {
        keyboard.push([{ text: `👤 ${shortName(user, user.user_id, 12)}`, callback_data: `pm_user_${user.user_id}` }]);
      }
      const nav = navRow('pm_user_list_', page, hasMore);
      if (nav) keyboard.push(nav);
      keyboard.push([{ text: '🚫 封禁用户', callback_data: 'ban_list' }]);
      keyboard.push([{ text: '🏠 主页', callback_data: 'admin_back' }]);
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
        await editOrSend(chatId, `❌ 未找到用户<code>${targetUserId}</code>`, undefined, messageId);
        return;
      }

      const name = displayName(user, targetUserId);
      const createdDate = fmtDate(user.created_at);
      const lastActive = user.last_message_at ? fmtDate(user.last_message_at) : '无';

      const tags = user.tags || '';
      const notes = user.notes || '';

      const text = `<b>╔══ 用户详情 ══╗</b>\n\n` +
        `┌─ 基本信息 ─┐\n` +
        `│ 👤 ${escapeHtml(name)}\n` +
        `│ 🆔 <code>${user.user_id}</code>\n` +
        (user.username ? `│ 📎 @${user.username}\n` : '') +
        `└───────────┘\n\n` +
        `┌─ 活动数据 ─┐\n` +
        `│ 📅 注册: ${createdDate}\n` +
        `│ 🕐 活跃: ${lastActive}\n` +
        `│ ${isBlocked ? '🚫 已封禁' : '✅ 正常'}\n` +
        `└───────────┘\n\n` +
        `┌─ 标签备注 ─┐\n` +
        `│ 🏷️ ${tags ? escapeHtml(tags) : '<i>无</i>'}\n` +
        `│ 📝 ${notes ? escapeHtml(trunc(notes, 80)) : '<i>无</i>'}\n` +
        `└───────────┘`;

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

      keyboard.push([{ text: statusText, callback_data: statusAction }]);
      keyboard.push([{ text: '🏷️ 标签', callback_data: `set_tags_${targetUserId}` }, { text: '📝 备注', callback_data: `set_notes_${targetUserId}` }]);
      keyboard.push([{ text: '📜 历史', callback_data: `msg_history_${targetUserId}` }, { text: '✅ 已读', callback_data: `mark_read_${targetUserId}` }]);
      keyboard.push([{ text: '◀ 返回列表', callback_data: 'user_list' }, { text: '🏠 主页', callback_data: 'admin_back' }]);

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

      const text = `<b>╔══ 数据统计 ══╗</b>\n\n` +
        `┌─ 用户数据 ─┐\n` +
        `│ 👥 总用户  ${totalUsers}\n` +
        `│ 🟢 今日活跃  ${messageStats.todayActiveUsers.size}\n` +
        `│ 📊 人均消息  ${avgPerUser}\n` +
        `│ 🚫 封禁  ${blockedUsers}\n` +
        `└───────────┘\n\n` +
        `┌─ 消息数据 ─┐\n` +
        `│ 📨 今日  ${messageStats.todayMessages}\n` +
        `│ 💬 总量  ${messageStats.totalMessages}\n` +
        `└───────────┘\n\n` +
        `<i>⚠️ 统计数据为内存缓存，重启后重置</i>`;

      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: '✅ 标记全部已读', callback_data: 'mark_all_read' }],
          [{ text: '🏠 主页', callback_data: 'admin_back' }]
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
        `<b>╔══ 群发消息 ══╗</b>\n\n` +
        `┌─ 发送信息 ─┐\n│ 👥 目标: ${userCount} 人\n│ 📝 支持: HTML / 纯文本\n└───────────┘\n\n<i>请直接输入广播内容</i>`, {
        reply_markup: mk([{ text: '❌ 取消', callback_data: 'admin_back' }])
      }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 启动失败', undefined, messageId);
    }
  }

  async function showPmBanList(chatId: number, messageId?: number): Promise<void> {
    try {
      let users: Array<{ user_id: number; username: string | null; first_name: string | null }> = [];
      try { users = await db.getBlockedPmUsers(); } catch (e) { log.error('Query error in ban list', { error: e }); }

      let text = `<b>╔══ 封禁列表 ══╗</b>  ${users.length} 人\n\n`;
      if (users.length === 0) {
        text += `<i>暂无封禁用户</i>`;
      } else {
        for (let i = 0; i < users.length; i++) {
          const user = users[i];
          text += `┌─ ${i + 1}. 🚫 <b>${escapeHtml(displayName(user, user.user_id))}</b>\n│ 🆔 <code>${user.user_id}</code>\n└───────────┘\n`;
        }
        if (users.length > 10) text += `<i>…仅显示前 10 人</i>\n`;
      }

      const keyboard: KbRow[] = [];
      for (const user of users.slice(0, 5)) {
        keyboard.push([{ text: `✅ 解封 ${shortName(user, user.user_id, 12)}`, callback_data: `unban_pm_${user.user_id}` }]);
      }
      if (users.length > 5) {
        keyboard.push([{ text: `... 还有 ${users.length - 5} 人可解封`, callback_data: 'noop' }]);
      }
      keyboard.push([{ text: '◀ 用户管理', callback_data: 'user_list' }, { text: '🏠 主页', callback_data: 'admin_back' }]);
      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showPmSettings(chatId: number, messageId?: number): Promise<void> {
    try {
      let welcomeMsg = '';
      try { welcomeMsg = await db.getSetting('welcome_message') || ''; } catch { }

      const text = `<b>╔══ 基础设置 ══╗</b>\n\n` +
        `┌─ 当前配置 ─┐\n` +
        `│ 💬 欢迎消息:\n` +
        `${welcomeMsg ? `│ ${escapeHtml(welcomeMsg.substring(0, 50))}${welcomeMsg.length > 50 ? '...' : ''}\n` : '│ ⚠️ <i>未设置（使用默认值）</i>\n'}` +
        `└───────────┘\n\n` +
        `┌─ 系统状态 ─┐\n│ 🌐 语言: 中文 (zh_CN)\n│ ✅ 状态: 运行中\n└───────────┘`;

      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: '✏️ 修改欢迎语', callback_data: 'pm_set_welcome' }],
          [{ text: '🔄 重置默认', callback_data: 'pm_reset_welcome' }],
          [{ text: '🏠 主页', callback_data: 'admin_back' }]
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

      const text = `<b>╔══ 消息过滤 ══╗</b>\n\n` +
        `┌─ 关键词过滤 ─┐\n` +
        `│ 🔒 规则 ${keywords.length} 条 (启用 ${kwActive})\n` +
        `│ 按关键词/正则匹配拦截消息\n` +
        `└───────────┘`;

      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: '🔒 关键词规则', callback_data: 'blacklist' }],
          [{ text: '🏠 主页', callback_data: 'admin_back' }]
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

      const text = `<b>╔══ 回复管理 ══╗</b>\n\n` +
        `┌─ 自动回复 ─┐\n` +
        `│ 🤖 规则 ${autoReplies.length} 条 (启用 ${autoActive})\n` +
        `│ 用户消息匹配关键词时自动回复\n` +
        `└───────────┘\n\n` +
        `┌─ 快捷回复 ─┐\n` +
        `│ ⚡ 模板 ${quickReplies.length} 条\n` +
        `│ 管理员一键发送预设回复\n` +
        `└───────────┘`;

      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: '🤖 自动回复', callback_data: 'auto_replies' }, { text: '⚡ 快捷回复', callback_data: 'quick_replies' }],
          [{ text: '🏠 主页', callback_data: 'admin_back' }]
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

      let text = `<b>╔══ 自动回复 ══╗</b>  ${page + 1}/${totalPages}\n\n`;
      if (pageReplies.length === 0) {
        text += `<i>暂无自动回复规则</i>`;
      } else {
        for (let i = 0; i < pageReplies.length; i++) {
          const reply = pageReplies[i];
          const matchTypeText = reply.match_type === 'exact' ? '精确' : reply.match_type === 'regex' ? '正则' : '包含';
          text += `┌─ ${start + i + 1}. ${reply.is_enabled ? '✅' : '⏸️'} <b>${escapeHtml(reply.keyword)}</b>\n│ 📋 ${matchTypeText}\n│ 💬 ${escapeHtml(trunc(reply.reply_text, 25))}\n└───────────┘\n`;
        }
      }

      const keyboard: KbRow[] = [];
      for (const reply of pageReplies) {
        const statusIcon = reply.is_enabled ? '⏸️' : '✅';
        keyboard.push([{ text: `${statusIcon} ${trunc(reply.keyword, 10)}`, callback_data: `auto_reply_${reply.id}` }]);
      }
      keyboard.push([{ text: '➕ 添加规则', callback_data: 'add_auto_reply' }]);
      const nav = navRow('auto_replies_', page, hasMore);
      if (nav) keyboard.push(nav);
      keyboard.push([{ text: '◀ 回复管理', callback_data: 'reply_mgmt' }, { text: '🏠 主页', callback_data: 'admin_back' }]);
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

      let text = `<b>╔══ 黑名单关键词 ══╗</b>  ${page + 1}/${totalPages}\n\n`;
      if (pageKeywords.length === 0) {
        text += `<i>暂无黑名单关键词</i>`;
      } else {
        for (let i = 0; i < pageKeywords.length; i++) {
          const kw = pageKeywords[i];
          text += `┌─ ${start + i + 1}. ${kw.is_enabled ? '✅' : '⏸️'} <b>${escapeHtml(kw.keyword)}</b>\n│ 📋 ${kw.is_regex ? '正则' : '普通'}${kw.reason ? `\n│ 📝 ${escapeHtml(kw.reason)}` : ''}\n└───────────┘\n`;
        }
      }

      const keyboard: KbRow[] = [];
      for (const kw of pageKeywords) {
        const statusIcon = kw.is_enabled ? '⏸️' : '✅';
        keyboard.push([{ text: `${statusIcon} ${trunc(kw.keyword, 8)}`, callback_data: `blacklist_${kw.id}` }]);
      }
      keyboard.push([{ text: '➕ 添加关键词', callback_data: 'add_blacklist' }]);
      const nav = navRow('blacklist_page_', page, hasMore);
      if (nav) keyboard.push(nav);
      keyboard.push([{ text: '◀ 消息过滤', callback_data: 'msg_filter' }, { text: '🏠 主页', callback_data: 'admin_back' }]);
      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showWorkHoursSettings(chatId: number, messageId?: number): Promise<void> {
    try {
      const setting = await db.getWorkHoursSetting();
      let text = `<b>╔══ 工作时间 ══╗</b>\n\n`;
      if (!setting || !setting.enabled) {
        text += `┌─ 当前配置 ─┐\n│ ⏸️ 已关闭\n└───────────┘\n\n💡 点击下方按钮开启并设置工作时间`;
      } else {
        text += `┌─ 当前配置 ─┐\n│ ✅ 已开启\n│ 🕐 ${String(setting.startHour).padStart(2, '0')}:00 - ${String(setting.endHour).padStart(2, '0')}:00\n└───────────┘\n\n💬 非工作时间回复:\n${escapeHtml(setting.offHoursMessage || '默认提示')}`;
      }
      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: setting?.enabled ? '🔴 关闭' : '✅ 开启', callback_data: 'toggle_work_hours' }, { text: '🕐 设置时间', callback_data: 'set_work_hours_time' }],
          [{ text: '📝 设置回复语', callback_data: 'set_off_hours_msg' }],
          [{ text: '🏠 主页', callback_data: 'admin_back' }]
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

      let text = `<b>╔══ 对话历史 ══╗</b>  ${escapeHtml(name)}\n\n`;
      if (messages.length === 0) {
        text += `<i>暂无消息记录</i>`;
      } else {
        for (const msg of messages) {
          const dir = msg.direction === 'in' ? '👤' : '🤖';
          const readIcon = msg.direction === 'in' && !msg.is_read ? ' 🔵' : '';
          const ratingIcon = msg.rating === 1 ? ' 👍' : msg.rating === -1 ? ' 👎' : '';
          text += `${dir} ${fmtTime(msg.created_at)}${readIcon}${ratingIcon}\n${escapeHtml(trunc(msg.content, 40))}\n──────\n`;
        }
      }

      const keyboard: KbRow[] = [];
      const nav = navRow(`msg_history_${targetUserId}_`, page, messages.length === pageSize);
      if (nav) keyboard.push(nav);
      keyboard.push([{ text: '◀ 返回用户', callback_data: `pm_user_${targetUserId}` }, { text: '🏠 主页', callback_data: 'admin_back' }]);

      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      log.error('Error showing message history', { error: e });
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showQuickReplies(chatId: number, messageId?: number): Promise<void> {
    try {
      const replies = await db.getQuickReplies();
      let text = `<b>╔══ 快捷回复 ══╗</b>  ${replies.length} 条\n\n`;
      if (replies.length === 0) {
        text += `<i>暂无快捷回复</i>`;
      } else {
        for (let i = 0; i < Math.min(replies.length, 10); i++) {
          const r = replies[i];
          text += `┌─ ${i + 1}. ⚡ ${escapeHtml(r.title)}\n│ ${escapeHtml(trunc(r.content, 30))}\n└───────────┘\n`;
        }
      }

      const keyboard: KbRow[] = [];
      for (const r of replies.slice(0, 5)) {
        keyboard.push([
          { text: `⚡ ${trunc(r.title, 12)}`, callback_data: `use_quick_${r.id}` },
          { text: '🗑️', callback_data: `delete_quick_${r.id}` }
        ]);
      }
      keyboard.push([{ text: '➕ 添加', callback_data: 'add_quick_reply' }]);
      keyboard.push([{ text: '◀ 回复管理', callback_data: 'reply_mgmt' }, { text: '🏠 主页', callback_data: 'admin_back' }]);

      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showScheduledMessages(chatId: number, messageId?: number): Promise<void> {
    try {
      const messages = await db.getAllScheduledMessages();
      let text = `<b>╔══ 定时消息 ══╗</b>  ${messages.length} 条\n\n`;
      if (messages.length === 0) {
        text += `<i>暂无定时消息</i>`;
      } else {
        for (const msg of messages.slice(0, 10)) {
          const time = fmtTime(msg.scheduled_at);
          const status = msg.is_sent ? '✅ 已发送' : '⏳ 待发送';
          const target = msg.user_id ? `用户${msg.user_id}` : '所有人';
          text += `┌─ ${status}\n│ 🎯 ${target}\n│ 🕐 ${time}\n│ 📝 ${escapeHtml(trunc(msg.content, 25))}\n└───────────┘\n`;
        }
        if (messages.length > 10) text += `<i>…仅显示前 10 条</i>\n`;
      }

      const keyboard: KbRow[] = [];
      keyboard.push([{ text: '📢 群发所有人', callback_data: 'new_scheduled_all' }]);
      keyboard.push([{ text: '👤 发给指定用户', callback_data: 'user_list' }]);
      for (const msg of messages.filter(m => !m.is_sent).slice(0, 3)) {
        const target = msg.user_id ? `用户${msg.user_id}` : '所有人';
        keyboard.push([{ text: `🗑️ 删除: ${target}`, callback_data: `del_scheduled_${msg.id}` }]);
      }
      keyboard.push([{ text: '🏠 主页', callback_data: 'admin_back' }]);
      await editOrSend(chatId, text, { reply_markup: mk(...keyboard) }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showAuditLog(chatId: number, messageId?: number): Promise<void> {
    try {
      const logs = await db.getAuditLogs(20);
      let text = `<b>╔══ 审计日志 ══╗</b>\n\n`;
      if (logs.length === 0) {
        text += `<i>暂无操作记录</i>`;
      } else {
        for (const entry of logs.slice(0, 15)) {
          const time = fmtTime(entry.created_at);
          text += `┌─ 🕐 ${time}\n│ 📋 ${escapeHtml(entry.action)}${entry.target_id ? ` → ${escapeHtml(entry.target_id)}` : ''}\n└───────────┘\n`;
        }
      }

      await editOrSend(chatId, text, {
        reply_markup: mk([{ text: '🏠 主页', callback_data: 'admin_back' }])
      }, messageId);
    } catch (e) {
      await editOrSend(chatId, '❌ 加载失败', undefined, messageId);
    }
  }

  async function showBackupPanel(chatId: number, messageId?: number): Promise<void> {
    try {
      const stats = await db.getPmStats();
      const text = `<b>╔══ 数据备份 ══╗</b>\n\n` +
        `┌─ 数据概览 ─┐\n` +
        `│ 👥 用户: ${stats.totalUsers}\n` +
        `│ 💬 消息: ${stats.totalMessages}\n` +
        `│ 🚫 封禁: ${stats.blockedUsers}\n` +
        `└───────────┘\n\n` +
        `<i>点击下方按钮导出数据</i>`;

      await editOrSend(chatId, text, {
        reply_markup: mk(
          [{ text: '📥 导出JSON', callback_data: 'export_json' }],
          [{ text: '🏠 主页', callback_data: 'admin_back' }]
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
      const helpText = '<b>╔══ 使用帮助 ══╗</b>\n\n' +
        '┌─ 当前版本 ─┐\n' +
        `📦 v${BOT_VERSION}\n` +
        '└───────────┘\n\n' +
        '┌─ 功能说明 ─┐\n' +
        '📌 👥 用户管理 - 查看/管理所有用户\n' +
        '📌 📨 待处理 - 查看待处理消息\n' +
        '📌 📊 数据统计 - 查看消息/用户统计\n' +
        '📌 📢 群发消息 - 向所有用户发送通知\n' +
        '📌 ⚙️ 基础设置 - 欢迎语等系统配置\n' +
        '📌 💬 自动回复 - 关键词匹配自动回复\n' +
        '📌 🔒 黑名单 - 过滤垃圾/广告消息\n' +
        '📌 🕐 工作时间 - 非工作时间自动回复\n' +
        '📌 🚫 封禁列表 - 封禁/解封用户操作\n' +
        '📌 ⚡ 快捷回复 - 预设常用回复模板\n' +
        '📌 ⏰ 定时消息 - 定时发送消息\n' +
        '📌 📝 审计日志 - 操作记录追踪\n' +
        '📌 💾 数据备份 - 导出系统数据\n' +
        '└───────────┘\n\n' +
        '┌─ 使用提示 ─┐\n' +
        '💡 所有操作在一个窗口内完成\n' +
        '💡 点击按钮即可切换不同功能\n' +
        '💡 管理员可直接回复用户消息\n' +
        '💡 用户详情支持标签/备注管理\n' +
        '└───────────┘';
      await editOrSend(ctx.chatId, helpText, { reply_markup: mk([{ text: '🏠 主页', callback_data: 'admin_back' }]) }, ctx.msgId);
    }],
    ['admin_back', async (ctx) => { await showAdminPanel(ctx.chatId, ctx.msgId); }],
    ['back_to_admin', async (ctx) => { await showAdminPanel(ctx.chatId, ctx.msgId); }],
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
      await editOrSend(ctx.chatId, `<b>📥 数据导出</b>\n\n<code>${escapeHtml(truncated)}</code>`, {
        reply_markup: mk([{ text: '🏠 主页', callback_data: 'admin_back' }])
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
    { prefix: 'pm_user_list_', handler: async (ctx) => { await showPmUserList(ctx.chatId, cbNum(ctx.data, 3), ctx.msgId); } },
    { prefix: 'ignore_msg_', handler: async (ctx) => {
      deletePendingMessage(cbNum(ctx.data, 2));
      await editOrSend(ctx.chatId, '✅ 已忽略该消息', { reply_markup: mk([{ text: '◀ 返回待处理', callback_data: 'pending_messages' }]) }, ctx.msgId);
    }},
    { prefix: 'auto_replies_', handler: async (ctx) => { await showAutoReplies(ctx.chatId, cbNum(ctx.data, 2), ctx.msgId); } },
    { prefix: 'blacklist_page_', handler: async (ctx) => { await showBlacklistKeywords(ctx.chatId, cbNum(ctx.data, 2), ctx.msgId); } },
    { prefix: 'auto_reply_', handler: async (ctx) => {
      const replyId = cbNum(ctx.data, 2);
      if (replyId <= 0) return;
      const reply = await guard('auto_reply_detail')(db.getAutoReply(replyId));
      if (reply === null) { await showFail(ctx.chatId, ctx.msgId, '加载'); return; }
      if (!reply) { await editOrSend(ctx.chatId, '❌ 规则不存在', undefined, ctx.msgId); return; }
      await editOrSend(ctx.chatId,
        '<b>╔══ 自动回复规则 ══╗</b>\n\n🔑 <b>关键词:</b> ' + escapeHtml(reply.keyword) + '\n📝 <b>回复内容:</b>\n' + escapeHtml(reply.reply_text) + '\n📋 <b>匹配类型:</b> ' + reply.match_type + '\n状态: ' + (reply.is_enabled ? '✅ 已启用' : '⏸️ 已禁用') + '\n\n请选择操作：', {
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
        '<b>╔══ 黑名单关键词 ══╗</b>\n\n🔑 <b>关键词:</b> ' + escapeHtml(kw.keyword) + '\n📋 <b>类型:</b> ' + (kw.is_regex ? '正则' : '普通') + '\n' + (kw.reason ? '📝 <b>原因:</b> ' + escapeHtml(kw.reason) + '\n' : '') + '状态: ' + (kw.is_enabled ? '✅ 已启用' : '⏸️ 已禁用') + '\n\n请选择操作：', {
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
  async function handlePoll(timeoutSeconds = 10): Promise<{ fetched: number; skipped?: boolean }> {
    await ensureDbInitialized(env);

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

  return { handleUpdate, handlePoll };
}
