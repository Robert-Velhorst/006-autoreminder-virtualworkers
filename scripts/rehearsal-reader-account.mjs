import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { verifyRehearsalReader } from './verify-rehearsal-reader.mjs';

export async function provisionRehearsalReader(admin, { expectedDataDirectory, connectReader, persist, random = randomBytes }) {
  const [rows] = await admin.query('SELECT DATABASE() AS db, @@datadir AS directory, @@port AS port, @@event_scheduler AS scheduler');
  if (rows.length !== 1 || rows[0].db !== 'aptlss_pilot_rehearsal' ||
      typeof rows[0].directory !== 'string' || path.resolve(rows[0].directory) !== path.resolve(expectedDataDirectory) ||
      Number(rows[0].port) !== 33317 || rows[0].scheduler !== 'DISABLED') {
    throw new Error('Reader account creation requires the verified owned fixture');
  }
  const [clients] = await admin.query("SELECT COUNT(*) AS total FROM information_schema.processlist WHERE ID<>CONNECTION_ID() AND USER NOT IN ('system user','event_scheduler')");
  if (clients.length !== 1 || Number(clients[0].total) !== 0) throw new Error('Other clients prevent reader account creation');
  const username = 'aptlss_reader_' + random(8).toString('hex');
  const password = random(32).toString('hex');
  if (!/^aptlss_reader_[a-f0-9]{16}$/.test(username) || !/^[a-f0-9]{64}$/.test(password)) throw new Error('Invalid generated fixture identity');
  let created = false;
  let reader;
  try {
    // Generated hex-only values avoid identifier interpolation from external input.
    await admin.query(`CREATE USER '${username}'@'127.0.0.1' IDENTIFIED BY '${password}'`);
    created = true;
    await admin.query(`GRANT SELECT, SHOW VIEW ON \`aptlss_pilot_rehearsal\`.* TO '${username}'@'127.0.0.1'`);
    reader = await connectReader({ username, password });
    await verifyRehearsalReader(reader, expectedDataDirectory);
    await reader.end();
    reader = undefined;
    await persist({ username, password });
    return { readerProvisioned: true, productionTouched: false };
  } catch {
    if (reader) await reader.end().catch(() => {});
    if (created) {
      try { await admin.query(`DROP USER '${username}'@'127.0.0.1'`); }
      catch { throw new Error('Reader provisioning failed; owned account cleanup requires inspection'); }
    }
    throw new Error('Reader provisioning failed; no clearance issued');
  }
}
