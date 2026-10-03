import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { provisionRehearsalReader } from './rehearsal-reader-account.mjs';
const directory = path.resolve('owned-fixture');
function fixture({ wrongIdentity = false, clients = 0, failGrant = false, failPersist = false, failCreate = false, failDrop = false, failConnect = false, failEnd = false } = {}) {
  const writes = [];
  let persisted = false;
  const admin = { async query(sql) {
    if (sql.includes('DATABASE()')) return [[{ db: wrongIdentity ? 'production' : 'aptlss_pilot_rehearsal', directory, port: 33317, scheduler: 'DISABLED' }]];
    if (sql.includes('COUNT(*)')) return [[{ total: clients }]];
    writes.push(sql.split(' ')[0]);
    if (failCreate && sql.startsWith('CREATE')) throw Error('existing account');
    if (failDrop && sql.startsWith('DROP')) throw Error('private cleanup error');
    if (failGrant && sql.startsWith('GRANT')) throw Error('private SQL error');
    return [[]];
  } };
  const options = { expectedDataDirectory: directory, random: length => Buffer.alloc(length, 1),
    async connectReader({ username }) { assert.ok(username.length <= 32); if (failConnect) throw Error('private connection error'); return { async query(sql) {
      if (sql.includes('@@datadir')) return [[{ directory, port: 33317, scheduler: 'DISABLED' }]];
      if (sql.includes('DATABASE()')) return [[{ db: 'aptlss_pilot_rehearsal', port: 33317 }]];
      return [[{ Grants: "GRANT SELECT, SHOW VIEW ON `aptlss_pilot_rehearsal`.* TO `reader`@`127.0.0.1`" }]];
    }, async end() { if (failEnd) throw Error('private disconnect error'); } }; },
    async persist() { if (failPersist) throw Error('private path'); persisted = true; },
  };
  return { admin, options, writes, persisted: () => persisted };
}

test('never drops an account when creation fails', async () => {
  const f = fixture({ failCreate: true });
  await assert.rejects(provisionRehearsalReader(f.admin, f.options), { message: 'Reader provisioning failed; no clearance issued' });
  assert.deepEqual(f.writes, ['CREATE']);
  assert.equal(f.persisted(), false);
});
for (const options of [{ failConnect: true }, { failEnd: true }]) {
  test(`cleans up without saving after ${options.failConnect ? 'connection' : 'disconnect'} failure`, async () => {
    const f = fixture(options);
    await assert.rejects(provisionRehearsalReader(f.admin, f.options), { message: 'Reader provisioning failed; no clearance issued' });
    assert.deepEqual(f.writes, ['CREATE', 'GRANT', 'DROP']);
    assert.equal(f.persisted(), false);
  });
}
test('reports unsuccessful account cleanup without leaking provider errors', async () => {
  const f = fixture({ failGrant: true, failDrop: true });
  await assert.rejects(provisionRehearsalReader(f.admin, f.options), { message: 'Reader provisioning failed; owned account cleanup requires inspection' });
  assert.deepEqual(f.writes, ['CREATE', 'GRANT', 'DROP']);
  assert.equal(f.persisted(), false);
});
test('creates only a new restricted reader after identity verification', async () => {
  const f = fixture();
  assert.equal((await provisionRehearsalReader(f.admin, f.options)).readerProvisioned, true);
  assert.deepEqual(f.writes, ['CREATE', 'GRANT']);
  assert.equal(f.persisted(), true);
});
for (const [name, options] of [['wrong database', { wrongIdentity: true }], ['other clients', { clients: 1 }]]) {
  test(`does not mutate with ${name}`, async () => {
    const f = fixture(options);
    await assert.rejects(provisionRehearsalReader(f.admin, f.options));
    assert.deepEqual(f.writes, []);
  });
}
for (const [name, options] of [['grant failure', { failGrant: true }], ['private save failure', { failPersist: true }]]) {
  test(`removes only its new account after ${name}`, async () => {
    const f = fixture(options);
    await assert.rejects(provisionRehearsalReader(f.admin, f.options), { message: 'Reader provisioning failed; no clearance issued' });
    assert.deepEqual(f.writes, ['CREATE', 'GRANT', 'DROP']);
    assert.equal(f.persisted(), false);
  });
}
