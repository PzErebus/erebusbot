/**
 * 反垃圾单元测试：滑动窗口限流 + 广告特征识别
 *
 * 两个函数均为模块级纯逻辑（内存态），配合 resetAntiSpamState() 做测试隔离。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, matchAd, resetAntiSpamState } from '../src/bot';

describe('滑动窗口限流 checkRateLimit', () => {
  beforeEach(() => resetAntiSpamState());

  it('窗口内前 5 条放行', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(42, t0 + i * 1000).allowed).toBe(true);
    }
  });

  it('窗口内第 6 条被拦截，且累计违规次数递增', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) checkRateLimit(42, t0 + i * 1000);
    const first = checkRateLimit(42, t0 + 6000);
    expect(first.allowed).toBe(false);
    expect(first.violations).toBe(1);
    const second = checkRateLimit(42, t0 + 7000);
    expect(second.allowed).toBe(false);
    expect(second.violations).toBe(2);
  });

  it('窗口滑过后重新放行（10 秒前的消息不再计入）', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) checkRateLimit(42, t0 + i * 1000);
    // 第 6 条在窗口内 → 拦截
    expect(checkRateLimit(42, t0 + 6000).allowed).toBe(false);
    // 超过窗口期后 → 放行
    expect(checkRateLimit(42, t0 + 11_000).allowed).toBe(true);
  });

  it('不同用户互不影响', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) checkRateLimit(1, t0);
    expect(checkRateLimit(2, t0).allowed).toBe(true);
  });
});

describe('广告特征识别 matchAd', () => {
  it('命中博彩类', () => {
    expect(matchAd('澳门在线博彩平台')).toBe('博彩');
  });

  it('命中刷单兼职类', () => {
    expect(matchAd('日结300 刷单兼职了解一下')).toBe('刷量兼职');
  });

  it('命中引流联系方式', () => {
    expect(matchAd('有问题加我微信详聊')).toBe('引流联系方式');
    expect(matchAd('联系vx:abc123')).toBe('引流联系方式');
  });

  it('命中 QQ 号引流', () => {
    expect(matchAd('进群交流 扣扣：123456789')).toBe('QQ号引流');
  });

  it('命中拉群外链', () => {
    expect(matchAd('快来 t.me/abc12345 领福利')).toBe('拉群外链');
  });

  it('命中字符刷屏', () => {
    expect(matchAd('哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈')).toBe('字符刷屏');
  });

  it('正常消息不误报（含普通链接、数字、价格）', () => {
    expect(matchAd('你好，我想咨询一下这个商品')).toBeNull();
    expect(matchAd('订单号是 202610020001，帮我查下')).toBeNull();
    // 普通网站链接不拦（只拦 t.me 拉群链接）
    expect(matchAd('可以看下 https://example.com/product/123')).toBeNull();
    expect(matchAd('这个多少钱？能便宜点吗')).toBeNull();
  });
});
