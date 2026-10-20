import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithRetry } = vi.hoisted(() => ({ fetchWithRetry: vi.fn() }));

vi.mock('../utils/retry', () => ({ fetchWithRetry }));

import { TrelloChecklistSyncService } from './trello-checklist-sync';

describe('TrelloChecklistSyncService mutation retries', () => {
  const service = new TrelloChecklistSyncService({ apiKey: 'key', token: 'token' });

  beforeEach(() => {
    fetchWithRetry.mockReset();
    fetchWithRetry.mockResolvedValue({ ok: true, json: async () => ({ id: 'checklist-1', name: 'Checklist' }) });
  });

  it.each([
    ['createChecklist', () => service.createChecklist('card-1', 'Checklist')],
    ['addChecklistItem', () => service.addChecklistItem('checklist-1', 'Step')],
    ['updateChecklistItemState', () => service.updateChecklistItemState('card-1', 'item-1', 'complete')],
    ['deleteChecklist', () => service.deleteChecklist('checklist-1')],
  ])('%s does not automatically retry a Trello mutation', async (_name, invoke) => {
    await invoke();

    expect(fetchWithRetry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: expect.stringMatching(/POST|PUT|DELETE/) }),
      expect.objectContaining({ maxRetries: 0 }),
    );
  });
});
