/**
 * Admin API 鉴权链路集成测试
 *
 * 覆盖：公开端点 / 后台页面下发 / 登录端点签发令牌 / 数据接口强制鉴权。
 * 之前 dashboard 前端所有 fetch 都不带凭据导致表格全 401，这里锁死行为。
 */
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { authenticateAdminRequest, issueAdminToken, secureEqual } from '../src/auth';
import type { Env } from '../src/types';

const API_KEY = 'test-admin-api-key';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    BOT_D1: {} as never,
    BOT_TOKEN: '123456:TEST',
    ADMIN_USER_ID: '1001',
    ADMIN_API_KEY: API_KEY,
    LANGUAGE: 'zh-CN',
    ENVIRONMENT: 'production',
    ...overrides
  } as Env;
}

// 每个用例用独立 IP，避免互相触发登录限速
let ipSeq = 0;
async function call(path: string, init: Record<string, unknown> = {}, env = makeEnv()): Promise<Response> {
  const headers = new Headers(init.headers as Record<string, string>);
  if (!headers.get('CF-Connecting-IP')) {
    headers.set('CF-Connecting-IP', `10.0.0.${++ipSeq}`);
  }
  const request = new Request(`https://erebus.test${path}`, {
    method: init.method as string,
    headers,
    body: init.body as BodyInit
  });
  return worker.fetch(request, env);
}

describe('公开端点', () => {
  it('/health 无需认证即可访问', async () => {
    const res = await call('/health', {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
  });

  it('/ 返回服务信息', async () => {
    const res = await call('/', {});
    expect(res.status).toBe(200);
  });
});

describe('后台页面 /admin', () => {
  it('未携带凭据时仍然下发后台页面（前端弹出登录浮层）', async () => {
    const res = await call('/admin', {});
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ErebusBot');
    expect(html).toContain('loginMask');
  });

  it('携带有效 API Key 时也返回后台页面', async () => {
    const res = await call('/admin', { headers: { 'X-API-Key': API_KEY } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ErebusBot');
  });
});

describe('数据接口强制鉴权', () => {
  it('无凭据访问 /admin/api/stats 返回 401', async () => {
    const res = await call('/admin/api/stats', {});
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBeTruthy();
  });

  it('已过期/被篡改的令牌无法访问数据接口', async () => {
    const token = await issueAdminToken(makeEnv());
    const tampered = `${token.slice(0, -4)}AAAA`;
    const res = await call('/admin/api/stats', { headers: { Authorization: `Bearer ${tampered}` } });
    expect(res.status).toBe(401);
  });

  it('合法令牌可以通过鉴权（不再返回 401）', async () => {
    const token = await issueAdminToken(makeEnv());
    const res = await call('/admin/api/stats', {
      headers: { Authorization: `Bearer ${token}` },
      method: 'GET'
    });
    expect(res.status).not.toBe(401);
  });
});

describe('登录端点 /admin/api/auth/login', () => {
  it('错误 API Key 返回 401 Invalid credentials', async () => {
    const res = await call('/admin/api/auth/login', {
      method: 'POST',
      headers: { 'X-API-Key': 'wrong-key' }
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid credentials');
  });

  it('缺少凭据返回 401 Invalid credentials', async () => {
    const res = await call('/admin/api/auth/login', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('正确 API Key 签发可用令牌', async () => {
    const res = await call('/admin/api/auth/login', {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY }
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { token: string; tokenType: string; expiresIn: number };
    expect(data.token).toBeTruthy();
    expect(data.tokenType).toBe('Bearer');
    expect(data.expiresIn).toBeGreaterThan(0);

    // 签出来的令牌必须能通过现有的 authenticateAdminRequest
    const authRequest = new Request('https://erebus.test/admin/api/stats', {
      headers: { Authorization: `Bearer ${data.token}` }
    });
    const auth = await authenticateAdminRequest(authRequest, makeEnv());
    expect(auth.success).toBe(true);
    expect(auth.role).toBe('admin');
  });

  it('Bearer 通道只认 JWT，不认原始 API Key（避免混淆两个凭据通道）', async () => {
    const authRequest = new Request('https://erebus.test/admin/api/stats', {
      headers: { Authorization: `Bearer ${API_KEY}` }
    });
    const auth = await authenticateAdminRequest(authRequest, makeEnv());
    expect(auth.success).toBe(false);
  });

  it('非 POST 方法返回 405', async () => {
    const res = await call('/admin/api/auth/login', { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('未配置 ADMIN_API_KEY 时返回 503 而不是 401', async () => {
    const res = await call(
      '/admin/api/auth/login',
      { method: 'POST', headers: { 'X-API-Key': API_KEY } },
      makeEnv({ ADMIN_API_KEY: undefined })
    );
    expect(res.status).toBe(503);
  });
});

describe('令牌签发与比较', () => {
  it('签出的 JWT 结构为三段式且角色为 admin', async () => {
    const token = await issueAdminToken(makeEnv(), 'alice');
    const parts = token.split('.');
    expect(parts).toHaveLength(3);

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    expect(payload.role).toBe('admin');
    expect(payload.userId).toBe('alice');
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it('未配置 ADMIN_JWT_SECRET 时由 ADMIN_API_KEY 派生密钥，签发的令牌依然可校验', async () => {
    const token = await issueAdminToken(makeEnv());
    expect(makeEnv().ADMIN_JWT_SECRET).toBeUndefined();

    const auth = await authenticateAdminRequest(
      new Request('https://erebus.test/x', { headers: { Authorization: `Bearer ${token}` } }),
      makeEnv()
    );
    expect(auth.success).toBe(true);
  });

  it('显式配置 ADMIN_JWT_SECRET 时优先使用该密钥，换成别的密钥则校验失败', async () => {
    const envA = makeEnv({ ADMIN_JWT_SECRET: 'secret-a' });
    const envB = makeEnv({ ADMIN_JWT_SECRET: 'secret-b' });
    const tokenA = await issueAdminToken(envA);

    const ok = await authenticateAdminRequest(
      new Request('https://erebus.test/x', { headers: { Authorization: `Bearer ${tokenA}` } }),
      envA
    );
    expect(ok.success).toBe(true);

    const bad = await authenticateAdminRequest(
      new Request('https://erebus.test/x', { headers: { Authorization: `Bearer ${tokenA}` } }),
      envB
    );
    expect(bad.success).toBe(false);
  });

  it('非 ASCII 的 userId 也能正确校验（base64url 解码支持 UTF-8）', async () => {
    const token = await issueAdminToken(makeEnv(), '管理员');
    const auth = await authenticateAdminRequest(
      new Request('https://erebus.test/x', { headers: { Authorization: `Bearer ${token}` } }),
      makeEnv()
    );
    expect(auth.success).toBe(true);
    expect(auth.userId).toBe('管理员');
  });

  it('secureEqual 对相同内容返回 true', async () => {
    expect(await secureEqual('abc', 'abc')).toBe(true);
  });

  it('secureEqual 对前缀相同但不同的内容返回 false', async () => {
    expect(await secureEqual('abcdef', 'abcdf')).toBe(false);
  });
});
