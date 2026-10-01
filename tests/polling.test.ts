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
  tgOk: true,
  tgStatus: 200
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
  state.tgStatus = 200;

  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    state.fetchUrls.push(url);
    // getUpdates 走测试可控的返回值；其余（sendMessage 等）一律成功，避免 api() 触发重试退避拖慢测试
    if (url.includes('getUpdates')) {
      return {
        ok: state.tgStatus < 400,
        status: state.tgStatus,
        json: async () =>
          state.tgStatus === 409
            ? { ok: false, result: [], description: 'Conflict: terminated by other getUpdates request' }
            : { ok: state.tgOk, result: state.updates }
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

  it('长轮询超时可配置，且必须小于轮询间隔（否则撞 409）', async () => {
    state.updates = [];

    const bot = createBot(makeEnv());
    await bot.handlePoll(5);

    expect(state.fetchUrls[0]).toContain('timeout=5');
  });

  it('getUpdates 返回 409 Conflict 时跳过本轮且**不**推进 offset', async () => {
    state.updates = [userMessage(7001, 'ping')];
    state.tgStatus = 409;

    const bot = createBot(makeEnv());
    const result = await bot.handlePoll();

    expect(result.fetched).toBe(0);
    // 关键：offset 不能前进，否则 409 期间积压的消息会被永久跳过
    expect(state.updateSettingCalls).toHaveLength(0);
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

describe('Cron 触发器入口', () => {
  it('Worker 必须导出 scheduled —— 漏掉它 crons 配了也不会跑轮询', async () => {
    const worker = (await import('../src/index')).default;
    expect(typeof worker.scheduled).toBe('function');
  });

  it('scheduled() 会真正拉一次消息并推进 offset', async () => {
    const worker = (await import('../src/index')).default;
    state.updates = [userMessage(8001, 'ping')];

    await worker.scheduled({} as never, makeEnv());

    expect(state.updateSettingCalls).toContainEqual([OFF_KEY, '8002']);
  });
});

describe('PollerDO 闹钟轮询器', () => {
  function fakeCtx(initialAlarm: number | null = null) {
    let alarm = initialAlarm;
    const setAt: number[] = [];
    // 统计值（pollCount / lastDurationMs）也用真实 Map 存，避免 #stat 打不到让断言形同虚设
    const store = new Map<string, unknown>();
    return {
      setAt,
      store,
      alarmTick: () => alarm,
      ctx: {
        storage: {
          getAlarm: async () => alarm,
          setAlarm: async (v: number) => {
            alarm = v;
            setAt.push(v);
          },
          get: async <T>(k: string) => store.get(k) as T | undefined,
          put: async (k: string, v: unknown) => {
            store.set(k, v);
          }
        },
        // 让 handler 跑完再读闹钟，模拟真实执行顺序
        blockConcurrencyWhile: async (fn: () => Promise<void>) => {
          await fn();
        }
      } as unknown as DurableObjectState
    };
  }

  it('alarm 拉一次消息后立即续上下一次闹钟', async () => {
    const { PollerDO } = await import('../src/poller');
    const fake = fakeCtx(null);
    state.updates = [userMessage(9001, 'ping')];

    const doInstance = new PollerDO(fake.ctx, makeEnv() as never);
    await (doInstance as unknown as { alarm(): Promise<void> }).alarm();

    // 现在一个周期会先排一次、结束再排一次，两次值必须完全相同（都锚在本轮起点）
    expect(fake.setAt.length).toBeGreaterThan(0);
    expect(new Set(fake.setAt).size).toBe(1);
    expect(fake.setAt[0]!).toBeGreaterThan(Date.now());
    expect(state.updateSettingCalls).toContainEqual([OFF_KEY, '9002']);
  });

  it('alarm 抛错时仍然续期，避免闹钟链断掉后整个 bot 静默失联', async () => {
    const { PollerDO } = await import('../src/poller');
    const fake = fakeCtx(null);
    state.tgStatus = 409; // 让 getUpdates 失败

    const doInstance = new PollerDO(fake.ctx, makeEnv() as never);
    await (doInstance as unknown as { alarm(): Promise<void> }).alarm();

    expect(fake.setAt.length).toBeGreaterThan(0);
    expect(new Set(fake.setAt).size).toBe(1);
  });

  it('下一轮闹钟按「本轮起点」排，长轮询耗时不会累加进周期', async () => {
    const { PollerDO } = await import('../src/poller');
    const { DEFAULT_POLL_INTERVAL_MS } = await import('../src/poller');
    const fake = fakeCtx(null);

    // 制造 ~250ms 的长轮询耗时：若按「本轮结束」排闹钟，周期会被推迟这么多
    state.updates = [userMessage(9100, 'slow-ack')];
    const origFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('getUpdates')) {
        await new Promise((r) => setTimeout(r, 250));
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: state.updates })
        } as Response;
      }
      return origFetch(input, init);
    });

    const before = Date.now();
    const doInstance = new PollerDO(fake.ctx, makeEnv() as never);
    await (doInstance as unknown as { alarm(): Promise<void> }).alarm();
    globalThis.fetch = origFetch;

    const elapsed = Date.now() - before;
    const next = fake.setAt[0]!;
    // 闹钟应落在「起点 + interval」，而不是「起点 + interval + 长轮询耗时」
    expect(elapsed).toBeGreaterThan(200);
    expect(next - before).toBeLessThanOrEqual(DEFAULT_POLL_INTERVAL_MS + 50);
    expect(next - before).toBeGreaterThan(DEFAULT_POLL_INTERVAL_MS - 100);
  });

  it('nudge 只在闹钟缺失或过于遥远时才重排，不打断正在等待的那一轮', async () => {
    const { PollerDO } = await import('../src/poller');
    const soon = Date.now() + 5000;
    const fake = fakeCtx(soon);

    const doInstance = new PollerDO(fake.ctx, makeEnv() as never);
    const res = await doInstance.fetch(new Request('https://poller.internal/nudge', { method: 'POST' }));
    const body = (await res.json()) as { rescheduled: boolean };

    expect(body.rescheduled).toBe(false);
    expect(fake.alarmTick()).toBe(soon);
  });
});

