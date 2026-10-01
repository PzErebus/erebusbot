/**
 * 轮询执行器（Cron / 手动触发共用）
 *
 * 为什么需要互斥锁：Telegram 同一时刻只允许一个 getUpdates 长连接，
 * 两个并发请求会互相把对方打掉（409 Conflict），两侧的 offset 推进逻辑都会乱。
 */
import type { Env } from './types';
import { createLogger } from './logger';

const log = createLogger('poll');

let pollInFlight = false;

export async function runPoll(env: Env, source: string): Promise<Record<string, unknown>> {
  if (pollInFlight) {
    log.warn('Poll skipped, another poll still in flight', { source });
    return { ok: true, fetched: 0, skipped: true };
  }
  pollInFlight = true;
  try {
    const { createBot } = await import('./bot');
    const { fetched } = await createBot(env).handlePoll();
    if (fetched > 0) log.info('Poll finished', { source, fetched });
    return { ok: true, fetched };
  } catch (e) {
    log.error('Cron poll error', { source, error: e });
    return { ok: false, fetched: 0, error: String(e) };
  } finally {
    pollInFlight = false;
  }
}
