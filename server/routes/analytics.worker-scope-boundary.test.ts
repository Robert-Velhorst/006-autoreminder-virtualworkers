import { matchesTimerWhere } from '../test/timerDatabase';
import type { Request } from 'express';
import express from 'express';
import request from 'supertest';
import { taskAssignments, timeEntries, vaProfiles, type User } from '../../drizzle/schema.postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));

import analyticsRouter from './analytics';

type Row = Record<string, unknown>;

function matchesWhere(row: Row, condition: unknown): boolean {
  const chunks = (condition as { queryChunks?: unknown[] })?.queryChunks ?? [];
  const nestedSql = chunks.filter((chunk): chunk is { queryChunks: unknown[] } =>
    typeof chunk === 'object' && chunk !== null && 'queryChunks' in chunk
      && Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)
  );
  if (nestedSql.length) {
    const operators = chunks.flatMap(chunk => {
      if (typeof chunk !== 'object' || chunk === null || !('value' in chunk)) return [];
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string') : [];
    }).join('');
    return /\bor\b/i.test(operators)
      ? nestedSql.some(child => matchesWhere(row, child))
      : nestedSql.every(child => matchesWhere(row, child));
  }

  const column = chunks.find((chunk): chunk is { name: string; table: unknown } =>
    typeof chunk === 'object' && chunk !== null && 'name' in chunk && 'table' in chunk
      && typeof (chunk as { name?: unknown }).name === 'string'
  );
  if (!column) return true;

  const values: unknown[] = [];
  const collectParams = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collectParams);
    } else if (typeof value === 'object' && value !== null) {
      if ('encoder' in value && 'value' in value) values.push((value as { value: unknown }).value);
      else if ('queryChunks' in value) collectParams((value as { queryChunks: unknown[] }).queryChunks);
    }
  };
  collectParams(chunks);

  const operators = chunks.flatMap(chunk => {
    if (typeof chunk !== 'object' || chunk === null || !('value' in chunk)) return [];
    const value = (chunk as { value?: unknown }).value;
    return Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string') : [];
  }).join('');
  return /\bin\b/i.test(operators)
    ? values.includes(row[column.name])
    : row[column.name] === values[0];
}

function database(profiles: Row[], tasks: Row[] = [], times: Row[] = []) {
  // These fixtures explicitly model reviewed ownership. Colliding fixture
  // identities remain unresolved; production code performs no such inference.
  times.forEach(row => {
    if (Object.prototype.hasOwnProperty.call(row, 'trackedUserId')) return;
    const owners = profiles.filter(profile => profile.founderId === row.founderId &&
      (profile.id === row.vaId || profile.userId === row.vaId));
    const unique = [...new Map(owners.map(profile => [profile.id, profile])).values()];
    row.trackedUserId = unique.length === 1 ? unique[0].userId : null;
    row.trackedProfileId = unique.length === 1 ? unique[0].id : null;
  });
  const db = {
    select: vi.fn((selection?: Row) => {
      let table: unknown;
      let condition: unknown;
      const rows = () => {
        const source = table === vaProfiles ? profiles : table === taskAssignments ? tasks : table === timeEntries ? times : [];
        const found = condition ? source.filter(row => matchesTimerWhere(row, condition)) : source;
        return selection?.count ? [{ count: found.length }] : found;
      };
      const query: any = {
        from: (value: unknown) => { table = value; return query; },
        where: (value: unknown) => { condition = value; return query; },
        orderBy: () => query,
        then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve(rows()).then(resolve, reject),
      };
      return query;
    }),
  };
  return db;
}

const worker = { id: 42, openId: 'worker-42', name: 'Worker', role: 'worker' } as User;
const owner = { id: 9, openId: 'owner-9', name: 'Owner', role: 'user' } as User;
const admin = { id: 1, openId: 'admin-1', name: 'Admin', role: 'admin' } as User;

function profile(id: number, userId: number, founderId: number, name: string, status = 'active'): Row {
  return {
    id, userId, founderId, name, status,
    workingDays: '0,1,2,3,4,5,6', workStartHour: 9, workEndHour: 17,
    breakfastTime: null, breakfastDuration: null,
    lunchTime: null, lunchDuration: null,
    dinnerTime: null, dinnerDuration: null,
  };
}

function appFor(user?: User) {
  const app = express();
  app.use((req: Request, _res, next) => {
    if (user) (req as Request & { user?: User }).user = user;
    next();
  });
  app.use('/api/analytics', analyticsRouter);
  return app;
}

const endpoints = [
  '/api/analytics/worker-productivity',
  '/api/analytics/team-capacity',
  '/api/analytics/trends',
] as const;

function workerData() {
  const now = new Date();
  const profiles = [
    profile(7, worker.id, 9, 'Current worker'),
    profile(8, worker.id, 9, 'Inactive former profile', 'inactive'),
    profile(worker.id, 70, 9, 'Peer with colliding profile ID'),
    profile(11, 43, 9, 'Other worker'),
    profile(12, 90, 10, 'Other founder worker'),
  ];
  const tasks = [
    { id: 1, taskId: 'own-done', vaId: 7, founderId: 9, status: 'completed', updatedAt: now },
    { id: 2, taskId: 'own-open', vaId: 7, founderId: 9, status: 'assigned', updatedAt: now },
    { id: 3, taskId: 'inactive-task', vaId: 8, founderId: 9, status: 'assigned', updatedAt: now },
    { id: 4, taskId: 'peer-task', vaId: 11, founderId: 9, status: 'completed', updatedAt: now },
    { id: 5, taskId: 'foreign-founder-task', vaId: 7, founderId: 10, status: 'completed', updatedAt: now },
  ];
  const time = (id: number, vaId: number, founderId: number, minutes: number, isVoided = false): Row => ({
    id, taskId: `time-${id}`, vaId, founderId, startTime: now,
    endTime: new Date(now.getTime() + minutes * 60_000), durationMinutes: minutes,
    durationSeconds: null, isVoided,
  });
  const times = [
    time(1, 7, 9, 30),
    time(2, worker.id, 9, 15),
    time(3, 8, 9, 60),
    time(4, 11, 9, 90),
    time(5, 7, 10, 150),
    time(6, 7, 9, 200, true),
  ];
  return { profiles, tasks, times };
}

