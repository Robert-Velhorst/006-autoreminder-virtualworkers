import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { verifyRehearsalReader } from './verify-rehearsal-reader.mjs';
const directory = path.resolve('owned-fixture');
const identity = { directory, port: 33317, scheduler: 'DISABLED' };
function connection(actual, write = false) {
  return { async query(sql) {
    if (sql.includes('@@datadir')) return [[actual]];
    if (sql.includes('DATABASE()')) return [[{ db: 'aptlss_pilot_rehearsal', port: 33317 }]];
    return [[{ Grants: `GRANT ${write ? 'SELECT, INSERT' : 'SELECT'} ON \`aptlss_pilot_rehearsal\`.* TO \`fixture\`@\`localhost\`` }]];
  } };
}
test('combines database identity and account isolation', async () => {
  assert.equal((await verifyRehearsalReader(connection(identity), directory)).identityVerified, true);
});
for (const [label, change] of [['directory', { directory: directory + '-other' }], ['port', { port: 3306 }], ['events', { scheduler: 'ON' }]]) {
  test(`rejects incorrect ${label}`, async () => {
    await assert.rejects(verifyRehearsalReader(connection({ ...identity, ...change }), directory));
  });
}
test('correct identity cannot compensate for write privileges', async () => {
  await assert.rejects(verifyRehearsalReader(connection(identity, true), directory));
});
