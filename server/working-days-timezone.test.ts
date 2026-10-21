import express from 'express';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clients, holidays, taskAssignments, taskDependencies, userWorkingHours, vaProfiles, users } from '../drizzle/schema.postgres';
import { matchesTimerWhere } from './test/timerDatabase';
import { dateKeyInTimeZone, dateWindowInTimeZone, dayOfWeekForDateKey, dayOfWeekInTimeZone, zonedDateTimeToUtc } from '../shared/workerTime';
import { calculateScheduledTargetSeconds } from './complianceMetrics';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), provider: vi.fn() }));
vi.mock('./db', () => ({ getDb: mocks.getDb }));
vi.mock('./utils/retry', () => ({ fetchWithRetry: mocks.provider }));
vi.mock('./services/trello-cache', () => ({
  getCachedTasks: vi.fn(), setCachedTasks: vi.fn(), invalidateCache: vi.fn(),
}));
import { getCachedTasks, setCachedTasks } from './services/trello-cache';
vi.mock('./services/request-queue', () => ({
  requestQueue: { execute: async (_key: string, operation: () => Promise<unknown>) => operation() },
}));
vi.mock('./services/websocket', () => ({ websocketService: {} }));

type Row = Record<string, unknown>;

describe('Working Days and Timezone Features (isolated production routes)', () => {
  let server: Server;
  let rows: Map<unknown, Row[]>;
  let authenticated = true;
  let cardDate: string;
  let blockedFetch: ReturnType<typeof vi.fn>;
  const fixtureUser = { id: 8101, openId: 'working-days-route-fixture', role: 'admin' };

  beforeAll(async () => {
    // Own only the cache-expiry interval created while importing this router.
    const intervals: ReturnType<typeof setInterval>[] = [];
    const realSetInterval = globalThis.setInterval;
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, timeout, ...args) => {
      const interval = realSetInterval(handler, timeout, ...args);
      intervals.push(interval);
      return interval;
    });
    let workingHoursRouter;
    let aptlssRouter;
    try {
      workingHoursRouter = (await import('./routes/working-hours')).default;
      aptlssRouter = (await import('./routes/aptlss')).default;
    } finally {
      intervalSpy.mockRestore();
      intervals.forEach(clearInterval);
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (authenticated) Object.assign(req, { user: fixtureUser });
      next();
    });
    app.use('/api/working-hours', workingHoursRouter);
    app.use('/api', aptlssRouter);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  });

  beforeEach(() => {
    authenticated = true;
    cardDate = '2030-01-07'; // Monday, with an explicit provider due date.
    vi.stubEnv('TZ', 'UTC');
    vi.stubEnv('TRELLO_API_KEY', 'fixture-key');
    vi.stubEnv('TRELLO_TOKEN', 'fixture-token');
    blockedFetch = vi.fn(() => { throw new Error('Unexpected network fetch outside the fixture'); });
    vi.stubGlobal('fetch', blockedFetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rows = new Map<unknown, Row[]>([
      [userWorkingHours, [{
        userId: fixtureUser.id, userOpenId: fixtureUser.openId,
        workStartHour: 10, workStartMinute: 0, workEndHour: 18, workEndMinute: 0,
        workingDays: '1,2,3,4,5',
        timezone: 'Europe/Amsterdam', enableBreaks: 0,
        lunchTime: '13:00', lunchDuration: 30,
        breakfastTime: '09:00', breakfastDuration: 45,
        dinnerTime: '20:00', dinnerDuration: 120,
        shortBreakInterval: 120, shortBreakDuration: 10,
        longBreakInterval: 240, longBreakDuration: 30,
        country: 'NL', weeklyHoursMin: 30, weeklyHoursMax: 40,
        dailyHoursMin: '6', dailyHoursMax: '8',
      }]],
      [clients, []], [holidays, []], [taskAssignments, []], [vaProfiles, []], [taskDependencies, []],
      [users, [fixtureUser]],
    ]);
    const readRows = (table: unknown) => {
      const result = rows.get(table);
      if (!result) throw new Error('Unconfigured fixture table');
      return result;
    };
    const db: any = {
      transaction: (operation: (tx: any) => Promise<unknown>) => operation(db),
      execute: async () => ({ rows: [] }),
      select: () => ({ from: (table: unknown) => {
        let condition: unknown;
        let limit = Infinity;
        const result = () => readRows(table).filter(row => matchesTimerWhere(row, condition)).slice(0, limit);
        const query = {
          where: (value: unknown) => { condition = value; return query; },
          orderBy: () => query,
          for: () => query,
          limit: (count: number) => { limit = count; return query; },
          then: (resolve: (value: Row[]) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(result()).then(resolve, reject),
        };
        return query;
      } }),
      insert: (table: unknown) => ({ values: async (value: Row) => { readRows(table).push(value); } }),
      update: (table: unknown) => ({ set: (value: Row) => ({ where: async (_condition: unknown) => {
        Object.assign(readRows(table)[0], value);
      } }) }),
    };
    mocks.getDb.mockReset().mockResolvedValue(db);
    vi.mocked(getCachedTasks).mockReset();
    vi.mocked(setCachedTasks).mockClear();
    mocks.provider.mockReset().mockImplementation(async (input: string) => {
      const url = new URL(input);
      expect(url.origin).toBe('https://api.trello.com');
      expect(url.searchParams.get('key')).toBe('fixture-key');
      expect(url.searchParams.get('token')).toBe('fixture-token');
      const responses: Record<string, unknown> = {
        '/1/members/me/organizations': [{ id: 'fixture-workspace', displayName: 'Fixture' }],
        '/1/organizations/fixture-workspace/boards': [{ id: 'fixture-board', name: 'Fixture board' }],
        '/1/boards/fixture-board/cards': [{
          id: 'fixture-card', name: 'Prepare report', closed: false, list: { name: 'Doing' },
          due: cardDate + 'T12:00:00.000Z', labels: [],
          checklists: [{ id: 'fixture-checklist', name: 'APTLSS', checkItems: [
            { id: 'pending', name: 'Prepare report (1h)', state: 'incomplete', pos: 1 },
            { id: 'complete', name: 'Completed report (1h)', state: 'complete', pos: 2 },
          ] }],
        }],
      };
      if (!(url.pathname in responses)) throw new Error('Unconfigured provider endpoint: ' + url.pathname);
      return new Response(JSON.stringify(responses[url.pathname]), { status: 200 });
    });
  });

  afterEach(() => {
    try { expect(blockedFetch).not.toHaveBeenCalled(); }
    finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });

  afterAll(async () => {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  async function tasks() {
    const response = await request(server).get('/api/trello/tasks').expect(200);
    expect(mocks.provider).toHaveBeenCalledTimes(3);
    expect(response.body.tasks).toHaveLength(1);
    expect(response.body.overflow).toEqual([]);
    expect(response.body.tasks[0].id).toBe('fixture-card_pending');
    return response.body;
  }

  it('returns explicit default working days and UTC when no settings exist', async () => {
    rows.set(userWorkingHours, []);
    const { body } = await request(server).get('/api/working-hours/settings').expect(200);
    expect(body).toMatchObject({ workingDays: '1,2,3,4,5', timezone: 'UTC', workStartHour: 9 });
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it('returns saved working days and timezone without requiring provider access', async () => {
    const { body } = await request(server).get('/api/working-hours/settings').expect(200);
    expect(body).toMatchObject({ workingDays: '1,2,3,4,5', timezone: 'Europe/Amsterdam', enableBreaks: false });
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it('round-trips updated weekend working days and timezone through the production routes', async () => {
    const settings = { ...rows.get(userWorkingHours)![0], workingDays: '0,6', timezone: 'Asia/Tokyo' };
    await request(server).post('/api/working-hours/settings').send(settings).expect(200, { success: true, scope: 'global' });
    const { body } = await request(server).get('/api/working-hours/settings').expect(200);
    expect(body).toMatchObject({ workingDays: '0,6', timezone: 'Asia/Tokyo' });
    cardDate = '2030-01-06'; // Sunday is enabled by the saved setting.
    const result = await tasks();
    expect(result.timezone).toBe('Asia/Tokyo');
    expect(result.tasks[0]).toMatchObject({ date: cardDate, startTime: '10:00', endTime: '11:00' });
  });

  it('inserts the first settings record with the authenticated identity', async () => {
    rows.set(userWorkingHours, []);
    await request(server).post('/api/working-hours/settings')
      .send({ workingDays: '1,3,5', timezone: 'Australia/Sydney' }).expect(200);
    expect(rows.get(userWorkingHours)).toHaveLength(1);
    expect(rows.get(userWorkingHours)![0]).toMatchObject({
      userId: fixtureUser.id, userOpenId: fixtureUser.openId,
      workingDays: '1,3,5', timezone: 'Australia/Sydney',
    });
  });

  it('uses per-worker working days and timezone rather than global defaults', async () => {
    rows.set(vaProfiles, [{ id: 9101, founderId: fixtureUser.id, name: 'Fixture worker',
      workingDays: '0,6', timezone: 'Asia/Tokyo', workStartHour: 7, workEndHour: 15 }]);
    const { body } = await request(server).get('/api/working-hours/settings?workerId=9101').expect(200);
    expect(body).toMatchObject({ workingDays: '0,6', timezone: 'Asia/Tokyo', workStartHour: 7,
      workEndHour: 15, _isWorkerSettings: true, _workerId: 9101 });
  });

  it('parses real checklist items and schedules an incomplete task within configured hours', async () => {
    const result = await tasks();
    expect(result.timezone).toBe('Europe/Amsterdam');
    expect(result.tasks[0]).toMatchObject({ date: cardDate, durationHours: 1,
      startTime: '10:00', endTime: '11:00', isCompleted: false });
  });

  it('marks tasks on a disabled Sunday as unscheduled rather than inventing a time slot', async () => {
    cardDate = '2030-01-06';
    const result = await tasks();
    expect(result.tasks[0]).toMatchObject({ date: cardDate, startTime: 'TBD', endTime: 'TBD', note: 'Non-working day' });
  });

  it('honors a custom weekday list instead of assuming every Monday is a workday', async () => {
    rows.get(userWorkingHours)![0].workingDays = '2,4';
    const result = await tasks();
    expect(result.tasks[0]).toMatchObject({ startTime: 'TBD', endTime: 'TBD', note: 'Non-working day' });
  });

  it('keeps an active holiday unscheduled even when its weekday is enabled', async () => {
    rows.set(holidays, [{ userOpenId: fixtureUser.openId, date: cardDate, isActive: 1 }]);
    const result = await tasks();
    expect(result.tasks[0]).toMatchObject({ startTime: 'TBD', endTime: 'TBD', note: 'Holiday' });
  });

  it('converts an instant across date boundaries using production timezone logic', () => {
    const instant = new Date('2030-01-07T00:30:00.000Z');
    expect(dateKeyInTimeZone(instant, 'UTC')).toBe('2030-01-07');
    expect(dateKeyInTimeZone(instant, 'America/New_York')).toBe('2030-01-06');
    expect(dateKeyInTimeZone(instant, 'Asia/Tokyo')).toBe('2030-01-07');
  });

  it.each(['/api/working-hours/settings', '/api/trello/tasks'])('rejects unauthenticated requests to %s before dependencies', async endpoint => {
    authenticated = false;
    await request(server).get(endpoint).expect(401, { error: 'Unauthorized' });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it('returns 503 when settings cannot access the database instead of passing with empty data', async () => {
    mocks.getDb.mockResolvedValue(null);
    await request(server).get('/api/working-hours/settings').expect(503, { error: 'Database not available' });
  });

  it('returns 503 before provider calls when task assignment verification has no database', async () => {
    mocks.getDb.mockResolvedValue(null);
    await request(server).get('/api/trello/tasks').expect(503, { error: 'Worker assignments could not be verified; retry before scheduling' });
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(setCachedTasks).not.toHaveBeenCalled();
  });

  it.each(['inactive', 'role', 'ambiguous', 'foreign', 'duplicate'])('does not schedule or cache an unverified %s assignment', async invalid => {
    rows.set(users, [fixtureUser, { id: 8201, role: invalid === 'role' ? 'admin' : 'worker' }]);
    rows.set(vaProfiles, [{ id: 9101, userId: 8201, founderId: invalid === 'foreign' ? 99 : fixtureUser.id,
      status: invalid === 'inactive' ? 'inactive' : 'active' }]);
    rows.set(taskAssignments, [{ id: 1, taskId: 'fixture-card_pending', founderId: fixtureUser.id, vaId: 9101, status: 'assigned' }]);
    if (invalid === 'ambiguous') rows.get(vaProfiles)!.push({ id: 9102, userId: 8201, founderId: fixtureUser.id, status: 'active' });
    if (invalid === 'duplicate') rows.get(taskAssignments)!.push({ ...rows.get(taskAssignments)![0], id: 2, status: 'completed' });
    await request(server).get('/api/trello/tasks').expect(409);
    expect(setCachedTasks).not.toHaveBeenCalled();
  });

  it('does not serve a cached schedule after its worker was offboarded', async () => {
    vi.mocked(getCachedTasks).mockResolvedValue({ tasks: [{ id: 'fixture-card_pending', workerId: 9101 }], overflow: [] });
    rows.set(users, [fixtureUser, { id: 8201, role: 'worker' }]);
    rows.set(vaProfiles, [{ id: 9101, userId: 8201, founderId: fixtureUser.id, status: 'inactive' }]);
    rows.set(taskAssignments, [{ id: 1, taskId: 'fixture-card_pending', founderId: fixtureUser.id, vaId: 9101, status: 'assigned' }]);
    await request(server).get('/api/trello/tasks').expect(409);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(setCachedTasks).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing worker rather than silently using global settings', async () => {
    await request(server).get('/api/working-hours/settings?workerId=9101').expect(404, { error: 'Worker not found' });
  });

  it('reports provider failure without issuing a real network request or returning empty success', async () => {
    mocks.provider.mockRejectedValue(new Error('Fixture provider unavailable'));
    await request(server).get('/api/trello/tasks').expect(500, { error: 'Failed to fetch tasks from Trello' });
    expect(mocks.provider).toHaveBeenCalledTimes(1);
  });
});

describe("working-day and timezone scheduling", () => {
  it("maps date keys to weekdays independently of the host timezone", () => {
    const week = [
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
    ];

    expect(week.map(dayOfWeekForDateKey)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it("uses the worker's local date and weekday at UTC day boundaries", () => {
    const instant = new Date("2026-07-30T22:30:00.000Z");

    expect(dateKeyInTimeZone(instant, "Africa/Nairobi")).toBe("2026-07-31");
    expect(dayOfWeekInTimeZone(instant, "Africa/Nairobi")).toBe(5);
    expect(dateKeyInTimeZone(instant, "America/New_York")).toBe("2026-07-30");
    expect(dayOfWeekInTimeZone(instant, "America/New_York")).toBe(4);
  });

  it("calculates working-day targets and excludes configured non-working days", () => {
    const schedule = {
      workStartTime: "08:00",
      workEndTime: "17:00",
      workingDays: [1, 2, 3, 4, 5],
      breaks: [{ startTime: "12:00", durationMinutes: 60 }],
    };

    expect(calculateScheduledTargetSeconds(schedule, "2026-09-18")).toBe(8 * 3600);
    expect(calculateScheduledTargetSeconds(schedule, "2026-09-19")).toBe(0);
    expect(calculateScheduledTargetSeconds(schedule, "2026-09-20")).toBe(0);
  });

  it("builds local-day UTC windows with the correct DST duration", () => {
    const springForward = dateWindowInTimeZone("2026-03-29", "Europe/Amsterdam");
    const fallBack = dateWindowInTimeZone("2026-10-25", "Europe/Amsterdam");

    expect(springForward.start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect((springForward.endExclusive.getTime() - springForward.start.getTime()) / 3_600_000).toBe(23);
    expect(fallBack.start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect((fallBack.endExclusive.getTime() - fallBack.start.getTime()) / 3_600_000).toBe(25);
  });

  it("converts local working times using the date-specific timezone offset", () => {
    expect(zonedDateTimeToUtc("2026-07-30", "09:00", "Europe/Amsterdam").toISOString())
      .toBe("2026-07-30T07:00:00.000Z");
    expect(zonedDateTimeToUtc("2026-12-30", "09:00", "Europe/Amsterdam").toISOString())
      .toBe("2026-12-30T08:00:00.000Z");
  });
});
