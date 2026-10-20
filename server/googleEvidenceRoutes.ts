import { createHash, createHmac, createSecretKey, randomBytes, timingSafeEqual } from "crypto";
import { parse as parseCookies } from "cookie";
import express, { type Request, type Response } from "express";
import { getSessionCookieOptions } from "./_core/cookies";
import { requireActiveWorkerProfile } from "./middleware/auth";
import {
  clearGoogleMailDeliveryConnection,
  clearGoogleRefreshToken,
  consumeGoogleOAuthState,
  getGoogleMailDeliveryStatus,
  saveGoogleOAuthState,
  saveGoogleMailDeliveryConnection,
  saveGoogleRefreshToken,
} from "./googleEvidence";

const router = express.Router();
router.use((req: Request & { user?: { id: number; role: string } | null }, res, next) => {
  const isOAuthCallback = req.path === "/callback" || req.path === "/mail-delivery/callback";
  if (isOAuthCallback && !req.user) return next();
  return requireActiveWorkerProfile(req, res, next);
});
const OAUTH_COOKIE = "google_evidence_oauth";
const MAIL_DELIVERY_OAUTH_COOKIE = "google_mail_delivery_oauth";
const OAUTH_MAX_AGE_MS = 10 * 60 * 1_000;
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

type OAuthState = {
  vaId: number;
  nonce: string;
  expiresAt: number;
};

type OAuthCookie = OAuthState & {
  state: string;
  codeVerifier: string;
};

type MailDeliveryOAuthState = {
  userId: number;
  nonce: string;
  expiresAt: number;
};

type MailDeliveryOAuthCookie = MailDeliveryOAuthState & {
  state: string;
  codeVerifier: string;
};

function secret() {
  const value = process.env.JWT_SECRET?.trim();
  if (!value || value.length < 32) throw new Error("JWT_SECRET is required for Google OAuth");
  return value;
}

function sign(value: string) {
  return createHmac("sha256", createSecretKey(Buffer.from(secret(), "utf8"))).update(value).digest("base64url");
}

// PKCE hashes a canonical, high-entropy protocol nonce, never a user password.
export function googlePkceChallenge(nonce: string) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(nonce)) throw new Error("Invalid PKCE nonce");
  const bytes = Buffer.from(nonce, "base64url");
  if (bytes.length < 32 || bytes.toString("base64url") !== nonce) throw new Error("Invalid PKCE nonce");
  return createHash("sha256").update(nonce).digest("base64url");
}

function encodeSignedJson(value: object) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function decodeSignedJson<T>(value: string | undefined): T | null {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function redirectBaseUrl(req: Request) {
  // The Trello callback is also a server-owned, public URL. Reusing its origin
  // keeps OAuth and webhook configuration aligned without trusting request
  // headers in production.
  const configured = process.env.PUBLIC_URL?.trim()
    || process.env.WEBHOOK_BASE_URL?.trim()
    || process.env.TRELLO_WEBHOOK_CALLBACK_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("PUBLIC_URL must be an HTTP(S) URL");
    return url.origin;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("A configured public URL is required for Google OAuth in production");
  }
  const host = req.get("host");
  if (!host) throw new Error("Unable to determine the dashboard URL");
  const protocol = req.get("x-forwarded-proto") || req.protocol || "http";
  return `${protocol}://${host}`;
}

function googleClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Google OAuth needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server");
  return { clientId, clientSecret };
}

function clearOauthCookie(req: Request, res: Response) {
  res.clearCookie(OAUTH_COOKIE, getSessionCookieOptions(req));
}

function redirectSettings(res: Response, result: "connected" | "error") {
  res.redirect(`/worker/settings?google=${result}`);
}

function redirectMailSettings(res: Response, result: "connected" | "error") {
  res.redirect(`/settings?gmailDelivery=${result}`);
}

function isAdmin(req: Request & { user?: { id: number; role: string } | null }) {
  return req.user?.role === "admin";
}

function requireRole(
  req: Request & { user?: { id: number; role: string } | null },
  res: Response,
  role: "admin" | "worker",
): req is Request & { user: { id: number; role: string } } {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  if (req.user.role !== role) {
    res.status(403).json({ error: role === "admin" ? "An administrator session is required" : "A worker session is required" });
    return false;
  }
  return true;
}

