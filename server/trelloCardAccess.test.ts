import { describe, expect, it } from 'vitest';
import { cardBelongsToMember } from './trelloCardAccess';

describe('Trello worker card access', () => {
  it('accepts only cards assigned to the linked member', () => {
    expect(cardBelongsToMember({ idMembers: ['member-a', 'member-b'] }, 'member-b')).toBe(true);
    expect(cardBelongsToMember({ idMembers: ['member-a'] }, 'member-b')).toBe(false);
    expect(cardBelongsToMember({ idMembers: null }, 'member-b')).toBe(false);
  });
});
