import type { ManagerAction, ManagerTimeSample } from "../shared/aptlssManager";
import { recordedSeconds } from '../shared/timerDuration';

type TimingPrediction = {
  cardId: string;
  stepIds: number[];
  minutes: Pick<ManagerAction["minutes"], "low" | "likely" | "high">;
};

export function managerTimingPredictions(value: unknown): TimingPrediction[] {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap(action => {
    if (!action || typeof action !== "object" || typeof action.cardId !== "string"
      || !Array.isArray(action.stepIds) || !action.stepIds.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0)
      || !action.minutes || typeof action.minutes !== "object") return [];
    const { low, likely, high } = action.minutes;
    if (![low, likely, high].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
      || low > likely || likely > high) return [];
    return [{ cardId: action.cardId, stepIds: [...action.stepIds], minutes: { low, likely, high } }];
  });
}

type TimingEntry = {
  id: number;
  aptlssStepId: number | null;
  cardId: string | null;
  category: string;
  startTime: Date | string;
  endTime: Date | string | null;
  durationSeconds: number | null;
  durationMinutes: number | null;
  notes?: string | null;
  isVoided?: boolean;
};

type TimingStep = {
  id: number;
  cardId: string;
  category: string;
  status: string;
};

type TimingEvent = { timeEntryId: number; eventType: string };
type TimeInterval = { start: number; end: number };

function timestamp(value: Date | string | null) {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function unionMinutes(intervals: readonly TimeInterval[]) {
  const ordered = [...intervals].sort((left, right) => left.start - right.start);
  let totalMilliseconds = 0;
  let start: number | null = null;
  let end: number | null = null;

  for (const interval of ordered) {
    if (start === null || end === null) {
      start = interval.start;
      end = interval.end;
    } else if (interval.start <= end) {
      end = Math.max(end, interval.end);
    } else {
      totalMilliseconds += end - start;
      start = interval.start;
      end = interval.end;
    }
  }

  if (start !== null && end !== null) totalMilliseconds += end - start;
  return totalMilliseconds / 60_000;
}

export function aggregateManagerTimeSamples(
  entries: readonly TimingEntry[],
  steps: readonly TimingStep[],
  events: readonly TimingEvent[],
): {
  samples: ManagerTimeSample[];
  timeSummary: { waitingMinutes: number; interruptedMinutes: number };
} {
  const completedSteps = new Map(
    steps.filter(step => step.status === "complete").map(step => [step.id, step]),
  );
  const interruptedEntries = new Set(
    events
      .filter(event => /pause|interrupt|auto.stop/i.test(event.eventType))
      .map(event => event.timeEntryId),
  );
  const samples = new Map<number, ManagerTimeSample>();
  const sampleIntervals = new Map<number, TimeInterval[]>();
  const waitingIntervals: TimeInterval[] = [];
  const interruptedIntervals: TimeInterval[] = [];

  for (const entry of entries) {
    const seconds = recordedSeconds(entry);
    const startedAt = timestamp(entry.startTime);
    const completedAt = timestamp(entry.endTime);
    if (
      !Number.isFinite(seconds) || seconds <= 0 || seconds > 12 * 3600 ||
      !startedAt || !completedAt
    ) continue;

    const start = new Date(startedAt).getTime();
    const end = Math.min(
      start + seconds * 1000,
      new Date(completedAt).getTime(),
    );
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const interval = { start, end };

    if (/wait|break/i.test(entry.category)) {
      waitingIntervals.push(interval);
      continue;
    }

    const interrupted = interruptedEntries.has(entry.id) || /\(paused\)\s*$/i.test(entry.notes ?? "");
    if (interrupted) interruptedIntervals.push(interval);

    const step = entry.aptlssStepId === null
      ? undefined
      : completedSteps.get(entry.aptlssStepId);
    if (
      !step ||
      step.cardId !== entry.cardId ||
      !startedAt
    ) continue;

    const intervals = sampleIntervals.get(step.id) ?? [];
    intervals.push(interval);
    sampleIntervals.set(step.id, intervals);
    const sample = samples.get(step.id) ?? {
      id: step.id,
      cardId: step.cardId,
      stepId: step.id,
      category: step.category,
      minutes: 0,
      completed: true,
      interrupted: false,
      startedAt,
      completedAt,
    };
    sample.interrupted ||= interrupted;
    if (new Date(startedAt) < new Date(sample.startedAt!)) {
      sample.startedAt = startedAt;
    }
    if (new Date(completedAt) > new Date(sample.completedAt!)) {
      sample.completedAt = completedAt;
    }
    sample.minutes = unionMinutes(intervals);
    samples.set(step.id, sample);
  }

  return {
    samples: [...samples.values()],
    timeSummary: {
      waitingMinutes: unionMinutes(waitingIntervals),
      interruptedMinutes: unionMinutes(interruptedIntervals),
    },
  };
}
