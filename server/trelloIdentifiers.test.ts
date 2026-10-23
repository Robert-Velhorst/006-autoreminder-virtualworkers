import { describe, expect, it } from 'vitest';
import { parseTrelloModelId, trelloCardUrl } from '../shared/trelloIdentifiers';

describe('Trello URL trust boundaries', () => {
  it.each(['ckEuBpNz', '689fb9bd6fbae715527a75bc', ' ckEuBpNz '])('accepts a plain supported model ID: %s', value => {
    expect(parseTrelloModelId(value)).toBe(value.trim());
  });
  it.each(['https://trello.com/b/ckEuBpNz', 'https://www.trello.com/b/ckEuBpNz/board-name',
    'https://trello.com:443/b/ckEuBpNz/board-name?view=board#section'])('extracts an exact trusted board URL: %s', value => {
    expect(parseTrelloModelId(value)).toBe('ckEuBpNz');
  });
  it.each(['https://trello.com.attacker.example/b/ckEuBpNz', 'https://attacker.example/trello.com/b/ckEuBpNz',
    'https://attacker.example/?next=https://trello.com/b/ckEuBpNz', 'https://trello.com@attacker.example/b/ckEuBpNz',
    'https://attacker.example@trello.com/b/ckEuBpNz', 'http://trello.com/b/ckEuBpNz',
    'https://trello.com:444/b/ckEuBpNz', '//trello.com/b/ckEuBpNz', 'https://trello.com/c/ckEuBpNz',
    'https://trello.com/b/ckEuBpNz%2Fother', 'https://trello.com/b/ckEuBpNz/board/extra',
    'javascript:alert(1)', 'short', 'a'.repeat(33), 'abc12345/../other', ''])('rejects an untrusted model input: %s', value => {
    expect(parseTrelloModelId(value)).toBeNull();
  });
  it('creates only fixed-host links from validated card IDs', () => {
    expect(trelloCardUrl('689fb9bd6fbae715527a75bc')).toBe('https://trello.com/c/689fb9bd6fbae715527a75bc');
    for (const value of ['../other', '//attacker.example', '" onmouseover="alert(1)', '<script>alert(1)</script>', '', 'a'.repeat(33)]) {
      expect(trelloCardUrl(value)).toBeNull();
    }
  });
});
