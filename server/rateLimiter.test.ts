import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from "vitest";
const redisState = vi.hoisted(() => ({ client: null as null | { eval: ReturnType<typeof vi.fn> } }));
vi.mock('./services/redis', () => ({ getRedis: () => redisState.client, isRedisAvailable: () => redisState.client !== null }));
import {
  consumeMemoryRateLimit,
  consumeRedisRateLimit,
  getRateLimitIdentifier,
  isAnonymousApiReadProbe,
  isAnonymousAuthReadProbe,
  isAnonymousSessionProbe,
  isAptlssExpensiveRequest,
  createRateLimiter,
  authRateLimiterWithReadProbeBypass,
  apiRateLimiter,
  apiRateLimiterWithAnonymousSessionProbeBypass,
  aptlssGenerationRateLimiter,
  atisRateLimiter,
  readRateLimiter,
  expensiveOperationRateLimiter,
} from "./middleware/rate-limiter";

beforeEach(() => { redisState.client = null; });

describe("rate-limit counter consumption", () => {
  it("uses the authenticated local user before a shared proxy IP", () => {
    expect(getRateLimitIdentifier({ user: { id: 42 }, ip: "203.0.113.5" })).toBe("user:42");
    expect(getRateLimitIdentifier({ user: { openId: "oauth-user" }, ip: "203.0.113.5" })).toBe("user:oauth-user");
    expect(getRateLimitIdentifier({ ip: "203.0.113.5" })).toBe("ip:203.0.113.5");
  });

  it("counts concurrent in-memory requests without losing increments", async () => {
    const key = `test:${Date.now()}`;
    const counters = await Promise.all(Array.from({ length: 6 }, () => consumeMemoryRateLimit(key, 60_000)));

    expect(counters.map((entry) => entry.count).sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("uses one Redis script to increment and set the expiry", async () => {
    let call: unknown[] | null = null;
    const redis = {
      eval: async (...args: unknown[]) => {
        call = args;
        return ["3", "59000"];
      },
    };

    await expect(consumeRedisRateLimit(redis, "ratelimit:/auth/login:127.0.0.1", 60_000)).resolves.toMatchObject({ count: 3 });
    expect(call).not.toBeNull();
    expect(String(call?.[0])).toContain("INCR");
    expect(String(call?.[0])).toContain("PEXPIRE");
  });
});

describe('Express-equivalent policy selectors', () => {
  it.each(['/OWNER-BOOTSTRAP/STATUS/', '/Trello/Client-Key'])('preserves a public auth read probe alias %s', path => {
    expect(isAnonymousAuthReadProbe('GET', path)).toBe(true);
    expect(isAnonymousAuthReadProbe('POST', path)).toBe(false);
    expect(isAnonymousApiReadProbe('GET', `/AUTH${path}`, null)).toBe(true);
    expect(isAnonymousApiReadProbe('GET', `/AUTH${path}`, { id: 1 })).toBe(false);
  });

  it('does not normalize unmatched multiple slashes into a read bypass', () => {
    expect(isAnonymousAuthReadProbe('GET', '/trello/client-key//')).toBe(false);
    expect(isAnonymousApiReadProbe('GET', '/AUTH/trello/client-key//', null)).toBe(false);
  });

  it('normalizes only the Express mount of the case-sensitive tRPC session probe', () => {
    expect(isAnonymousSessionProbe('GET', '/TRPC/auth.me', null)).toBe(true);
    expect(isAnonymousSessionProbe('GET', '/trpc/AUTH.ME', null)).toBe(false);
    expect(isAnonymousSessionProbe('GET', '/trpc/auth.me/', null)).toBe(false);
    expect(isAnonymousSessionProbe('POST', '/TRPC/auth.me', null)).toBe(false);
  });

  it('selects expensive mutation aliases without matching an unrelated namespace', () => {
    expect(isAptlssExpensiveRequest('POST', '/APTLSS/GENERATE/')).toBe(true);
    expect(isAptlssExpensiveRequest('DELETE', '/Aptlss/scheduled/dynamic-id/')).toBe(true);
    expect(isAptlssExpensiveRequest('GET', '/APTLSS/HISTORY/')).toBe(false);
    expect(isAptlssExpensiveRequest('POST', '/aptlss-other/generate')).toBe(false);
  });
});

let nextIp = 1;
function httpFixture() {
  const app = express(); app.set('trust proxy', 1);
  const ip = `203.0.113.${nextIp++}`;
  return { app,
    get: (path: string) => request(app).get(path).set('X-Forwarded-For', ip),
    post: (path: string) => request(app).post(path).set('X-Forwarded-For', ip),
  };
}

describe('mounted HTTP policy budgets', () => {
  it('requires an explicit stable configuration bucket', () => {
    expect(() => createRateLimiter({ windowMs: 60000, maxRequests: 2 } as any)).toThrow('stable rate-limit policy bucket');
    expect(() => createRateLimiter({ bucket: '/dynamic/path', windowMs: 60000, maxRequests: 2 })).toThrow();
  });

  it('shares the strict login budget across case, slash, query and alternate auth endpoints', async () => {
    const f = httpFixture();
    f.app.use('/api', apiRateLimiterWithAnonymousSessionProbeBypass);
    f.app.use('/api/auth', authRateLimiterWithReadProbeBypass);
    f.app.post(['/api/auth/login', '/api/auth/trello/login-token'], (_req, res) => res.status(401).json({ error: 'Synthetic authentication rejection' }));
    for (const path of ['/api/auth/login', '/API/AUTH/LOGIN', '/api/auth/Login/', '/api/auth/login?attempt=4', '/api/auth/trello/login-token']) {
      expect((await f.post(path)).status).toBe(401);
    }
    const blocked = await f.post('/api/auth/lOgIn/');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['x-ratelimit-limit']).toBe('5');
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.body).toMatchObject({ limit: 5, windowMs: 900000 });
  });

  it('admits exactly five concurrent failures across mixed login aliases', async () => {
    const f = httpFixture();
    f.app.use('/api/auth', authRateLimiterWithReadProbeBypass);
    f.app.post('/api/auth/login', (_req, res) => res.status(401).end());
    const paths = ['/api/auth/login', '/api/auth/LOGIN/', '/api/auth/Login', '/API/AUTH/lOgIn/'];
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => f.post(paths[i % paths.length])));
    expect(responses.filter(response => response.status === 401)).toHaveLength(5);
    expect(responses.filter(response => response.status === 429)).toHaveLength(15);
  });

  it('does not give each dynamic invitation token its own authentication budget', async () => {
    const f = httpFixture();
    f.app.use('/api/worker-invitations', authRateLimiterWithReadProbeBypass);
    f.app.get('/api/worker-invitations/:token', (_req, res) => res.status(400).end());
    for (let i = 0; i < 5; i++) expect((await f.get(`/api/worker-invitations/synthetic-token-${i}`)).status).toBe(400);
    expect((await f.get('/API/WORKER-INVITATIONS/another-token/')).status).toBe(429);
  });

  it('preserves anonymous login read probes without consuming either policy budget', async () => {
    const f = httpFixture();
    f.app.use('/api', apiRateLimiterWithAnonymousSessionProbeBypass);
    f.app.use('/api/auth', authRateLimiterWithReadProbeBypass);
    f.app.get(['/api/auth/owner-bootstrap/status', '/api/auth/trello/client-key'], (_req, res) => res.json({ synthetic: true }));
    f.app.post('/api/auth/login', (_req, res) => res.status(401).end());
    for (let i = 0; i < 65; i++) expect((await f.get(i % 2 ? '/API/AUTH/OWNER-BOOTSTRAP/STATUS/' : '/api/auth/TRELLO/CLIENT-KEY')).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await f.post('/api/auth/login')).status).toBe(401);
    expect((await f.post('/api/auth/login')).status).toBe(429);
  });

  it('shares the expensive APTLSS budget across mutation aliases and dynamic job IDs', async () => {
    const f = httpFixture();
    f.app.use('/api', aptlssGenerationRateLimiter);
    f.app.get('/api/aptlss/history', (_req, res) => res.json({ synthetic: true }));
    f.app.post(['/api/aptlss/generate', '/api/aptlss/scheduled/:id'], (_req, res) => res.status(202).end());
    for (let i = 0; i < 7; i++) expect((await f.get('/API/APTLSS/HISTORY/')).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await f.post(`/API/APTLSS/scheduled/job-${i}/`)).status).toBe(202);
    expect((await f.post('/api/aptlss/GENERATE/')).status).toBe(429);
  });

  it('charges the API policy once when mounted globally and again on ATIS', async () => {
    const f = httpFixture();
    f.app.use('/api', apiRateLimiter);
    f.app.use('/api/atis', apiRateLimiter);
    f.app.get('/api/atis/card/:id', (_req, res) => res.json({ synthetic: true }));
    for (let i = 0; i < 60; i++) expect((await f.get(`/api/atis/card/${i}`)).status).toBe(200);
    expect((await f.get('/API/ATIS/card/new-id/')).status).toBe(429);
  });

  it('keeps API and ATIS policy buckets separate even at the same mount-relative path', async () => {
    const f = httpFixture();
    f.app.use('/api/atis', apiRateLimiter);
    f.app.post('/api/atis/reprocess/:cardId', atisRateLimiter, (_req, res) => res.status(202).end());
    for (let i = 0; i < 3; i++) expect((await f.post(`/api/atis/reprocess/${i}`)).status).toBe(202);
    const blocked = await f.post('/api/atis/reprocess/different-card');
    expect(blocked.status).toBe(429); expect(blocked.headers['x-ratelimit-limit']).toBe('3');
  });

  it('retains successful authentication refunds without erasing failed attempts', async () => {
    const f = httpFixture();
    f.app.use('/api/auth', authRateLimiterWithReadProbeBypass);
    f.app.post('/api/auth/login', (req, res) => req.query.success ? res.send({ synthetic: true }) : res.status(401).end());
    for (let i = 0; i < 4; i++) expect((await f.post('/api/auth/login')).status).toBe(401);
    for (let i = 0; i < 8; i++) expect((await f.post('/api/auth/LOGIN/?success=1')).status).toBe(200);
    expect((await f.post('/api/auth/login')).status).toBe(401);
    expect((await f.post('/api/auth/login')).status).toBe(429);
  });

  it('retains failed-read refunds across different resource paths', async () => {
    const f = httpFixture();
    f.app.use('/api/read', readRateLimiter);
    f.app.get('/api/read/:id', (_req, res) => res.status(404).send({ synthetic: true }));
    for (let i = 0; i < 125; i++) expect((await f.get(`/api/read/${i}`)).status).toBe(404);
  });

  it('shares the ten-operation expensive preset across dynamic resources', async () => {
    const f = httpFixture();
    f.app.use('/api/batch', expensiveOperationRateLimiter);
    f.app.post('/api/batch/:id', (_req, res) => res.status(202).end());
    for (let i = 0; i < 10; i++) expect((await f.post(`/api/batch/${i}`)).status).toBe(202);
    const blocked = await f.post('/API/BATCH/different-id/');
    expect(blocked.status).toBe(429); expect(blocked.headers['x-ratelimit-limit']).toBe('10');
  });

  it('keeps separate authenticated-user budgets behind the same proxy IP', async () => {
    const f = httpFixture();
    f.app.use((req, _res, next) => {
      (req as typeof req & { user: { id: number } }).user = { id: Number(req.headers['x-synthetic-user']) };
      next();
    });
    f.app.use('/api', createRateLimiter({ bucket: 'synthetic-users', windowMs: 60000, maxRequests: 2 }));
    f.app.get('/api/card/:id', (_req, res) => res.json({ synthetic: true }));
    expect((await f.get('/api/card/a').set('X-Synthetic-User', '101')).status).toBe(200);
    expect((await f.get('/api/card/b').set('X-Synthetic-User', '101')).status).toBe(200);
    expect((await f.get('/api/card/c').set('X-Synthetic-User', '101')).status).toBe(429);
    expect((await f.get('/api/card/c').set('X-Synthetic-User', '102')).status).toBe(200);
  });

  it('enforces one Redis-backed budget atomically across concurrent aliases and refunds once', async () => {
    const counters = new Map<string, number>();
    const evalMock = vi.fn(async (script: string, _keys: number, key: string) => {
      if (script.includes('INCR')) { const count = (counters.get(key) ?? 0) + 1; counters.set(key, count); return [count, 60000]; }
      counters.set(key, Math.max(0, (counters.get(key) ?? 0) - 1)); return 0;
    });
    redisState.client = { eval: evalMock };
    const f = httpFixture();
    f.app.use('/api', createRateLimiter({ bucket: 'synthetic-redis', windowMs: 60000, maxRequests: 3, skipSuccessfulRequests: true }));
    f.app.post('/api/work/:id', (req, res) => req.query.success ? res.send({ synthetic: true }) : res.status(401).end());
    expect((await f.post('/api/work/initial?success=1')).status).toBe(200);
    expect(evalMock.mock.calls.filter(([script]) => script.includes('DECR'))).toHaveLength(1);
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => f.post(`/API/WORK/${i}/`)));
    expect(responses.filter(response => response.status === 401)).toHaveLength(3);
    expect(responses.filter(response => response.status === 429)).toHaveLength(9);
    expect(new Set(evalMock.mock.calls.map(call => call[2])).size).toBe(1);
    expect([...counters.keys()][0]).toMatch(/^ratelimit:synthetic-redis:ip:/);
    expect(evalMock.mock.calls[0][0]).toContain('PEXPIRE');
  });
});

