/**
 * 轮询器 Durable Object —— 把「每秒/每 15 秒捞一次」变成可能
 *
 * 背景：Cloudflare Cron 触发器的最小粒度是 1 分钟（每 60 秒），
 * 消息最坏要等满 60 秒才有响应。注意注释里千万别写 cron 表达式，其中的星号加斜杠会提前闭合块注释。而 Durable Object 的 alarm 可以自己续期、
 * 精度远细于 1 分钟，因此把轮询循环放进 DO，Cron 退化为「看门狗」只负责兜底唤醒。
 *
 * 分工（重要）：
 * - DO.alarm()      ：唯一真正调用 getUpdates 的地方，保持单一持有者，杜绝 409 抢连接
 * - DO.fetch(PING)  ：Cron 调用，只检查/重排 alarm，绝不自己轮询
 * - scheduled()     ：Cron 调 PING；DO 万一失效则直接兜底轮询一次
 */
import type { Env } from './types';
import { createLogger } from './logger';

const log = createLogger('poller');

export const DEFAULT_POLL_INTERVAL_MS = 15000;

function pollIntervalMs(env: Env): number {
  const raw = Number(env.POLL_INTERVAL_MS);
  if (Number.isFinite(raw) && raw >= 5000 && raw <= 60000) return raw;
  return DEFAULT_POLL_INTERVAL_MS;
}

export class PollerDO {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) { }

  /**
   * 看门狗入口：destination 为 cron 时只对齐闹钟，不做轮询。
   * 仅当「闹钟没设」或「下次闹钟远在下个周期之后」才重排，避免把正在等消息的闹钟往后推。
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/status') {
      const next = await this.ctx.storage.getAlarm();
      return new Response(
        JSON.stringify({
          ok: true,
          intervalMs: pollIntervalMs(this.env),
          nextAlarmAt: next,
          nextAlarmInMs: next === null ? null : Math.max(0, next - Date.now()),
          pollCount: await this.#stat('pollCount'),
          lastFetched: await this.#stat('lastFetched')
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.pathname === '/nudge') {
      const interval = pollIntervalMs(this.env);
      const next = await this.ctx.storage.getAlarm();
      if (next === null || next - Date.now() > interval) {
        await this.ctx.storage.setAlarm(Date.now() + interval);
        return new Response(JSON.stringify({ ok: true, rescheduled: true, next: Date.now() + interval }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true, rescheduled: false, next }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response('PollerDO alive', { status: 200 });
  }

  async #stat(key: string): Promise<number> {
    return ((await this.ctx.storage.get<number>(key)) ?? 0) as number;
  }

  /** 定时循环：拉一批 -> 立刻续上下一次闹钟（异常也不能断链） */
  async alarm(): Promise<void> {
    let interval = pollIntervalMs(this.env);
    try {
      const { createBot } = await import('./bot');
      const { fetched } = await createBot(this.env).handlePoll(
        Math.max(3, Math.min(10, Math.floor(interval / 1000) - 3))
      );
      await this.ctx.storage.put('pollCount', (await this.#stat('pollCount')) + 1);
      if (fetched > 0) {
        await this.ctx.storage.put('lastFetched', fetched);
        log.info('Poll finished', { source: 'do-alarm', fetched });
      }
    } catch (e) {
      // 失败也要续期，否则闹钟链断掉后整个 bot 静默失联
      log.error('PollerDO alarm error', { error: e });
      interval = Math.min(interval * 2, 60000);
    }
    await this.ctx.storage.setAlarm(Date.now() + interval);
  }
}
