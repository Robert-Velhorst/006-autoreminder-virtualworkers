import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRehearsalConnection } from './rehearsal-connection.mjs';
import { assertReadOnlyRehearsalSession } from './rehearsal-readonly.mjs';

export async function verifyRehearsalReader(connection, expectedDataDirectory) {
  const [rows] = await connection.query('SELECT @@datadir AS directory, @@port AS port, @@event_scheduler AS scheduler');
  if (rows.length !== 1 || typeof rows[0].directory !== 'string' ||
      path.resolve(rows[0].directory) !== path.resolve(expectedDataDirectory) ||
      Number(rows[0].port) !== 33317 || rows[0].scheduler !== 'DISABLED') {
    throw new Error('Rehearsal database identity is not verified');
  }
  return { ...await assertReadOnlyRehearsalSession(connection), identityVerified: true, eventScheduler: 'DISABLED' };
}

async function main() {
  const data = path.resolve('.local/mysql-production-restore-20261001/data');
  const url = await readRehearsalConnection('.local/pilot/codex-private/rehearsal-reader.json', data);
  const { default: mysql } = await import('mysql2/promise');
  const connection = await mysql.createConnection({ uri: url, connectTimeout: 10_000 });
  try {
    const result = await verifyRehearsalReader(connection, data);
    console.log(JSON.stringify({ ...result, applicationRollbackVerified: false }));
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Read-only rehearsal preflight failed; application start is not authorized'); process.exitCode = 1; });
}
