import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { confinedLocalPath } from './local-filesystem-policy.mjs';

function physicalFuturePath(path) {
  const missing = [];
  let ancestor = path;
  while (true) {
    try { return resolve(realpathSync(ancestor), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Could not verify private Codex authentication location.');
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error('Could not verify private Codex authentication location.');
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

export function resolveCodexBridgePaths(env, cwd = process.cwd()) {
  const selectedRoot = resolve(cwd, env.APTLSS_CODEX_BRIDGE_ROOT || '.');
  const root = selectedRoot === resolve(process.cwd())
    ? realpathSync(process.cwd()) : confinedLocalPath(selectedRoot);
  const queue = confinedLocalPath(resolve(root, env.APTLSS_CODEX_QUEUE_DIR || '.local/pilot/codex-queue'));
  const managerWork = confinedLocalPath(resolve(root, env.APTLSS_CODEX_PRIVATE_DIR || '.local/pilot/codex-private'));
  const llmWork = confinedLocalPath(resolve(root, env.APTLSS_CODEX_LLM_PRIVATE_DIR || '.local/pilot/codex-llm-private'));
  const contains = (parent, child) => {
    const path = relative(parent, child);
    return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
  };
  for (const [left, right] of [[queue, managerWork], [queue, llmWork], [managerWork, llmWork]]) {
    if (contains(left, right) || contains(right, left)) throw new Error('Bridge queue and private directories must be separate.');
  }
  if ([env.CODEX_HOME, env.HOME, env.USERPROFILE].some(path => path && !isAbsolute(path))) {
    throw new Error('Codex authentication home paths must be absolute.');
  }
  const authHomes = env.CODEX_HOME ? [resolve(env.CODEX_HOME)]
    : [homedir(), env.HOME, env.USERPROFILE].filter(Boolean).map(home => resolve(home, '.codex'));
  for (const home of authHomes) {
    const physical = physicalFuturePath(home);
    if ([home, physical].some(path => contains(queue, path) || contains(path, queue))) {
      throw new Error('Codex authentication must remain outside the shared queue.');
    }
  }
  return { root, queue, managerWork, llmWork };
}
