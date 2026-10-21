import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFinancialDatabase, type FinancialDatabase } from './test/financialDatabase';
import { settlePaymentCycle, saveWeeklyPayLog, getWeeklyPayLogs, getWeeklyPayLog, incrementWeeklyD1 } from './financialLedger';

const baseUrl = process.env.APTLSS_TEST_DATABASE_URL;
const founder = { id: 6101, role: 'admin' as const, openId: 'financial-founder' };
const foreignFounder = { id: 6104, role: 'admin' as const, openId: 'financial-other-founder' };
const worker = { id: 6102, role: 'worker' as const, openId: 'financial-worker' };
const week = { vaId: worker.id, weekStart: '2026-10-05', weekEnd: '2026-10-11' };
const settled = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
function errorChain(error: unknown): { code?: string; message?: string }[] {
  const chain: { code?: string; message?: string }[] = [];
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error); chain.push(error);
    error = (error as { cause?: unknown }).cause;
  }
  return chain;
}

async function seed(pool: Pool) {
  await pool.query(`INSERT INTO users (id,"openId",role) VALUES
    (6101,'financial-founder','admin'),(6102,'financial-worker','worker'),
    (6103,'financial-peer','worker'),(6104,'financial-other-founder','admin'),
    (6105,'financial-other-worker','worker')`);
  await pool.query(`INSERT INTO va_profiles (id,"userId","founderId",name,status) VALUES
    (61,6102,6101,'Worker','active'),(62,6103,6101,'Peer','active'),
    (63,6105,6104,'Other tenant','active')`);
}

async function raw(pool: Pool, table: 'payment_cycles' | 'weekly_pay_log' | 'financial_ledger_events') {
  return (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows.map(row => row.row);
}

async function waitForOwnedWaiters(pool: Pool, gatePid: number, count: number) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const waiting = (await pool.query<{ pid: number; blockers: number[] }>(`SELECT pid,pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
      AND cardinality(pg_blocking_pids(pid))>0`)).rows;
    const reachesGate = (pid: number, seen = new Set<number>()): boolean => {
      if (pid === gatePid) return true;
      if (seen.has(pid)) return false;
      const next = new Set(seen).add(pid);
      return waiting.find(row => row.pid === pid)?.blockers.some(blocker => reachesGate(blocker,next)) ?? false;
    };
    if (waiting.length === count && waiting.every(row => reachesGate(row.pid))) return waiting;
    await new Promise(resolve => setTimeout(resolve,10));
  }
  throw new Error('Expected owned financial PostgreSQL lock waiters were not observed');
}

