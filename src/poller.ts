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

// 上一版是 15000 且存在「timeout + interval」的累加周期，实测消息最坏要等 ~25s。
export const DEFAULT_POLL_INTERVAL_MS = 10000;
/** 单次长连接最长阻塞秒数。必须 < interval/1000，否则上一轮没返回、下一轮就撞 409 */
const POLL_TIMEOUT_CAP = 25;
/** 一个闹钟周期内最多开几次长连接。正常 2 次就够，这里只是死循环兜底（避免 409 时空转撞连接） */
const MAX_ROUNDS_PER_CYCLE = 3;

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
          lastFetched: await this.#stat('lastFetched'),
          lastDurationMs: await this.#stat('lastDurationMs')
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

  /** 定时循环：连续长轮询 -> 续上下一次闹钟（异常也不能断链） */
  async alarm(): Promise<void> {
    const interval = pollIntervalMs(this.env);
    // 关键：长轮询最长会阻塞 timeout 秒，若按「本轮结束」排下一轮闹钟，
    // 周期会变成 timeout + interval（如 10 + 15 = 25s），消息最坏要等满 25 秒。
    // 改为从「本轮起点」排，周期收敛回 interval 本身。
    const deadline = Date.now() + interval;

    // 一开始就落闹钟：即便后面 import/poll 抛错，闹钟链也不会断
    await this.ctx.storage.setAlarm(deadline);

    try {
      const { createBot } = await import('./bot');
      const t0 = Date.now();
      // 连续长轮询：一轮 getUpdates 返回后立刻发下一轮。
      // 若每 interval 秒才开一次长连接，连接只覆盖前 interval-timeout 秒，
      // 剩下一段「盲窗」里来的点击/消息要干等下一轮（以前约 17% 的概率等满 10 秒）。
      // 这里用循环把连接覆盖率压到接近 100%，盲窗只剩两次连接切换的几十毫秒。
      let fetched = 0;
      let rounds = 0;
      while (rounds < MAX_ROUNDS_PER_CYCLE && deadline - Date.now() > 500) {
        const remainingSec = Math.ceil((deadline - Date.now()) / 1000);
        const r = await createBot(this.env).handlePoll(Math.min(POLL_TIMEOUT_CAP, remainingSec));
        fetched += r.fetched;
        rounds++;
        // 409 / 异常时立刻退出，等下一次闹钟重来，否则会死循环式反复撞同一条连接
        if (r.skipped) break;
      }
      const durationMs = Date.now() - t0;
      await this.ctx.storage.put('pollCount', (await this.#stat('pollCount')) + rounds);
      await this.ctx.storage.put('lastDurationMs', durationMs);
      if (fetched > 0) {
        await this.ctx.storage.put('lastFetched', fetched);
        log.info('Poll finished', { source: 'do-alarm', fetched, rounds, durationMs });
      }
    } catch (e) {
      // 失败也要续期，否则闹钟链断掉后整个 bot 静默失联
      log.error('PollerDO alarm error', { error: e });
    }

    // 下轮闹钟仍锚在本轮起点：即使上面处理得慢，也不会把耗时累加进周期
    await this.ctx.storage.setAlarm(deadline);
  }
}
