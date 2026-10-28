import { describe, expect, it } from 'vitest';
import { logString } from './logString';

describe('single-line untrusted log values', () => {
  it.each([
    ['ordinary text', 'Robert'],
    ['empty text', ''],
    ['forged line', 'user\n[LocalAuth] Login accepted'],
    ['carriage return', 'user\rreplacement'],
    ['terminal escape', '\u001b[2Juser'],
    ['C0 controls', '\u0000\t\b\f\u001f'],
    ['C1 controls', '\u007f\u0085\u009b'],
    ['Unicode line separators', 'before\u2028middle\u2029after'],
    ['quotes and literal escapes', '"user"\\nnext'],
    ['Unicode name', 'Zoë 🙂'],
  ])('preserves %s without emitting a control character', (_label, value) => {
    const encoded = logString(value);
    expect(encoded).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(JSON.parse(encoded)).toBe(value);
  });
});
