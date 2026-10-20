import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('legacy bulk scheduling boundary', () => {
  it('restricts unused assignment mutations to administrators and bounds their input', () => {
    const source = readFileSync(new URL('./routers.ts', import.meta.url), 'utf8');
    const scheduling = source.slice(source.indexOf('scheduling: router({'), source.indexOf('// Manus merged routers'));

    expect(scheduling).toContain('bulkComplete: adminProcedure');
    expect(scheduling).toContain('bulkIncomplete: adminProcedure');
    expect(scheduling).toContain('z.array(z.string().min(1)).min(1).max(100)');
    expect(scheduling).not.toContain('bulkComplete: protectedProcedure');
    expect(scheduling).not.toContain('bulkIncomplete: protectedProcedure');
  });
});