async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null) as { refresh_token?: unknown; access_token?: unknown } | null;
  if (!response.ok || typeof body?.refresh_token !== "string" || !body.refresh_token || typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("Google did not return the required mail delivery credential");
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token };
}

router.get("/connect", async (req: Request & { user?: { id: number; role: string } | null }, res: Response) => {
  try {
    if (!requireRole(req, res, "worker")) return;
    const { clientId } = googleClient();
    const redirectUri = `${redirectBaseUrl(req)}/api/google-evidence/callback`;
    const now = Date.now();
    const statePayload: OAuthState = {
      vaId: req.user.id,
      nonce: randomBytes(24).toString("base64url"),
      expiresAt: now + OAUTH_MAX_AGE_MS,
    };
    const state = encodeSignedJson(statePayload);
    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = googlePkceChallenge(codeVerifier);
    const cookie: OAuthCookie = { ...statePayload, state, codeVerifier };
    await saveGoogleOAuthState("worker", statePayload.vaId, statePayload.nonce, statePayload.expiresAt);
    res.cookie(OAUTH_COOKIE, encodeSignedJson(cookie), {
      ...getSessionCookieOptions(req),
      httpOnly: true,
      secure: getSessionCookieOptions(req).secure,
      maxAge: OAUTH_MAX_AGE_MS,
    });

    const authorization = new URL(GOOGLE_AUTHORIZE_URL);
    authorization.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      scope: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/drive.metadata.readonly",
      ].join(" "),
    }).toString();
    return res.redirect(authorization.toString());
  } catch {
    console.error("[GoogleEvidence] Unable to start OAuth");
    return res.status(500).json({ error: "Unable to start the Google connection. Check the server OAuth configuration." });
  }
});

router.get("/callback", async (req: Request & { user?: { id: number; role: string } | null }, res: Response) => {
  const clearAndError = () => {
    clearOauthCookie(req, res);
    redirectSettings(res, "error");
  };
  try {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const incomingState = typeof req.query.state === "string" ? req.query.state : null;
    const error = typeof req.query.error === "string" ? req.query.error : null;
    const cookies = parseCookies(req.headers.cookie ?? "");
    const stored = decodeSignedJson<OAuthCookie>(cookies[OAUTH_COOKIE]);
    const state = decodeSignedJson<OAuthState>(incomingState ?? undefined);
    if (error || !code || !stored || !state || stored.expiresAt < Date.now() || state.expiresAt < Date.now()
      || stored.state !== incomingState || stored.nonce !== state.nonce || stored.vaId !== state.vaId
      || !req.user || req.user.role !== "worker" || req.user.id !== state.vaId) {
      return clearAndError();
    }
    if (!await consumeGoogleOAuthState("worker", state.vaId, state.nonce, state.expiresAt)) {
      return clearAndError();
    }
    const { clientId, clientSecret } = googleClient();
    const redirectUri = `${redirectBaseUrl(req)}/api/google-evidence/callback`;
    const tokens = await exchangeAuthorizationCode({ code, clientId, clientSecret, redirectUri, codeVerifier: stored.codeVerifier });
    await saveGoogleRefreshToken(state.vaId, tokens.refreshToken);
    clearOauthCookie(req, res);
    return redirectSettings(res, "connected");
  } catch {
    console.error("[GoogleEvidence] OAuth callback failed");
    return clearAndError();
  }
});

router.get("/mail-delivery/status", async (req: Request & { user?: { id: number; role: string } | null }, res: Response) => {
  try {
    if (!requireRole(req, res, "admin")) return;
    return res.json(await getGoogleMailDeliveryStatus());
  } catch {
    console.error("[GoogleMailDelivery] Unable to read status");
    return res.status(500).json({ error: "Unable to read Gmail delivery status" });
  }
});

