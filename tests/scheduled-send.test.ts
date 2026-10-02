/**
 * 定时消息发送器（processScheduledMessages）测试
 *
 * 回归背景：getPendingScheduledMessages/markScheduledMessageSent 原先全仓库零调用，
 * 定时消息创建后永远不会被发送（P0 缺陷）。现在由 PollerDO alarm 每轮调用发送器。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  due: [] as Array<{ id: number; user_id: number | null; content: string; scheduled_at: number }>,
  users: [] as Array<{ user_id: number }>,
  markedSent: [] as number[],
  sentTexts: [] as Array<{ chat_id: unknown; text: string }>,
  sendMessageOk: true
}));

vi.mock('../src/db-optimized', () => ({
  createOptimizedDb: () =>
    new Proxy(
      {},
      {
        get(_target: unknown, prop: string) {
          if (prop === 'then') return undefined;
          if (prop === 'getPendingScheduledMessages') return async () => state.due;
          if (prop === 'getPmUsers') return async () => state.users;
          if (prop === 'markScheduledMessageSent') return async (id: number) => { state.markedSent.push(id); };
          return async () => null;
        }
      }
    )
}));

vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('/sendMessage')) {
    if (!state.sendMessageOk) {
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'chat not found' }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body || '{}')) as { chat_id: number; text: string };
    state.sentTexts.push({ chat_id: body.chat_id, text: body.text });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: body.chat_id } } }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
}));

import { createBot } from '../src/bot';
import type { Env } from '../src/types';

function makeEnv(): Env {
  return { BOT_TOKEN: 'test:token', ADMIN_USER_ID: '1001', BOT_D1: {} } as unknown as Env;
}

const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => {
  state.due = [];
  state.users = [];
  state.markedSent = [];
  state.sentTexts = [];
  state.sendMessageOk = true;
});

describe('定时消息发送器 processScheduledMessages', () => {
  it('到期消息发送给指定用户并标记已发送', async () => {
    state.due = [{ id: 7, user_id: 555, content: '该复查了', scheduled_at: NOW - 10 }];

    const bot = createBot(makeEnv());
    const r = await bot.processScheduledMessages();

    expect(r).toEqual({ scanned: 1, sent: 1, failed: 0 });
    expect(state.sentTexts).toHaveLength(1);
    expect(state.sentTexts[0].chat_id).toBe(555);
    expect(state.sentTexts[0].text).toContain('该复查了');
    expect(state.markedSent).toEqual([7]);
  });

  it('没有到期消息时不发送、不写标记', async () => {
    const bot = createBot(makeEnv());
    const r = await bot.processScheduledMessages();

    expect(r).toEqual({ scanned: 0, sent: 0, failed: 0 });
    expect(state.sentTexts).toHaveLength(0);
    expect(state.markedSent).toHaveLength(0);
  });

  it('user_id 为空时广播给全部用户', async () => {
    state.due = [{ id: 8, user_id: null, content: '系统公告', scheduled_at: NOW - 5 }];
    state.users = [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }];

    const bot = createBot(makeEnv());
    const r = await bot.processScheduledMessages();

    expect(r.sent).toBe(3);
    expect(state.sentTexts).toHaveLength(3);
    expect(state.sentTexts.map(s => s.chat_id).sort()).toEqual([1, 2, 3]);
    expect(state.markedSent).toEqual([8]);
  });

  it('投递失败也标记已发送（防无限重试），并计入 failed', async () => {
    state.sendMessageOk = false;
    state.due = [{ id: 9, user_id: 555, content: 'x', scheduled_at: NOW - 60 }];

    const bot = createBot(makeEnv());
    const r = await bot.processScheduledMessages();

    expect(r).toEqual({ scanned: 1, sent: 0, failed: 1 });
    expect(state.markedSent).toEqual([9]);
  });

  it('多条到期消息逐条处理，各自标记', async () => {
    state.due = [
      { id: 11, user_id: 1, content: 'a', scheduled_at: NOW - 30 },
      { id: 12, user_id: 2, content: 'b', scheduled_at: NOW - 20 }
    ];

    const bot = createBot(makeEnv());
    const r = await bot.processScheduledMessages();

    expect(r).toEqual({ scanned: 2, sent: 2, failed: 0 });
    expect(state.markedSent).toEqual([11, 12]);
  });
});
