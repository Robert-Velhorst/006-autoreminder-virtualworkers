import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../../drizzle/schema.postgres';
import { insertCanonicalTimer, timerFailure, withTimerAccountTransaction } from '../canonicalTimer';

// Only launched by the opt-in native test against its newly created private DB.
const connectionString = process.env.APTLSS_TIMER_PROCESS_FIXTURE;
const target = new URL(connectionString ?? 'invalid:');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
  || !/^\/canonical_timer_[a-f0-9]{32}$/.test(target.pathname)
  || target.searchParams.get('sslmode') !== 'disable') throw new Error('Invalid owned timer fixture');
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000,
  options: '-c statement_timeout=5000 -c lock_timeout=5000' });
try {
  const db = drizzle(pool, { schema });
  const [before] = await db.select({ id: schema.timeEntries.id }).from(schema.timeEntries).where(and(
    eq(schema.timeEntries.trackedUserId, 1002), isNull(schema.timeEntries.endTime), eq(schema.timeEntries.isVoided, false),
  ));
  try {
    const entry = await withTimerAccountTransaction(db, { id: 1002, role: 'worker' }, (tx, locked) => insertCanonicalTimer(tx, {
      trackedUserId: 1002, trackedProfileId: locked.profile!.id, vaId: null, founderId: locked.founderId,
      taskId: 'process-restart-fixture', startTime: new Date(),
    }));
    process.stdout.write(JSON.stringify({ status: 200, entryId: entry.id }));
  } catch (error) {
    if (timerFailure(error)?.status !== 409) throw error;
    process.stdout.write(JSON.stringify({ status: 409, entryId: before?.id }));
  }
} catch {
  process.stderr.write('Timer fixture process failed'); process.exitCode = 1;
} finally { await pool.end(); }
