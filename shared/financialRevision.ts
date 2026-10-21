const counterKeys = [
  'meritM1', 'meritM2', 'meritM3', 'meritStreak',
  'demeritD1', 'demeritD2', 'demeritD3', 'demeritD4', 'demeritD5',
  'demeritD6', 'demeritD7', 'demeritD8', 'demeritD9', 'demeritD10', 'demeritD11',
] as const;

export type WeeklyPayRevisionRow = Record<typeof counterKeys[number], number | string> & {
  id: number; vaId: number; founderId: number;
  weekStart: Date | string; weekEnd: Date | string;
  notes: string | null; paymentCycleId: number | null;
};

function dateKey(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

// This is a content revision, not a secret or authorization token. Excluding
// timestamps avoids driver/session timezone and sub-millisecond precision drift.
export function weeklyPayRevision(row: WeeklyPayRevisionRow | null): string | null {
  if (row === null) return null;
  const counters = Object.fromEntries(counterKeys.map(field => [field, Number(row[field])]));
  if (Object.values(counters).some(value => !Number.isFinite(value))) {
    throw new Error('Cannot determine a revision for invalid pay counters');
  }
  return JSON.stringify({ id: row.id, vaId: row.vaId, founderId: row.founderId,
    weekStart: dateKey(row.weekStart), weekEnd: dateKey(row.weekEnd),
    ...counters, notes: row.notes, paymentCycleId: row.paymentCycleId });
}
