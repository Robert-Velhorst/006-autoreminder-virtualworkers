import { describe, expect, it } from 'vitest';
import { encodeTrelloPathSegment } from './trello-path';

describe('encodeTrelloPathSegment', () => {
  it.each([
    '0123456789abcdef01234567',
    'AbCd1234',
  ])('accepts a Trello ID or card short link: %s', (value) => {
    expect(encodeTrelloPathSegment(value)).toBe(value);
  });

  it.each([
    '../members/me',
    'card/attachments',
    'card-id-123',
    '%2fadmin',
    'short',
    12345678,
    null,
  ])('rejects unsafe or invalid path input: %s', (value) => {
    expect(encodeTrelloPathSegment(value)).toBeNull();
  });
});
