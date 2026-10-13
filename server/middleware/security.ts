import type { NextFunction, Request, Response } from "express";

function contentSecurityPolicy(hostname: string) {
  const development = process.env.NODE_ENV === "development";
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  // Keep Vite's development-only eval compatibility bound to loopback origins.
  // A development server exposed through a tunnel retains the stricter policy.
  const localDevelopment = development && loopback;
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    localDevelopment
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : development
        ? "script-src 'self' 'unsafe-inline'"
        : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    localDevelopment ? "connect-src 'self' wss: ws:" : "connect-src 'self' wss:",
  ].join("; ");
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", contentSecurityPolicy(_req.hostname));
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
