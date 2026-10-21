import { matchesTimerWhere } from '../test/timerDatabase';
import type { Request } from 'express';
import express from 'express';
import request from 'supertest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { taskAssignments, timeEntries, vaProfiles, type User } from '../../drizzle/schema.postgres';

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));

import reportsRouter from './reports';

type Row = Record<string, any>;
const dialect = new MySqlDialect();

function equalityParameter(sql: string, params: unknown[], column: string) {
  const marker = '`' + column + '` = ?';
  const position = sql.indexOf(marker);
  if (position < 0) return undefined;
  const index = (sql.slice(0, position).match(/\?/g) ?? []).length;
  return params[index];
}

function createDatabase(profiles: Row[], entries: Row[], tasks: Row[] = []) {
  const queries: Array<{ table: unknown; condition?: unknown }> = [];
  const db = {
    select: vi.fn((selection?: Row) => {
      let table: unknown;
      let condition: unknown;
      const query: any = {
        from: (value: unknown) => { table = value; return query; },
        where: (value: unknown) => { condition = value; queries.push({ table, condition }); return query; },
        orderBy: () => query,
        limit: () => query,
        then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) => {
          let rows = table === vaProfiles ? profiles : table === timeEntries ? entries : table === taskAssignments ? tasks : [];
          if (condition && table === vaProfiles) {
            const compiled = dialect.sqlToQuery(condition as any);
            const userId = equalityParameter(compiled.sql, compiled.params, 'userId');
            const founderId = equalityParameter(compiled.sql, compiled.params, 'founderId');
            if (userId !== undefined) rows = rows.filter(row => row.userId === userId);
            if (founderId !== undefined) rows = rows.filter(row => row.founderId === founderId);
          }
          if (condition && table === timeEntries) {
            const compiled = dialect.sqlToQuery(condition as any);
            const founderId = equalityParameter(compiled.sql, compiled.params, 'founderId');
            if (founderId !== undefined) rows = rows.filter(row => row.founderId === founderId);
            const vaIdPosition = compiled.sql.indexOf('`vaId`');
            if (vaIdPosition >= 0 && /`vaId` in/i.test(compiled.sql)) {
              const firstVaIdParam = (compiled.sql.slice(0, vaIdPosition).match(/\?/g) ?? []).length;
              const vaIds = compiled.params.slice(firstVaIdParam);
              rows = rows.filter(row => vaIds.includes(row.vaId));
            }
          }
          if (condition && table === taskAssignments) {
            const compiled = dialect.sqlToQuery(condition as any);
            const founderId = equalityParameter(compiled.sql, compiled.params, 'founderId');
            if (founderId !== undefined) rows = rows.filter(row => row.founderId === founderId);
            const vaIdPosition = compiled.sql.indexOf('`vaId`');
            if (vaIdPosition >= 0 && /`vaId` in/i.test(compiled.sql)) {
              const firstVaIdParam = (compiled.sql.slice(0, vaIdPosition).match(/\?/g) ?? []).length;
              const vaIds = compiled.params.slice(firstVaIdParam);
              rows = rows.filter(row => vaIds.includes(row.vaId));
            }
          }
          if (condition) rows = rows.filter(row => matchesTimerWhere(row, condition));
          if (selection?.count) rows = [{ count: rows.length }];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    }),
  };
  return { db, queries };
}

function timeEntry(id: number, vaId: number, founderId: number, source: string, trackedUserId: number | null = null, trackedProfileId: number | null = null) {
  return {
    id, trackedUserId, trackedProfileId, isVoided: false,
    vaId,
    founderId,
    taskId: `task-${id}`,
    durationMinutes: 20,
    startTime: new Date('2026-09-02T09:00:00Z'),
    endTime: new Date('2026-09-02T09:20:00Z'),
    source,
  };
}

function appFor(user?: User) {
  const app = express();
  if (user) app.use((req: Request, _res, next) => {
    (req as Request & { user?: User }).user = user;
    next();
  });
  app.use('/api/reports', reportsRouter);
  return app;
}

const worker = { id: 42, openId: 'worker-42', name: 'Worker', role: 'worker' } as User;
const admin = { id: 1, openId: 'admin-1', name: 'Admin', role: 'admin' } as User;
const founder = { id: 7, openId: 'founder-7', name: 'Founder', role: 'user' } as User;

describe('reports CSV spreadsheet safety', () => {
  beforeEach(() => vi.clearAllMocks());

  const prefixes = ['', ' ', '\t', '\r', '\n', '\ufeff', '\u0000', '\u001f', '\u007f', '\u0085', '\u200b', ' \ufeff\t\u0000'];
  const formulas = prefixes.flatMap(prefix => ['=', '+', '-', '@', '\uff1d', '\uff0b', '\uff0d', '\uff20'].map(marker => `${prefix}${marker}1+1`));

  it.each(formulas)('neutralizes time-entry formula strings %j', async formula => {
    mocks.getDb.mockResolvedValue(createDatabase([], [timeEntry(51, 3, 7, formula)]).db);
    const response = await request(appFor(admin))
      .get('/api/reports/export?format=csv&type=time-entries')
      .expect(200);

    const safe = `'${formula}`;
    const encoded = /[\r\n]/.test(safe) ? `"${safe}"` : safe;
    expect(response.headers['content-type']).toMatch(/^text\/csv/);
    expect(response.headers['content-disposition']).toContain('time-entries.csv');
    expect(response.text).toBe('id,trackedUserId,trackedProfileId,legacyVaId,founderId,taskId,durationMinutes,startTime,endTime,source\r\n'
      + `51,,,3,7,task-51,20,2026-09-02T09:00:00.000Z,2026-09-02T09:20:00.000Z,${encoded}`);
  });

  it.each(['=HYPERLINK("https://example.invalid","label")', ' \ufeff+1', '\t-1', '\u0000@SUM(1,2)',
    ...['\uff1d', '\uff0b', '\uff0d', '\uff20'].flatMap(marker => [
      `${marker}SUM(1,2)`, ` \ufeff\t${marker}SUM(1,2)`,
    ])])(
    'neutralizes task-summary string cells %j with RFC quoting', async formula => {
      mocks.getDb.mockResolvedValue(createDatabase([], [], [{
        id: 81, taskId: formula, vaId: 3, founderId: 7, status: formula,
        assignedAt: new Date('2026-09-02T09:00:00Z'), updatedAt: new Date('2026-09-02T09:00:00Z'),
      }]).db);
      const response = await request(appFor(admin))
        .get('/api/reports/export?format=csv&type=task-summary')
        .expect(200);

      const safe = `'${formula}`;
      const encoded = /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
      expect(response.headers['content-disposition']).toContain('task-summary.csv');
      expect(response.text).toBe('id,taskId,vaId,founderId,status,assignedAt,updatedAt\r\n'
        + `81,${encoded},3,7,${encoded},2026-09-02T09:00:00.000Z,2026-09-02T09:00:00.000Z`);
    });

  it('preserves actual negative numbers, nulls, and ordinary quoted multiline strings', async () => {
    mocks.getDb.mockResolvedValue(createDatabase([], [{
      ...timeEntry(51, 3, 7, 'ordinary, "quoted"\r\nnext line'),
      taskId: null, durationMinutes: -12.5, endTime: null,
    }]).db);
    const response = await request(appFor(admin))
      .get('/api/reports/export?format=csv&type=time-entries')
      .expect(200);

    expect(response.text).toBe('id,trackedUserId,trackedProfileId,legacyVaId,founderId,taskId,durationMinutes,startTime,endTime,source\r\n'
      + '51,,,3,7,,-12.5,2026-09-02T09:00:00.000Z,,"ordinary, ""quoted""\r\nnext line"');
  });

  it('neutralizes malicious task IDs and sources together in time-entry output', async () => {
    mocks.getDb.mockResolvedValue(createDatabase([], [{
      ...timeEntry(51, 3, 7, '\ufeff@SUM(1,2)'),
      taskId: '=HYPERLINK("https://example.invalid","task")', durationMinutes: -20,
    }]).db);
    const response = await request(appFor(admin))
      .get('/api/reports/export?format=csv&type=time-entries')
      .expect(200);
    expect(response.text).toBe('id,trackedUserId,trackedProfileId,legacyVaId,founderId,taskId,durationMinutes,startTime,endTime,source\r\n'
      + '51,,,3,7,"\'=HYPERLINK(""https://example.invalid"",""task"")",-20,2026-09-02T09:00:00.000Z,2026-09-02T09:20:00.000Z,"\'\ufeff@SUM(1,2)"');
  });

  it('preserves ordinary strings containing non-leading formula characters', async () => {
    mocks.getDb.mockResolvedValue(createDatabase([], [timeEntry(51, 3, 7, 'alice@example.invalid + adjustment = -1')]).db);
    const response = await request(appFor(admin))
      .get('/api/reports/export?format=csv&type=time-entries')
      .expect(200);
    expect(response.text).toContain(',alice@example.invalid + adjustment = -1');
    expect(response.text).not.toContain("'alice");
  });
});

describe('reports export authorization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('limits worker time-entry CSV to its explicit canonical account within the active tenant', async () => {
    const profiles = [
      { id: 3, userId: 42, founderId: 7, status: 'active' },
      { id: 4, userId: 42, founderId: 8, status: 'inactive' },
      { id: 9, userId: 88, founderId: 7, status: 'active' },
    ];
    const { db, queries } = createDatabase(profiles, [
      timeEntry(51, 42, 7, 'active-account-entry', 42, 3),
      timeEntry(52, 3, 7, 'active-profile-entry', 42, 3),
      timeEntry(53, 88, 7, 'other-worker-account-entry'),
      timeEntry(54, 9, 7, 'other-worker-profile-entry'),
      timeEntry(55, 42, 8, 'other-founder-entry'),
      timeEntry(56, 4, 8, 'inactive-profile-entry'),
    ]);
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(worker))
      .get('/api/reports/export?format=csv&type=time-entries')
      .expect(200);

    expect(response.text).toContain('active-account-entry');
    expect(response.text).toContain('active-profile-entry');
    expect(response.text).not.toContain('other-worker-account-entry');
    expect(response.text).not.toContain('other-worker-profile-entry');
    expect(response.text).not.toContain('other-founder-entry');
    expect(response.text).not.toContain('inactive-profile-entry');

    const entryQuery = queries.find(query => query.table === timeEntries);
    const compiled = dialect.sqlToQuery(entryQuery?.condition as any);
    expect(compiled.sql).toContain('founderId');
    expect(compiled.sql).toContain('trackedUserId');
    expect(compiled.params).toEqual([42, 7]);
  });

  it('omits legacy entries whose ID could belong to another profile', async () => {
    const profiles = [
      { id: 42, userId: 88, founderId: 7, status: 'active' },
      { id: 88, userId: 99, founderId: 7, status: 'active' },
    ];
    mocks.getDb.mockResolvedValue(createDatabase(profiles, [
      timeEntry(61, 42, 7, 'unambiguous-profile-entry', 88, 42),
      timeEntry(62, 88, 7, 'ambiguous-worker-or-profile-entry'),
    ]).db);
    const collisionWorker = { id: 88, openId: 'worker-88', name: 'Worker', role: 'worker' } as User;

    const response = await request(appFor(collisionWorker))
      .get('/api/reports/export?format=csv&type=time-entries')
      .expect(200);

    expect(response.text).toContain('unambiguous-profile-entry');
    expect(response.text).not.toContain('ambiguous-worker-or-profile-entry');
  });

  it.each([
    { name: 'worker', user: worker, allowed: ['worker-task'], profiles: [
      { id: 3, userId: 42, founderId: 7, status: 'active' },
      { id: 4, userId: 42, founderId: 7, status: 'inactive' },
      { id: 9, userId: 88, founderId: 7, status: 'active' },
    ] },
    { name: 'founder', user: founder, allowed: ['founder-task'], profiles: [
      { id: 3, userId: 42, founderId: 7, status: 'active' },
      { id: 9, userId: 88, founderId: 8, status: 'active' },
    ] },
  ])('keeps $name task exports inside both profile and founder ownership', async ({ user, allowed, profiles }) => {
    const tasks = [
      { id: 81, taskId: user.role === 'worker' ? 'worker-task' : 'founder-task', vaId: 3, founderId: 7,
        status: 'assigned', assignedAt: new Date('2026-09-02T09:00:00Z'), updatedAt: new Date('2026-09-02T09:00:00Z') },
      { id: 82, taskId: 'cross-founder-mismatch', vaId: 3, founderId: 8,
        status: 'assigned', assignedAt: new Date('2026-09-02T09:00:00Z'), updatedAt: new Date('2026-09-02T09:00:00Z') },
      { id: 83, taskId: 'other-worker-task', vaId: 9, founderId: 7,
        status: 'assigned', assignedAt: new Date('2026-09-02T09:00:00Z'), updatedAt: new Date('2026-09-02T09:00:00Z') },
      { id: 84, taskId: 'inactive-worker-task', vaId: 4, founderId: 7,
        status: 'assigned', assignedAt: new Date('2026-09-02T09:00:00Z'), updatedAt: new Date('2026-09-02T09:00:00Z') },
    ];
    const { db } = createDatabase(profiles, [], tasks);
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(user))
      .get('/api/reports/export?format=csv&type=task-summary')
      .expect(200);

    for (const taskId of allowed) expect(response.text).toContain(taskId);
    expect(response.text).not.toContain('cross-founder-mismatch');
    if (user.role === 'worker') {
      expect(response.text).not.toContain('other-worker-task');
      expect(response.text).not.toContain('inactive-worker-task');
    }
  });

  it.each([
    {
      name: 'inactive',
      profiles: [{ id: 4, userId: 42, founderId: 7, status: 'inactive' }],
      tasks: [{ id: 84, taskId: 'inactive-profile-task', vaId: 4, founderId: 7,
        status: 'assigned', assignedAt: new Date('2026-09-02T09:00:00Z'), updatedAt: new Date('2026-09-02T09:00:00Z') }],
    },
    {
      name: 'ambiguous',
      profiles: [
        { id: 3, userId: 42, founderId: 7, status: 'active' },
        { id: 4, userId: 42, founderId: 7, status: 'active' },
      ],
      tasks: [
        { id: 83, taskId: 'active-profile-task-a', vaId: 3, founderId: 7,
          status: 'assigned', assignedAt: new Date('2026-09-02T09:00:00Z'), updatedAt: new Date('2026-09-02T09:00:00Z') },
        { id: 84, taskId: 'active-profile-task-b', vaId: 4, founderId: 7,
          status: 'assigned', assignedAt: new Date('2026-09-02T09:00:00Z'), updatedAt: new Date('2026-09-02T09:00:00Z') },
      ],
    },
  ])('denies direct task export for a worker with an $name profile set', async ({ profiles, tasks }) => {
    const { db } = createDatabase(profiles, [], tasks);
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(worker))
      .get('/api/reports/export?format=csv&type=task-summary')
      .expect(403, { error: 'An active worker profile is required' });

    expect(response.text).not.toContain('inactive-profile-task');
    expect(response.text).not.toContain('active-profile-task-a');
    expect(response.text).not.toContain('active-profile-task-b');
    expect(db.select).toHaveBeenCalledOnce();
  });

  it('rejects unsupported roles instead of treating them as founders', async () => {
    const unsupported = { id: 7, openId: 'unsupported-7', name: 'Other role', role: 'auditor' } as User;
    await request(appFor(unsupported))
      .get('/api/reports/export?format=csv&type=task-summary')
      .expect(403, { error: 'Forbidden' });

    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'admin', user: admin, expected: ['admin-history-a', 'admin-history-b', 'other-founder-entry'] },
    { name: 'founder', user: founder, expected: ['admin-history-a', 'admin-history-b'] },
  ])('preserves $name access to historical time entries', async ({ user, expected }) => {
    const profiles = [
      { id: 3, userId: 42, founderId: 7, status: 'inactive' },
      { id: 4, userId: 43, founderId: 7, status: 'inactive' },
      { id: 5, userId: 44, founderId: 8, status: 'inactive' },
    ];
    const { db } = createDatabase(profiles, [
      timeEntry(71, 3, 7, 'admin-history-a'),
      timeEntry(72, 4, 7, 'admin-history-b'),
      timeEntry(73, 5, 8, 'other-founder-entry'),
    ]);
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(user))
      .get('/api/reports/export?format=csv&type=time-entries')
      .expect(200);

    for (const source of expected) expect(response.text).toContain(source);
    if (user.role !== 'admin') expect(response.text).not.toContain('other-founder-entry');
  });

  it('authenticates PDF export requests and rejects PDF without querying export data', async () => {
    await request(appFor())
      .get('/api/reports/export?format=pdf&type=task-summary')
      .expect(401);
    await request(appFor(admin))
      .get('/api/reports/export?format=pdf&type=task-summary')
      .expect(400, {
        error: 'Unsupported export format or type',
        supported: ['csv/time-entries', 'csv/task-summary'],
      });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});
