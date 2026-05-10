// 安全工具模块 - HTTP安全头、CSP、CORS

// 内容安全策略(CSP)头
export function generateCSPHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
  };
}

// CORS头配置
export function generateCORSHeaders(allowedOrigin?: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': allowedOrigin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Max-Age': '86400'
  };
}

// 处理CORS预检请求
export function handleCORSOptionsRequest(allowedOrigin?: string): Response {
  return new Response(null, {
    status: 204,
    headers: generateCORSHeaders(allowedOrigin)
  });
}

// 安全响应头
export function generateSecurityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  };
}

// 创建安全JSON响应
export function createSafeResponse(
  body: unknown,
  status: number = 200,
  additionalHeaders: HeadersInit = {}
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...generateSecurityHeaders()
  });

  if (additionalHeaders) {
    if (additionalHeaders instanceof Headers) {
      additionalHeaders.forEach((value, key) => { headers.set(key, value); });
    } else if (Array.isArray(additionalHeaders)) {
      additionalHeaders.forEach(([key, value]) => { headers.set(key, value); });
    } else {
      Object.entries(additionalHeaders).forEach(([key, value]) => { headers.set(key, value); });
    }
  }

  return new Response(JSON.stringify(body), { status, headers });
}