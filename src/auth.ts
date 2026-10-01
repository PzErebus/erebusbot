// 认证和授权模块 - Admin API安全访问控制

import type { Env } from './types';
import { createLogger } from './logger';

const log = createLogger('auth');

export interface AuthResult {
  success: boolean;
  userId?: string;
  role?: string;
  error?: string;
}

interface JWTPayload {
  userId: string;
  role: 'admin' | 'user';
  iat: number;
  exp: number;
}

export async function authenticateAdminRequest(request: Request, env: Env): Promise<AuthResult> {
  if (!env.ADMIN_API_KEY && !env.ADMIN_USER_ID) {
    return { success: false, error: 'Admin authentication not configured' };
  }

  const authHeader = request.headers.get('Authorization');
  const apiKey = request.headers.get('X-API-Key');

  if (apiKey && env.ADMIN_API_KEY) {
    if (await secureEqual(apiKey, env.ADMIN_API_KEY)) {
      return { success: true, userId: 'system', role: 'admin' };
    }
    return { success: false, error: 'Invalid API key' };
  }

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const result = await verifyJWT(token, env);
    if (result.success && result.role === 'admin') {
      return result;
    }
    return { success: false, error: 'Invalid or expired token' };
  }

  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  const devToken = request.headers.get('X-Dev-Token');

  if (env.ENVIRONMENT === 'development' &&
      (clientIP === '127.0.0.1' || clientIP === '::1') &&
      devToken === env.DEV_ACCESS_TOKEN) {
    log.warn('Development mode access from localhost');
    return { success: true, userId: 'dev', role: 'admin' };
  }

  return { success: false, error: 'Authentication required' };
}

/**
 * base64url → bytes。
 * 注意：不能直接用 atob 解 base64url —— Node 的 atob 不接受 '-'/'_'，
 * 而 Cloudflare Workers 的实现却是宽容的；统一在这里归一化，保证跨运行时一致。
 */
function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  let normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4 !== 0) normalized += '=';
  const binary = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * JWT 签名密钥：优先使用 ADMIN_JWT_SECRET，
 * 未配置时由 ADMIN_API_KEY 派生（保证同一部署内稳定，轮换 API Key 后旧令牌自动失效）。
 */
async function resolveJwtSecret(env: Env): Promise<string> {
  if (env.ADMIN_JWT_SECRET) return env.ADMIN_JWT_SECRET;
  if (!env.ADMIN_API_KEY) throw new Error('Admin authentication not configured');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`erebusbot:jwt:${env.ADMIN_API_KEY}`)
  );
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 签发管理员会话 JWT（默认 12 小时有效期） */
export async function issueAdminToken(
  env: Env,
  userId = 'system',
  ttlSeconds = 12 * 3600
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: JWTPayload = {
    userId,
    role: 'admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  };

  const secret = await resolveJwtSecret(env);
  const encodedHead = base64UrlEncodeString(JSON.stringify(header));
  const encodedPayload = base64UrlEncodeString(JSON.stringify(payload));
  const data = `${encodedHead}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));

  return `${data}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

/**
 * 常量时间比较：先做 SHA-256 摘要再逐字节比对，
 * 避免密钥比较时泄露时序信息。
 */
export async function secureEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b))
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function verifyJWT(token: string, env: Env): Promise<AuthResult> {
  try {
    // 优先显式密钥，未配置时回落到由 ADMIN_API_KEY 派生的密钥（与签发端一致）
    let jwtSecret: string;
    try {
      jwtSecret = env.ADMIN_JWT_SECRET || (await resolveJwtSecret(env));
    } catch {
      return { success: false, error: 'JWT verification not configured' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { success: false, error: 'Invalid token format' };
    }

    const [, payloadB64, signatureB64] = parts;

    try {
      const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64))) as JWTPayload;

      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        return { success: false, error: 'Token expired' };
      }

      if (payload.role !== 'admin') {
        return { success: false, error: 'Insufficient permissions' };
      }

      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(jwtSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
      );

      const signature = base64UrlToBytes(signatureB64);
      const data = encoder.encode(`${parts[0]}.${payloadB64}`);

      const isValid = await crypto.subtle.verify('HMAC', key, signature, data);

      if (!isValid) {
        return { success: false, error: 'Invalid token signature' };
      }

      return { success: true, userId: payload.userId, role: payload.role };
    } catch {
      return { success: false, error: 'Invalid token payload' };
    }
  } catch (error) {
    log.error('JWT verification error', { error });
    return { success: false, error: 'Token verification failed' };
  }
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
  expiresAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
let lastCleanupTime = 0;

function cleanupExpiredRateLimits(): void {
  const now = Math.floor(Date.now() / 1000);
  if (now - lastCleanupTime < 300) return;
  lastCleanupTime = now;
  for (const [key, entry] of rateLimitStore) {
    if (entry.expiresAt < now) {
      rateLimitStore.delete(key);
    }
  }
}

export async function checkRateLimit(
  identifier: string,
  action: string,
  env: Env,
  maxRequests: number = 100,
  windowSeconds: number = 60
): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
  const key = `ratelimit:${identifier}:${action}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const expiresAt = windowStart + windowSeconds;

  cleanupExpiredRateLimits();

  try {
    const existing = rateLimitStore.get(key);

    if (!existing || existing.windowStart < windowStart || existing.expiresAt < now) {
      rateLimitStore.set(key, { count: 1, windowStart, expiresAt });
      return { allowed: true, remaining: maxRequests - 1, resetTime: expiresAt };
    }

    if (existing.count >= maxRequests) {
      return { allowed: false, remaining: 0, resetTime: existing.expiresAt };
    }

    existing.count++;
    rateLimitStore.set(key, existing);

    return { allowed: true, remaining: maxRequests - existing.count, resetTime: existing.expiresAt };
  } catch {
    return { allowed: true, remaining: 0, resetTime: now + windowSeconds };
  }
}

export function createAuthHeaders(rateLimitRemaining: number, rateLimitReset: number): HeadersInit {
  return {
    'X-RateLimit-Remaining': String(rateLimitRemaining),
    'X-RateLimit-Reset': String(rateLimitReset),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
  };
}

export function createUnauthorizedResponse(message: string = 'Unauthorized'): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' }
  });
}

export function createRateLimitResponse(retryAfter: number): Response {
  return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) }
  });
}