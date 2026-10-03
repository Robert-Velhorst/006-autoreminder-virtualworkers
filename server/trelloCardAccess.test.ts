import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  getDb: vi.fn(),
  resolveWorkerOperatorContext: vi.fn(),
  fetchWithRetry: vi.fn(),
}));

vi.mock('./db', async importOriginal => ({
  ...(await importOriginal<typeof import('./db')>()),
  getDb: calls.getDb,
}));
vi.mock('./workerOperatorContext', () => ({
  resolveWorkerOperatorContext: calls.resolveWorkerOperatorContext,
}));
vi.mock('./utils/retry', () => ({
  fetchWithRetry: calls.fetchWithRetry,
}));

import { cardBelongsToMember, fetchAuthorizedTrelloCard, TrelloAccessError } from './trelloCardAccess';
import type { User } from '../drizzle/schema';

const worker = { id: 9, role: 'worker' } as User;

beforeEach(() => {
  vi.clearAllMocks();
  calls.getDb.mockResolvedValue({});
  vi.stubEnv('TRELLO_API_KEY', 'test-key');
  vi.stubEnv('TRELLO_TOKEN', 'test-token');
});
afterEach(() => vi.unstubAllEnvs());

describe('Trello worker card access', () => {
  it('accepts only cards assigned to the linked member', () => {
    expect(cardBelongsToMember({ idMembers: ['member-a', 'member-b'] }, 'member-b')).toBe(true);
    expect(cardBelongsToMember({ idMembers: ['member-a'] }, 'member-b')).toBe(false);
    expect(cardBelongsToMember({ idMembers: null }, 'member-b')).toBe(false);
  });

  it('fails closed when the selected worker profile has no unambiguous Trello member', async () => {
    calls.resolveWorkerOperatorContext.mockResolvedValue({ trelloMemberId: null });

    await expect(fetchAuthorizedTrelloCard(worker, 'card-1')).rejects.toMatchObject({
      name: 'TrelloAccessError',
      status: 403,
    } satisfies Partial<TrelloAccessError>);
    expect(calls.fetchWithRetry).not.toHaveBeenCalled();
  });

  it('reports a database outage separately from a missing worker Trello link', async () => {
    calls.getDb.mockResolvedValue(null);

    await expect(fetchAuthorizedTrelloCard(worker, 'card-1')).rejects.toMatchObject({
      name: 'TrelloAccessError',
      status: 503,
    } satisfies Partial<TrelloAccessError>);
    expect(calls.resolveWorkerOperatorContext).not.toHaveBeenCalled();
    expect(calls.fetchWithRetry).not.toHaveBeenCalled();
  });

  it('checks card membership against the worker context selected by the shared resolver', async () => {
    calls.resolveWorkerOperatorContext.mockResolvedValue({ trelloMemberId: 'active-member' });
    calls.fetchWithRetry.mockResolvedValue({
      ok: true,
      json: async () => ({ idMembers: ['active-member'] }),
    });

    await expect(fetchAuthorizedTrelloCard(worker, 'card-1')).resolves.toEqual({ idMembers: ['active-member'] });
    expect(calls.resolveWorkerOperatorContext).toHaveBeenCalledWith(worker, expect.any(Object));
    expect(calls.fetchWithRetry).toHaveBeenCalledWith(expect.stringContaining('cards/card-1?'), undefined, { maxRetries: 0 });
  });
});
