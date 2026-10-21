import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.db }));
import holidayRoutes from './holidays';

function app(role = 'admin') {
  const instance = express();
  instance.use((req, _res, next) => {
    Object.assign(req, { user: { id: 7, role, openId: 'founder-seven' } });
    next();
  });
  instance.use('/api/holidays', holidayRoutes);
  return instance;
}

beforeEach(() => { vi.clearAllMocks(); mocks.db.mockResolvedValue(null); });
afterEach(() => vi.unstubAllGlobals());

describe('holiday country coverage', () => {
  it.each([
    'Asia/Karachi', 'Asia/Kolkata', 'Asia/Colombo', 'Asia/Kathmandu',
    'Asia/Yangon', 'Asia/Bangkok', 'Asia/Phnom_Penh', 'Asia/Kuala_Lumpur',
    'Asia/Taipei', 'Asia/Tashkent', 'Asia/Kuwait', 'Asia/Qatar',
    'Asia/Bahrain', 'Asia/Tehran', 'Asia/Jerusalem', 'Asia/Beirut',
    'Asia/Dubai', 'Asia/Riyadh', 'Pacific/Fiji', 'Pacific/Guam', 'Unknown/Zone',
  ])('refuses unavailable coverage without fetching or touching stored holidays: %s', async timezone => {
    const provider = vi.fn(); vi.stubGlobal('fetch', provider);
    const response = await request(app()).get(`/api/holidays/by-timezone/${encodeURIComponent(timezone)}/2026`);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Holiday coverage unavailable for this timezone');
    expect(provider).not.toHaveBeenCalled();
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it.each([['Europe/Amsterdam', 'NL'], ['Africa/Nairobi', 'KE'], ['Asia/Almaty', 'KZ']])(
    'stores only the actual country calendar for %s', async (timezone, country) => {
      const record = { date: '2026-01-01', name: 'New Year', localName: 'Local New Year', countryCode: country };
      const provider = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify([record]) }));
      vi.stubGlobal('fetch', provider);
      const values = vi.fn(async () => undefined);
      const remove = vi.fn(async () => undefined);
      const saved = [{ id: 12, userId: 7, userOpenId: 'founder-seven', date: record.date, name: record.localName, country, isActive: 1 }];
      const db = {
        delete: vi.fn(() => ({ where: remove })),
        insert: vi.fn(() => ({ values })),
        select: vi.fn(() => ({ from: () => ({ where: () => ({ orderBy: async () => saved }) }) })),
      };
      mocks.db.mockResolvedValue(db);
      const response = await request(app()).get(`/api/holidays/by-timezone/${encodeURIComponent(timezone)}/2026`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: true, countryCode: country, holidays: saved });
      expect(provider).toHaveBeenCalledExactlyOnceWith(`https://date.nager.at/api/v3/PublicHolidays/2026/${country}`,
        expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
      expect(values).toHaveBeenCalledExactlyOnceWith(saved.map(({ id: _id, ...row }) => row));
      expect(remove).toHaveBeenCalledOnce();
    },
  );

  it.each(['', '[]', '{}'])('does not replace stored holidays or claim coverage on an empty/non-array response: %j', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => body })));
    const response = await request(app()).get('/api/holidays/by-timezone/Europe%2FAmsterdam/2026');
    expect(response.status).toBe(404);
    expect(response.body.success).toBeUndefined();
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it('preserves provider 404 semantics without touching stored holidays', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    await request(app()).get('/api/holidays/by-timezone/Africa%2FNairobi/2026').expect(404);
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it('does not advertise unsupported Pakistan/India coverage', async () => {
    const response = await request(app()).get('/api/holidays/countries').expect(200);
    expect(response.body).toContainEqual({ countryCode: 'KE', name: 'Kenya' });
    expect(response.body.some((country: { countryCode: string }) => ['PK', 'IN'].includes(country.countryCode))).toBe(false);
  });

  it('preserves the admin boundary before provider or database access', async () => {
    const provider = vi.fn(); vi.stubGlobal('fetch', provider);
    await request(app('worker')).get('/api/holidays/by-timezone/Africa%2FNairobi/2026').expect(403);
    expect(provider).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
  });

  it('does not replace holidays when the requested worker is not owned by the founder', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify([
      { date: '2026-01-01', name: 'New Year', countryCode: 'KE' },
    ]) })));
    const db = {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })),
      delete: vi.fn(), insert: vi.fn(),
    };
    mocks.db.mockResolvedValue(db);
    await request(app()).get('/api/holidays/by-timezone/Africa%2FNairobi/2026?workerId=99').expect(404);
    expect(db.delete).not.toHaveBeenCalled(); expect(db.insert).not.toHaveBeenCalled();
  });

  it.each(['2019', '2031', '2026junk'])('preserves year validation: %s', async year => {
    const provider = vi.fn(); vi.stubGlobal('fetch', provider);
    await request(app()).get(`/api/holidays/by-timezone/Africa%2FNairobi/${year}`).expect(400);
    expect(provider).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
  });
});
