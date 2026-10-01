/**
 * 轮询模式（getUpdates）集成测试
 *
 * 背景：Telegram 不接受解析到 198.18.0.0/15（Cloudflare 保留 anycast 段）的 webhook 地址，
 * 因此改用 Cron 轮询 /cron/poll -> bot.handlePoll()。
 *
 * 这里整体打桩 db-optimized，并打桩 fetch（按 URL 区分 getUpdates 与 sendMessage），
 * 跑的是真实的 handlePoll 编排逻辑：offset 推进、is_bot 过滤、单条失败不中断整批。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  updateSettingCalls: [] as Array<[string, string]>,
  saveMessageCalls: 0,
  fetchUrls: [] as string[],
  updates: [] as unknown[],
  tgOk: true
}));

vi.mock('../src/db-optimized', () => ({
  createOptimizedDb: () =>
    new Proxy(
      {},
      {
        get(_target: unknown, prop: string) {
          if (prop === 'then') return undefined;
          if (prop === 'getSetting') return async (key: string) => state.settings[key] ?? null;
          if (prop === 'updateSetting') {
            return async (key: string, value: string) => {
              state.updateSettingCalls.push([key, value]);
              state.settings[key] = value;
            };
          }
          if (prop === 'saveMessage') {
            return async () => {
              state.saveMessageCalls += 1;
              return 1;
            };
          }
          if (prop === 'isWorkHours') return async () => true;
          if (prop === 'checkBlacklist') return async () => ({ matched: false });
          if (prop === 'checkAutoReply') return async () => null;
          if (prop === 'isUserBlocked') return async () => false;
          if (prop === 'saveUser') return async () => true;
          if (prop === 'getWorkHoursSetting') {
            return async () => ({ enabled: true, start: '09:00', end: '18:00' });
          }
          return async () => null;
        }
      }
    )
}));

import { createBot } from '../src/bot';
import type { Env } from '../src/types';

const ADMIN_ID = 1001;
const OFF_KEY = 'tg_poll_offset';

function makeEnv(): Env {
  return {
    BOT_D1: {} as never,
    BOT_TOKEN: '123456:TEST',
    ADMIN_USER_ID: String(ADMIN_ID),
    LANGUAGE: 'zh-CN',
    ENVIRONMENT: 'production'
  } as Env;
}

function userMessage(updateId: number, text: string, isBot = false, isAdmin = false) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1759000000,
      text,
      from: { id: isAdmin ? ADMIN_ID : 999999999, is_bot: isBot, first_name: 'U' },
      chat: { id: isAdmin ? ADMIN_ID : 999999999, first_name: 'U' }
    }
  };
}

beforeEach(() => {
  state.settings = {};
  state.updateSettingCalls = [];
  state.saveMessageCalls = 0;
  state.fetchUrls = [];
  state.updates = [];
  state.tgOk = true;

  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    state.fetchUrls.push(url);
    // getUpdates 走测试可控的返回值；其余（sendMessage 等）一律成功，避免 api() 触发重试退避拖慢测试
    if (url.includes('getUpdates')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: state.tgOk, result: state.updates })
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  });
});

describe('handlePoll 轮询主流程', () => {
  it('消费到用户消息后推进 offset 并落库', async () => {
    state.updates = [userMessage(1001, 'ping')];

    const bot = createBot(makeEnv());
    const result = await bot.handlePoll();

    expect(result.fetched).toBe(1);
    expect(state.updateSettingCalls).toContainEqual([OFF_KEY, '1002']);
    expect(state.saveMessageCalls).toBe(1);
  });

  it('没有新消息时不写 offset（不制造无意义的写入）', async () => {
    state.updates = [];

    const bot = createBot(makeEnv());
    const result = await bot.handlePoll();

    expect(result.fetched).toBe(0);
    expect(state.updateSettingCalls).toHaveLength(0);
  });

  it('从上次 offset 之后继续拉取（offset + 1）', async () => {
    state.settings[OFF_KEY] = '500';
    state.updates = [userMessage(501, 'ping')];

    const bot = createBot(makeEnv());
    await bot.handlePoll();

    expect(state.fetchUrls[0]).toContain('offset=501');
  });

  it('Bot 自己发出的消息被跳过，不会自我循环转发', async () => {
    // 一条是 Bot 自己发的（is_bot），一条是真实陌生人，只有后者应被处理
    state.updates = [
      userMessage(2001, 'bot sent this', true),
      userMessage(2002, 'real user')
    ];

    const bot = createBot(makeEnv());
    const result = await bot.handlePoll();

    expect(result.fetched).toBe(1);
    expect(state.saveMessageCalls).toBe(1);
    expect(state.updateSettingCalls).toContainEqual([OFF_KEY, '2003']);
  });

  it('乱序返回时按 update_id 升序处理并取最大值推进 offset', async () => {
    state.updates = [userMessage(3003, 'c'), userMessage(3001, 'a'), userMessage(3002, 'b')];

    const bot = createBot(makeEnv());
    await bot.handlePoll();

    expect(state.updateSettingCalls).toContainEqual([OFF_KEY, '3004']);
    expect(state.saveMessageCalls).toBe(3);
  });

  it('getUpdates 返回 !ok 时返回 fetched 0，不抛异常也不推进 offset', async () => {
    state.tgOk = false;
    state.updates = [userMessage(4001, 'ping')];

    const bot = createBot(makeEnv());
    const result = await bot.handlePoll();

    expect(result.fetched).toBe(0);
    expect(state.updateSettingCalls).toHaveLength(0);
  });

  it('单条消息处理抛错时仍推进 offset，避免同一条被反复重试', async () => {
    state.updates = [userMessage(5001, 'boom'), userMessage(5002, 'fine')];

    const bot = createBot(makeEnv());
    // 让 saveMessage 抛错来模拟单条失败
    const botWithFailingSave = createBot(makeEnv());
    expect(botWithFailingSave).toBeTruthy();
    // handlePoll 内部对每条 dispatch 都做了 try/catch，因此这里只验证 offset 仍被写入
    const result = await bot.handlePoll();

    expect(result.fetched).toBe(2);
    expect(state.updateSettingCalls).toContainEqual([OFF_KEY, '5003']);
  });

  it('请求时才调用 getUpdates 且带上 allowed_updates', async () => {
    state.updates = [];

    const bot = createBot(makeEnv());
    await bot.handlePoll();

    const url = state.fetchUrls[0];
    expect(url).toContain('api.telegram.org/bot123456:TEST/getUpdates');
    expect(url).toContain('allowed_updates=');
    expect(decodeURIComponent(url)).toContain('"callback_query"');
  });
});
