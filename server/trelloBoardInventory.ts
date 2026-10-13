import { z } from 'zod';
import { fetchWithRetry } from './utils/retry';

const inventorySchema = z.array(z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/),
  prefs: z.object({ isTemplate: z.boolean().optional() }).passthrough().nullable().optional(),
}).passthrough());

export class TrelloBoardInventoryUnavailableError extends Error {
  constructor() {
    super('Trello board access could not be verified');
    this.name = 'TrelloBoardInventoryUnavailableError';
  }
}

/** Verify the configured token owner's complete board scope; stored rows are not access proof. */
export async function fetchVerifiedTrelloBoardIds(apiKey: string, token: string): Promise<string[]> {
  try {
    if (!apiKey.trim() || !token.trim()) throw new TrelloBoardInventoryUnavailableError();
    const signal = AbortSignal.timeout(10_000);
    const load = async (pathname: string, parameters: Record<string, string> = {}) => {
      signal.throwIfAborted();
      const query = new URLSearchParams({ ...parameters, key: apiKey, token });
      const response = await fetchWithRetry(`https://api.trello.com/1/${pathname}?${query}`, {
        signal, redirect: 'error',
      }, { maxRetries: 0 });
      if (!response.ok) throw new TrelloBoardInventoryUnavailableError();
      const inventory = inventorySchema.parse(await response.json());
      signal.throwIfAborted();
      return inventory;
    };

    const memberBoards = await load('members/me/boards', { filter: 'open', fields: 'id' });
    const workspaces = await load('members/me/organizations', { fields: 'id' });
    const boardIds = new Set(memberBoards.map(board => board.id));
    for (const workspace of workspaces) {
      const boards = await load(`organizations/${encodeURIComponent(workspace.id)}/boards`, {
        filter: 'open', fields: 'id,prefs',
      });
      for (const board of boards) {
        if (board.prefs?.isTemplate !== true) boardIds.add(board.id);
      }
    }
    signal.throwIfAborted();
    return [...boardIds];
  } catch {
    // Do not retain provider bodies, credential-bearing URLs or raw transport errors.
    throw new TrelloBoardInventoryUnavailableError();
  }
}
