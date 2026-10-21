import express from 'express';
import request from 'supertest';
import { parse as parseCookies } from 'cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { users } from '../../drizzle/schema.postgres';
import { COOKIE_NAME } from '../../shared/const';
import { timerTestDatabase } from '../test/timerDatabase';

const controls = vi.hoisted(() => ({
  secret: crypto.randomUUID() + crypto.randomUUID(), getDb: vi.fn(), upsert: vi.fn(), account: vi.fn(),
  create: vi.fn(), consume: vi.fn(), states: new Map<string, { bindingHash: string; callbackUri: string; expires: number }>(),
}));
vi.mock('./env', () => ({ ENV: { appId: 'synthetic-oauth-app', cookieSecret: controls.secret,
  oAuthServerUrl: 'https://provider.example.invalid', isProduction: false } }));
vi.mock('../db', () => ({ getDb: controls.getDb, upsertUser: controls.upsert,
  getUserByOpenId: controls.account, isSessionRevoked: async () => false }));
vi.mock('./oauthStateDb', () => ({ createOAuthLoginState: controls.create, consumeOAuthLoginState: controls.consume }));
import { registerOAuthRoutes } from './oauth';
import { sdk } from './sdk';
import { ENV } from './env';
import { hashOAuthLoginNonce, createOAuthLoginNonce, openOAuthLoginBinding, OAUTH_LOGIN_STATE_TTL_MS } from './oauthState';