describe("APTLSS generation rate-limit scope", () => {
  it("limits APTLSS mutations only", () => {
    expect(isAptlssExpensiveRequest("POST", "/aptlss/generate")).toBe(true);
    expect(isAptlssExpensiveRequest("POST", "/aptlss/generate-batch")).toBe(true);
    expect(isAptlssExpensiveRequest("DELETE", "/aptlss/scheduled/1")).toBe(true);
    expect(isAptlssExpensiveRequest("GET", "/aptlss/history")).toBe(false);
    expect(isAptlssExpensiveRequest("GET", "/trpc/auth.me")).toBe(false);
    expect(isAptlssExpensiveRequest("POST", "/trello/cards/1/status")).toBe(false);
  });
});

describe("anonymous session probe rate-limit scope", () => {
  it("exempts only the read-only unauthenticated auth.me query", () => {
    expect(isAnonymousSessionProbe("GET", "/trpc/auth.me", null)).toBe(true);
    expect(isAnonymousSessionProbe("GET", "/trpc/auth.me", { openId: "worker-1" })).toBe(false);
    expect(isAnonymousSessionProbe("POST", "/trpc/auth.me", null)).toBe(false);
    expect(isAnonymousSessionProbe("GET", "/trpc/settings.get", null)).toBe(false);
  });
});

