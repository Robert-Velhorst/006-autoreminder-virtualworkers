import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool, escapeIdentifier } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { parse as parseCookies } from 'cookie';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireIsolatedPostgresTestDatabase } from '../shared/isolatedPostgresTestDatabase.mjs';
import { getDb, closeDb } from './db';
import { COOKIE_NAME } from '../shared/const';
import { ENV } from './_core/env';
import { sdk } from './_core/sdk';
import { registerOAuthRoutes } from './_core/oauth';
import { createOAuthLoginState, consumeOAuthLoginState } from './_core/oauthStateDb';
import { createOAuthLoginNonce, hashOAuthLoginNonce, OAUTH_LOGIN_STATE_PREFIX, type OAuthLoginStateRecord } from './_core/oauthState';

const fixtureUrl = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!fixtureUrl)('OAuth state native atomicity and DB-clock expiry', { timeout: 25000 }, () => {
  const databaseName = `oauth_state_${randomUUID().replaceAll('-', '')}`;
  const applicationName = `oauth-state-test-${randomUUID()}`;
  const prior = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX, PGAPPNAME: process.env.PGAPPNAME };
  let administrator: Pool | undefined;
  let pool: Pool;
  let created = false;
  beforeAll(async () => {
    const base = new URL(requireIsolatedPostgresTestDatabase(fixtureUrl, process.env.NODE_ENV === 'production'));
    if (!/^oauth_state_[a-f0-9]{32}$/.test(databaseName)) throw new Error('Invalid owned OAuth fixture database');
    administrator = new Pool({ connectionString: base.href, max: 1, connectionTimeoutMillis: 5000 });
    created = true;
    try { await administrator.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`); }
    catch (error) { if ((error as { code?: string }).code === '42P04') created = false; throw error; }
    base.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: base.href, max: 4, connectionTimeoutMillis: 5000,
      options: '-c statement_timeout=15000 -c lock_timeout=5000' });
    await migrate(drizzle(pool), { migrationsFolder: path.resolve(import.meta.dirname, '../drizzle-postgres-v1') });
    await closeDb(); process.env.DATABASE_URL = base.href; process.env.DATABASE_POOL_MAX = '4'; process.env.PGAPPNAME = applicationName;
    const application = await getDb();
    if (!application) throw new Error('Private OAuth fixture database unavailable');
    expect((await application.execute<{ name: string }>(sql`SELECT current_database() AS name`)).rows[0].name).toBe(databaseName);
  }, 90000);
  beforeEach(async () => {
    vi.useRealTimers(); await pool.query('TRUNCATE app_settings RESTART IDENTITY');
  });
  afterAll(async () => {
    vi.useRealTimers();
    try { await closeDb(); }
    finally {
      try { if (pool) await pool.end(); }
      finally {
        try { if (created && administrator) await administrator.query(`DROP DATABASE ${escapeIdentifier(databaseName)}`); }
        finally {
          try { if (administrator) await administrator.end(); }
          finally {
            for (const key of ['DATABASE_URL', 'DATABASE_POOL_MAX', 'PGAPPNAME'] as const) {
              if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
            }
          }
        }
      }
    }
  });
  function attempt() {
    const state = createOAuthLoginNonce(), binding = createOAuthLoginNonce();
    const record: OAuthLoginStateRecord = { stateHash: hashOAuthLoginNonce(state), bindingHash: hashOAuthLoginNonce(binding),
      callbackUri: 'https://dashboard.example.invalid/api/oauth/callback' };
    return { state, binding, record, key: `${OAUTH_LOGIN_STATE_PREFIX}${record.stateHash}` };
  }
  const rows = async () => (await pool.query('SELECT to_jsonb(s) AS row FROM app_settings s ORDER BY id')).rows.map(row => row.row);
  async function age(key: string, minutes: number) {
    await pool.query(`UPDATE app_settings SET "updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC')-$2::integer*INTERVAL '1 minute' WHERE key=$1`, [key, minutes]);
  }
  async function waitForBlocked(pid: number, count: number) {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const result = await pool.query<{ pid: number; blockers: number[] }>(`SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'
          AND cardinality(pg_blocking_pids(pid)) > 0`, [applicationName]);
      if (result.rows.length === count && result.rows.some(row => row.blockers.includes(pid))) {
        const ownedGraph = new Set([pid, ...result.rows.map(row => row.pid)]);
        expect(result.rows.every(row => row.blockers.every(blocker => ownedGraph.has(blocker)))).toBe(true);
        expect(new Set(result.rows.map(row => row.pid)).size).toBe(count);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('OAuth consume PostgreSQL lock barrier was not reached');
  }

  it('stores only hashed secrets under the private null-owner namespace and stamps creation with DB time', async () => {
    const login = attempt(); await createOAuthLoginState(login.record);
    const persisted = await rows(); expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ key: login.key, vaId: null });
    expect(JSON.parse(persisted[0].value)).toEqual({ bindingHash: login.record.bindingHash, callbackUri: login.record.callbackUri });
    expect(JSON.stringify(persisted)).not.toContain(login.state); expect(JSON.stringify(persisted)).not.toContain(login.binding);
    const age = (await pool.query(`SELECT abs(extract(epoch FROM (("updatedAt" AT TIME ZONE 'UTC')-clock_timestamp()))) AS seconds FROM app_settings`)).rows[0].seconds;
    expect(Number(age)).toBeLessThan(5);
  });

  it('completes mounted OAuth through real PG state, account upsert and session signing, and rejects replay', async () => {
    const configuration = { appId: ENV.appId, cookieSecret: ENV.cookieSecret, oAuthServerUrl: ENV.oAuthServerUrl };
    const keys = ['NODE_ENV', 'PUBLIC_URL', 'VITE_OAUTH_PORTAL_URL', 'SESSION_APP_ID'] as const;
    const environment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const appId = `oauth-chain-${randomUUID()}`, openId = `oauth-chain-user-${randomUUID()}`;
    const callbackUri = 'https://dashboard.example.invalid/api/oauth/callback';
    const exchange = vi.spyOn(sdk, 'exchangeCodeForToken');
    const userInfo = vi.spyOn(sdk, 'getUserInfo');
    try {
      Object.assign(ENV, { appId, cookieSecret: randomBytes(48).toString('hex'), oAuthServerUrl: 'https://provider.example.invalid' });
      process.env.NODE_ENV = 'test'; process.env.PUBLIC_URL = 'https://dashboard.example.invalid';
      process.env.VITE_OAUTH_PORTAL_URL = 'https://portal.example.invalid'; process.env.SESSION_APP_ID = appId;
      const seeded = (await pool.query(`INSERT INTO users ("openId",role,name,"loginMethod")
        VALUES ($1,'admin','Before OAuth','local') RETURNING id,"sessionEpoch"::text AS epoch`, [openId])).rows[0];
      exchange.mockResolvedValue({ accessToken: 'synthetic-chain-provider-token' } as never);
      userInfo.mockResolvedValue({ openId, name: 'After OAuth', email: 'oauth-chain@example.invalid', loginMethod: 'oauth' } as never);
      const application = express(); registerOAuthRoutes(application);
      const browser = request.agent(application);
      const started = await browser.get('/api/oauth/start').expect(302);
      const authorization = new URL(started.headers.location);
      expect(authorization.origin).toBe('https://portal.example.invalid');
      expect(authorization.searchParams.get('appId')).toBe(appId);
      expect(authorization.searchParams.get('redirectUri')).toBe(callbackUri);
      const state = authorization.searchParams.get('state')!;
      const bindingCookie = ([] as string[]).concat(started.headers['set-cookie'] ?? [])[0].split(';')[0];
      const binding = Object.values(parseCookies(bindingCookie))[0]!;
      const persisted = await rows(); expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ key: `${OAUTH_LOGIN_STATE_PREFIX}${hashOAuthLoginNonce(state)}`, vaId: null });
      expect(JSON.parse(persisted[0].value)).toEqual({ bindingHash: hashOAuthLoginNonce(binding), callbackUri });
      expect(JSON.stringify(persisted)).not.toContain(state); expect(JSON.stringify(persisted)).not.toContain(binding);
      expect(exchange).not.toHaveBeenCalled(); expect(userInfo).not.toHaveBeenCalled();

      const completed = await browser.get('/api/oauth/callback').query({ state, code: 'synthetic-chain-code' }).expect(302);
      expect(completed.headers.location).toBe('/'); expect(await rows()).toEqual([]);
      expect(exchange).toHaveBeenCalledExactlyOnceWith('synthetic-chain-code', callbackUri);
      expect(userInfo).toHaveBeenCalledExactlyOnceWith('synthetic-chain-provider-token');
      const account = (await pool.query('SELECT to_jsonb(u) AS row FROM users u WHERE id=$1', [seeded.id])).rows[0].row;
      expect(account).toMatchObject({ id: seeded.id, openId, role: 'admin', name: 'After OAuth', email: 'oauth-chain@example.invalid', loginMethod: 'oauth' });
      expect(account.lastSignedIn).not.toBeNull();
      const currentEpoch = (await pool.query('SELECT "sessionEpoch"::text AS epoch FROM users WHERE id=$1', [seeded.id])).rows[0].epoch;
      expect(BigInt(currentEpoch)).toBeGreaterThan(BigInt(seeded.epoch));
      const cookies = ([] as string[]).concat(completed.headers['set-cookie'] ?? []);
      const sessionHeader = cookies.find(value => value.startsWith(`${COOKIE_NAME}=`));
      expect(sessionHeader).toBeDefined();
      const signedSession = parseCookies(sessionHeader!.split(';')[0])[COOKIE_NAME]!;
      expect(await sdk.verifySession(signedSession)).toMatchObject({ userId: seeded.id, sessionEpoch: currentEpoch, openId, appId });

      // Supply even the original browser binding on replay: rejection must be
      // persisted one-time consumption, not merely the cleared cookie jar.
      await request(application).get('/api/oauth/callback').set('Cookie', bindingCookie)
        .query({ state, code: 'synthetic-chain-code' }).expect(400);
      expect(exchange).toHaveBeenCalledOnce(); expect(userInfo).toHaveBeenCalledOnce();
      expect(await rows()).toEqual([]);
      expect((await pool.query('SELECT to_jsonb(u) AS row FROM users u WHERE id=$1', [seeded.id])).rows[0].row).toEqual(account);
    } finally {
      exchange.mockRestore(); userInfo.mockRestore(); Object.assign(ENV, configuration);
      for (const key of keys) {
        if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key];
      }
    }
  });

  it('allows exactly one real parallel DELETE through an observed PostgreSQL row-lock barrier and rejects replay', async () => {
    const login = attempt(); await createOAuthLoginState(login.record);
    const gate = await pool.connect(); const operations: Promise<{ value?: boolean; error?: unknown }>[] = [];
    try {
      await gate.query('BEGIN'); const pid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await gate.query('SELECT id FROM app_settings WHERE key=$1 FOR UPDATE', [login.key]);
      for (let index = 0; index < 2; index++) operations.push(consumeOAuthLoginState(login.record).then(value => ({ value }), error => ({ error })));
      await waitForBlocked(pid, 2);
      await gate.query('COMMIT');
      const results = await Promise.all(operations);
      expect(results.every(result => !result.error)).toBe(true);
      expect(results.map(result => result.value).sort()).toEqual([false, true]);
      expect(await consumeOAuthLoginState(login.record)).toBe(false); expect(await rows()).toEqual([]);
    } finally { await gate.query('ROLLBACK'); gate.release(true); await Promise.allSettled(operations); }
  });

  it('rejects a state that expires while its unchanged row is locked, checking DB time after the lock wait', async () => {
    const login = attempt(); await createOAuthLoginState(login.record);
    await pool.query(`UPDATE app_settings SET "updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC')-INTERVAL '599 seconds' WHERE key=$1`, [login.key]);
    const before = await rows(); const gate = await pool.connect();
    let pending: Promise<{ value?: boolean; error?: unknown }> | undefined;
    try {
      await gate.query('BEGIN'); const pid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await gate.query('SELECT id FROM app_settings WHERE key=$1 FOR UPDATE', [login.key]);
      pending = consumeOAuthLoginState(login.record).then(value => ({ value }), error => ({ error }));
      await waitForBlocked(pid, 1);
      const deadline = performance.now() + 5000;
      let expired = false;
      while (performance.now() < deadline) {
        expired = (await pool.query(`SELECT (clock_timestamp() AT TIME ZONE 'UTC')-"updatedAt">INTERVAL '600 seconds' AS expired
          FROM app_settings WHERE key=$1`, [login.key])).rows[0].expired === true;
        if (expired) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(expired).toBe(true);
      await gate.query('COMMIT');
      const result = await pending; if (result.error) throw result.error;
      expect(result.value).toBe(false); expect(await rows()).toEqual(before);
    } finally { await gate.query('ROLLBACK'); gate.release(true); if (pending) await pending; }
  });

  it.each(['binding','callback','state'] as const)('a %s mismatch cannot consume the genuine attempt', async mismatch => {
    const login = attempt(); await createOAuthLoginState(login.record); const before = await rows();
    const other = attempt();
    const bad = { ...login.record, ...(mismatch === 'binding' ? { bindingHash: other.record.bindingHash }
      : mismatch === 'state' ? { stateHash: other.record.stateHash } : { callbackUri: 'https://evil.example.invalid/api/oauth/callback' }) };
    expect(await consumeOAuthLoginState(bad)).toBe(false); expect(await rows()).toEqual(before);
    expect(await consumeOAuthLoginState(login.record)).toBe(true);
  });

  it('refuses an app-setting row owned by a user, even with matching state, binding and callback', async () => {
    const login = attempt(); await createOAuthLoginState(login.record);
    await pool.query('UPDATE app_settings SET "vaId"=7 WHERE key=$1', [login.key]);
    const before = await rows(); expect(await consumeOAuthLoginState(login.record)).toBe(false);
    expect(await rows()).toEqual(before);
  });

  it.each([9, 10, 11])('uses DB-clock age at %i minutes rather than the application wall clock', async minutes => {
    const login = attempt(); await createOAuthLoginState(login.record); await age(login.key, minutes);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2040-11-04T06:30:00Z'));
    try { expect(await consumeOAuthLoginState(login.record)).toBe(minutes === 9); }
    finally { vi.useRealTimers(); }
  });

  it('retains one-time state across a full application DB pool restart', async () => {
    const login = attempt(); await createOAuthLoginState(login.record);
    const before = await rows(); await closeDb();
    const application = (await getDb())!;
    expect((await application.execute<{ name: string }>(sql`SELECT current_database() AS name`)).rows[0].name).toBe(databaseName);
    expect(await rows()).toEqual(before);
    expect(await consumeOAuthLoginState(login.record)).toBe(true);
    await closeDb();
    expect(await consumeOAuthLoginState(login.record)).toBe(false);
  });

  it.each(['America/New_York', 'Asia/Kolkata', 'Pacific/Honolulu'])('keeps creation and expiry UTC-correct on alternate DB session timezone %s', async timezone => {
    // A single application pool connection makes SET apply to every actual
    // state-store query; no timezone behavior is simulated by a SQL mock.
    await closeDb(); process.env.DATABASE_POOL_MAX = '1';
    const application = (await getDb())!;
    await application.execute(sql`SELECT set_config('TimeZone', ${timezone}, false)`);
    try {
      const fresh = attempt(); await createOAuthLoginState(fresh.record);
      const elapsed = (await pool.query(`SELECT abs(extract(epoch FROM (("updatedAt" AT TIME ZONE 'UTC')-clock_timestamp()))) AS seconds
        FROM app_settings WHERE key=$1`, [fresh.key])).rows[0].seconds;
      expect(Number(elapsed)).toBeLessThan(5);
      expect(await consumeOAuthLoginState(fresh.record)).toBe(true);
      const expired = attempt(); await createOAuthLoginState(expired.record); await age(expired.key, 11);
      expect(await consumeOAuthLoginState(expired.record)).toBe(false);
    } finally {
      await closeDb(); process.env.DATABASE_POOL_MAX = '4';
    }
  });

  it('cleans only expired null-owner OAuth records, preserving worker settings and unrelated namespaces', async () => {
    const expired = attempt(), active = attempt(), owned = attempt();
    for (const item of [expired,active,owned]) await createOAuthLoginState(item.record);
    await age(expired.key, 11); await age(owned.key, 11);
    await pool.query('UPDATE app_settings SET "vaId"=7 WHERE key=$1', [owned.key]);
    await pool.query(`INSERT INTO app_settings (key,value,"updatedAt") VALUES
      ('ordinary_setting','private-setting',(clock_timestamp() AT TIME ZONE 'UTC')-INTERVAL '1 day'),
      ('oauthXloginXstate:unrelated','other',(clock_timestamp() AT TIME ZONE 'UTC')-INTERVAL '1 day')`);
    await createOAuthLoginState(attempt().record);
    const keys = (await rows()).map(row => row.key);
    expect(keys).not.toContain(expired.key); expect(keys).toContain(active.key); expect(keys).toContain(owned.key);
    expect(keys).toContain('ordinary_setting'); expect(keys).toContain('oauthXloginXstate:unrelated');
  });

  it('rolls back expired cleanup when the following state INSERT fails, preserving all original rows', async () => {
    const duplicate = attempt(), expired = attempt();
    await createOAuthLoginState(duplicate.record); await createOAuthLoginState(expired.record); await age(expired.key, 11);
    const before = await rows();
    await expect(createOAuthLoginState(duplicate.record)).rejects.toMatchObject({ cause: { code: '23505' } });
    expect(await rows()).toEqual(before);
  });

  it('leaves the genuine state consumable when a real DB trigger rejects its DELETE', async () => {
    const login = attempt(); await createOAuthLoginState(login.record); const before = await rows();
    try {
      await pool.query(`CREATE FUNCTION reject_oauth_consume() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Synthetic OAuth deletion rejection' USING ERRCODE='23514'; END; $$`);
      await pool.query('CREATE TRIGGER reject_oauth_consume BEFORE DELETE ON app_settings FOR EACH ROW EXECUTE FUNCTION reject_oauth_consume()');
      await expect(consumeOAuthLoginState(login.record)).rejects.toMatchObject({ cause: { code: '23514', message: 'Synthetic OAuth deletion rejection' } });
      expect(await rows()).toEqual(before);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS reject_oauth_consume ON app_settings');
      await pool.query('DROP FUNCTION IF EXISTS reject_oauth_consume()');
    }
    expect(await consumeOAuthLoginState(login.record)).toBe(true);
  });
});