describe.skipIf(!baseUrl)('financial ledger native acceptance', { timeout: 30000 }, () => {
  let fixture: FinancialDatabase;
  beforeAll(async () => { fixture = await createFinancialDatabase(baseUrl); },120000);
  beforeEach(async () => {
    await fixture.pool.query('TRUNCATE financial_ledger_events,payment_cycles,weekly_pay_log,time_day_reviews,va_profiles,users RESTART IDENTITY CASCADE');
    await seed(fixture.pool);
  });
  afterAll(async () => { if (fixture) await fixture.close(); });
  const cycle = async (founderId = founder.id) => (await fixture.pool.query(`INSERT INTO payment_cycles
    ("founderId","cycleStart","cycleEnd",notes) VALUES ($1,'2026-10-01','2026-10-16','Original financial record') RETURNING id`,[founderId])).rows[0].id as number;
  const save = (values: Partial<Parameters<typeof saveWeeklyPayLog>[2]> = {}) => saveWeeklyPayLog(fixture.db,founder,{ ...week,...values });
  async function accountGate(client: PoolClient, id = founder.id) {
    await client.query('BEGIN');
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await client.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',[id]);
    return pid;
  }

  it('does not change any cycle or weekly row for foreign or missing settlement IDs', async () => {
    const own = await cycle(); const other = await cycle(foreignFounder.id);
    await save();
    const before = { cycles: await raw(fixture.pool,'payment_cycles'), weeks: await raw(fixture.pool,'weekly_pay_log'), events: await raw(fixture.pool,'financial_ledger_events') };
    for (const cycleId of [other,999999]) {
      await expect(settlePaymentCycle(fixture.db,founder,{ cycleId })).rejects.toBeDefined();
      expect(await raw(fixture.pool,'payment_cycles')).toEqual(before.cycles);
      expect(await raw(fixture.pool,'weekly_pay_log')).toEqual(before.weeks);
      expect(await raw(fixture.pool,'financial_ledger_events')).toEqual(before.events);
    }
    expect(own).not.toBe(other);
  });

  it('settles once and preserves the successor identity on a repeated settlement request', async () => {
    const id = await cycle();
    await settlePaymentCycle(fixture.db,founder,{ cycleId: id });
    const before = await raw(fixture.pool,'payment_cycles');
    const events = await raw(fixture.pool,'financial_ledger_events');
    expect(events).toMatchObject([{ cycleId: id,founderId: founder.id,actorUserId: founder.id,kind: 'cycle_settled' }]);
    expect(events).toHaveLength(1);
    expect(before).toHaveLength(2);
    expect(before.find(row => row.id === id)).toMatchObject({ isPaid: true,notes: 'Original financial record' });
    expect(before.filter(row => row.id !== id)).toMatchObject([{ founderId: founder.id,isPaid: false,cycleStart: '2026-10-17' }]);
    await settled(settlePaymentCycle(fixture.db,founder,{ cycleId: id }));
    expect(await raw(fixture.pool,'payment_cycles')).toEqual(before);
    expect(await raw(fixture.pool,'financial_ledger_events')).toEqual(events);
  });

  it('serializes concurrent settlement behind a real account lock and creates only one successor', async () => {
    const id = await cycle(); const gate = await fixture.pool.connect(); const pending: Promise<any>[] = [];
    try {
      const pid = await accountGate(gate);
      pending.push(settled(settlePaymentCycle(fixture.db,founder,{ cycleId: id })));
      await waitForOwnedWaiters(fixture.pool,pid,1);
      pending.push(settled(settlePaymentCycle(fixture.db,founder,{ cycleId: id })));
      expect(new Set((await waitForOwnedWaiters(fixture.pool,pid,2)).map(row => row.pid)).size).toBe(2);
      expect((await raw(fixture.pool,'payment_cycles'))[0].isPaid).toBe(false);
      await gate.query('COMMIT');
      const results = await Promise.all(pending);
      expect(results.filter(result => !result.error).length).toBeGreaterThanOrEqual(1);
      const rows = await raw(fixture.pool,'payment_cycles');
      expect(rows).toHaveLength(2); expect(rows.filter(row => row.isPaid)).toHaveLength(1);
      expect(rows.filter(row => !row.isPaid)).toHaveLength(1);
      expect(await raw(fixture.pool,'financial_ledger_events')).toMatchObject([{ kind: 'cycle_settled',cycleId: id }]);
      expect(await raw(fixture.pool,'financial_ledger_events')).toHaveLength(1);
      const stable = rows.find(row => !row.isPaid).id;
      await settled(settlePaymentCycle(fixture.db,founder,{ cycleId: id }));
      expect((await raw(fixture.pool,'payment_cycles')).find(row => !row.isPaid).id).toBe(stable);
    } finally { await gate.query('ROLLBACK'); gate.release(true); await Promise.allSettled(pending); }
  });

  it('rolls settlement back if the successor insert fails, retaining the original financial record', async () => {
    const id = await cycle(); const before = await raw(fixture.pool,'payment_cycles');
    await fixture.pool.query(`CREATE FUNCTION reject_financial_successor() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic successor rejection' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER reject_financial_successor BEFORE INSERT ON payment_cycles FOR EACH ROW EXECUTE FUNCTION reject_financial_successor()`);
    try {
      const result = await settled(settlePaymentCycle(fixture.db,founder,{ cycleId: id }));
      expect(errorChain(result.error)).toEqual(expect.arrayContaining([expect.objectContaining({ code: '23514',message: 'Synthetic successor rejection' })]));
      expect(await raw(fixture.pool,'payment_cycles')).toEqual(before);
      expect(await raw(fixture.pool,'financial_ledger_events')).toEqual([]);
    } finally { await fixture.pool.query('DROP TRIGGER reject_financial_successor ON payment_cycles; DROP FUNCTION reject_financial_successor()'); }
  });

  it('serializes concurrent first weekly upserts into one stable identity without losing the final write', async () => {
    const gate = await fixture.pool.connect(); const pending: Promise<any>[] = [];
    try {
      const pid = await accountGate(gate);
      pending.push(settled(save({ notes: 'First operator write' }))); await waitForOwnedWaiters(fixture.pool,pid,1);
      pending.push(settled(save({ notes: 'Second operator write' }))); await waitForOwnedWaiters(fixture.pool,pid,2);
      expect(await raw(fixture.pool,'weekly_pay_log')).toEqual([]);
      await gate.query('COMMIT');
      for (const result of await Promise.all(pending)) if (result.error) throw result.error;
      const rows = await raw(fixture.pool,'weekly_pay_log'); expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ vaId: worker.id,founderId: founder.id,notes: 'Second operator write' });
      const id = rows[0].id; await save({ notes: 'Third operator write' });
      expect(await raw(fixture.pool,'weekly_pay_log')).toMatchObject([{ id,notes: 'Third operator write' }]);
      const events = await raw(fixture.pool,'financial_ledger_events');
      expect(events.map(event => event.weeklyLogId)).toEqual([id,id,id]);
      expect(events.map(event => event.kind)).toEqual(['weekly_saved','weekly_saved','weekly_saved']);
    } finally { await gate.query('ROLLBACK'); gate.release(true); await Promise.allSettled(pending); }
  });

  it('retains every concurrent D1 increment, including first creation, without a lost update', async () => {
    const gate = await fixture.pool.connect(); const pending: Promise<any>[] = [];
    try {
      const pid = await accountGate(gate);
      pending.push(settled(incrementWeeklyD1(fixture.db,worker.id,'2026-10-07',2))); await waitForOwnedWaiters(fixture.pool,pid,1);
      pending.push(settled(incrementWeeklyD1(fixture.db,worker.id,'2026-10-07',3))); await waitForOwnedWaiters(fixture.pool,pid,2);
      await gate.query('COMMIT');
      for (const result of await Promise.all(pending)) if (result.error) throw result.error;
      const rows = await raw(fixture.pool,'weekly_pay_log'); expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ vaId: worker.id,founderId: founder.id,weekStart: week.weekStart,demeritD1: '5.00' });
      expect(await raw(fixture.pool,'financial_ledger_events')).toHaveLength(2);
      expect((await raw(fixture.pool,'financial_ledger_events')).map(row => row.kind)).toEqual(['d1_incremented','d1_incremented']);
    } finally { await gate.query('ROLLBACK'); gate.release(true); await Promise.allSettled(pending); }
  });

  it('scopes real financial reads to authorized founder and worker identities', async () => {
    await save();
    await saveWeeklyPayLog(fixture.db,foreignFounder,{ ...week,vaId: 6105,notes: 'Other tenant private pay' });
    const own = await getWeeklyPayLogs(fixture.db,founder,{ vaId: worker.id,limit: 10 });
    expect(own).toHaveLength(1); expect(own[0]).toMatchObject({ vaId: worker.id,founderId: founder.id });
    expect(await getWeeklyPayLog(fixture.db,worker,{ weekStart: week.weekStart })).toMatchObject({ vaId: worker.id,founderId: founder.id });
    const foreign = await settled(getWeeklyPayLogs(fixture.db,founder,{ vaId: 6105,limit: 10 }));
    if (!foreign.error) expect(foreign.value).toEqual([]);
    const forged = await settled(getWeeklyPayLog(fixture.db,worker,{ vaId: 6105,weekStart: week.weekStart }));
    if (!forged.error && forged.value) expect(forged.value.vaId).toBe(worker.id);
  });

  it.each([
    { label: 'actor role',query: "UPDATE users SET role='worker' WHERE id=6101" },
    { label: 'worker account role',query: "UPDATE users SET role='user' WHERE id=6102" },
    { label: 'worker offboarding',query: "UPDATE va_profiles SET status='inactive' WHERE id=61" },
    { label: 'worker founder relink',query: 'UPDATE va_profiles SET "founderId"=6104 WHERE id=61' },
    { label: 'worker account relink',query: 'UPDATE va_profiles SET "userId"=6103 WHERE id=61' },
  ])('rechecks $label after an observed PostgreSQL lock wait before writing any pay row', async ({ query }) => {
    const gate = await fixture.pool.connect(); let pending: Promise<any> | undefined;
    try {
      await gate.query('BEGIN'); const pid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await gate.query(query); pending = settled(save());
      await waitForOwnedWaiters(fixture.pool,pid,1); await gate.query('COMMIT');
      expect((await pending).error).toBeDefined(); expect(await raw(fixture.pool,'weekly_pay_log')).toEqual([]);
      expect(await raw(fixture.pool,'financial_ledger_events')).toEqual([]);
    } finally { await gate.query('ROLLBACK'); gate.release(true); if (pending) await pending; }
  });

  it.each(['cycle_settled','weekly_saved','d1_incremented'] as const)('rolls back the entire %s transaction if its mandatory audit insert fails', async kind => {
    const id = await cycle(); const before = await raw(fixture.pool,'payment_cycles');
    await fixture.pool.query(`CREATE FUNCTION reject_financial_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic financial audit rejection' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER reject_financial_audit BEFORE INSERT ON financial_ledger_events FOR EACH ROW EXECUTE FUNCTION reject_financial_audit()`);
    try {
      const operation = kind === 'cycle_settled' ? settlePaymentCycle(fixture.db,founder,{ cycleId: id })
        : kind === 'weekly_saved' ? save() : incrementWeeklyD1(fixture.db,worker.id,'2026-10-07',1);
      const result = await settled(operation);
      expect(errorChain(result.error)).toEqual(expect.arrayContaining([expect.objectContaining({ code: '23514',message: 'Synthetic financial audit rejection' })]));
      expect(await raw(fixture.pool,'payment_cycles')).toEqual(before);
      expect(await raw(fixture.pool,'weekly_pay_log')).toEqual([]);
      expect(await raw(fixture.pool,'financial_ledger_events')).toEqual([]);
    } finally { await fixture.pool.query('DROP TRIGGER reject_financial_audit ON financial_ledger_events; DROP FUNCTION reject_financial_audit()'); }
  });

  it.each(['linked','overlapping','locked'] as const)('preserves %s weekly records against edits, detachment, and D1 increments', async kind => {
    const id = await cycle();
    // The linked case deliberately does not overlap the weekly dates: the old
    // settlement link alone must prevent detachment/repricing of that history.
    if (kind === 'linked') await fixture.pool.query(`UPDATE payment_cycles SET "cycleStart"='2026-11-01',"cycleEnd"='2026-11-16' WHERE id=$1`,[id]);
    await save(kind === 'linked' ? { paymentCycleId: id } : {});
    if (kind === 'locked') await fixture.pool.query(`INSERT INTO time_day_reviews ("dateKey",status) VALUES ('2026-10-07','locked')`);
    else await settlePaymentCycle(fixture.db,founder,{ cycleId: id });
    const before = await raw(fixture.pool,'weekly_pay_log'); const events = await raw(fixture.pool,'financial_ledger_events');
    for (const operation of [
      () => save({ notes: 'Forbidden accounting change' }),
      () => save({ paymentCycleId: null,notes: 'Forbidden detach' }),
      () => incrementWeeklyD1(fixture.db,worker.id,'2026-10-07',1),
    ]) {
      await expect(operation()).rejects.toBeDefined();
      expect(await raw(fixture.pool,'weekly_pay_log')).toEqual(before);
      expect(await raw(fixture.pool,'financial_ledger_events')).toEqual(events);
    }
  });

  it('deduplicates a retried D1 event without changing its financial row or audit timestamp', async () => {
    await incrementWeeklyD1(fixture.db,worker.id,'2026-10-07',2,'fixture:d1:stable-event');
    const before = await raw(fixture.pool,'weekly_pay_log'); const events = await raw(fixture.pool,'financial_ledger_events');
    await incrementWeeklyD1(fixture.db,worker.id,'2026-10-07',2,'fixture:d1:stable-event');
    expect(await raw(fixture.pool,'weekly_pay_log')).toEqual(before);
    expect(await raw(fixture.pool,'financial_ledger_events')).toEqual(events);
    await expect(incrementWeeklyD1(fixture.db,worker.id,'2026-10-07',3,'fixture:d1:stable-event')).rejects.toBeDefined();
    expect(await raw(fixture.pool,'weekly_pay_log')).toEqual(before);
    expect(await raw(fixture.pool,'financial_ledger_events')).toEqual(events);
  });

  it('rejects a stale admin settlement after the actual account-role update commits', async () => {
    const id = await cycle(); const before = await raw(fixture.pool,'payment_cycles');
    const gate = await fixture.pool.connect(); let pending: Promise<any> | undefined;
    try {
      await gate.query('BEGIN'); const pid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await gate.query("UPDATE users SET role='worker' WHERE id=6101");
      pending = settled(settlePaymentCycle(fixture.db,founder,{ cycleId: id }));
      await waitForOwnedWaiters(fixture.pool,pid,1); await gate.query('COMMIT');
      expect((await pending).error).toBeDefined();
      expect(await raw(fixture.pool,'payment_cycles')).toEqual(before);
      expect(await raw(fixture.pool,'financial_ledger_events')).toEqual([]);
    } finally { await gate.query('ROLLBACK'); gate.release(true); if (pending) await pending; }
  });

  it.each([
    "UPDATE users SET role='user' WHERE id=6102",
    "UPDATE va_profiles SET status='inactive' WHERE id=61",
    'UPDATE va_profiles SET "founderId"=6104 WHERE id=61',
  ])('rechecks D1 recipient eligibility after the observed change lock: %s', async query => {
    const gate = await fixture.pool.connect(); let pending: Promise<any> | undefined;
    try {
      await gate.query('BEGIN'); const pid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await gate.query(query); pending = settled(incrementWeeklyD1(fixture.db,worker.id,'2026-10-07',1));
      await waitForOwnedWaiters(fixture.pool,pid,1); await gate.query('COMMIT');
      expect((await pending).error).toBeDefined();
      expect(await raw(fixture.pool,'weekly_pay_log')).toEqual([]);
      expect(await raw(fixture.pool,'financial_ledger_events')).toEqual([]);
    } finally { await gate.query('ROLLBACK'); gate.release(true); if (pending) await pending; }
  });
});

