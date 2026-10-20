import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateRehearsalConnection, readRehearsalConnection } from './rehearsal-connection.mjs';
const data = path.resolve('fixture-owned-data');
const valid = { version: 1, dataDirectory: data, url: 'mysql://fixture:unused@127.0.0.1:33317/aptlss_pilot_rehearsal' };
test('accepts only the exact owned fixture configuration', () => assert.equal(validateRehearsalConnection(valid, data), valid.url));
for (const url of ['mysql://fixture:unused@127.0.0.1:3307/aptlss_pilot_rehearsal', 'mysql://fixture:unused@remote:33317/aptlss_pilot_rehearsal', 'mysql://fixture:unused@127.0.0.1:33317/production', valid.url + '?ssl=true', 'not-a-url']) {
  test(`rejects unsafe fixture address case ${url.length}`, () => {
    assert.throws(() => validateRehearsalConnection({ ...valid, url }, data), error => !error.message.includes('unused') && /does not match/.test(error.message));
  });
}
test('rejects a different data directory', () => assert.throws(() => validateRehearsalConnection(valid, data + '-other')));
test('rejects extra settings and unsupported formats', () => assert.throws(() => validateRehearsalConnection({ ...valid, version: 2, extra: true }, data)));
test('missing configuration fails closed without exposing a filesystem path', async () => {
  await assert.rejects(readRehearsalConnection('nonexistent-fixture-config-019f.json', data), { message: 'Private rehearsal connection is unavailable' });
});
