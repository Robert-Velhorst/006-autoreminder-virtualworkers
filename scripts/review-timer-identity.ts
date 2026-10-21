import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../drizzle/schema.postgres';
import { requirePostgresDatabaseUrl } from '../server/db/databaseUrl';
import { resolveTimerIdentity, timerIdentityReviewReport } from '../server/timerIdentityReview';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  execute: { type: 'boolean', default: false }, 'entry-id': { type: 'string' }, 'tracked-user-id': { type: 'string' },
  'tracked-profile-id': { type: 'string' }, 'actor-user-id': { type: 'string' }, 'expected-founder-id': { type: 'string' },
  'evidence-reference': { type: 'string' },
} });
if (positionals.length !== 1 || !['report', 'resolve'].includes(positionals[0])) throw new Error('Usage: review-timer-identity.ts report|resolve [explicit identity/evidence flags] [--execute]');
const pool = new Pool({ connectionString: requirePostgresDatabaseUrl(process.env.DATABASE_URL, {
  requireVerifiedTls: process.env.NODE_ENV === 'production',
}), max: 1, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000 -c lock_timeout=5000' });
try {
  const db = drizzle(pool, { schema });
  const result = positionals[0] === 'report' ? await timerIdentityReviewReport(db) : await resolveTimerIdentity(db, {
    entryId: Number(values['entry-id']), trackedUserId: Number(values['tracked-user-id']), actorUserId: Number(values['actor-user-id']),
    trackedProfileId: values['tracked-profile-id'] === undefined ? undefined : Number(values['tracked-profile-id']),
    expectedFounderId: Number(values['expected-founder-id']), evidenceReference: values['evidence-reference'] ?? '', execute: values.execute,
  });
  console.log(JSON.stringify(result, null, 2));
} catch {
  console.error('Timer identity review failed. No connection details or row contents are logged. Review IDs, evidence, and database constraints.');
  process.exitCode = 1;
} finally { await pool.end(); }
