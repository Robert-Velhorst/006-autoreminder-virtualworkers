import { describe, expect, it } from 'vitest';
import { serializeCsv, serializeCsvCell } from './csv';

describe('CSV serialization', () => {
  it('distinguishes typed negative numbers from untrusted numeric-looking strings', () => {
    expect(serializeCsv([[-12.5, 0, 12.5, '-12.5', '+12.5']]))
      .toBe("-12.5,0,12.5,'-12.5,'+12.5");
  });

  it('guards stringified objects, arrays, boxed numbers and bigints', () => {
    expect(serializeCsvCell({ toString: () => '\ufeff=1+1' })).toBe("'\ufeff=1+1");
    expect(serializeCsvCell(['@SUM(1,2)'])).toBe('"\'@SUM(1,2)"');
    expect(serializeCsvCell(new Number(-12))).toBe("'-12");
    expect(serializeCsvCell(-12n)).toBe("'-12");
  });

  it('does not grant non-finite numbers the numeric bypass', () => {
    expect(serializeCsvCell(-Infinity)).toBe("'-Infinity");
    expect(serializeCsvCell(Infinity)).toBe('Infinity');
    expect(serializeCsvCell(NaN)).toBe('NaN');
  });

  it.each(['=', '+', '-', '@', '\uff1d', '\uff0b', '\uff0d', '\uff20'])('neutralizes %s after Unicode whitespace and control characters', marker => {
    expect(serializeCsvCell(`\u00a0\ufeff\u200b\u0000\u0085${marker}1`))
      .toBe(`'\u00a0\ufeff\u200b\u0000\u0085${marker}1`);
  });

  it('quotes formula cells after neutralization and preserves embedded delimiters and line breaks', () => {
    expect(serializeCsv([['=SUM(1,2)', '@"quoted"\r\nnext'], [null, undefined]]))
      .toBe('"\'=SUM(1,2)","\'@""quoted""\r\nnext"\r\n,');
  });

  it('preserves ordinary cells and does not repeatedly prefix apostrophe-protected strings', () => {
    expect(serializeCsv([['ordinary', "'=1", 'a=b', 'a-b', 'a+b', 'a@b']]))
      .toBe("ordinary,'=1,a=b,a-b,a+b,a@b");
    expect(serializeCsv([])).toBe('');
  });
});
