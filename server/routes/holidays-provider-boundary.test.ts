import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('holiday provider boundary', () => {
  it('bounds outbound holiday provider calls with a request timeout', () => {
    const source = readFileSync(new URL('./holidays.ts', import.meta.url), 'utf8');

    expect(source).toContain('const HOLIDAY_REQUEST_TIMEOUT_MS = 10_000;');
    expect(source).toContain('signal: AbortSignal.timeout(HOLIDAY_REQUEST_TIMEOUT_MS)');
  });

  it('does not expose provider or database exception text to holiday clients', () => {
    const source = readFileSync(new URL('./holidays.ts', import.meta.url), 'utf8');

    expect(source).toContain("return res.status(500).json({ error: 'Failed to fetch holidays' });");
    expect(source).not.toContain("return res.status(500).json({ error: error?.message || 'Failed to fetch holidays' });");
  });
});
