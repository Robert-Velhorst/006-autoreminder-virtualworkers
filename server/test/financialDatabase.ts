import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool, escapeIdentifier } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../../drizzle/schema.postgres';
import { requireIsolatedPostgresTestDatabase } from '../../shared/isolatedPostgresTestDatabase.mjs';

/** Never migrates or drops the supplied base database; owns one exact UUID database. */
export async function createFinancialDatabase(baseUrl: string | undefined, throughMigration?: number) {
  const base = new URL(requireIsolatedPostgresTestDatabase(baseUrl, process.env.NODE_ENV === 'production'));
  const name = `financial_${randomUUID().replaceAll('-', '')}`;
  if (!/^financial_[a-f0-9]{32}$/.test(name)) throw new Error('Unsafe financial fixture identity');
  const canonical = path.resolve(import.meta.dirname, '../../drizzle-postgres-v1');
  const admin = new Pool({ connectionString: base.href, max: 1, connectionTimeoutMillis: 5000 });
  let pool: Pool | undefined;
  let directory: string | undefined;
  let created = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { if (pool) await pool.end(); }
    finally {
      try { if (created) await admin.query(`DROP DATABASE ${escapeIdentifier(name)}`); }
      finally {
        try { await admin.end(); }
        finally { if (directory) await rm(directory, { recursive: true, force: true }); }
      }
    }
  };
  try {
    // Record ownership before awaiting CREATE so a lost reply still takes the cleanup path.
    created = true;
    try { await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`); }
    catch (error) { if ((error as { code?: string }).code === '42P04') created = false; throw error; }
    base.pathname = `/${name}`;
    pool = new Pool({ connectionString: base.href, max: 10, connectionTimeoutMillis: 5000,
      options: '-c timezone=UTC -c statement_timeout=15000 -c lock_timeout=8000' });
    if ((await pool.query('SELECT current_database() AS name')).rows[0].name !== name) {
      throw new Error('Financial fixture database identity mismatch');
    }
    const db = drizzle(pool, { schema });
    let folder = canonical;
    if (throughMigration !== undefined) {
      if (!Number.isSafeInteger(throughMigration) || throughMigration < 0) throw new Error('Invalid financial migration boundary');
      const journal = JSON.parse(await readFile(path.join(canonical, 'meta/_journal.json'), 'utf8'));
      const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= throughMigration);
      if (!entries.some((entry: { idx: number }) => entry.idx === throughMigration)) throw new Error('Missing financial baseline migration');
      directory = await mkdtemp(path.join(tmpdir(), 'financial-migrations-'));
      await mkdir(path.join(directory, 'meta'));
      await writeFile(path.join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
      for (const entry of entries) await copyFile(path.join(canonical, `${entry.tag}.sql`), path.join(directory, `${entry.tag}.sql`));
      folder = directory;
    }
    await migrate(db, { migrationsFolder: folder });
    return { name, pool, db, close, migrateLatest: () => migrate(db, { migrationsFolder: canonical }) };
  } catch (error) {
    try { await close(); }
    catch { throw new Error('Financial fixture initialization failed and owned cleanup was not confirmed'); }
    throw error;
  }
}

export type FinancialDatabase = Awaited<ReturnType<typeof createFinancialDatabase>>;
