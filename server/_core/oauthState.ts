import { createHash, randomBytes } from "node:crypto";
import type { CookieOptions, Request } from "express";
import { ENV } from "./env";
import { getSessionCookieOptions } from "./cookies";

export const OAUTH_LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_LOGIN_STATE_PREFIX = "oauth_login_state:";

export type OAuthLoginStateRecord = {
  stateHash: string;
  bindingHash: string;
  callbackUri: string;
};

export type OAuthLoginConfiguration = {
  appId: string;
  portalUrl: string;
  callbackUri: string;
};

function secureConfiguredUrl(value: string | undefined) {
  const configured = value?.trim() || "";
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.username || url.password || configured.includes("?") || configured.includes("#")
    || /^[^:]+:\/\/[^/]*@/.test(configured)) {
    throw new Error("Invalid OAuth configuration");
  }
  return url;
}

export function getOAuthLoginConfiguration(): OAuthLoginConfiguration {
  const publicUrl = process.env.PUBLIC_URL?.trim();
  const origin = new URL(publicUrl || "");
  const localHttp = process.env.NODE_ENV !== "production" && origin.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if ((origin.protocol !== "https:" && !localHttp) || origin.username || origin.password
    || origin.search || origin.hash || (publicUrl !== origin.origin && publicUrl !== `${origin.origin}/`)) {
    throw new Error("Invalid OAuth configuration");
  }
  const portal = secureConfiguredUrl(process.env.VITE_OAUTH_PORTAL_URL);
  secureConfiguredUrl(ENV.oAuthServerUrl);
  const appId = ENV.appId?.trim();
  if (!appId) throw new Error("Invalid OAuth configuration");
  return { appId, portalUrl: portal.href.replace(/\/$/, ""), callbackUri: `${origin.origin}/api/oauth/callback` };
}

export function createOAuthLoginNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function isOAuthLoginNonce(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

export function hashOAuthLoginNonce(value: string): string {
  if (!isOAuthLoginNonce(value)) throw new Error("Invalid OAuth nonce");
  return createHash("sha256").update(value).digest("hex");
}

export function getOAuthLoginCookieName(): string {
  return process.env.NODE_ENV === "production" ? "__Host-va_oauth_binding" : "va_oauth_binding";
}

export function getOAuthLoginCookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: getSessionCookieOptions(req).secure,
    path: process.env.NODE_ENV === "production" ? "/" : "/api/oauth",
  };
}
