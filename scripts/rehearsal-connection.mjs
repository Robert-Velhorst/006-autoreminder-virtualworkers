import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function validateRehearsalConnection(config, expectedDataDirectory) {
  try {
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        Object.keys(config).sort().join(',') !== 'dataDirectory,url,version' || config.version !== 1) throw Error();
    const url = new URL(config.url);
    if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' || url.port !== '33317' ||
        url.pathname !== '/aptlss_pilot_rehearsal' || url.search || url.hash || !url.username || !url.password ||
        typeof config.dataDirectory !== 'string' || path.resolve(config.dataDirectory) !== path.resolve(expectedDataDirectory)) throw Error();
    return config.url;
  } catch { throw new Error('Private rehearsal connection does not match the owned fixture'); }
}

export async function readRehearsalConnection(file, expectedDataDirectory) {
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('Private rehearsal connection is unavailable'); }
  return validateRehearsalConnection(config, expectedDataDirectory);
}
