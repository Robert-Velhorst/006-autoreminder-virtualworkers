import { parseCookie as parseCookies } from 'cookie';
import type { NextFunction, Request, Response } from 'express';
import { COOKIE_NAME } from '@shared/const';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function toOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function configuredOrigins(env: NodeJS.ProcessEnv = process.env) {
  return [env.PUBLIC_URL, env.WEBHOOK_BASE_URL, env.APP_URL, env.VITE_FRONTEND_URL]
    .map(toOrigin)
    .filter((origin): origin is string => Boolean(origin));
}

function requestOrigin(req: Request) {
  const host = req.get('host');
  if (!host) return null;
  return toOrigin(`${req.protocol}://${host}`);
}

function submittedOrigin(req: Request) {
  const origin = toOrigin(req.get('origin'));
  if (origin) return origin;
  return toOrigin(req.get('referer'));
}

function hasSessionCookie(req: Request) {
  return Boolean(parseCookies(req.headers.cookie ?? '')[COOKIE_NAME]);
}

/**
 * Reject cross-site browser writes performed with a dashboard session cookie.
 * Bearer-token integrations, webhooks, and login/bootstrap requests have no
 * existing session cookie and therefore remain outside this browser-only gate.
 */
export function requireTrustedSessionOrigin(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method.toUpperCase()) || !(req as Request & { user?: unknown }).user || !hasSessionCookie(req)) {
    return next();
  }

  const source = submittedOrigin(req);
  const trusted = new Set([requestOrigin(req), ...configuredOrigins()].filter((origin): origin is string => Boolean(origin)));
  if (!source || !trusted.has(source)) {
    return res.status(403).json({ error: 'Cross-site browser mutation rejected' });
  }
  return next();
}
