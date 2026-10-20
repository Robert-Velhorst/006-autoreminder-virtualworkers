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

// Historical rows use either a profile ID or a worker account ID in vaId.
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
    const profiles = await db.select({
      id: vaProfiles.id,
      status: vaProfiles.status,
      founderId: vaProfiles.founderId,
    }).from(vaProfiles).where(eq(vaProfiles.userId, scope.userId)).orderBy(vaProfiles.id);
    const profile = selectWorkerProfile(profiles);
    if (!profile) return [];

    const identities = Array.from(new Set([scope.userId, profile.id]));
    return query.where(and(
      eq(timeEntries.founderId, profile.founderId),
      inArray(timeEntries.vaId, identities),
    ));
  }
  return query.where(eq(timeEntries.founderId, scope.founderId));
}

type ProfileIdentity = Pick<VAProfile, 'id' | 'userId' | 'founderId'>;
type EntryIdentity = Pick<TimeEntry, 'vaId' | 'founderId'>;

export function attributeTimeEntriesToProfiles<T extends EntryIdentity>(
  profiles: readonly ProfileIdentity[],
  entries: readonly T[]
) {
  const profilesByIdentity = new Map<string, Set<number>>();
  for (const profile of profiles) {
    for (const identity of [profile.id, profile.userId]) {
      const key = `${profile.founderId}:${identity}`;
      const owners = profilesByIdentity.get(key) ?? new Set<number>();
      owners.add(profile.id);
      profilesByIdentity.set(key, owners);
    }
  }

  const entriesByProfileId = new Map<number, T[]>();
  const unattributed: T[] = [];
  for (const entry of entries) {
    if (entry.vaId === entry.founderId) {
      unattributed.push(entry);
      continue;
    }
    const owners = profilesByIdentity.get(`${entry.founderId}:${entry.vaId}`);
    if (!owners || owners.size !== 1) {
      unattributed.push(entry);
      continue;
    }
    const profileId = owners.values().next().value as number;
    const profileEntries = entriesByProfileId.get(profileId) ?? [];
    profileEntries.push(entry);
    entriesByProfileId.set(profileId, profileEntries);
  }

  return { entriesByProfileId, unattributed };
}
