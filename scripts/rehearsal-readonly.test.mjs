import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReadOnlyGrants, assertReadOnlyRehearsalSession } from './rehearsal-readonly.mjs';
const usage = "GRANT USAGE ON *.* TO 'fixture'@'localhost'";
const select = "GRANT SELECT, SHOW VIEW ON `aptlss_pilot_rehearsal`.* TO 'fixture'@'localhost'";
test('accepts explicit owned-schema read privileges only', () => {
  assert.equal(validateReadOnlyGrants([usage, select]).readOnly, true);
});
test('accepts MySQL backtick account notation without broader rights', () => {
  assert.equal(validateReadOnlyGrants([usage.replaceAll("'", '`'), select.replaceAll("'", '`')]).readOnly, true);
});
for (const [name, grant] of [
  ['write', select.replace('SELECT, SHOW VIEW', 'SELECT, INSERT')],
  ['global read', select.replace('`aptlss_pilot_rehearsal`.*', '*.*')],
  ['other schema', select.replace('aptlss_pilot_rehearsal', 'production')],
  ['delegation', select + ' WITH GRANT OPTION'],
  ['role', "GRANT 'admin'@'%' TO 'fixture'@'localhost'"],
  ['dynamic privilege', "GRANT SYSTEM_USER ON *.* TO 'fixture'@'localhost'"],
]) test(`rejects ${name}`, () => assert.throws(() => validateReadOnlyGrants([usage, grant])));
test('usage alone is insufficient', () => assert.throws(() => validateReadOnlyGrants([usage])));
test('empty grant evidence fails closed', () => assert.throws(() => validateReadOnlyGrants([])));
test('checks actual session database and port before reading grants', async () => {
  let calls = 0;
  await assert.rejects(assertReadOnlyRehearsalSession({ async query() { calls++; return [[{ db: 'production', port: 33317 }]]; } }));
  assert.equal(calls, 1);
});
test('validates actual current account grant result', async () => {
  const connection = { async query(sql) {
    if (sql.startsWith('SELECT')) return [[{ db: 'aptlss_pilot_rehearsal', port: 33317 }]];
    assert.equal(sql, 'SHOW GRANTS FOR CURRENT_USER');
    return [[{ Grants: usage }, { Grants: select }]];
  } };
  assert.equal((await assertReadOnlyRehearsalSession(connection)).readOnly, true);
});
