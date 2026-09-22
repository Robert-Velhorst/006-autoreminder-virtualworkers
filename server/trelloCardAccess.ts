import { eq } from 'drizzle-orm';
import { vaProfiles, type User } from '../drizzle/schema';
import { getDb } from './db';
import { fetchWithRetry } from './utils/retry';

export class TrelloAccessError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'TrelloAccessError';
  }
}

export function cardBelongsToMember(card: { idMembers?: unknown }, memberId: string) {
  return Array.isArray(card.idMembers) && card.idMembers.includes(memberId);
}

function credentials() {
  const key = process.env.TRELLO_API_KEY?.trim();
  const token = process.env.TRELLO_TOKEN?.trim();
  if (!key || !token) throw new TrelloAccessError(503, 'Trello credentials are not configured');
  return { key, token };
}

async function workerMemberId(user: User) {
  const db = await getDb();
  if (!db) throw new TrelloAccessError(503, 'Database not available');
  const [profile] = await db
    .select({ trelloMemberId: vaProfiles.trelloMemberId })
    .from(vaProfiles)
    .where(eq(vaProfiles.userId, user.id))
    .limit(1);
  const memberId = profile?.trelloMemberId?.trim();
  if (!memberId) throw new TrelloAccessError(403, 'Your worker profile is not linked to a Trello member');
  return memberId;
}

export async function fetchAuthorizedTrelloCard<T extends { idMembers?: unknown } = { idMembers?: unknown }>(
  user: User,
  cardId: string,
  options: { attachments?: boolean; checklists?: boolean; fields?: string } = {},
): Promise<T> {
  if (user.role !== 'admin' && user.role !== 'worker') {
    throw new TrelloAccessError(403, 'Trello cards require an admin or worker account');
  }
  const memberId = user.role === 'worker' ? await workerMemberId(user) : null;
  const { key, token } = credentials();
  const query = new URLSearchParams({
    key,
    token,
    fields: options.fields || 'all',
  });
  if (options.attachments) query.set('attachments', 'true');
  if (options.checklists) query.set('checklists', 'all');

  const response = await fetchWithRetry(
    `https://api.trello.com/1/cards/${encodeURIComponent(cardId)}?${query.toString()}`,
    undefined,
    { maxRetries: 0 },
  );
  if (!response.ok) {
    throw new TrelloAccessError(response.status === 404 ? 404 : 502, response.status === 404
      ? 'Trello card not found'
      : 'Could not load the Trello card');
  }
  const card = await response.json() as T;
  if (memberId && !cardBelongsToMember(card, memberId)) {
    throw new TrelloAccessError(403, 'This Trello card is not assigned to your linked member account');
  }
  return card;
}

export async function fetchAuthorizedTrelloCardWithComments<T extends { idMembers?: unknown } = { idMembers?: unknown }>(
  user: User,
  cardId: string,
) {
  const card = await fetchAuthorizedTrelloCard<T>(user, cardId, { attachments: true, checklists: true });
  const { key, token } = credentials();
  const query = new URLSearchParams({ key, token, filter: 'commentCard' });
  const response = await fetchWithRetry(
    `https://api.trello.com/1/cards/${encodeURIComponent(cardId)}/actions?${query.toString()}`,
    undefined,
    { maxRetries: 0 },
  );
  if (!response.ok) throw new TrelloAccessError(502, 'Could not load Trello comments');
  return { ...card, comments: await response.json() };
}
