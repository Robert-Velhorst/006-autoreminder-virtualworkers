import { and, eq, inArray } from 'drizzle-orm';
import {
  timeEntries,
  vaProfiles,
  type User,
  type VAProfile,
  type TimeEntry,
} from '../drizzle/schema.postgres';
import type { getDb } from './db';
import { selectWorkerProfile } from './workerOperatorContext';

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Account = Pick<User, 'id' | 'role'>;

export type TimeEntryAccountScope =
  | { kind: 'all' }
  | { kind: 'worker'; userId: number }
  | { kind: 'founder'; founderId: number };

// Legacy vaId is provenance only, never an account ownership predicate.
export function timeEntryAccountScope(user: Account): TimeEntryAccountScope {
  if (user.role === 'admin') return { kind: 'all' };
  if (user.role === 'worker') return { kind: 'worker', userId: user.id };
  return { kind: 'founder', founderId: user.id };
}

export async function loadAccountTimeEntries(
  db: Database,
  user: Account
): Promise<TimeEntry[]> {
  const query = db.select().from(timeEntries);
  const scope = timeEntryAccountScope(user);
  if (scope.kind === 'all') return query;
  if (scope.kind === 'worker') {
    const profiles = await db.select().from(vaProfiles).where(eq(vaProfiles.userId, scope.userId)).orderBy(vaProfiles.id);
    const profile = selectWorkerProfile(profiles);
    if (!profile) return [];
    return query.where(and(eq(timeEntries.trackedUserId, scope.userId), eq(timeEntries.founderId, profile.founderId)));
  }
  return query.where(eq(timeEntries.founderId, scope.founderId));
}

type ProfileIdentity = Pick<VAProfile, 'id' | 'userId' | 'founderId'>;
type EntryIdentity = Pick<TimeEntry, 'trackedUserId' | 'trackedProfileId' | 'founderId'>;

export function attributeTimeEntriesToProfiles<T extends EntryIdentity>(
  profiles: readonly ProfileIdentity[], entries: readonly T[],
) {
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  const entriesByProfileId = new Map<number, T[]>();
  const unattributed: T[] = [];
  for (const entry of entries) {
    const profile = entry.trackedProfileId === null ? undefined : byId.get(entry.trackedProfileId);
    if (!profile || entry.trackedUserId !== profile.userId || entry.founderId !== profile.founderId) {
      unattributed.push(entry);
      continue;
    }
    const rows = entriesByProfileId.get(profile.id) ?? [];
    rows.push(entry);
    entriesByProfileId.set(profile.id, rows);
  }
  return { entriesByProfileId, unattributed };
}
