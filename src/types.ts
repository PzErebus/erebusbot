export interface Env {
  BOT_D1: D1Database;
  BOT_TOKEN: string;
  ADMIN_USER_ID: string;
  LANGUAGE: string;

  ENVIRONMENT?: 'development' | 'production' | 'testing';
  ADMIN_API_KEY?: string;
  ADMIN_JWT_SECRET?: string;
  CORS_ALLOWED_ORIGIN?: string;
  DEV_ACCESS_TOKEN?: string;
  ADMIN_IDS?: string;
  WEBHOOK_SECRET?: string;
  SILICONFLOW_API_KEY?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
  video?: { file_id: string; file_unique_id: string; width: number; height: number; duration: number };
  sticker?: { file_id: string; file_unique_id: string; type: string };
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string };
  voice?: { file_id: string; file_unique_id: string; duration: number };
  audio?: { file_id: string; file_unique_id: string; duration: number; title?: string };
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
