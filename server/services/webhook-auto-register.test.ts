import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('webhook auto-registration provider boundary', () => {
  it('bounds every Trello request so maintenance runs can recover', () => {
    const source = readFileSync(
      new URL('./webhook-auto-register.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('const TRELLO_REQUEST_TIMEOUT_MS = 15_000');
    expect(source).toContain('const timeout = AbortSignal.timeout(TRELLO_REQUEST_TIMEOUT_MS)');
    expect(source.match(/signal: requestSignal\(context\)/g)).toHaveLength(3);
    expect(source).toContain('AbortSignal.any([context.signal, timeout])');
  });
});
