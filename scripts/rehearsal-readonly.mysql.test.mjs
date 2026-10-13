import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validateReadOnlyGrants, assertReadOnlyRehearsalSession } from './rehearsal-readonly.mjs';
const enabled = process.env.APTLSS_ISOLATED_MYSQL_TEST === '1';
test('actual MySQL grants allow reading, deny writing, and reject privilege escalation', { skip: !enabled, timeout: 120_000 }, async () => {
  const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  const owner = randomUUID();
  let id;
  try {
    const started = docker('run', '-d', '--rm', '--name', 'va-dashboard-verification', '--label', `aptlss.test-owner=${owner}`, '--network', 'none',
      '--memory', '1g', '--cpus', '2', '--pids-limit', '256', '-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes',
      'mysql:8.4', '--port=33317', '--mysqlx=OFF', '--event-scheduler=DISABLED');
    assert.equal(started.status, 0, started.stderr);
    id = started.stdout.trim();
    assert.match(id, /^[a-f0-9]{64}$/);
    const sql = (statement, user = 'root') => docker('exec', id, 'mysql', '--protocol=socket', '-u', user, '--batch', '--skip-column-names', '-e', statement);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const probe = sql('SELECT @@port');
      if (probe.status === 0 && probe.stdout.trim() === '33317') { ready = true; break; }
      await new Promise(done => setTimeout(done, 1000));
    }
    assert.ok(ready, 'owned MySQL instance must become available');
    const setup = sql("CREATE DATABASE aptlss_pilot_rehearsal; CREATE TABLE aptlss_pilot_rehearsal.probe (id INT); INSERT INTO aptlss_pilot_rehearsal.probe VALUES (1); CREATE USER 'fixture'@'localhost'; GRANT SELECT, SHOW VIEW ON aptlss_pilot_rehearsal.* TO 'fixture'@'localhost';");
    assert.equal(setup.status, 0, setup.stderr);
    const grants = () => {
      const result = sql('SHOW GRANTS FOR CURRENT_USER', 'fixture');
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim().split(/\r?\n/);
    };
    assert.equal(validateReadOnlyGrants(grants()).readOnly, true);
    const actualSession = { async query(statement) {
      if (statement === 'SELECT DATABASE() AS db, @@port AS port') {
        const result = sql('USE aptlss_pilot_rehearsal; ' + statement, 'fixture');
        assert.equal(result.status, 0, result.stderr);
        const [db, port] = result.stdout.trim().split('\t');
        return [[{ db, port: Number(port) }]];
      }
      assert.equal(statement, 'SHOW GRANTS FOR CURRENT_USER');
      return [grants().map(Grants => ({ Grants }))];
    } };
    assert.equal((await assertReadOnlyRehearsalSession(actualSession)).readOnly, true);
    const read = sql('SELECT id FROM aptlss_pilot_rehearsal.probe', 'fixture');
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stdout.trim(), '1');
    const write = sql('INSERT INTO aptlss_pilot_rehearsal.probe VALUES (2)', 'fixture');
    assert.notEqual(write.status, 0);
    assert.match(write.stderr, /1142/);
    assert.equal(sql("GRANT UPDATE ON aptlss_pilot_rehearsal.* TO 'fixture'@'localhost'").status, 0);
    assert.throws(() => validateReadOnlyGrants(grants()));
    await assert.rejects(assertReadOnlyRehearsalSession(actualSession));
    assert.equal(sql("REVOKE UPDATE ON aptlss_pilot_rehearsal.* FROM 'fixture'@'localhost'; GRANT SELECT ON aptlss_pilot_rehearsal.* TO 'fixture'@'localhost' WITH GRANT OPTION;").status, 0);
    await assert.rejects(assertReadOnlyRehearsalSession(actualSession));
  } finally {
    if (!id) {
      const owned = docker('ps', '-aq', '--no-trunc', '--filter', `label=aptlss.test-owner=${owner}`);
      assert.equal(owned.status, 0, 'cannot verify owned container after launch failure');
      const ids = owned.stdout.trim().split(/\r?\n/).filter(Boolean);
      assert.ok(ids.length <= 1);
      id = ids[0];
    }
    if (id) {
      const removed = docker('rm', '-f', id);
      assert.equal(removed.status, 0, removed.stderr);
    }
  }
});
