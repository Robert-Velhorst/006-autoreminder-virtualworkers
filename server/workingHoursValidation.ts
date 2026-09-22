type WorkingHoursSettings = Record<string, unknown>;

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isNumberInRange(value: unknown, minimum: number, maximum: number) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum;
}

function isValidClockTime(value: unknown) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

function hasValidTimezone(value: unknown) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 50) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function validateWorkingHoursSettings(input: WorkingHoursSettings):
  | { ok: true }
  | { ok: false; error: string } {
  const startHour = input.workStartHour;
  const startMinute = input.workStartMinute;
  const endHour = input.workEndHour;
  const endMinute = input.workEndMinute;
  if (!isIntegerInRange(startHour, 0, 23) || !isIntegerInRange(startMinute, 0, 59)
    || !isIntegerInRange(endHour, 0, 23) || !isIntegerInRange(endMinute, 0, 59)) {
    return { ok: false, error: 'Work start and end must be valid times' };
  }

  const workDuration = ((endHour * 60) + endMinute) - ((startHour * 60) + startMinute);
  if (workDuration <= 0) {
    return { ok: false, error: 'Work end must be after work start' };
  }
  if (workDuration > 16 * 60) {
    return { ok: false, error: 'Workday cannot exceed 16 hours' };
  }

  for (const [label, timeKey, durationKey] of [
    ['Breakfast', 'breakfastTime', 'breakfastDuration'],
    ['Lunch', 'lunchTime', 'lunchDuration'],
    ['Dinner', 'dinnerTime', 'dinnerDuration'],
  ] as const) {
    if (!isValidClockTime(input[timeKey])) {
      return { ok: false, error: `${label} time must be a valid HH:MM value` };
    }
    if (!isIntegerInRange(input[durationKey], 0, 240)) {
      return { ok: false, error: `${label} duration must be between 0 and 240 minutes` };
    }
  }

  if (!isIntegerInRange(input.shortBreakInterval, 30, 480)
    || !isIntegerInRange(input.longBreakInterval, 30, 480)
    || !isIntegerInRange(input.shortBreakDuration, 5, 60)
    || !isIntegerInRange(input.longBreakDuration, 5, 60)) {
    return { ok: false, error: 'Short and long break intervals must be 30-480 minutes with 5-60 minute durations' };
  }

  const workingDays = typeof input.workingDays === 'string'
    ? input.workingDays.split(',').map((day) => day.trim()).filter(Boolean)
    : [];
  if (workingDays.length === 0 || workingDays.some((day) => !/^[0-6]$/.test(day)) || new Set(workingDays).size !== workingDays.length) {
    return { ok: false, error: 'Working days must contain one or more days from 0 through 6' };
  }

  if (!hasValidTimezone(input.timezone)) {
    return { ok: false, error: 'Timezone must be a valid IANA timezone' };
  }
  if (typeof input.country !== 'string' || !/^[A-Za-z]{2}$/.test(input.country)) {
    return { ok: false, error: 'Country must be a two-letter ISO code' };
  }

  if (!isNumberInRange(input.weeklyHoursMin, 1, 168) || !isNumberInRange(input.weeklyHoursMax, 1, 168)) {
    return { ok: false, error: 'Weekly targets must be between 1 and 168 hours' };
  }
  if (Number(input.weeklyHoursMin) > Number(input.weeklyHoursMax)) {
    return { ok: false, error: 'Weekly minimum cannot exceed weekly maximum' };
  }
  if (!isNumberInRange(input.dailyHoursMin, 0.5, 16) || !isNumberInRange(input.dailyHoursMax, 0.5, 16)) {
    return { ok: false, error: 'Daily targets must be between 0.5 and 16 hours' };
  }
  if (Number(input.dailyHoursMin) > Number(input.dailyHoursMax)) {
    return { ok: false, error: 'Daily minimum cannot exceed daily maximum' };
  }

  return { ok: true };
}
