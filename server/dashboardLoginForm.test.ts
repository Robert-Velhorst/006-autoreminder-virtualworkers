import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('DashboardLayout login form', () => {
  it('gives password managers the correct login autocomplete metadata', () => {
    const source = readFileSync(new URL('../client/src/components/DashboardLayout.tsx', import.meta.url), 'utf8');

    expect(source).toContain('autoComplete="username"');
    expect(source).toContain('autoComplete={mode === \'login\' ? \'current-password\' : \'new-password\'}');
  });
});
