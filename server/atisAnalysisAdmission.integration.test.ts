import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFinancialDatabase, type FinancialDatabase } from './test/financialDatabase';
import type { ScheduledJobContext } from './scheduledJobRuntime';
const controls = vi.hoisted(() => ({ db: undefined as any, provider: vi.fn() }));
vi.mock('./db', () => ({ getDb: async () => controls.db }));
vi.mock('./services/atis-understanding', () => ({ processCardUnderstandingOutcome: controls.provider }));
import { createAtisAnalysisPreview, confirmAtisAnalysisPreview, getAtisAnalysisJob } from './atisAnalysisAdmission';
import { ATIS_JOB_KEYS, getAtisOperation, startAtisOperation } from './atisOperations';

const baseUrl = process.env.APTLSS_TEST_DATABASE_URL;
const settled = <T>(promise: Promise<T>) => promise.then(value => ({ value,error: undefined }),error => ({ value: undefined,error }));
describe.skipIf(!baseUrl)('ATIS admission native PostgreSQL (synthetic understanding service, no providers)', { timeout: 30000 }, () => {
  let fixture: FinancialDatabase;
  const gates: Array<() => void> = [];
  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>(accept => { resolve = accept; });
    gates.push(resolve); return { promise,resolve };
  }
  async function until(predicate: () => Promise<boolean>, message = 'Expected owned ATIS state did not settle', timeout = 6000) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve,10));
    }
    throw new Error(message);
  }
  async function blockedBy(pid: number) {
    await until(async () => (await fixture.pool.query(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))`,[pid])).rowCount! > 0,'Expected actual owned PG lock wait');
  }
  beforeAll(async () => { fixture = await createFinancialDatabase(baseUrl); controls.db = fixture.db; },120000);
  beforeEach(async () => {
    controls.db = fixture.db; controls.provider.mockReset();
    controls.provider.mockImplementation(async (_id: number,{ context }: { context: ScheduledJobContext }) => {
      await context.assertOwnership(); return { kind: 'generated',understanding: {} };
    });
    await fixture.pool.query(`TRUNCATE atis_analysis_items,atis_analysis_requests,scheduled_job_runs,scheduled_job_leases,
      atis_card_understanding,atis_cards,users RESTART IDENTITY CASCADE`);
    await fixture.pool.query(`INSERT INTO users (id,"openId",role) VALUES (1,'admission-founder','admin'),(2,'admission-other','admin'),(3,'admission-worker','worker')`);
    await cards(3);
  });
  afterEach(async () => {
    for (const release of gates.splice(0)) release();
    if (fixture) await until(async () => Number((await fixture.pool.query('SELECT count(*) AS n FROM scheduled_job_leases')).rows[0].n) === 0);
  });
  afterAll(async () => { controls.db = undefined; if (fixture) await fixture.close(); });
  async function cards(count: number) {
    await fixture.pool.query(`INSERT INTO atis_cards (id,"trelloId","boardId","boardTrelloId",name,"listName","isArchived")
      SELECT n,'admission-card-'||n,1,'admission-board','Card '||n,'Doing',0 FROM generate_series(1,$1::integer) n
      ON CONFLICT (id) DO NOTHING`,[count]);
  }
  const preview = (selection: Parameters<typeof createAtisAnalysisPreview>[1] = { mode: 'pending' }) => createAtisAnalysisPreview(1,selection);
  const confirm = (id: string,key = 'native-confirmation',extra = {}) => confirmAtisAnalysisPreview(1,id,{ requestKey: key,...extra });
  const done = async (id: string) => {
    await until(async () => ['completed','interrupted','failed'].includes((await getAtisAnalysisJob(1,id))?.state ?? ''),
      'Expected bounded admitted batch to settle',20000);
    return (await getAtisAnalysisJob(1,id))!;
  };

  it('creates DB-only frozen sorted previews with truthful bounded cursor counts and large guidance outside run metadata', async () => {
    await cards(205);
    const first = await preview({ mode: 'reanalyze',forceAll: true,guidance: { goal: 'x'.repeat(4000),deliverable: 'y'.repeat(4000) } });
    expect(first).toMatchObject({ matched: 205,total: 100,remaining: 105,nextAfterCardId: 100 });
    expect(first.cards.map(card => card.id)).toEqual(Array.from({ length: 100 },(_,i) => i+1));
    const second = await preview({ mode: 'reanalyze',forceAll: true,afterCardId: first.nextAfterCardId });
    expect(second).toMatchObject({ matched: 105,total: 100,remaining: 5,nextAfterCardId: 200 });
    expect(controls.provider).not.toHaveBeenCalled();
    expect((await fixture.pool.query('SELECT * FROM atis_analysis_items')).rows).toEqual([]);
    expect((await fixture.pool.query('SELECT * FROM scheduled_job_runs')).rows).toEqual([]);
  });

  it('selects active placeholders using actual malformed/nonarray JSON without casts failing or confidence substitution', async () => {
    await cards(10);
    const values = ['malformed','{}','[]','[{"step":"one"}]','[{"step":"one"},{"step":"two"}]','null','12','[]','[]'];
    for (let i=0;i<values.length;i++) await fixture.pool.query(`INSERT INTO atis_card_understanding
      ("cardId","cardTrelloId","aptlssChecklist","confidenceScore") VALUES ($1,$2,$3,99)`,[i+2,`admission-card-${i+2}`,values[i]]);
    await fixture.pool.query(`UPDATE atis_cards SET "isArchived"=1 WHERE id=9; UPDATE atis_cards SET "listName"='Completed' WHERE id=10`);
    expect((await preview({ mode: 'active_placeholders' })).cards.map(card => card.id)).toEqual([1,2,3,4,5,7,8]);
    expect(controls.provider).not.toHaveBeenCalled();
  });

  it('attempts exactly the frozen 100-card batch, never later source rows or the remaining backlog', async () => {
    await cards(205);
    const p = await preview({ mode: 'reanalyze',forceAll: true });
    await cards(206);
    await fixture.pool.query(`UPDATE atis_cards SET name='Changed source name' WHERE id=1`);
    await confirm(p.id);
    const job = await done(p.id);
    expect(job).toMatchObject({ state: 'completed',matched: 205,total: 100,remaining: 105,processed: 100 });
    expect(job.items[0].cardName).toBe('Card 1');
    expect(controls.provider.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 100 },(_,i) => i+1));
    expect((await fixture.pool.query('SELECT count(*)::integer AS n FROM atis_analysis_items')).rows[0].n).toBe(100);
  });

  it('keeps archived or deleted frozen sources missing and preserves fallback versus generated counts', async () => {
    const p = await preview();
    await fixture.pool.query(`UPDATE atis_cards SET "isArchived"=1 WHERE id=2; DELETE FROM atis_cards WHERE id=3`);
    controls.provider.mockImplementation(async () => ({ kind: 'fallback',understanding: {} }));
    await confirm(p.id);
    expect(await done(p.id)).toMatchObject({ state: 'completed',total: 3,processed: 1,fallback: 1,generated: 0,missing: 2,pending: 0 });
    expect(controls.provider).toHaveBeenCalledTimes(1);
  });

  it('confirms concurrently once, freezes membership and persists calling before service invocation', async () => {
    const hold = gate(),entered = gate();
    controls.provider.mockImplementation(async (cardId: number) => {
      const [row] = (await fixture.pool.query('SELECT state FROM atis_analysis_items WHERE "cardId"=$1',[cardId])).rows;
      expect(row.state).toBe('calling'); entered.resolve(); await hold.promise;
      return { kind: cardId === 1 ? 'fallback' : 'generated',understanding: {} };
    });
    const p = await preview();
    const [a,b] = await Promise.all([confirm(p.id),confirm(p.id)]);
    expect(a.id).toBe(b.id); expect(a.operationId).toBe(b.operationId);
    await entered.promise;
    expect((await fixture.pool.query('SELECT * FROM atis_analysis_items')).rows).toHaveLength(3);
    expect((await fixture.pool.query('SELECT * FROM scheduled_job_runs')).rows).toHaveLength(1);
    await expect(confirm(p.id,'different-key')).rejects.toMatchObject({ status: 409,code: 'REQUEST_CONFLICT' });
    hold.resolve(); const result = await done(p.id);
    expect(result).toMatchObject({ state: 'completed',processed: 3,fallback: 1,generated: 2,pending: 0 });
    await confirm(p.id); expect(controls.provider).toHaveBeenCalledTimes(3);
    expect((await fixture.pool.query('SELECT detail FROM scheduled_job_runs')).rows[0].detail.length).toBeLessThan(1000);
  });

  it('rejects one key reused on another preview and hides foreign preview/job identities', async () => {
    const first = await preview(); await confirm(first.id); await done(first.id);
    const next = await preview({ mode: 'reanalyze',forceAll: true });
    await expect(confirm(next.id)).rejects.toMatchObject({ status: 409,code: 'REQUEST_CONFLICT' });
    expect(await getAtisAnalysisJob(2,first.id)).toBeNull();
    await expect(confirmAtisAnalysisPreview(2,first.id,{ requestKey: 'foreign' })).rejects.toMatchObject({ status: 404 });
    expect((await fixture.pool.query('SELECT * FROM atis_analysis_items WHERE "requestId"=$1',[next.id])).rows).toEqual([]);
  });

  it('expires with the DB clock after an observed preview lock wait, retaining the unconfirmed preview', async () => {
    const p = await preview(); const controller = await fixture.pool.connect(); let pending: Promise<any> | undefined;
    try {
      await fixture.pool.query(`UPDATE atis_analysis_requests SET "expiresAt"=clock_timestamp()+interval '1 second' WHERE id=$1`,[p.id]);
      await controller.query('BEGIN'); const pid = (await controller.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await controller.query('SELECT id FROM atis_analysis_requests WHERE id=$1 FOR UPDATE',[p.id]);
      pending = settled(confirm(p.id)); await blockedBy(pid);
      await until(async () => (await fixture.pool.query('SELECT "expiresAt" <= clock_timestamp() AS expired FROM atis_analysis_requests WHERE id=$1',[p.id])).rows[0].expired);
      await controller.query('COMMIT'); expect((await pending).error).toMatchObject({ status: 409,code: 'EXPIRED' });
      expect((await fixture.pool.query('SELECT "confirmedAt" FROM atis_analysis_requests WHERE id=$1',[p.id])).rows[0].confirmedAt).toBeNull();
      expect(controls.provider).not.toHaveBeenCalled();
    } finally { await controller.query('ROLLBACK'); controller.release(true); if (pending) await pending; }
  });

  it('rolls preview consumption, membership and run creation back if the durable run insert fails', async () => {
    const p = await preview();
    await fixture.pool.query(`CREATE FUNCTION reject_admitted_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Synthetic run rejection' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER reject_admitted_run BEFORE INSERT ON scheduled_job_runs FOR EACH ROW EXECUTE FUNCTION reject_admitted_run()`);
    try {
      await expect(confirm(p.id)).rejects.toMatchObject({ status: 503 });
      expect((await fixture.pool.query('SELECT "confirmedAt","requestKeyHash" FROM atis_analysis_requests WHERE id=$1',[p.id])).rows[0]).toEqual({ confirmedAt: null,requestKeyHash: null });
      expect((await fixture.pool.query('SELECT * FROM atis_analysis_items')).rows).toEqual([]);
      expect(controls.provider).not.toHaveBeenCalled();
    } finally { await fixture.pool.query('DROP TRIGGER reject_admitted_run ON scheduled_job_runs; DROP FUNCTION reject_admitted_run()'); }
    await confirm(p.id); expect((await done(p.id)).processed).toBe(3);
  });

  it('shares the legacy global understanding lease and does not reserve an overlapping preview', async () => {
    const hold = gate(); const p = await preview();
    const operation = await startAtisOperation({ kind: 'understanding',ownerUserId: 1,request: { limit: 100 } },async () => {
      await hold.promise; return { processed: 0 };
    });
    await expect(confirm(p.id)).rejects.toMatchObject({ status: 409,code: 'REQUEST_CONFLICT' });
    expect((await fixture.pool.query('SELECT * FROM atis_analysis_items')).rows).toEqual([]);
    expect((await fixture.pool.query('SELECT "jobKey" FROM scheduled_job_leases')).rows).toEqual([{ jobKey: ATIS_JOB_KEYS.understanding }]);
    hold.resolve(); await until(async () => (await getAtisOperation(operation.id))?.state === 'completed');
    await confirm(p.id); await done(p.id);
  });

  it.each(['role-cycle','password-rotation'] as const)('invalidates an old preview after %s even when the admin is eligible again', async change => {
    const p = await preview();
    if (change === 'role-cycle') await fixture.pool.query("UPDATE users SET role='worker' WHERE id=1; UPDATE users SET role='admin' WHERE id=1");
    else await fixture.pool.query("UPDATE users SET \"passwordHash\"='synthetic-rotation' WHERE id=1");
    await expect(confirm(p.id)).rejects.toMatchObject({ status: 409,code: 'APPROVAL_CHANGED' });
    expect(controls.provider).not.toHaveBeenCalled();
    expect((await fixture.pool.query('SELECT * FROM atis_analysis_items')).rows).toEqual([]);
  });

  it('fences a queued provider result after revocation/reactivation, retains uncertainty and never calls the next card', async () => {
    const hold = gate(),entered = gate(); let lateWrite = false;
    controls.provider.mockImplementation(async (_cardId: number,{ context }: { context: ScheduledJobContext }) => {
      entered.resolve(); await hold.promise;
      await fixture.db.transaction(async tx => { await context.assertOwnership(tx); lateWrite = true; });
      return { kind: 'generated',understanding: {} };
    });
    const p = await preview(); await confirm(p.id); await entered.promise;
    await fixture.pool.query("UPDATE users SET role='worker' WHERE id=1; UPDATE users SET role='admin' WHERE id=1");
    hold.resolve();
    const job = await done(p.id);
    expect(job).toMatchObject({ state: 'interrupted',uncertain: 1,pending: 2,processed: 0 });
    expect(lateWrite).toBe(false); expect(controls.provider).toHaveBeenCalledTimes(1);
    expect((await fixture.pool.query('SELECT state FROM atis_analysis_items ORDER BY "cardId"')).rows.map(row => row.state)).toEqual(['calling','pending','pending']);
  });

  it('presents expired calling work as uncertain, never replays it and requires exact interrupted-operation acknowledgement', async () => {
    const hold = gate(),entered = gate();
    controls.provider.mockImplementation(async (_id: number,{ context }: { context: ScheduledJobContext }) => {
      entered.resolve(); await hold.promise; await context.assertOwnership(); return { kind: 'generated',understanding: {} };
    });
    const p = await preview(); const initial = await confirm(p.id); await entered.promise;
    await fixture.pool.query(`UPDATE scheduled_job_leases SET "leaseExpiresAt"=clock_timestamp()-interval '1 second'`);
    expect(await getAtisAnalysisJob(1,p.id)).toMatchObject({ state: 'interrupted',uncertain: 1 });
    await confirm(p.id); expect(controls.provider).toHaveBeenCalledTimes(1);
    const replacement = await preview({ mode: 'single',cardId: 2 });
    await expect(confirm(replacement.id,'replacement')).rejects.toMatchObject({ status: 409,code: 'RECOVERY_REQUIRED' });
    await expect(confirm(replacement.id,'replacement',{ acknowledgeInterruptedOperationId: initial.operationId!+1 })).rejects.toMatchObject({ status: 409 });
    controls.provider.mockImplementation(async () => ({ kind: 'generated',understanding: {} }));
    await confirm(replacement.id,'replacement',{ acknowledgeInterruptedOperationId: initial.operationId });
    expect((await done(replacement.id)).processed).toBe(1);
    hold.resolve();
  });

  it('retains uncertainty if provider work succeeded but its progress transaction is rejected', async () => {
    const p = await preview();
    await fixture.pool.query(`CREATE FUNCTION reject_analysis_progress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state='generated' THEN RAISE EXCEPTION 'Synthetic progress rejection' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_analysis_progress BEFORE UPDATE ON atis_analysis_items FOR EACH ROW EXECUTE FUNCTION reject_analysis_progress()`);
    try {
      await confirm(p.id); expect(await done(p.id)).toMatchObject({ state: 'interrupted',uncertain: 1,failed: 0,pending: 2 });
      expect(controls.provider).toHaveBeenCalledTimes(1);
      await confirm(p.id); expect(controls.provider).toHaveBeenCalledTimes(1);
    } finally { await fixture.pool.query('DROP TRIGGER reject_analysis_progress ON atis_analysis_items; DROP FUNCTION reject_analysis_progress()'); }
  });

  it('does not present an unexpected service/write exception as a safely failed provider outcome', async () => {
    controls.provider.mockRejectedValue(new Error('Private provider or database diagnostics'));
    const p = await preview(); await confirm(p.id);
    const job = await done(p.id);
    expect(job).toMatchObject({ state: 'interrupted',uncertain: 1,failed: 0,pending: 2 });
    expect(JSON.stringify(job)).not.toContain('Private provider');
    expect(controls.provider).toHaveBeenCalledTimes(1);
    const next = await preview();
    await expect(confirm(next.id,'different-request')).rejects.toMatchObject({ status: 409,code: 'RECOVERY_REQUIRED' });
  });
});
