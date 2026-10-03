import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const repository = new URL('../', import.meta.url);
function checkRepositoryIgnore(input) {
  const cwd = mkdtempSync(join(tmpdir(), 'aptlss-ignore-'));
  try {
    writeFileSync(join(cwd, '.gitignore'), readFileSync(new URL('.gitignore', repository)));
    writeFileSync(join(cwd, 'empty-excludes'), '');
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), '');
    return spawnSync('git', ['-c', 'core.excludesFile=' + join(cwd, 'empty-excludes'), 'check-ignore', '--no-index', '--stdin'], { cwd, input, encoding: 'utf8' });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
const privatePaths = ['.env', '.env.production', '.env.test', '.env.db.local', '.local/pilot/codex-private/rehearsal-db.json', '.superpowers/brainstorm/.last-token', 'artifacts/private-backup.json'];
test('private runtime and account files are excluded from Git publication', () => {
  const result = checkRepositoryIgnore(privatePaths.join('\n') + '\n');
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/).sort(), [...privatePaths].sort());
});
test('example configuration stays publishable', () => {
  const result = checkRepositoryIgnore('.env.example\n.env.production.example\n');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
});
test('Docker build context also excludes local brainstorm state', () => {
  const rules = readFileSync(new URL('.dockerignore', repository), 'utf8').split(/\r?\n/).map(line => line.trim());
  assert.ok(rules.includes('.superpowers'));
  assert.ok(rules.includes('.local'));
  assert.ok(rules.includes('artifacts'));
});