router.get("/mail-delivery/connect", async (req: Request & { user?: { id: number; role: string } | null }, res: Response) => {
  try {
    if (!requireRole(req, res, "admin")) return;
    const { clientId } = googleClient();
    const redirectUri = `${redirectBaseUrl(req)}/api/google-evidence/mail-delivery/callback`;
    const now = Date.now();
    const statePayload: MailDeliveryOAuthState = {
      userId: req.user!.id,
      nonce: randomBytes(24).toString("base64url"),
      expiresAt: now + OAUTH_MAX_AGE_MS,
    };
    const state = encodeSignedJson(statePayload);
    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = googlePkceChallenge(codeVerifier);
    const cookie: MailDeliveryOAuthCookie = { ...statePayload, state, codeVerifier };
    await saveGoogleOAuthState("mail-delivery", statePayload.userId, statePayload.nonce, statePayload.expiresAt);
    res.cookie(MAIL_DELIVERY_OAUTH_COOKIE, encodeSignedJson(cookie), {
      ...getSessionCookieOptions(req),
      httpOnly: true,
      secure: getSessionCookieOptions(req).secure,
      maxAge: OAUTH_MAX_AGE_MS,
    });

    const authorization = new URL(GOOGLE_AUTHORIZE_URL);
    authorization.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      scope: ["openid", "email", "https://www.googleapis.com/auth/gmail.send"].join(" "),
    }).toString();
    return res.redirect(authorization.toString());
  } catch {
    console.error("[GoogleMailDelivery] Unable to start OAuth");
    return res.status(500).json({ error: "Unable to start Gmail delivery setup. Check the server OAuth configuration." });
  }
});

router.get("/mail-delivery/callback", async (req: Request & { user?: { id: number; role: string } | null }, res: Response) => {
  const clearAndError = () => {
    res.clearCookie(MAIL_DELIVERY_OAUTH_COOKIE, getSessionCookieOptions(req));
    redirectMailSettings(res, "error");
  };
  try {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const incomingState = typeof req.query.state === "string" ? req.query.state : null;
    const error = typeof req.query.error === "string" ? req.query.error : null;
    const cookies = parseCookies(req.headers.cookie ?? "");
    const stored = decodeSignedJson<MailDeliveryOAuthCookie>(cookies[MAIL_DELIVERY_OAUTH_COOKIE]);
    const state = decodeSignedJson<MailDeliveryOAuthState>(incomingState ?? undefined);
    if (error || !code || !stored || !state || stored.expiresAt < Date.now() || state.expiresAt < Date.now()
      || stored.state !== incomingState || stored.nonce !== state.nonce || stored.userId !== state.userId
      || !isAdmin(req) || req.user!.id !== state.userId) {
      return clearAndError();
    }
    if (!await consumeGoogleOAuthState("mail-delivery", state.userId, state.nonce, state.expiresAt)) {
      return clearAndError();
    }
    const { clientId, clientSecret } = googleClient();
    const redirectUri = `${redirectBaseUrl(req)}/api/google-evidence/mail-delivery/callback`;
    const tokens = await exchangeAuthorizationCode({ code, clientId, clientSecret, redirectUri, codeVerifier: stored.codeVerifier });
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const profile = await profileResponse.json().catch(() => null) as { email?: unknown; email_verified?: unknown } | null;
    if (!profileResponse.ok || typeof profile?.email !== "string" || !profile.email || profile.email_verified !== true) {
      return clearAndError();
    }
    await saveGoogleMailDeliveryConnection(tokens.refreshToken, profile.email);
    res.clearCookie(MAIL_DELIVERY_OAUTH_COOKIE, getSessionCookieOptions(req));
    return redirectMailSettings(res, "connected");
  } catch {
    console.error("[GoogleMailDelivery] OAuth callback failed");
    return clearAndError();
  }
});

router.post("/mail-delivery/disconnect", async (req: Request & { user?: { id: number; role: string } | null }, res: Response) => {
  try {
    if (!requireRole(req, res, "admin")) return;
    await clearGoogleMailDeliveryConnection();
    return res.json({ success: true });
  } catch {
    console.error("[GoogleMailDelivery] Unable to disconnect");
    return res.status(500).json({ error: "Unable to remove Gmail delivery access" });
  }
});

router.post("/disconnect", async (req: Request & { user?: { id: number; role: string } | null }, res: Response) => {
  try {
    if (!requireRole(req, res, "worker")) return;
    await clearGoogleRefreshToken(req.user.id);
    return res.json({ success: true });
  } catch {
    console.error("[GoogleEvidence] Unable to disconnect OAuth");
    return res.status(500).json({ error: "Unable to remove the Google connection" });
  }
});

export default router;
