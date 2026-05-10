/// <reference types="@cloudflare/workers-types" />
import { MemoryCache } from './cache';
import { createLogger } from './logger';

const log = createLogger('db');

export class OptimizedDatabase {
  private db: D1Database;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;
  private cache: MemoryCache;
  private regexCache = new Map<string, RegExp>();
  private static readonly MAX_REGEX_CACHE = 200;

  constructor(d1: D1Database, cache: MemoryCache) {
    this.db = d1;
    this.cache = cache;
  }

  private getOrCompileRegex(key: string, pattern: string, flags: string = 'i'): RegExp | null {
    let regex = this.regexCache.get(key);
    if (regex) return regex;
    try {
      regex = new RegExp(pattern, flags);
      if (this.regexCache.size >= OptimizedDatabase.MAX_REGEX_CACHE) {
        const firstKey = this.regexCache.keys().next().value;
        if (firstKey !== undefined) this.regexCache.delete(firstKey);
      }
      this.regexCache.set(key, regex);
      return regex;
    } catch {
      return null;
    }
  }

  private async safeExecute<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const errorMsg = String(e);
      if (errorMsg.includes('no such table') ||
          errorMsg.includes('SQLITE_ERROR') ||
          errorMsg.includes('D1_EXEC_ERROR')) {
        await this.ensureInit();
        return await fn();
      }
      log.error('Operation failed', { operation, error: e });
      throw e;
    }
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.init();
    try {
      await this.initPromise;
      this.initialized = true;
    } finally {
      this.initPromise = null;
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const batchSql = `
      CREATE TABLE IF NOT EXISTS user_sessions (user_id INTEGER PRIMARY KEY, action TEXT, data TEXT, created_at INTEGER, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pm_users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, username TEXT, first_name TEXT, last_name TEXT, created_at INTEGER, last_message_at INTEGER, is_blocked BOOLEAN DEFAULT 0, tags TEXT DEFAULT '', notes TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS pm_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, direction TEXT NOT NULL, message_type TEXT DEFAULT 'text', content TEXT, file_id TEXT, user_msg_id INTEGER, admin_msg_id INTEGER, is_read BOOLEAN DEFAULT 0, rating INTEGER DEFAULT 0, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS pm_message_mappings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_msg_id INTEGER, admin_msg_id INTEGER NOT NULL UNIQUE, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS pm_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS pm_auto_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT NOT NULL, reply_text TEXT NOT NULL, match_type TEXT DEFAULT 'contains', is_enabled BOOLEAN DEFAULT 1, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS pm_blacklist_keywords (id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT NOT NULL, is_regex BOOLEAN DEFAULT 0, is_enabled BOOLEAN DEFAULT 1, created_at INTEGER, reason TEXT);
      CREATE TABLE IF NOT EXISTS pm_quick_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, category TEXT DEFAULT 'general', is_enabled BOOLEAN DEFAULT 1, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS pm_scheduled_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, content TEXT, message_type TEXT DEFAULT 'text', file_id TEXT, scheduled_at INTEGER NOT NULL, is_sent BOOLEAN DEFAULT 0, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS pm_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, details TEXT, created_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_pm_messages_user_id ON pm_messages(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pm_messages_direction_read ON pm_messages(direction, is_read);
      CREATE INDEX IF NOT EXISTS idx_pm_message_mappings_admin ON pm_message_mappings(admin_msg_id);
      CREATE INDEX IF NOT EXISTS idx_pm_users_blocked ON pm_users(is_blocked);
      CREATE INDEX IF NOT EXISTS idx_pm_scheduled_pending ON pm_scheduled_messages(is_sent, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_pm_audit_log_created ON pm_audit_log(created_at);
      INSERT OR IGNORE INTO pm_settings (key, value) VALUES ('welcome_message', '👋 欢迎使用！请发送消息，我会转发给管理员。'), ('language', 'zh_CN');
    `;

    await this.db.exec(batchSql);

    const alterStatements = [
      'ALTER TABLE pm_users ADD COLUMN tags TEXT DEFAULT \'\'',
      'ALTER TABLE pm_users ADD COLUMN notes TEXT DEFAULT \'\'',
      'ALTER TABLE pm_messages ADD COLUMN file_id TEXT',
      'ALTER TABLE pm_messages ADD COLUMN is_read BOOLEAN DEFAULT 0',
      'ALTER TABLE pm_messages ADD COLUMN rating INTEGER DEFAULT 0',
    ];
    for (const sql of alterStatements) {
      try { await this.db.exec(sql); } catch {}
    }

    this.initialized = true;
  }

  // ============ Settings with Cache ============
  async getSetting(key: string): Promise<string | null> {
    const cacheKey = `setting:${key}`;
    const cached = this.cache.get<string>(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const result = await this.safeExecute('getSetting', async () => {
        const r = await this.db.prepare('SELECT value FROM pm_settings WHERE key = ?').bind(key).first<{ value: string }>();
        return r?.value || null;
      });
      this.cache.set(cacheKey, result, 300); // 5分钟缓存
      return result;
    } catch (e) {
      log.error('getSetting error', { key, error: e });
      return null;
    }
  }

  async updateSetting(key: string, value: string): Promise<void> {
    await this.safeExecute('updateSetting', async () => {
      const now = Math.floor(Date.now() / 1000);
      await this.db.prepare(`
        INSERT INTO pm_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `).bind(key, value, now).run();
    });
    this.cache.delete(`setting:${key}`);
  }

  // ============ User Sessions ============
  async getUserSession(userId: number): Promise<{ action: string; data: string } | null> {
    const cacheKey = `session:${userId}`;
    const cached = this.cache.get<{ action: string; data: string } | null>(cacheKey);
    if (cached !== undefined) return cached;
    if (this.cache.isNegative(cacheKey)) return null;

    const result = await this.safeExecute('getUserSession', async () => {
      const now = Math.floor(Date.now() / 1000);
      return await this.db.prepare('SELECT action, data FROM user_sessions WHERE user_id = ? AND expires_at > ?')
        .bind(userId, now).first<{ action: string; data: string }>();
    });
    if (result) this.cache.set(cacheKey, result, 30);
    else this.cache.setNegative(cacheKey, 10);
    return result;
  }

  async setUserSession(userId: number, action: string, data: string, expiresInMinutes = 30): Promise<void> {
    await this.safeExecute('setUserSession', async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + expiresInMinutes * 60;
      await this.db.prepare(`
        INSERT INTO user_sessions (user_id, action, data, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          action = excluded.action,
          data = excluded.data,
          expires_at = excluded.expires_at
      `).bind(userId, action, data, now, expiresAt).run();
    });
    this.cache.set(`session:${userId}`, { action, data }, 30);
  }

  async clearUserSession(userId: number): Promise<void> {
    await this.safeExecute('clearUserSession', async () => {
      await this.db.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId).run();
    });
    this.cache.delete(`session:${userId}`);
  }

  // ============ PM Users ============
  async saveUser(userId: number, username?: string, firstName?: string, lastName?: string): Promise<void> {
    await this.safeExecute('saveUser', async () => {
      const now = Math.floor(Date.now() / 1000);
      await this.db.prepare(`
        INSERT INTO pm_users (user_id, username, first_name, last_name, created_at, last_message_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          last_message_at = excluded.last_message_at
      `).bind(userId, username || null, firstName || null, lastName || null, now, now).run();
    });
    this.cache.delete(`user:${userId}`);
    this.cache.delete(`blocked:${userId}`);
    this.cache.delete('users:list:100');
    this.cache.delete('users:list:1000');
  }

  async isUserBlocked(userId: number): Promise<boolean> {
    const cacheKey = `blocked:${userId}`;
    const cached = this.cache.get<boolean>(cacheKey);
    if (cached !== undefined) return cached;

    const result = await this.safeExecute('isUserBlocked', async () => {
      const r = await this.db.prepare('SELECT is_blocked FROM pm_users WHERE user_id = ?')
        .bind(userId).first<{ is_blocked: number }>();
      return r?.is_blocked === 1;
    });
    this.cache.set(cacheKey, result, 60);
    return result;
  }

  async blockUser(userId: number): Promise<void> {
    await this.safeExecute('blockUser', async () => {
      await this.db.prepare('UPDATE pm_users SET is_blocked = 1 WHERE user_id = ?').bind(userId).run();
    });
    this.cache.set(`blocked:${userId}`, true, 60);
    this.cache.delete('blocked_users');
    this.cache.delete('stats:pm');
  }

  async unblockPmUser(userId: number): Promise<void> {
    await this.safeExecute('unblockPmUser', async () => {
      await this.db.prepare('UPDATE pm_users SET is_blocked = 0 WHERE user_id = ?').bind(userId).run();
    });
    this.cache.set(`blocked:${userId}`, false, 60);
    this.cache.delete('blocked_users');
    this.cache.delete('stats:pm');
  }

  async getPmUser(userId: number): Promise<{
    user_id: number;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    created_at: number;
    last_message_at: number | null;
    is_blocked: boolean;
    tags: string;
    notes: string;
  } | null> {
    const cacheKey = `user:${userId}`;
    const cached = this.cache.get<{
      user_id: number;
      username: string | null;
      first_name: string | null;
      last_name: string | null;
      created_at: number;
      last_message_at: number | null;
      is_blocked: boolean;
      tags: string;
      notes: string;
    } | null>(cacheKey);
    if (cached !== undefined) return cached;

    const result = await this.safeExecute('getPmUser', async () => {
      return await this.db.prepare('SELECT * FROM pm_users WHERE user_id = ?').bind(userId).first<{
        user_id: number;
        username: string | null;
        first_name: string | null;
        last_name: string | null;
        created_at: number;
        last_message_at: number | null;
        is_blocked: boolean;
        tags: string;
        notes: string;
      }>();
    });
    if (result) this.cache.set(cacheKey, result, 30);
    else this.cache.setNegative(cacheKey, 15);
    return result;
  }

  async getPmUsers(limit: number = 100): Promise<Array<{
    user_id: number;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    created_at: number;
    last_message_at: number | null;
    is_blocked: boolean;
  }>> {
    const cacheKey = `users:list:${limit}`;
    const cached = this.cache.get<Array<{
      user_id: number;
      username: string | null;
      first_name: string | null;
      last_name: string | null;
      created_at: number;
      last_message_at: number | null;
      is_blocked: boolean;
    }>>(cacheKey);
    if (cached !== undefined) return cached;

    const result = await this.safeExecute('getPmUsers', async () => {
      const result = await this.db.prepare('SELECT * FROM pm_users ORDER BY last_message_at DESC LIMIT ?')
        .bind(limit).all();
      return result.results as Array<{
        user_id: number;
        username: string | null;
        first_name: string | null;
        last_name: string | null;
        created_at: number;
        last_message_at: number | null;
        is_blocked: boolean;
      }> || [];
    });
    this.cache.set(cacheKey, result, 30);
    return result;
  }

  async getPmUserCount(): Promise<number> {
    const cached = this.cache.get<number>('stats:userCount');
    if (cached !== undefined) return cached;

    const result = await this.safeExecute('getPmUserCount', async () => {
      const r = await this.db.prepare('SELECT COUNT(*) as count FROM pm_users').first<{ count: number }>();
      return r?.count || 0;
    });
    this.cache.set('stats:userCount', result, 60);
    return result;
  }

  async getBlockedPmUsers(): Promise<Array<{ user_id: number; username: string | null; first_name: string | null }>> {
    const cached = this.cache.get<Array<{ user_id: number; username: string | null; first_name: string | null }>>('blocked_users');
    if (cached !== undefined) return cached;

    const result = await this.safeExecute('getBlockedPmUsers', async () => {
      const result = await this.db.prepare('SELECT user_id, username, first_name FROM pm_users WHERE is_blocked = 1')
        .all();
      return result.results as Array<{ user_id: number; username: string | null; first_name: string | null }> || [];
    });
    this.cache.set('blocked_users', result, 60);
    return result;
  }

  // ============ PM Message Mappings ============
  async getPmMessageMapping(adminMsgId: number): Promise<{ user_id: number } | null> {
    const cacheKey = `msg_mapping:${adminMsgId}`;
    const cached = this.cache.get<{ user_id: number }>(cacheKey);
    if (cached !== undefined) return cached;

    const result = await this.safeExecute('getPmMessageMapping', async () => {
      return await this.db.prepare('SELECT user_id FROM pm_message_mappings WHERE admin_msg_id = ?')
        .bind(adminMsgId).first<{ user_id: number }>();
    });
    if (result) this.cache.set(cacheKey, result, 300);
    return result;
  }

  async savePmMessageMapping(userId: number, userMsgId: number, adminMsgId: number): Promise<void> {
    await this.safeExecute('savePmMessageMapping', async () => {
      const now = Math.floor(Date.now() / 1000);
      await this.db.prepare(`
        INSERT INTO pm_message_mappings (user_id, user_msg_id, admin_msg_id, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(userId, userMsgId, adminMsgId, now).run();
    });
  }

  // ============ Stats ============
  async getPmStats(): Promise<{ totalUsers: number; totalMessages: number; todayMessages: number; blockedUsers: number }> {
    const cached = this.cache.get<{ totalUsers: number; totalMessages: number; todayMessages: number; blockedUsers: number }>('stats:pm');
    if (cached !== undefined) return cached;

    const result = await this.safeExecute('getPmStats', async () => {
      const r = await this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM pm_users) as totalUsers,
          (SELECT COUNT(*) FROM pm_messages) as totalMessages,
          (SELECT COUNT(*) FROM pm_messages WHERE created_at > ?) as todayMessages,
          (SELECT COUNT(*) FROM pm_users WHERE is_blocked = 1) as blockedUsers
      `).bind(Math.floor(Date.now() / 1000) - 86400).first<{
        totalUsers: number;
        totalMessages: number;
        todayMessages: number;
        blockedUsers: number;
      }>();

      return {
        totalUsers: r?.totalUsers || 0,
        totalMessages: r?.totalMessages || 0,
        todayMessages: r?.todayMessages || 0,
        blockedUsers: r?.blockedUsers || 0,
      };
    });
    this.cache.set('stats:pm', result, 60);
    return result;
  }

  // ============ Auto Replies with Cache ============
  async getAutoReplies(): Promise<Array<{
    id: number;
    keyword: string;
    reply_text: string;
    match_type: string;
    is_enabled: number;
    created_at: number;
  }>> {
    const cached = this.cache.get<ReturnType<typeof this.getAutoReplies>>('auto_replies');
    if (cached !== undefined) return cached;

    const result = await this.safeExecute('getAutoReplies', async () => {
      const r = await this.db.prepare('SELECT * FROM pm_auto_replies ORDER BY created_at DESC').all();
      return r.results as Array<{
        id: number;
        keyword: string;
        reply_text: string;
        match_type: string;
        is_enabled: number;
        created_at: number;
      }> || [];
    });
    this.cache.set('auto_replies', result, 120);
    return result;
  }

  async addAutoReply(keyword: string, replyText: string, matchType: string): Promise<number> {
    const result = await this.safeExecute('addAutoReply', async () => {
      const now = Math.floor(Date.now() / 1000);
      const r = await this.db.prepare(`
        INSERT INTO pm_auto_replies (keyword, reply_text, match_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(keyword, replyText, matchType, now, now).run();
      return r.meta?.last_row_id || 0;
    });
    this.cache.delete('auto_replies');
    return result;
  }

  async toggleAutoReply(id: number, isEnabled: boolean): Promise<void> {
    await this.safeExecute('toggleAutoReply', async () => {
      await this.db.prepare('UPDATE pm_auto_replies SET is_enabled = ? WHERE id = ?')
        .bind(isEnabled ? 1 : 0, id).run();
    });
    this.cache.delete('auto_replies');
  }

  async deleteAutoReply(id: number): Promise<void> {
    await this.safeExecute('deleteAutoReply', async () => {
      await this.db.prepare('DELETE FROM pm_auto_replies WHERE id = ?').bind(id).run();
    });
    this.cache.delete('auto_replies');
  }

  async checkAutoReply(message: string): Promise<string | null> {
    try {
      const replies = await this.getAutoReplies();
      const lowerMsg = message.toLowerCase();

      for (const reply of replies) {
        if (!reply.is_enabled) continue;

        if (reply.match_type === 'exact') {
          if (lowerMsg === reply.keyword.toLowerCase()) return reply.reply_text;
        } else if (reply.match_type === 'regex') {
          const regex = this.getOrCompileRegex(`ar:${reply.keyword}`, reply.keyword);
          if (!regex) continue;
          if (regex.test(message)) return reply.reply_text;
        } else {
          if (lowerMsg.includes(reply.keyword.toLowerCase())) return reply.reply_text;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // ============ Blacklist with Cache ============
  async getBlacklistKeywords(): Promise<Array<{
    id: number;
    keyword: string;
    is_regex: number;
    is_enabled: number;
    reason: string | null;
    created_at: number;
  }>> {
    const cached = this.cache.get<ReturnType<typeof this.getBlacklistKeywords>>('blacklist');
    if (cached !== undefined) return cached;

    const result = await this.safeExecute('getBlacklistKeywords', async () => {
      const r = await this.db.prepare('SELECT * FROM pm_blacklist_keywords ORDER BY created_at DESC').all();
      return r.results as Array<{
        id: number;
        keyword: string;
        is_regex: number;
        is_enabled: number;
        reason: string | null;
        created_at: number;
      }> || [];
    });
    this.cache.set('blacklist', result, 120);
    return result;
  }

  async getEnabledBlacklistKeywords(): Promise<Array<{
    id: number;
    keyword: string;
    is_regex: number;
    is_enabled: number;
    reason: string | null;
  }>> {
    const cached = this.cache.get<Array<{
      id: number;
      keyword: string;
      is_regex: number;
      is_enabled: number;
      reason: string | null;
    }>>('blacklist:enabled');
    if (cached !== undefined) return cached;

    const result = await this.safeExecute('getEnabledBlacklistKeywords', async () => {
      const r = await this.db.prepare('SELECT id, keyword, is_regex, is_enabled, reason FROM pm_blacklist_keywords WHERE is_enabled = 1 ORDER BY created_at DESC').all();
      return (r.results as Array<{
        id: number;
        keyword: string;
        is_regex: number;
        is_enabled: number;
        reason: string | null;
      }>) || [];
    });
    this.cache.set('blacklist:enabled', result, 120);
    return result;
  }

  async addBlacklistKeyword(keyword: string, isRegex: boolean, reason?: string): Promise<number> {
    const result = await this.safeExecute('addBlacklistKeyword', async () => {
      const now = Math.floor(Date.now() / 1000);
      const r = await this.db.prepare(`
        INSERT INTO pm_blacklist_keywords (keyword, is_regex, is_enabled, created_at, reason)
        VALUES (?, ?, 1, ?, ?)
      `).bind(keyword, isRegex ? 1 : 0, now, reason || null).run();
      return r.meta?.last_row_id || 0;
    });
    this.cache.delete('blacklist');
    this.cache.delete('blacklist:enabled');
    return result;
  }

  async deleteBlacklistKeyword(id: number): Promise<void> {
    await this.safeExecute('deleteBlacklistKeyword', async () => {
      await this.db.prepare('DELETE FROM pm_blacklist_keywords WHERE id = ?').bind(id).run();
    });
    this.cache.delete('blacklist');
    this.cache.delete('blacklist:enabled');
  }

  async toggleBlacklistKeyword(id: number, isEnabled: boolean): Promise<void> {
    await this.safeExecute('toggleBlacklistKeyword', async () => {
      await this.db.prepare('UPDATE pm_blacklist_keywords SET is_enabled = ? WHERE id = ?')
        .bind(isEnabled ? 1 : 0, id).run();
    });
    this.cache.delete('blacklist');
    this.cache.delete('blacklist:enabled');
  }

  async checkBlacklist(message: string): Promise<{ matched: boolean; keyword?: string; reason?: string }> {
    try {
      const keywords = await this.getEnabledBlacklistKeywords();
      const lowerMsg = message.toLowerCase();

      for (const kw of keywords) {
        let matched = false;

        if (kw.is_regex === 1) {
          const regex = this.getOrCompileRegex(`bl:${kw.keyword}`, kw.keyword);
          if (!regex) continue;
          matched = regex.test(message);
        } else {
          matched = lowerMsg.includes(kw.keyword.toLowerCase());
        }

        if (matched) {
          return { matched: true, keyword: kw.keyword, reason: kw.reason || undefined };
        }
      }

      return { matched: false };
    } catch {
      return { matched: false };
    }
  }

  // ============ Work Hours with Cache ============
  async getWorkHoursSetting(): Promise<{ enabled: boolean; startHour: number; endHour: number; offHoursMessage: string } | null> {
    const cached = this.cache.get<ReturnType<typeof this.getWorkHoursSetting>>('work_hours');
    if (cached !== undefined) return cached;

    try {
      const result = await this.safeExecute('getWorkHoursSetting', async () => {
        const setting = await this.db.prepare("SELECT value FROM pm_settings WHERE key = 'work_hours'").first<{ value: string }>();
        if (!setting?.value) return null;
        return JSON.parse(setting.value);
      });
      this.cache.set('work_hours', result, 300);
      return result;
    } catch (e) {
      log.error('getWorkHoursSetting error', { error: e });
      return null;
    }
  }

  async setWorkHoursSetting(enabled: boolean, startHour: number, endHour: number, offHoursMessage: string): Promise<void> {
    const value = JSON.stringify({ enabled, startHour, endHour, offHoursMessage });
    await this.updateSetting('work_hours', value);
    this.cache.delete('work_hours');
  }

  async isWorkHours(): Promise<boolean> {
    const setting = await this.getWorkHoursSetting();
    if (!setting || !setting.enabled) return true;

    const now = new Date();
    const currentHour = now.getHours();

    if (setting.startHour <= setting.endHour) {
      return currentHour >= setting.startHour && currentHour < setting.endHour;
    } else {
      return currentHour >= setting.startHour || currentHour < setting.endHour;
    }
  }

  async getOffHoursMessage(): Promise<string | null> {
    const setting = await this.getWorkHoursSetting();
    return setting?.offHoursMessage || null;
  }

  // ============ Message Persistence ============
  async saveMessage(userId: number, direction: 'in' | 'out', messageType: string, content: string, fileId?: string, userMsgId?: number, adminMsgId?: number): Promise<number> {
    const result = await this.safeExecute('saveMessage', async () => {
      const now = Math.floor(Date.now() / 1000);
      const r = await this.db.prepare(
        'INSERT INTO pm_messages (user_id, direction, message_type, content, file_id, user_msg_id, admin_msg_id, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(userId, direction, messageType, content, fileId || null, userMsgId || null, adminMsgId || null, direction === 'out' ? 1 : 0, now).run();
      return r.meta?.last_row_id || 0;
    });
    if (direction === 'in') {
      this.cache.delete('stats:unread');
    }
    this.cache.delete('stats:pm');
    return result;
  }

  async getMessageHistory(userId: number, limit: number = 50, offset: number = 0): Promise<Array<{
    id: number; direction: string; message_type: string; content: string; file_id: string | null;
    is_read: number; rating: number; created_at: number;
  }>> {
    const cacheKey = `msg_history:${userId}:${offset}:${limit}`;
    const cached = this.cache.get<ReturnType<typeof this.getMessageHistory>>(cacheKey);
    if (cached !== undefined) return cached;

    const result = await this.safeExecute('getMessageHistory', async () => {
      const r = await this.db.prepare(
        'SELECT id, direction, message_type, content, file_id, is_read, rating, created_at FROM pm_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).bind(userId, limit, offset).all();
      return (r.results as Array<{
        id: number; direction: string; message_type: string; content: string; file_id: string | null;
        is_read: number; rating: number; created_at: number;
      }>) || [];
    });
    this.cache.set(cacheKey, result, 30);
    return result;
  }

  async getUnreadMessageCount(): Promise<number> {
    const cached = this.cache.get<number>('stats:unread');
    if (cached !== undefined) return cached;

    const result = await this.safeExecute('getUnreadMessageCount', async () => {
      const r = await this.db.prepare('SELECT COUNT(*) as count FROM pm_messages WHERE direction = \'in\' AND is_read = 0').first<{ count: number }>();
      return r?.count || 0;
    });
    this.cache.set('stats:unread', result, 30);
    return result;
  }

  async markMessagesAsRead(userId: number): Promise<void> {
    await this.safeExecute('markMessagesAsRead', async () => {
      await this.db.prepare('UPDATE pm_messages SET is_read = 1 WHERE user_id = ? AND direction = \'in\' AND is_read = 0').bind(userId).run();
    });
    this.cache.delete('stats:unread');
  }

  async markAllMessagesAsRead(): Promise<void> {
    await this.safeExecute('markAllMessagesAsRead', async () => {
      await this.db.prepare('UPDATE pm_messages SET is_read = 1 WHERE direction = \'in\' AND is_read = 0').run();
    });
    this.cache.delete('stats:unread');
  }

  async getUnreadMessages(limit: number = 20): Promise<Array<{
    id: number; user_id: number; direction: string; content: string; created_at: number;
    first_name?: string; username?: string; is_read: number;
  }>> {
    return await this.safeExecute('getUnreadMessages', async () => {
      const r = await this.db.prepare(
        'SELECT m.id, m.user_id, m.direction, m.content, m.created_at, m.is_read, u.first_name, u.username ' +
        'FROM pm_messages m LEFT JOIN pm_users u ON m.user_id = u.user_id ' +
        'WHERE m.direction = \'in\' AND m.is_read = 0 ORDER BY m.created_at DESC LIMIT ?'
      ).bind(limit).all();
      return (r.results as Array<{
        id: number; user_id: number; direction: string; content: string; created_at: number;
        first_name?: string; username?: string; is_read: number;
      }>) || [];
    });
  }

  async rateMessage(messageId: number, rating: number): Promise<void> {
    await this.safeExecute('rateMessage', async () => {
      await this.db.prepare('UPDATE pm_messages SET rating = ? WHERE id = ?').bind(rating, messageId).run();
    });
  }

  async searchMessages(query: string, limit: number = 50): Promise<Array<{
    id: number; user_id: number; direction: string; content: string; created_at: number;
  }>> {
    return await this.safeExecute('searchMessages', async () => {
      const r = await this.db.prepare(
        'SELECT id, user_id, direction, content, created_at FROM pm_messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?'
      ).bind(`%${query}%`, limit).all();
      return (r.results as Array<{
        id: number; user_id: number; direction: string; content: string; created_at: number;
      }>) || [];
    });
  }

  // ============ User Tags & Notes ============
  async setUserTags(userId: number, tags: string): Promise<void> {
    await this.safeExecute('setUserTags', async () => {
      await this.db.prepare('UPDATE pm_users SET tags = ? WHERE user_id = ?').bind(tags, userId).run();
    });
    this.cache.delete(`user:${userId}`);
  }

  async setUserNotes(userId: number, notes: string): Promise<void> {
    await this.safeExecute('setUserNotes', async () => {
      await this.db.prepare('UPDATE pm_users SET notes = ? WHERE user_id = ?').bind(notes, userId).run();
    });
    this.cache.delete(`user:${userId}`);
  }

  async getUserTags(userId: number): Promise<string> {
    const user = await this.getPmUser(userId);
    return user?.tags || '';
  }

  async getUserNotes(userId: number): Promise<string> {
    const user = await this.getPmUser(userId);
    return user?.notes || '';
  }

  // ============ Quick Replies ============
  async getQuickReplies(): Promise<Array<{
    id: number; title: string; content: string; category: string; is_enabled: number; created_at: number;
  }>> {
    const cached = this.cache.get<ReturnType<typeof this.getQuickReplies>>('quick_replies');
    if (cached !== undefined) return cached;

    const result = await this.safeExecute('getQuickReplies', async () => {
      const r = await this.db.prepare('SELECT * FROM pm_quick_replies WHERE is_enabled = 1 ORDER BY category, created_at').all();
      return (r.results as Array<{
        id: number; title: string; content: string; category: string; is_enabled: number; created_at: number;
      }>) || [];
    });
    this.cache.set('quick_replies', result, 120);
    return result;
  }

  async addQuickReply(title: string, content: string, category: string = 'general'): Promise<number> {
    const result = await this.safeExecute('addQuickReply', async () => {
      const now = Math.floor(Date.now() / 1000);
      const r = await this.db.prepare(
        'INSERT INTO pm_quick_replies (title, content, category, is_enabled, created_at) VALUES (?, ?, ?, 1, ?)'
      ).bind(title, content, category, now).run();
      return r.meta?.last_row_id || 0;
    });
    this.cache.delete('quick_replies');
    return result;
  }

  async deleteQuickReply(id: number): Promise<void> {
    await this.safeExecute('deleteQuickReply', async () => {
      await this.db.prepare('DELETE FROM pm_quick_replies WHERE id = ?').bind(id).run();
    });
    this.cache.delete('quick_replies');
  }

  // ============ Scheduled Messages ============
  async addScheduledMessage(userId: number | null, content: string, messageType: string, fileId: string | null, scheduledAt: number): Promise<number> {
    const result = await this.safeExecute('addScheduledMessage', async () => {
      const now = Math.floor(Date.now() / 1000);
      const r = await this.db.prepare(
        'INSERT INTO pm_scheduled_messages (user_id, content, message_type, file_id, scheduled_at, is_sent, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
      ).bind(userId, content, messageType, fileId, scheduledAt, now).run();
      return r.meta?.last_row_id || 0;
    });
    return result;
  }

  async getPendingScheduledMessages(): Promise<Array<{
    id: number; user_id: number | null; content: string; message_type: string; file_id: string | null; scheduled_at: number;
  }>> {
    return await this.safeExecute('getPendingScheduledMessages', async () => {
      const now = Math.floor(Date.now() / 1000);
      const r = await this.db.prepare(
        'SELECT id, user_id, content, message_type, file_id, scheduled_at FROM pm_scheduled_messages WHERE is_sent = 0 AND scheduled_at <= ? LIMIT 50'
      ).bind(now).all();
      return (r.results as Array<{
        id: number; user_id: number | null; content: string; message_type: string; file_id: string | null; scheduled_at: number;
      }>) || [];
    });
  }

  async markScheduledMessageSent(id: number): Promise<void> {
    await this.safeExecute('markScheduledMessageSent', async () => {
      await this.db.prepare('UPDATE pm_scheduled_messages SET is_sent = 1 WHERE id = ?').bind(id).run();
    });
  }

  async getAllScheduledMessages(): Promise<Array<{
    id: number; user_id: number | null; content: string; scheduled_at: number; is_sent: number;
  }>> {
    return await this.safeExecute('getAllScheduledMessages', async () => {
      const r = await this.db.prepare('SELECT id, user_id, content, scheduled_at, is_sent FROM pm_scheduled_messages ORDER BY scheduled_at DESC LIMIT 50').all();
      return (r.results as Array<{
        id: number; user_id: number | null; content: string; scheduled_at: number; is_sent: number;
      }>) || [];
    });
  }

  async deleteScheduledMessage(id: number): Promise<void> {
    await this.safeExecute('deleteScheduledMessage', async () => {
      await this.db.prepare('DELETE FROM pm_scheduled_messages WHERE id = ? AND is_sent = 0').bind(id).run();
    });
  }

  // ============ Audit Log ============
  async addAuditLog(adminId: number, action: string, targetType?: string, targetId?: string, details?: string): Promise<void> {
    await this.safeExecute('addAuditLog', async () => {
      const now = Math.floor(Date.now() / 1000);
      await this.db.prepare(
        'INSERT INTO pm_audit_log (admin_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(adminId, action, targetType || null, targetId || null, details || null, now).run();
    });
  }

  async getAuditLogs(limit: number = 50): Promise<Array<{
    id: number; admin_id: number; action: string; target_type: string | null; target_id: string | null; details: string | null; created_at: number;
  }>> {
    return await this.safeExecute('getAuditLogs', async () => {
      const r = await this.db.prepare('SELECT * FROM pm_audit_log ORDER BY created_at DESC LIMIT ?').bind(limit).all();
      return (r.results as Array<{
        id: number; admin_id: number; action: string; target_type: string | null; target_id: string | null; details: string | null; created_at: number;
      }>) || [];
    });
  }

  // ============ Data Export ============
  async exportAllData(): Promise<{
    users: unknown[]; messages: unknown[]; settings: unknown[];
    autoReplies: unknown[]; blacklist: unknown[];
  }> {
    return await this.safeExecute('exportAllData', async () => {
      const [users, messages, settings, autoReplies, blacklist] = await Promise.all([
        this.db.prepare('SELECT * FROM pm_users').all(),
        this.db.prepare('SELECT * FROM pm_messages ORDER BY created_at DESC LIMIT 5000').all(),
        this.db.prepare('SELECT * FROM pm_settings').all(),
        this.db.prepare('SELECT * FROM pm_auto_replies').all(),
        this.db.prepare('SELECT * FROM pm_blacklist_keywords').all(),
      ]);
      return {
        users: users.results,
        messages: messages.results,
        settings: settings.results,
        autoReplies: autoReplies.results,
        blacklist: blacklist.results,
      };
    });
  }
}

export function createOptimizedDb(env: { BOT_D1?: D1Database }, cache: MemoryCache): OptimizedDatabase {
  if (!env.BOT_D1) {
    throw new Error('BOT_D1 database binding is not configured');
  }
  return new OptimizedDatabase(env.BOT_D1, cache);
}
