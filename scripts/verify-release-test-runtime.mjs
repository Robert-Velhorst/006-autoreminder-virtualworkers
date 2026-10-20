import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function runtimeFailures({ node, vitest, typescript, tsx }) {
  const failures = [];
  if (!/^22\./.test(node)) failures.push('Release verification requires Node 22');
  for (const [name, actual, expected] of [['vitest', vitest, '4.1.11'], ['typescript', typescript, '5.9.3'], ['tsx', tsx, '4.20.6']]) {
    if (actual !== expected) failures.push(`${name}: expected ${expected}, found ${actual}`);
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const require = createRequire(resolve(import.meta.dirname, '../package.json'));
  const versions = { node: process.versions.node };
  for (const name of ['vitest', 'typescript', 'tsx']) {
    try { versions[name] = require(`${name}/package.json`).version; }
    catch { versions[name] = 'missing'; }
  }
  const failures = runtimeFailures(versions);
  console.log(JSON.stringify({ versions, passed: failures.length === 0, failures }));
  if (failures.length) process.exitCode = 1;
}
