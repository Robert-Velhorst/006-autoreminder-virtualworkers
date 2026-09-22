import type { NextFunction, Request, Response } from "express";

function contentSecurityPolicy() {
  // Vite's React refresh preamble is inline and HTTP development uses WS for HMR.
  // Match the canonical startup's explicit development check; all other modes stay strict.
  const development = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    development ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    development ? "connect-src 'self' wss: ws:" : "connect-src 'self' wss:",
  ].join("; ");
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", contentSecurityPolicy());
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Keep authenticated dashboard windows and resources same-origin isolated.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Origin-Agent-Cluster", "?1");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  if (_req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

export function getRequestBodyLimit(env = process.env) {
  const configured = env.REQUEST_BODY_LIMIT?.trim().toLowerCase();
  return configured && /^\d+(?:b|kb|mb)$/.test(configured) ? configured : "2mb";
}
