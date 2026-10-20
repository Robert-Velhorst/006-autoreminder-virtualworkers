import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('APTLSS and interview error boundaries', () => {
  it('keeps unexpected provider and persistence errors out of browser responses', () => {
    const aptlss = readFileSync(new URL('./aptlss.ts', import.meta.url), 'utf8');
    const interview = readFileSync(new URL('./interview-enhanced.ts', import.meta.url), 'utf8');

    expect(aptlss).toContain("error: 'Failed to generate APTLSS. Retry shortly or check the service configuration.'");
    expect(aptlss).not.toContain("error: error.message || 'Failed to generate APTLSS'");
    expect(interview).not.toContain('details: error instanceof Error ? error.message : String(error)');
  });
});
