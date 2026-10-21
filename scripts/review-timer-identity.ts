import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../drizzle/schema.postgres';
import { requirePostgresDatabaseUrl } from '../server/db/databaseUrl';
import { resolveTimerIdentity, resolveAndCloseLegacyTimer, timerIdentityReviewReport } from '../server/timerIdentityReview';
import { requireIsolatedPostgresTestDatabase } from '../shared/isolatedPostgresTestDatabase.mjs';

export function timerReviewDatabaseUrl(env: NodeJS.ProcessEnv) {
  return env.NODE_ENV === 'production'
    ? requirePostgresDatabaseUrl(env.DATABASE_URL, { requireVerifiedTls: true })
    : requireIsolatedPostgresTestDatabase(env.DATABASE_URL, false);
}

export async function runTimerIdentityReview(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
  execute: { type: 'boolean', default: false }, 'entry-id': { type: 'string' }, 'tracked-user-id': { type: 'string' },
  'tracked-profile-id': { type: 'string' }, 'actor-user-id': { type: 'string' }, 'expected-founder-id': { type: 'string' },
  'evidence-reference': { type: 'string' },
    'expected-legacy-va-id': { type: 'string' }, 'expected-profile-id': { type: 'string' },
    'end-time': { type: 'string' }, reason: { type: 'string' },
  } });
  if (positionals.length !== 1 || !['report', 'resolve', 'resolve-close'].includes(positionals[0])) {
    throw new Error('Usage: review-timer-identity.ts report|resolve|resolve-close [explicit identity/evidence flags] [--execute]');
  }
  const mode = positionals[0];
  const closeOnly = ['expected-legacy-va-id', 'expected-profile-id', 'end-time', 'reason'] as const;
  if (mode !== 'resolve-close' && closeOnly.some(name => values[name] !== undefined)) throw new Error('Closure flags require resolve-close mode');
  if (mode === 'report' && values.execute) throw new Error('Report mode cannot execute a mutation');
  const nullableId = (value: string | undefined) => {
    if (value === 'null') return null;
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Explicit positive ID or null required');
    return Number(value);
  };
  const identity = {
    entryId: Number(values['entry-id']), trackedUserId: Number(values['tracked-user-id']), actorUserId: Number(values['actor-user-id']),
    trackedProfileId: values['tracked-profile-id'] === undefined ? undefined : Number(values['tracked-profile-id']),
    expectedFounderId: Number(values['expected-founder-id']), evidenceReference: values['evidence-reference'] ?? '', execute: values.execute,
  };
  const closure = mode === 'resolve-close' ? {
    ...identity, trackedProfileId: nullableId(values['tracked-profile-id']),
    expectedLegacyVaId: nullableId(values['expected-legacy-va-id']), expectedTrackedProfileId: nullableId(values['expected-profile-id']),
    endTime: values['end-time'] ?? '', reason: values.reason ?? '',
  } : undefined;
  const pool = new Pool({ connectionString: timerReviewDatabaseUrl(env), max: 1, connectionTimeoutMillis: 5000,
    options: '-c timezone=UTC -c statement_timeout=15000 -c lock_timeout=5000' });
  try {
    const db = drizzle(pool, { schema });
    return mode === 'report' ? await timerIdentityReviewReport(db)
      : closure ? await resolveAndCloseLegacyTimer(db, closure) : await resolveTimerIdentity(db, identity);
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runTimerIdentityReview(process.argv.slice(2)), null, 2)); }
  catch {
    console.error('Timer identity review failed. No connection details or row contents are logged. Review IDs, evidence, time, settlement, and database constraints.');
    process.exitCode = 1;
  }
}
