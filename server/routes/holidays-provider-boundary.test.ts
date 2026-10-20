import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ getDb: vi.fn(async () => null) }));
import holidayRoutes from './holidays';

afterEach(() => vi.unstubAllGlobals());

function holidayApp() {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: 1, role: 'admin', openId: 'owner' } });
    next();
  });
  app.use('/api/holidays', holidayRoutes);
  return app;
}

describe('holiday provider boundary', () => {
  it.each([
    '/fetch/NL/2026%2F..%2F2030', '/fetch/NL/2026junk',
    '/fetch/NL/2026%3Fredirect=https%3A%2F%2Fevil.example',
    '/fetch/NL/2026.0', '/fetch/NL/2e3',
    '/by-timezone/__proto__/2026', '/by-timezone/constructor/2026',
    '/by-timezone/Europe%2FAmsterdam/2026junk',
  ])('refuses malformed path input before any provider call: %s', async path => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await request(holidayApp()).get('/api/holidays' + path).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['/fetch/NL/2026', '/by-timezone/Europe%2FAmsterdam/2026'])(
    'uses the canonical fixed provider URL and refuses redirects: %s', async path => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [] }));
      vi.stubGlobal('fetch', fetchMock);
      // The deliberately unavailable DB is reached only after the guarded fetch.
      await request(holidayApp()).get('/api/holidays' + path);
      expect(fetchMock).toHaveBeenCalledWith('https://date.nager.at/api/v3/PublicHolidays/2026/NL',
        expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
    },
  );
  it('bounds outbound holiday provider calls with a request timeout', () => {
    const source = readFileSync(new URL('./holidays.ts', import.meta.url), 'utf8');

    expect(source).toContain('const HOLIDAY_REQUEST_TIMEOUT_MS = 10_000;');
    expect(source).toContain('signal: AbortSignal.timeout(HOLIDAY_REQUEST_TIMEOUT_MS)');
  });

  it('does not expose provider or database exception text to holiday clients', () => {
    const source = readFileSync(new URL('./holidays.ts', import.meta.url), 'utf8');

    expect(source).toContain("return res.status(500).json({ error: 'Failed to fetch holidays' });");
    expect(source).not.toContain("return res.status(500).json({ error: error?.message || 'Failed to fetch holidays' });");
  });
});