describe("anonymous auth read rate-limit scope", () => {
  it("exempts only the login screen's safe GET probes from the strict auth budget", () => {
    expect(isAnonymousAuthReadProbe("GET", "/owner-bootstrap/status")).toBe(true);
    expect(isAnonymousAuthReadProbe("GET", "/trello/client-key")).toBe(true);
    expect(isAnonymousAuthReadProbe("POST", "/login")).toBe(false);
    expect(isAnonymousAuthReadProbe("POST", "/owner-bootstrap")).toBe(false);
    expect(isAnonymousAuthReadProbe("POST", "/trello/login-token")).toBe(false);
    expect(isAnonymousAuthReadProbe("GET", "/register")).toBe(false);
  });
});

describe("anonymous API read probe rate-limit scope", () => {
  it("exempts login-screen reads from the global API budget without exempting writes", () => {
    expect(isAnonymousApiReadProbe("GET", "/auth/owner-bootstrap/status", null)).toBe(true);
    expect(isAnonymousApiReadProbe("GET", "/auth/trello/client-key", null)).toBe(true);
    expect(isAnonymousApiReadProbe("GET", "/auth/owner-bootstrap/status", { openId: "owner-1" })).toBe(false);
    expect(isAnonymousApiReadProbe("POST", "/auth/login", null)).toBe(false);
    expect(isAnonymousApiReadProbe("GET", "/auth/register", null)).toBe(false);
  });
});