const callbackUri = 'https://dashboard.example.invalid/api/oauth/callback';
function mounted() { const app = express(); registerOAuthRoutes(app); return app; }
function cookieHeaders(response: request.Response): string[] { return ([] as string[]).concat(response.headers['set-cookie'] ?? []); }
function sessionCookie(response: request.Response) { return cookieHeaders(response).find(cookie => cookie.startsWith(`${COOKIE_NAME}=`)); }
async function start(client: ReturnType<typeof request.agent> | ReturnType<typeof request>) {
  const response = await client.get('/api/oauth/start').expect(302);
  const authorization = new URL(response.headers.location);
  const state = authorization.searchParams.get('state')!;
  const cookie = cookieHeaders(response)[0].split(';')[0];
  return { response, authorization, state, cookie };
}
function noAccountOrProviderCalls() {
  expect(sdk.exchangeCodeForToken).not.toHaveBeenCalled(); expect(sdk.getUserInfo).not.toHaveBeenCalled();
  expect(controls.upsert).not.toHaveBeenCalled(); expect(controls.account).not.toHaveBeenCalled();
}
beforeEach(() => {
  ENV.cookieSecret = controls.secret;
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('PUBLIC_URL', 'https://dashboard.example.invalid');
  vi.stubEnv('VITE_OAUTH_PORTAL_URL', 'https://portal.example.invalid'); vi.stubEnv('SESSION_APP_ID', 'synthetic-oauth-app');
  controls.states.clear();
  const account = { id: 7, openId: 'synthetic-oauth-owner', name: 'Synthetic Owner', role: 'admin', sessionEpoch: '1' };
  controls.getDb.mockReset().mockResolvedValue(timerTestDatabase(new Map([[users, [account]]])).db);
  controls.upsert.mockReset().mockResolvedValue(undefined); controls.account.mockReset().mockResolvedValue(account);
  controls.create.mockReset().mockImplementation(async record => {
    controls.states.set(record.stateHash, { ...record, expires: Date.now() + OAUTH_LOGIN_STATE_TTL_MS });
  });
  controls.consume.mockReset().mockImplementation(async record => {
    const stored = controls.states.get(record.stateHash);
    if (!stored || stored.expires <= Date.now() || stored.bindingHash !== record.bindingHash || stored.callbackUri !== record.callbackUri) return false;
    controls.states.delete(record.stateHash); return true;
  });
  vi.spyOn(sdk, 'exchangeCodeForToken').mockResolvedValue({ accessToken: 'synthetic-provider-token' } as never);
  vi.spyOn(sdk, 'getUserInfo').mockResolvedValue({ openId: account.openId, name: account.name, email: null, loginMethod: 'oauth' } as never);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { ENV.cookieSecret = controls.secret; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('mounted browser-bound OAuth login', () => {
  it('issues separate browser/state nonces, persists only hashes and uses configured callback despite hostile request metadata', async () => {
    const response = await request(mounted()).get('/api/oauth/start?redirectUri=https://evil.invalid&returnTo=//evil.invalid')
      .set('Host', 'evil.invalid').set('X-Forwarded-Host', 'evil.invalid').set('X-Forwarded-Proto', 'http').expect(302);
    const url = new URL(response.headers.location);
    expect(url.origin).toBe('https://portal.example.invalid'); expect(url.pathname).toBe('/app-auth');
    expect(url.searchParams.get('redirectUri')).toBe(callbackUri);
    const state = url.searchParams.get('state')!;
    const encryptedBinding = Object.values(parseCookies(cookieHeaders(response)[0].split(';')[0]))[0]!;
    const binding = openOAuthLoginBinding(encryptedBinding, callbackUri);
    expect(binding).toMatch(/^[\w-]{43}$/);
    expect(encryptedBinding).not.toContain(binding!);
    expect(state).not.toBe(binding); expect(state).toMatch(/^[\w-]{43}$/);
    expect(controls.create).toHaveBeenCalledWith({ stateHash: hashOAuthLoginNonce(state), bindingHash: hashOAuthLoginNonce(binding!), callbackUri });
    expect(JSON.stringify(controls.create.mock.calls)).not.toContain(state);
    expect(JSON.stringify(controls.create.mock.calls)).not.toContain(binding!);
    expect(response.headers['cache-control']).toBe('no-store'); noAccountOrProviderCalls();
  });

  it('completes the actual mounted flow and signs a UID/epoch-bound session', async () => {
    const client = request.agent(mounted()); const attempt = await start(client);
    const response = await client.get('/api/oauth/callback').query({ state: attempt.state, code: 'synthetic-code' }).expect(302);
    expect(response.headers.location).toBe('/'); expect(response.headers['cache-control']).toBe('no-store');
    expect(sdk.exchangeCodeForToken).toHaveBeenCalledWith('synthetic-code', callbackUri);
    expect(controls.states.size).toBe(0); expect(controls.upsert).toHaveBeenCalledOnce();
    const encoded = sessionCookie(response)!.split(';')[0].slice(COOKIE_NAME.length + 1);
    expect(await sdk.verifySession(decodeURIComponent(encoded))).toMatchObject({ userId: 7, sessionEpoch: '1', openId: 'synthetic-oauth-owner' });
    expect(cookieHeaders(response).some(cookie => cookie.startsWith('va_oauth_binding=;'))).toBe(true);
  });

  it.each(['missing code','missing state','malformed state','tampered state','legacy redirect state','missing cookie','malformed cookie','tampered cookie','wrong browser','swapped state'])(
    'rejects %s without provider/account calls or consuming the legitimate browser attempt', async defect => {
      const client = request.agent(mounted()); const legit = await start(client);
      const other = await start(request.agent(mounted()));
      let state: string | undefined = legit.state, code: string | undefined = 'synthetic-code', cookie = legit.cookie;
      if (defect === 'missing code') code = undefined;
      if (defect === 'missing state') state = undefined;
      if (defect === 'malformed state') state = 'invalid';
      if (defect === 'tampered state') state = createOAuthLoginNonce();
      if (defect === 'legacy redirect state') state = Buffer.from('https://evil.invalid/api/oauth/callback').toString('base64');
      if (defect === 'missing cookie') cookie = '';
      if (defect === 'malformed cookie') cookie = 'va_oauth_binding=invalid';
      if (defect === 'tampered cookie') {
        const [name, sealed] = Object.entries(parseCookies(cookie))[0];
        const middle = Math.floor(sealed!.length / 2);
        cookie = `${name}=${encodeURIComponent(sealed!.slice(0, middle) + (sealed![middle] === 'A' ? 'B' : 'A') + sealed!.slice(middle + 1))}`;
      }
      if (defect === 'wrong browser') cookie = other.cookie;
      if (defect === 'swapped state') state = other.state;
      const invalid = await request(mounted()).get('/api/oauth/callback').query({ ...(state ? { state } : {}), ...(code ? { code } : {}) })
        .set('Cookie', cookie).expect(400);
      expect(sessionCookie(invalid)).toBeUndefined(); expect(cookieHeaders(invalid)).toEqual([]);
      expect(controls.states.has(hashOAuthLoginNonce(legit.state))).toBe(true); noAccountOrProviderCalls();
      if (defect === 'tampered cookie') expect(controls.consume).not.toHaveBeenCalled();
      await client.get('/api/oauth/callback').query({ state: legit.state, code: 'legitimate-code' }).expect(302);
    },
  );

  it('does not erase the real agent cookie after an injected invalid-state request', async () => {
    const client = request.agent(mounted()); const legit = await start(client);
    await client.get('/api/oauth/callback').query({ state: createOAuthLoginNonce(), code: 'injected' }).expect(400);
    await client.get('/api/oauth/callback').query({ state: legit.state, code: 'legitimate-code' }).expect(302);
  });

  it('rejects repeated callback without a second provider exchange', async () => {
    const attempt = await start(request(mounted()));
    await request(mounted()).get('/api/oauth/callback').set('Cookie', attempt.cookie).query({ state: attempt.state, code: 'code' }).expect(302);
    await request(mounted()).get('/api/oauth/callback').set('Cookie', attempt.cookie).query({ state: attempt.state, code: 'code' }).expect(400);
    expect(sdk.exchangeCodeForToken).toHaveBeenCalledOnce(); expect(controls.upsert).toHaveBeenCalledOnce();
  });

  it('admits only one simultaneous callback before a deferred provider exchange, account write and session mint', async () => {
    const attempt = await start(request(mounted()));
    let entered!: () => void, release!: () => void;
    const providerEntered = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(sdk.exchangeCodeForToken).mockImplementationOnce(async () => {
      entered(); await gate; return { accessToken: 'synthetic-provider-token' } as never;
    });
    const mint = vi.spyOn(sdk, 'createSessionToken'); // Call through to the real signer.
    const first = request(mounted()).get('/api/oauth/callback').set('Cookie', attempt.cookie)
      .query({ state: attempt.state, code: 'same-code' }).then(response => response);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([providerEntered, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('OAuth provider gate was not reached')), 3000);
      })]);
      await request(mounted()).get('/api/oauth/callback').set('Cookie', attempt.cookie)
        .query({ state: attempt.state, code: 'same-code' }).expect(400);
      expect(controls.upsert).not.toHaveBeenCalled(); expect(mint).not.toHaveBeenCalled();
      release(); expect((await first).status).toBe(302);
      expect(sdk.exchangeCodeForToken).toHaveBeenCalledOnce(); expect(controls.upsert).toHaveBeenCalledOnce();
      expect(controls.account).toHaveBeenCalledOnce(); expect(mint).toHaveBeenCalledOnce();
    } finally { if (timer) clearTimeout(timer); release(); await first; }
  });

  it('holds an expired attempt before provider calls', async () => {
    const attempt = await start(request(mounted()));
    controls.states.get(hashOAuthLoginNonce(attempt.state))!.expires = Date.now() - 1;
    await request(mounted()).get('/api/oauth/callback').set('Cookie', attempt.cookie).query({ state: attempt.state, code: 'code' }).expect(400);
    noAccountOrProviderCalls();
  });

  it('does not consume a state under a different configured callback origin', async () => {
    const client = request.agent(mounted()); const attempt = await start(client);
    vi.stubEnv('PUBLIC_URL', 'https://different.example.invalid');
    await client.get('/api/oauth/callback').query({ state: attempt.state, code: 'code' }).expect(400);
    noAccountOrProviderCalls(); expect(controls.consume).not.toHaveBeenCalled();
    vi.stubEnv('PUBLIC_URL', 'https://dashboard.example.invalid');
    await client.get('/api/oauth/callback').query({ state: attempt.state, code: 'code' }).expect(302);
  });

  it('rejects a binding sealed under the previous key before persistence/provider/account calls without clearing the pending cookie', async () => {
    const client = request.agent(mounted()); const attempt = await start(client);
    ENV.cookieSecret = crypto.randomUUID() + crypto.randomUUID();
    const denied = await client.get('/api/oauth/callback').query({ state: attempt.state, code: 'code' }).expect(400);
    expect(cookieHeaders(denied)).toEqual([]); expect(controls.consume).not.toHaveBeenCalled(); noAccountOrProviderCalls();
    expect(controls.states.has(hashOAuthLoginNonce(attempt.state))).toBe(true);
    ENV.cookieSecret = controls.secret;
    await client.get('/api/oauth/callback').query({ state: attempt.state, code: 'code' }).expect(302);
  });

  it.each(['exchange','user info'])('consumes before %s failure and never logs provider secrets', async stage => {
    const attempt = await start(request(mounted()));
    const sensitive = `synthetic-provider-failure-${createOAuthLoginNonce()}`;
    const failure = new Error(sensitive, { cause: { authorization: sensitive, cookie: attempt.cookie, state: attempt.state } });
    if (stage === 'exchange') vi.mocked(sdk.exchangeCodeForToken).mockRejectedValueOnce(failure);
    else vi.mocked(sdk.getUserInfo).mockRejectedValueOnce(failure);
    const response = await request(mounted()).get('/api/oauth/callback').set('Cookie', attempt.cookie).query({ state: attempt.state, code: sensitive }).expect(500);
    expect(response.body).toEqual({ error: 'OAuth callback failed' }); expect(sessionCookie(response)).toBeUndefined();
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
    for (const value of [sensitive, attempt.state, attempt.cookie]) expect(logs).not.toContain(value);
    expect(controls.upsert).not.toHaveBeenCalled(); expect(controls.states.size).toBe(0);
    await request(mounted()).get('/api/oauth/callback').set('Cookie', attempt.cookie).query({ state: attempt.state, code: sensitive }).expect(400);
    expect(sdk.exchangeCodeForToken).toHaveBeenCalledOnce();
  });

  it.each(['create','consume'])('fails closed and redacts %s persistence failures', async stage => {
    const secret = createOAuthLoginNonce();
    if (stage === 'create') {
      controls.create.mockRejectedValueOnce(new Error(secret));
      const result = await request(mounted()).get('/api/oauth/start').expect(503);
      expect(cookieHeaders(result)).toEqual([]);
    } else {
      const attempt = await start(request(mounted())); controls.consume.mockRejectedValueOnce(new Error(secret));
      const result = await request(mounted()).get('/api/oauth/callback').set('Cookie', attempt.cookie).query({ state: attempt.state, code: secret }).expect(503);
      expect(cookieHeaders(result)).toEqual([]);
    }
    noAccountOrProviderCalls(); expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
  });

  it.each(['http://remote.invalid','https://user:password@dashboard.example.invalid','https://dashboard.example.invalid/path','https://dashboard.example.invalid?redirect=evil'])(
    'refuses unsafe configured public URL %s before persistence/provider calls', async value => {
      vi.stubEnv('PUBLIC_URL', value);
      await request(mounted()).get('/api/oauth/start').expect(503);
      expect(controls.create).not.toHaveBeenCalled(); noAccountOrProviderCalls();
    },
  );

  it('sets a production host-only secure binding cookie and a local scoped development cookie', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const production = cookieHeaders((await start(request(mounted()))).response)[0];
    expect(production).toMatch(/^__Host-va_oauth_binding=/); expect(production).toContain('Path=/;');
    expect(production).toContain('Secure'); expect(production).toContain('HttpOnly'); expect(production).toContain('SameSite=Lax');
    expect(production).not.toMatch(/Domain=/i); expect(production).toContain('Max-Age=600');
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('PUBLIC_URL', 'http://127.0.0.1');
    const development = cookieHeaders((await start(request(mounted()))).response)[0];
    expect(development).toMatch(/^va_oauth_binding=/); expect(development).toContain('Path=/api/oauth;');
    expect(development).not.toContain('Secure'); expect(development).not.toMatch(/Domain=/i);
  });

  it('clears the exact production __Host cookie only after valid consumption, preserving root/Secure/host-only flags', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const attempt = await start(request(mounted()));
    const result = await request(mounted()).get('/api/oauth/callback').set('Cookie', attempt.cookie)
      .query({ state: attempt.state, code: 'synthetic-code' }).expect(302);
    const cleared = cookieHeaders(result).find(cookie => cookie.startsWith('__Host-va_oauth_binding='))!;
    expect(cleared).toMatch(/^__Host-va_oauth_binding=;/); expect(cleared).toContain('Path=/;');
    expect(cleared).toContain('Secure'); expect(cleared).toContain('HttpOnly'); expect(cleared).toContain('SameSite=Lax');
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970'); expect(cleared).not.toMatch(/Domain=/i);
    const encoded = sessionCookie(result)!.split(';')[0].slice(COOKIE_NAME.length + 1);
    expect(await sdk.verifySession(decodeURIComponent(encoded))).toMatchObject({ userId: 7, sessionEpoch: '1' });
  });
});