describe.skipIf(!baseUrl)('financial identity cutover preserves conflicting legacy records', { timeout: 120000 }, () => {
  it.each(['weekly','cycles'] as const)('aborts migration 0009 for duplicate %s without repairing, deleting, or modifying history', async kind => {
    const legacy = await createFinancialDatabase(baseUrl,8);
    try {
      await seed(legacy.pool);
      await legacy.pool.query(`INSERT INTO payment_cycles (id,"founderId","cycleStart","cycleEnd",notes)
        VALUES (71,6101,'2026-10-01','2026-10-16','Original cycle')`);
      await legacy.pool.query(`INSERT INTO weekly_pay_log (id,"vaId","founderId","weekStart","weekEnd","paymentCycleId",notes)
        VALUES (81,6102,6101,'2026-10-05','2026-10-11',71,'Original weekly financial record')`);
      if (kind === 'weekly') await legacy.pool.query(`INSERT INTO weekly_pay_log
        (id,"vaId","founderId","weekStart","weekEnd","paymentCycleId","demeritD1",notes)
        VALUES (82,6102,6101,'2026-10-05','2026-10-11',71,7,'Conflicting historical accounting')`);
      else await legacy.pool.query(`INSERT INTO payment_cycles (id,"founderId","cycleStart","cycleEnd","isPaid",notes)
        VALUES (72,6101,'2026-10-01','2026-10-16',true,'Conflicting paid historical cycle')`);
      await legacy.pool.query(`INSERT INTO time_day_reviews ("dateKey",status,"summaryJson")
        VALUES ('2026-10-07','locked','{"weeklyLogId":81,"source":"legacy acceptance fixture"}')`);
      const snapshot = async () => ({
        cycles: await raw(legacy.pool,'payment_cycles'), weeks: await raw(legacy.pool,'weekly_pay_log'),
        history: (await legacy.pool.query('SELECT to_jsonb(t) AS row FROM time_day_reviews t ORDER BY id')).rows,
        ledger: (await legacy.pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows,
      });
      const before = await snapshot();
      const result = await settled(legacy.migrateLatest());
      expect(errorChain(result.error)).toEqual(expect.arrayContaining([expect.objectContaining({
        code: '23505',message: 'Duplicate financial records require explicit owner review; no cycle, ledger or history rows were changed',
      })]));
      expect(await snapshot()).toEqual(before);
      expect((await legacy.pool.query("SELECT to_regclass('public.financial_ledger_events') AS table_name")).rows[0].table_name).toBeNull();
    } finally { await legacy.close(); }
  });
});
