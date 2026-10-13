export type DailyBreak = {
  name: string;
  startTime: string;
  durationMinutes: number;
  icon?: string;
};

export type DailySchedule = {
  startTime: string;
  endTime: string;
  breaks: DailyBreak[];
  typingPractice?: boolean;
  typingPracticeMinutes?: number;
};

function minutesForTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function normalizeBreakLabel(name: string, startTime: string): string {
  const startMinutes = minutesForTime(startTime);
  if (startMinutes === null) return name.trim() || "Break";
  const normalized = name.trim().toLowerCase();
  const hour = Math.floor(startMinutes / 60);
  if (normalized === "breakfast" && hour >= 12) {
    return hour >= 17 ? "Evening break" : "Afternoon break";
  }
  if (normalized === "lunch" && (hour < 10 || hour >= 17)) {
    return hour >= 17 ? "Evening break" : "Morning break";
  }
  if (normalized === "dinner" && hour < 16) {
    return hour < 12 ? "Morning break" : "Afternoon break";
  }
  return name.trim();
}

export function normalizeDailySchedule(input: DailySchedule):
  | { ok: true; value: DailySchedule }
  | { ok: false; error: string } {
  const startMinutes = minutesForTime(input.startTime);
  const endMinutes = minutesForTime(input.endTime);
  if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) {
    return { ok: false, error: "Workday start must be before workday end" };
  }

  const normalizedBreaks: Array<DailyBreak & { startMinutes: number; endMinutes: number }> = [];
  for (const breakSlot of input.breaks) {
    const breakStart = minutesForTime(breakSlot.startTime);
    if (breakStart === null || !Number.isInteger(breakSlot.durationMinutes) || breakSlot.durationMinutes < 5 || breakSlot.durationMinutes > 240) {
      return { ok: false, error: "Each break must use a valid time and duration" };
    }
    const breakEnd = breakStart + breakSlot.durationMinutes;
    const name = breakSlot.name.trim() || "Break";
    if (breakStart < startMinutes || breakEnd > endMinutes) {
      return { ok: false, error: `${name} must end within the workday` };
    }
    normalizedBreaks.push({
      ...breakSlot,
      name: normalizeBreakLabel(name, breakSlot.startTime),
      startMinutes: breakStart,
      endMinutes: breakEnd,
    });
  }

  normalizedBreaks.sort((left, right) => left.startMinutes - right.startMinutes);
  for (let index = 1; index < normalizedBreaks.length; index++) {
    if (normalizedBreaks[index].startMinutes < normalizedBreaks[index - 1].endMinutes) {
      return { ok: false, error: "Breaks cannot overlap" };
    }
  }

  return {
    ok: true,
    value: {
      ...input,
      breaks: normalizedBreaks.map(({ startMinutes: _startMinutes, endMinutes: _endMinutes, ...breakSlot }) => breakSlot),
    },
  };
}
