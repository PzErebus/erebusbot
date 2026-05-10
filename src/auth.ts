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
    if (apiKey === env.ADMIN_API_KEY) {
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

async function verifyJWT(token: string, env: Env): Promise<AuthResult> {
  try {
    if (!env.ADMIN_JWT_SECRET) {
      return { success: false, error: 'JWT verification not configured' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { success: false, error: 'Invalid token format' };
    }

    const [, payloadB64, signatureB64] = parts;

    try {
      const payload = JSON.parse(atob(payloadB64)) as JWTPayload;

      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        return { success: false, error: 'Token expired' };
      }

      if (payload.role !== 'admin') {
        return { success: false, error: 'Insufficient permissions' };
      }

      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(env.ADMIN_JWT_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
      );

      const signature = Uint8Array.from(atob(signatureB64), c => c.charCodeAt(0));
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