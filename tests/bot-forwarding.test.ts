/**
 * Bot 消息转发主干集成测试
 *
 * db-optimized 整体打桩（在进程内维护一个替代对象），Telegram API 用打桩的 fetch 承接，
 * 因此这里跑的是真实的 handleUpdate 路由与编排逻辑，而不是被剥离后的纯函数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const overrides: Record<string, unknown> = {};

  function defaultResult(name: string): unknown {
    switch (name) {
      case 'getSetting':
        return null;
      case 'getWorkHoursSetting':
        return { enabled: true, start: '09:00', end: '18:00' };
      case 'isWorkHours':
        return true;
      case 'checkBlacklist':
        return { matched: false };
      case 'checkAutoReply':
        return null;
      case 'isUserBlocked':
        return false;
      case 'getUserSession':
        return null;
      case 'getPmMessageMapping':
        return null;
      case 'saveMessage':
        return 1;
      case 'savePmMessageMapping':
        return true;
      case 'saveUser':
        return true;
      default:
        return null;
    }
  }

  return { calls, overrides, defaultResult };
});

vi.mock('../src/db-optimized', () => ({
  createOptimizedDb: () =>
    new Proxy(
      {},
      {
        get(_target: unknown, prop: string) {
          // 避免被当成 thenable
          if (prop === 'then') return undefined;
          if (prop in h.overrides) return h.overrides[prop];
          return async () => {
            h.calls.push(prop);
            return h.defaultResult(prop);
          };
        }
      }
    )
}));

import { createBot } from '../src/bot';
import type { Env, TelegramUpdate } from '../src/types';

const ADMIN_ID = 1001;

function makeEnv(): Env {
  return {
    BOT_D1: {} as never,
    BOT_TOKEN: '123456:TEST',
    ADMIN_USER_ID: String(ADMIN_ID),
    LANGUAGE: 'zh-CN',
    ENVIRONMENT: 'production'
  } as Env;
}

interface TgCall {
  method: string;
  body: Record<string, unknown>;
}

let tgCalls: TgCall[];
let updateSeq = 0;

beforeEach(() => {
  tgCalls = [];
  h.calls.length = 0;
  for (const key of Object.keys(h.overrides)) delete h.overrides[key];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init: { body: string }) => {
      const method = String(url).split('/').pop()!;
      const body = JSON.parse(init.body) as Record<string, unknown>;
      tgCalls.push({ method, body });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 1000 + tgCalls.length,
            chat: { id: body.chat_id, type: 'private' },
            text: body.text
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    })
  );
});

function userMessage(fromId: number, text: string, extra: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: ++updateSeq,
    message: {
      message_id: 500 + updateSeq,
      date: Math.floor(Date.now() / 1000),
      from: { id: fromId, is_bot: false, first_name: '张三', username: 'zhangsan' },
      chat: { id: fromId, type: 'private' },
      text,
      ...extra
    }
  } as unknown as TelegramUpdate;
}

function adminReplyMessage(adminMsgId: number, text: string): TelegramUpdate {
  return {
    update_id: ++updateSeq,
    message: {
      message_id: 600 + updateSeq,
      date: Math.floor(Date.now() / 1000),
      from: { id: ADMIN_ID, is_bot: false, first_name: 'Admin', username: 'admin' },
      chat: { id: ADMIN_ID, type: 'private' },
      text,
      reply_to_message: { message_id: adminMsgId, chat: { id: ADMIN_ID, type: 'private' } }
    }
  } as unknown as TelegramUpdate;
}

function sentToAdmin(): TgCall[] {
  return tgCalls.filter(c => c.body.chat_id === ADMIN_ID);
}

describe('用户消息 → 管理员', () => {
  it('普通文本消息被转发给管理员并落库', async () => {
    const bot = createBot(makeEnv());
    await bot.handleUpdate(userMessage(555, '我需要租脚手架'));

    expect(tgCalls.some(c => c.method === 'sendMessage')).toBe(true);

    const forward = sentToAdmin().at(-1)!;
    expect(forward.body.text).toContain('我需要租脚手架');
    expect(forward.body.text).toContain('555');
    expect(forward.body.parse_mode).toBe('HTML');
    // HTML 上下文必须转义，避免标签被 Telegram 解析
    expect(forward.body.text).not.toContain('<b>需要</b>');

    // 用户侧收到回执
    const ack = tgCalls.find(c => c.body.chat_id === 555 && String(c.body.text).includes('已发送给管理员'));
    expect(ack).toBeTruthy();

    expect(h.calls).toContain('saveMessage');
    expect(h.calls).toContain('savePmMessageMapping');
  });

  it('HTML 特殊字符被转义后再转发', async () => {
    const bot = createBot(makeEnv());
    await bot.handleUpdate(userMessage(555, '<script>alert(1)</script>'));

    const forward = sentToAdmin().at(-1)!;
    expect(forward.body.text).toContain('&lt;script&gt;');
    expect(forward.body.text).not.toContain('<script>');
  });

  it('携带回复按钮（管理员直接回复依托的映射入口）', async () => {
    const bot = createBot(makeEnv());
    await bot.handleUpdate(userMessage(555, 'hello'));

    const forward = sentToAdmin().at(-1)!;
    const markup = JSON.stringify(forward.body.reply_markup);
    expect(markup).toContain('555');
  });

  it('/start 只回欢迎语，不打扰管理员', async () => {
    const bot = createBot(makeEnv());
    await bot.handleUpdate(userMessage(555, '/start'));

    expect(sentToAdmin()).toHaveLength(0);
    const welcome = tgCalls.find(c => c.body.chat_id === 555);
    expect(welcome).toBeTruthy();
    expect(String(welcome!.body.text).length).toBeGreaterThan(0);
  });

  it('黑名单命中：不转发给管理员，仅回提示', async () => {
    h.overrides.checkBlacklist = async () => ({ matched: true });
    const bot = createBot(makeEnv());
    await bot.handleUpdate(userMessage(555, '敏感词'));

    expect(sentToAdmin()).toHaveLength(0);
    const reply = tgCalls.find(c => c.body.chat_id === 555)!;
    expect(String(reply.body.text)).toContain('敏感内容');
  });

  it('非工作时间：不转发给管理员，仅回非工作时间提示', async () => {
    h.overrides.isWorkHours = async () => false;
    const bot = createBot(makeEnv());
    await bot.handleUpdate(userMessage(555, '在吗'));

    expect(sentToAdmin()).toHaveLength(0);
    const reply = tgCalls.find(c => c.body.chat_id === 555)!;
    expect(String(reply.body.text)).toContain('非工作时间');
  });

  it('自动回复命中：同时回用户并转发给管理员（标注已自动回复）', async () => {
    h.overrides.checkAutoReply = async () => '请稍后联系';
    const bot = createBot(makeEnv());
    await bot.handleUpdate(userMessage(555, '你好'));

    const forward = sentToAdmin().at(-1)!;
    expect(forward.body.text).toContain('已自动回复');
    expect(tgCalls.some(c => c.body.chat_id === 555 && c.body.text === '请稍后联系')).toBe(true);
  });

  it('封禁用户：拒绝转发', async () => {
    h.overrides.isUserBlocked = async () => true;
    const bot = createBot(makeEnv());
    await bot.handleUpdate(userMessage(555, '违规'));

    expect(sentToAdmin()).toHaveLength(0);
    const reply = tgCalls.find(c => c.body.chat_id === 555)!;
    expect(String(reply.body.text)).toContain('封禁');
  });
});

describe('管理员回复 → 用户', () => {
  it('按 admin_msg_id 映射反查 userId 并送达', async () => {
    h.overrides.getPmMessageMapping = async () => ({ user_id: 555 });
    const bot = createBot(makeEnv());
    await bot.handleUpdate(adminReplyMessage(777, '好的，马上安排'));

    const reply = tgCalls.find(c => c.body.chat_id === 555);
    expect(reply).toBeTruthy();
    expect(String(reply!.body.text)).toContain('管理员回复');
    expect(String(reply!.body.text)).toContain('好的，马上安排');
  });

  it('映射查不到时给出明确提示而不是静默丢弃', async () => {
    h.overrides.getPmMessageMapping = async () => null;
    const bot = createBot(makeEnv());
    await bot.handleUpdate(adminReplyMessage(999, 'who are you'));

    const reply = tgCalls.find(c => c.body.chat_id === ADMIN_ID && String(c.body.text).includes('无法找到'));
    expect(reply).toBeTruthy();
  });
});

describe('事件去重与空更新', () => {
  it('重复 update_id 只处理一次', async () => {
    const bot = createBot(makeEnv());
    const update = userMessage(555, '重复消息');

    await bot.handleUpdate(update);
    const firstCount = sentToAdmin().length;
    expect(firstCount).toBe(1);

    await bot.handleUpdate({ ...update });
    expect(sentToAdmin().length).toBe(firstCount);
  });

  it('缺少 update_id 的空更新被忽略', async () => {
    const bot = createBot(makeEnv());
    await bot.handleUpdate({} as TelegramUpdate);
    expect(tgCalls).toHaveLength(0);
  });

  it('既无 message 也无 callback_query 的更新被忽略', async () => {
    const bot = createBot(makeEnv());
    await bot.handleUpdate({ update_id: ++updateSeq } as TelegramUpdate);
    expect(tgCalls).toHaveLength(0);
  });
});
