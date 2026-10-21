export type RecordedTime = {
  endTime?: Date | string | null;
  startTime?: Date | string;
  isVoided?: boolean;
  durationSeconds?: number | null;
  durationMinutes?: number | null;
};

// Preserve recorded values; derive elapsed duration only for completed rows
// without either historical duration representation. Derived time uses the
// same whole-second policy as canonical timer stops and persisted snapshots.
export function recordedSeconds(entry: RecordedTime): number {
  if (entry.isVoided || !entry.endTime) return 0;
  const seconds = entry.durationSeconds != null ? entry.durationSeconds
    : entry.durationMinutes != null ? entry.durationMinutes * 60
      : entry.startTime ? Math.round((new Date(entry.endTime).getTime() - new Date(entry.startTime).getTime()) / 1000) : 0;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

export const recordedMinutes = (entry: RecordedTime) => recordedSeconds(entry) / 60;
