import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ATIS phase portal authorization boundary', () => {
  it('keeps every retained phase-analysis endpoint admin-only', () => {
    const source = readFileSync(new URL('./atis-phases.ts', import.meta.url), 'utf8');

    expect(source).toContain("import { requireAdmin, requestUser } from '../middleware/auth';");
    expect(source).toContain('router.use(requireAdmin);');
    expect(source).toContain('function sendPhaseFailure');
    expect(source).not.toContain('error: String(error)');
  });
});
