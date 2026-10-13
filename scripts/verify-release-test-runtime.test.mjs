import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFailures } from './verify-release-test-runtime.mjs';

const expected = { node: '22.23.3', vitest: '4.1.11', typescript: '5.9.3', tsx: '4.20.6' };
test('accepts the release test runtime', () => assert.deepEqual(runtimeFailures(expected), []));
for (const [key, value] of [['node', '25.2.1'], ['vitest', '2.1.9'], ['typescript', 'missing'], ['tsx', '4.19.1']]) {
  test(`rejects mismatched ${key}`, () => assert.equal(runtimeFailures({ ...expected, [key]: value }).length, 1));
}
