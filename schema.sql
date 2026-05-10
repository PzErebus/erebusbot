-- ErebusBot Database Schema
-- All tables required for the bot to function

CREATE TABLE IF NOT EXISTS user_sessions (
  user_id INTEGER PRIMARY KEY,
  action TEXT,
  data TEXT,
  created_at INTEGER,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pm_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  created_at INTEGER,
  last_message_at INTEGER,
  is_blocked BOOLEAN DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',
  content TEXT,
  user_msg_id INTEGER,
  admin_msg_id INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS pm_message_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  user_msg_id INTEGER,
  admin_msg_id INTEGER NOT NULL UNIQUE,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS pm_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS pm_auto_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  reply_text TEXT NOT NULL,
  match_type TEXT DEFAULT 'contains',
  is_enabled BOOLEAN DEFAULT 1,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS pm_blacklist_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  is_regex BOOLEAN DEFAULT 0,
  is_enabled BOOLEAN DEFAULT 1,
  created_at INTEGER,
  reason TEXT
);

INSERT OR IGNORE INTO pm_settings (key, value) VALUES
  ('welcome_message', '👋 欢迎使用！请发送消息，我会转发给管理员。'),
  ('language', 'zh_CN');
