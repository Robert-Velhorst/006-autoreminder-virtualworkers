import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { CookieOptions, Request } from "express";
import { ENV } from "./env";
import { getSessionCookieOptions } from "./cookies";

export const OAUTH_LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_LOGIN_STATE_PREFIX = "oauth_login_state:";
const BINDING_CONTEXT = "va-dashboard:oauth-binding:v1\0";

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

function bindingSecret(): string {
  const secret = ENV.cookieSecret;
  if (typeof secret !== "string" || Buffer.byteLength(secret.trim(), "utf8") < 32) {
    throw new Error("Invalid OAuth configuration");
  }
  return secret;
}

function bindingKey() {
  return createHash("sha256").update(BINDING_CONTEXT).update(bindingSecret()).digest();
}

function bindingAad(callbackUri: string) {
  return Buffer.from(`${BINDING_CONTEXT}${callbackUri}`, "utf8");
}

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
  bindingSecret();
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

export function encryptOAuthLoginBinding(binding: string, callbackUri: string): string {
  if (!isOAuthLoginNonce(binding)) throw new Error("Invalid OAuth nonce");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", bindingKey(), iv, { authTagLength: 16 });
  cipher.setAAD(bindingAad(callbackUri));
  const ciphertext = Buffer.concat([cipher.update(binding, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

export function openOAuthLoginBinding(cookie: string, callbackUri: string): string | null {
  if (typeof cookie !== "string" || cookie.length !== 101) return null;
  const components = cookie.split(".");
  if (components.length !== 4 || components[0] !== "v1") return null;
  const sizes = [12, 43, 16];
  const bytes = components.slice(1).map((value, index) => {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === sizes[index] && decoded.toString("base64url") === value ? decoded : null;
  });
  const [iv, ciphertext, tag] = bytes;
  if (!iv || !ciphertext || !tag) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", bindingKey(), iv, { authTagLength: 16 });
    decipher.setAAD(bindingAad(callbackUri));
    decipher.setAuthTag(tag);
    const binding = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return isOAuthLoginNonce(binding) ? binding : null;
  } catch {
    return null;
  }
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