describe('analytics worker scope boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('limits all worker analytics to the unique active profile and ignores caller-supplied IDs', async () => {
    const { profiles, tasks, times } = workerData();
    const db = database(profiles, tasks, times);
    mocks.getDb.mockResolvedValue(db);

    const productivity = await request(appFor(worker))
      .get('/api/analytics/worker-productivity?workerId=11&vaId=11&founderId=10')
      .expect(200);
    expect(productivity.body.productivity).toEqual([expect.objectContaining({
      workerId: 7,
      workerName: 'Current worker',
      totalAssigned: 2,
      completed: 1,
      actualMinutes: 30,
    })]);
    expect(productivity.body.unattributedTimeEntries).toBeUndefined();

    const capacity = await request(appFor(worker)).get(endpoints[1]).expect(200);
    expect(capacity.body.workers).toEqual([expect.objectContaining({ workerId: 7, workerName: 'Current worker', trackedMinutes: 30 })]);
    expect(capacity.body.trackedMinutes).toBe(30);
    expect(capacity.body.unattributedTimeEntries).toBeUndefined();

    const trends = await request(appFor(worker)).get(endpoints[2]).expect(200);
    expect(trends.body.trends.reduce((sum: number, day: { trackedMinutes: number }) => sum + day.trackedMinutes, 0)).toBe(30);
    expect(trends.body.trends.reduce((sum: number, day: { completedTasks: number }) => sum + day.completedTasks, 0)).toBe(1);
    expect(trends.body.trends.every((day: { unattributedTimeEntries?: unknown }) => day.unattributedTimeEntries === undefined)).toBe(true);
  });

  it.each([
    { name: 'no active profile', profiles: [profile(7, worker.id, 9, 'Inactive', 'inactive')] },
    { name: 'multiple active profiles', profiles: [profile(7, worker.id, 9, 'First'), profile(8, worker.id, 9, 'Second')] },
  ])('blocks every worker analytics endpoint for $name', async ({ profiles }) => {
    for (const endpoint of endpoints) {
      const db = database(profiles);
      mocks.getDb.mockResolvedValue(db);
      const response = await request(appFor(worker)).get(endpoint);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'An active worker profile is required' });
      expect(db.select).toHaveBeenCalledOnce();
      mocks.getDb.mockClear();
    }
  });

  it('keeps owner analytics inside that founder tenant', async () => {
    const profiles = [
      profile(7, 42, owner.id, 'Tenant worker'),
      profile(8, 43, owner.id, 'Tenant historical worker', 'inactive'),
      profile(12, 90, 10, 'Foreign tenant worker'),
    ];
    const tasks = [
      { id: 1, taskId: 'tenant-task', vaId: 7, founderId: owner.id, status: 'completed', updatedAt: new Date() },
      { id: 2, taskId: 'tenant-history', vaId: 8, founderId: owner.id, status: 'assigned', updatedAt: new Date() },
      { id: 3, taskId: 'foreign-task', vaId: 12, founderId: 10, status: 'completed', updatedAt: new Date() },
    ];
    mocks.getDb.mockResolvedValue(database(profiles, tasks));

    const response = await request(appFor(owner)).get(endpoints[0]).expect(200);
    expect(response.body.productivity.map((item: { workerId: number }) => item.workerId)).toEqual([7, 8]);
    expect(response.body.productivity.map((item: { totalAssigned: number }) => item.totalAssigned)).toEqual([1, 1]);
  });

  it('preserves explicit admin-wide analytics while preventing cross-tenant reads for an owner', async () => {
    const data = workerData();
    mocks.getDb.mockResolvedValue(database(data.profiles, data.tasks));
    const ownerResponse = await request(appFor(owner)).get(endpoints[0]).expect(200);
    expect(ownerResponse.body.productivity.map((item: { workerId: number }) => item.workerId)).toEqual([7, 8, 42, 11]);

    mocks.getDb.mockResolvedValue(database(data.profiles, data.tasks));
    const adminResponse = await request(appFor(admin)).get(endpoints[0]).expect(200);
    expect(adminResponse.body.productivity.map((item: { workerId: number }) => item.workerId)).toEqual([7, 8, 42, 11, 12]);
  });

  it('rejects unauthenticated and unsupported roles before analytics data is queried', async () => {
    await request(appFor()).get(endpoints[0]).expect(401);
    expect(mocks.getDb).not.toHaveBeenCalled();

    for (const role of ['auditor', 'founder']) {
      const unsupported = { ...owner, role } as User;
      await request(appFor(unsupported)).get(endpoints[0]).expect(403, { error: 'Forbidden' });
      expect(mocks.getDb).not.toHaveBeenCalled();
    }
  });
});
