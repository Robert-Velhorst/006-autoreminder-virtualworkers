import { AXIOS_TIMEOUT_MS, COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import axios, { type AxiosInstance } from "axios";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { randomUUID } from "crypto";
import type { User } from "../../drizzle/schema.postgres";
import * as db from "../db";
import { ENV } from "./env";
import type {
  ExchangeTokenRequest,
  ExchangeTokenResponse,
  GetUserInfoResponse,
  GetUserInfoWithJwtRequest,
  GetUserInfoWithJwtResponse,
} from "./types/manusTypes";
import { resolveLocalBypassUser } from "./localAuthBypass";
import { getSessionAudience, isSessionEpoch, type SessionIdentityProof } from "./sessionIdentity";
import { withSessionIdentity } from "../sessionLifecycle";
import { getOAuthLoginConfiguration } from "./oauthState";
// Utility function
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  openId: string;
  appId: string;
  name: string;
  sessionId?: string;
};

const EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
const GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
const GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;

class OAuthService {
  constructor(private client: ReturnType<typeof axios.create>) {
    if (ENV.oAuthServerUrl) {
      console.log("[OAuth] External OAuth compatibility enabled");
    } else {
      console.log("[OAuth] External OAuth disabled; local and Trello sessions remain available");
    }
  }

  async getTokenByCode(
    code: string,
    redirectUri: string
  ): Promise<ExchangeTokenResponse> {
    const configuration = getOAuthLoginConfiguration();
    if (redirectUri !== configuration.callbackUri) throw new Error("Invalid OAuth callback URI");
    const payload: ExchangeTokenRequest = {
      clientId: configuration.appId,
      grantType: "authorization_code",
      code,
      redirectUri,
    };

    const { data } = await this.client.post<ExchangeTokenResponse>(
      EXCHANGE_TOKEN_PATH,
      payload
    );

    return data;
  }

  async getUserInfoByToken(
    token: ExchangeTokenResponse
  ): Promise<GetUserInfoResponse> {
    const { data } = await this.client.post<GetUserInfoResponse>(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken,
      }
    );

    return data;
  }
}

const createOAuthHttpClient = (): AxiosInstance =>
  axios.create({
    baseURL: ENV.oAuthServerUrl,
    timeout: AXIOS_TIMEOUT_MS,
    maxRedirects: 0,
  });

class SDKServer {
  private readonly client: AxiosInstance;
  private readonly oauthService: OAuthService;

  constructor(client: AxiosInstance = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }

  private deriveLoginMethod(
    platforms: unknown,
    fallback: string | null | undefined
  ): string | null {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set<string>(
      platforms.filter((p): p is string => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (
      set.has("REGISTERED_PLATFORM_MICROSOFT") ||
      set.has("REGISTERED_PLATFORM_AZURE")
    )
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }

  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, validatedCallbackUri);
   */
  async exchangeCodeForToken(
    code: string,
    redirectUri: string
  ): Promise<ExchangeTokenResponse> {
    return this.oauthService.getTokenByCode(code, redirectUri);
  }

  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken: string): Promise<GetUserInfoResponse> {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken,
    } as ExchangeTokenResponse);
    const loginMethod = this.deriveLoginMethod(
      (data as any)?.platforms,
      (data as any)?.platform ?? data.platform ?? null
    );
    return {
      ...(data as any),
      platform: loginMethod,
      loginMethod,
    } as GetUserInfoResponse;
  }

  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) {
      return new Map<string, string>();
    }

    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }

  private getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }

  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(
    openId: string,
    options: { expiresInMs?: number; name?: string; expectedIdentity?: SessionIdentityProof } = {}
  ): Promise<string> {
    return this.signSession(
      {
        openId,
        appId: getSessionAudience(),
        name: options.name || "",
      },
      options
    );
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number; expectedIdentity?: SessionIdentityProof } = {}
  ): Promise<string> {
    return withSessionIdentity(payload.openId, options.expectedIdentity, async user => {
      const issuedAt = Date.now();
      const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
      const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
      const secretKey = this.getSessionSecret();

      return new SignJWT({
        openId: payload.openId,
        appId: payload.appId,
        name: payload.name,
        userId: user.id,
        sessionEpoch: user.sessionEpoch,
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setJti(randomUUID())
        .setExpirationTime(expirationSeconds)
        .sign(secretKey);
    });
  }

  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<{ openId: string; appId: string; name: string; sessionId: string; expiresAt: Date; userId?: number; sessionEpoch?: string } | null> {
    if (!cookieValue) {
      return null;
    }

    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
      });
      const { openId, appId, name, jti, exp, userId, sessionEpoch } = payload as Record<string, unknown>;
      const legacy = !("userId" in payload) && !("sessionEpoch" in payload);

      if (
        !isNonEmptyString(openId) ||
        !isNonEmptyString(appId) ||
        !isNonEmptyString(name) ||
        !isNonEmptyString(jti) ||
        typeof exp !== "number" ||
        appId !== getSessionAudience()
        || (!legacy && (!Number.isSafeInteger(userId) || (userId as number) <= 0 || !isSessionEpoch(sessionEpoch)))
      ) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }

      return {
        openId,
        appId,
        name,
        sessionId: jti,
        expiresAt: new Date(exp * 1000),
        ...(!legacy ? { userId: userId as number, sessionEpoch: sessionEpoch as string } : {}),
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }

  async getUserInfoWithJwt(
    jwtToken: string
  ): Promise<GetUserInfoWithJwtResponse> {
    const payload: GetUserInfoWithJwtRequest = {
      jwtToken,
      projectId: ENV.appId,
    };

    const { data } = await this.client.post<GetUserInfoWithJwtResponse>(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );

    const loginMethod = this.deriveLoginMethod(
      (data as any)?.platforms,
      (data as any)?.platform ?? data.platform ?? null
    );
    return {
      ...(data as any),
      platform: loginMethod,
      loginMethod,
    } as GetUserInfoWithJwtResponse;
  }

  async authenticateRequest(req: Request): Promise<User> {
    const bypassUser = await resolveLocalBypassUser(req);
    if (bypassUser) return withSessionIdentity(bypassUser.openId, undefined, async user => user);

    // Regular authentication flow
    const cookies = this.parseCookies(req.headers.cookie);
    const sessionCookie = cookies.get(COOKIE_NAME);
    const session = await this.verifySession(sessionCookie);

    if (!session || await db.isSessionRevoked(session.sessionId)) {
      throw ForbiddenError("Invalid session cookie");
    }

    return withSessionIdentity(session.openId,
      session.userId === undefined ? "legacy" : { userId: session.userId, sessionEpoch: session.sessionEpoch! },
      async user => user);
  }

  async revokeSession(cookieValue: string | undefined | null): Promise<void> {
    if (!cookieValue) return;
    const session = await this.verifySession(cookieValue);
    if (!session) return;
    await db.revokeSession(session.sessionId, session.expiresAt);
  }
}

export const sdk = new SDKServer();
