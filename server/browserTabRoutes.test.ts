import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('browser tab collector error boundary', () => {
  it('returns validation feedback without exposing unexpected internal errors', () => {
    const source = readFileSync(new URL('./browserTabRoutes.ts', import.meta.url), 'utf8');

    expect(source).toContain('"Browser inventory could not be recorded. Retry shortly."');
    expect(source).not.toContain('error instanceof Error ? error.message : "Browser inventory failed"');
  });
});
