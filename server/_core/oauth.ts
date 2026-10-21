import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import { parse as parseCookies } from "cookie";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";
import { sessionIdentityProof } from "./sessionIdentity";
import {
  createOAuthLoginNonce, getOAuthLoginConfiguration, getOAuthLoginCookieName,
  getOAuthLoginCookieOptions, hashOAuthLoginNonce, isOAuthLoginNonce, OAUTH_LOGIN_STATE_TTL_MS,
  openOAuthLoginBinding, encryptOAuthLoginBinding,
} from "./oauthState";
import { createOAuthLoginState, consumeOAuthLoginState } from "./oauthStateDb";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/start", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    let configuration;
    try { configuration = getOAuthLoginConfiguration(); }
    catch {
      res.status(503).json({ error: "OAuth login is unavailable" });
      return;
    }
    const state = createOAuthLoginNonce();
    const binding = createOAuthLoginNonce();
    let sealedBinding: string;
    try {
      sealedBinding = encryptOAuthLoginBinding(binding, configuration.callbackUri);
      await createOAuthLoginState({ stateHash: hashOAuthLoginNonce(state), bindingHash: hashOAuthLoginNonce(binding),
        callbackUri: configuration.callbackUri });
    } catch {
      console.error("[OAuth] State storage unavailable");
      res.status(503).json({ error: "OAuth login is unavailable" });
      return;
    }
    res.cookie(getOAuthLoginCookieName(), sealedBinding, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" || getSessionCookieOptions(req).secure,
      path: process.env.NODE_ENV === "production" ? "/" : "/api/oauth",
      maxAge: OAUTH_LOGIN_STATE_TTL_MS,
    });
    const authorization = new URL(`${configuration.portalUrl}/app-auth`);
    authorization.search = new URLSearchParams({ appId: configuration.appId, redirectUri: configuration.callbackUri,
      state, type: "signIn" }).toString();
    res.redirect(302, authorization.href);
  });

  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const encryptedBinding = parseCookies(req.headers.cookie ?? "")[getOAuthLoginCookieName()];
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !isOAuthLoginNonce(state) || !encryptedBinding) {
      res.status(400).json({ error: "Invalid OAuth login attempt" });
      return;
    }

    let configuration;
    try { configuration = getOAuthLoginConfiguration(); }
    catch {
      res.status(503).json({ error: "OAuth login is unavailable" });
      return;
    }
    const binding = openOAuthLoginBinding(encryptedBinding, configuration.callbackUri);
    if (!binding) {
      res.status(400).json({ error: "Invalid OAuth login attempt" });
      return;
    }
    try {
      const consumed = await consumeOAuthLoginState({ stateHash: hashOAuthLoginNonce(state), bindingHash: hashOAuthLoginNonce(binding),
        callbackUri: configuration.callbackUri });
      if (!consumed) {
        res.status(400).json({ error: "Invalid OAuth login attempt" });
        return;
      }
    } catch {
      console.error("[OAuth] State storage unavailable");
      res.status(503).json({ error: "OAuth login is unavailable" });
      return;
    }

    res.clearCookie(getOAuthLoginCookieName(), getOAuthLoginCookieOptions(req));
    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, configuration.callbackUri);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);

      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }

      await db.upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: new Date(),
      });

      const account = await db.getUserByOpenId(userInfo.openId);
      if (!account) throw new Error("Account unavailable");
      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
        expectedIdentity: sessionIdentityProof(account),
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      res.redirect(302, "/");
    } catch {
      console.error("[OAuth] Callback failed");
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}