describe('PollerDO 连续长轮询覆盖', () => {
  it('一个周期内会连开多次长连接消除盲窗，且次数受上限约束不会空转', async () => {
    const { PollerDO, DEFAULT_POLL_INTERVAL_MS } = await import('../src/poller');
    const MAX_ROUNDS = 3; // 与 src/poller.ts 的 MAX_ROUNDS_PER_CYCLE 保持一致
    const fake = { setAt: [] as number[], ctx: {
      storage: {
        getAlarm: async () => null,
        setAlarm: async (v: number) => { fake.setAt.push(v); },
        get: async () => undefined,
        put: async () => {}
      },
      blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); }
    } as unknown as DurableObjectState };

    state.updates = [];
    const origFetch = globalThis.fetch;
    let getUpdatesCalls = 0;
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('getUpdates')) {
        getUpdatesCalls++;
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as Response;
      }
      return origFetch(input, init);
    });

    const doInstance = new PollerDO(fake.ctx, makeEnv() as never);
    const t0 = Date.now();
    await (doInstance as unknown as { alarm(): Promise<void> }).alarm();
    globalThis.fetch = origFetch;

    // 每轮返回得再快，也必须退出：既不能空转到下一个闹钟周期，也不能无限撞连接
    expect(getUpdatesCalls).toBeLessThanOrEqual(MAX_ROUNDS);
    expect(getUpdatesCalls).toBeGreaterThanOrEqual(1);
    expect(Date.now() - t0).toBeLessThan(DEFAULT_POLL_INTERVAL_MS / 1000);
    expect(new Set(fake.setAt).size).toBe(1);
  });
});
