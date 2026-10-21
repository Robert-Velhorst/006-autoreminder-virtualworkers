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

function inArrayParameters(sql: string, params: unknown[], column: string) {
  const clause = new RegExp('`' + column + '` in \\(([^)]*)\\)', 'i').exec(sql);
  if (!clause || clause.index === undefined) return undefined;
  const start = (sql.slice(0, clause.index).match(/\?/g) ?? []).length;
  const count = (clause[1].match(/\?/g) ?? []).length;
  return params.slice(start, start + count);
}

function createDatabase(profiles: Row[], entries: Row[], tasks: Row[] = []) {
  const queriedTables: unknown[] = [];
  const db = {
    select: vi.fn((selection?: Row) => {
      let table: unknown;
      let condition: unknown;
      const query: any = {
        from: (value: unknown) => { table = value; return query; },
        where: (value: unknown) => { condition = value; queriedTables.push(table); return query; },
        orderBy: () => query,
        then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) => {
          let rows = table === vaProfiles ? profiles : table === timeEntries ? entries : table === taskAssignments ? tasks : [];
          if (condition) {
            const compiled = dialect.sqlToQuery(condition as any);
            const userId = equalityParameter(compiled.sql, compiled.params, 'userId');
            const founderId = equalityParameter(compiled.sql, compiled.params, 'founderId');
            const vaIds = inArrayParameters(compiled.sql, compiled.params, 'vaId');
            if (table === vaProfiles && userId !== undefined) rows = rows.filter(row => row.userId === userId);
            if (founderId !== undefined) rows = rows.filter(row => row.founderId === founderId);
            if (vaIds) rows = rows.filter(row => vaIds.includes(row.vaId));
          }
          if (condition) rows = rows.filter(row => matchesTimerWhere(row, condition));
          if (selection?.count) rows = [{ count: rows.length }];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    }),
  };
  return { db, queriedTables };
}

function appFor(user?: User) {
  const app = express();
  if (user) {
    app.use((req: Request, _res, next) => {
      (req as Request & { user?: User }).user = user;
      next();
    });
  }
  app.use('/api/reports', reportsRouter);
  return app;
}

function assignedTask(id: number, taskId: string, vaId: number, founderId: number) {
  return {
    id,
    taskId,
    vaId,
    founderId,
    status: 'assigned',
    assignedAt: new Date('2026-09-02T09:00:00Z'),
    updatedAt: new Date('2026-09-02T09:00:00Z'),
  };
}

function timeEntry(id: number, vaId: number, founderId: number, source: string, trackedUserId: number | null = null, trackedProfileId: number | null = null) {
  return {
    id, trackedUserId, trackedProfileId, isVoided: false,
    vaId,
    founderId,
    taskId: 'task-' + id,
    durationMinutes: 20,
    startTime: new Date('2026-09-02T09:00:00Z'),
    endTime: new Date('2026-09-02T09:20:00Z'),
    source,
  };
}

const worker = { id: 42, openId: 'worker-42', name: 'Worker', role: 'worker' } as User;

describe('reports worker object authorization boundary', () => {
  beforeEach(() => mocks.getDb.mockReset());

  it('rejects unauthenticated export requests before loading the database', async () => {
    await request(appFor())
      .get('/api/reports/export?format=csv&type=task-summary')
      .expect(401, { error: 'Unauthorized' });

    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it.each(['founder', 'auditor'])('rejects unsupported role %s before reading report objects', async role => {
    const { db } = createDatabase(
      [{ id: 3, userId: 42, founderId: 7, status: 'active' }],
      [],
      [assignedTask(81, 'must-not-be-exported', 3, 7)],
    );
    mocks.getDb.mockResolvedValue(db);
    const unsupported = { id: 7, openId: 'unsupported-7', name: 'Unsupported', role } as unknown as User;

    await request(appFor(unsupported))
      .get('/api/reports/export?format=csv&type=task-summary')
      .expect(403, { error: 'Forbidden' });

    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('exports only tasks assigned to the worker active profile and its founder', async () => {
    const { db } = createDatabase([
      { id: 3, userId: 42, founderId: 7, status: 'active' },
      { id: 4, userId: 42, founderId: 7, status: 'inactive' },
      { id: 9, userId: 88, founderId: 7, status: 'active' },
    ], [], [
      assignedTask(81, 'assigned-to-active-worker', 3, 7),
      assignedTask(82, 'assigned-to-other-worker', 9, 7),
      assignedTask(83, 'assigned-to-inactive-profile', 4, 7),
      assignedTask(84, 'founder-id-does-not-match', 3, 8),
    ]);
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(worker))
      .get('/api/reports/export?format=csv&type=task-summary&workerId=88&founderId=8')
      .expect(200);

    expect(response.text).toContain('assigned-to-active-worker');
    expect(response.text).not.toContain('assigned-to-other-worker');
    expect(response.text).not.toContain('assigned-to-inactive-profile');
    expect(response.text).not.toContain('founder-id-does-not-match');
  });

  it('exports only the active worker profile time entries, excluding other workers and founders', async () => {
    const { db } = createDatabase([
      { id: 3, userId: 42, founderId: 7, status: 'active' },
      { id: 9, userId: 88, founderId: 7, status: 'active' },
      { id: 4, userId: 42, founderId: 8, status: 'inactive' },
    ], [
      timeEntry(51, 42, 7, 'active-worker-legacy-entry', 42, 3),
      timeEntry(52, 3, 7, 'active-worker-profile-entry', 42, 3),
      timeEntry(53, 88, 7, 'other-worker-legacy-entry'),
      timeEntry(54, 9, 7, 'other-worker-profile-entry'),
      timeEntry(55, 42, 8, 'other-founder-legacy-entry'),
      timeEntry(56, 4, 8, 'other-founder-profile-entry'),
    ]);
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(worker))
      .get('/api/reports/export?format=csv&type=time-entries&workerId=88')
      .expect(200);

    expect(response.text).toContain('active-worker-legacy-entry');
    expect(response.text).toContain('active-worker-profile-entry');
    expect(response.text).not.toContain('other-worker-legacy-entry');
    expect(response.text).not.toContain('other-worker-profile-entry');
    expect(response.text).not.toContain('other-founder-legacy-entry');
    expect(response.text).not.toContain('other-founder-profile-entry');
  });

  it('denies worker exports when more than one active profile makes the object scope ambiguous', async () => {
    const { db, queriedTables } = createDatabase([
      { id: 3, userId: 42, founderId: 7, status: 'active' },
      { id: 4, userId: 42, founderId: 8, status: 'active' },
    ], [timeEntry(51, 3, 7, 'ambiguous-profile-data')], [
      assignedTask(81, 'ambiguous-profile-task', 3, 7),
    ]);
    mocks.getDb.mockResolvedValue(db);

    const response = await request(appFor(worker))
      .get('/api/reports/export?format=csv&type=task-summary')
      .expect(403, { error: 'An active worker profile is required' });

    expect(response.text).not.toContain('ambiguous-profile-task');
    expect(queriedTables).toEqual([vaProfiles]);
  });
});
