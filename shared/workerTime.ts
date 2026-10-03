const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_KEY_PATTERN = /^\d{2}:\d{2}$/;

export class InvalidWorkerTimeZoneError extends Error {
  readonly code = "INVALID_WORKER_TIME_ZONE";

  constructor() {
    super("The saved worker time zone is invalid. Set it to a valid IANA time zone before creating or changing a schedule.");
    this.name = "InvalidWorkerTimeZoneError";
  }
}

export function validateWorkerTimeZone(timeZone: string | null | undefined) {
  const candidate = timeZone?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    throw new InvalidWorkerTimeZoneError();
  }
}

function parts(value: Date | number, timeZone?: string | null) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("A valid timestamp is required");
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: validateWorkerTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  return Object.fromEntries(values.map((item) => [item.type, item.value]));
}

function dateKeyParts(dateKey: string) {
  if (!DATE_KEY_PATTERN.test(dateKey)) throw new Error("A date key in YYYY-MM-DD format is required");
  const [year, month, day] = dateKey.split("-").map(Number);
  return { year, month, day };
}

function timeKeyParts(timeKey: string) {
  if (!TIME_KEY_PATTERN.test(timeKey)) throw new Error("A time key in HH:MM format is required");
  const [hour, minute] = timeKey.split(":").map(Number);
  if (hour > 23 || minute > 59) throw new Error("A valid time key is required");
  return { hour, minute };
}

export function dateKeyInTimeZone(value: Date | number = Date.now(), timeZone?: string | null) {
  const valueParts = parts(value, timeZone);
  const result = `${valueParts.year}-${valueParts.month}-${valueParts.day}`;
  if (!DATE_KEY_PATTERN.test(result)) throw new Error("Unable to format a local date");
  return result;
}

export function timeKeyInTimeZone(value: Date | number = Date.now(), timeZone?: string | null) {
  const valueParts = parts(value, timeZone);
  return `${valueParts.hour}:${valueParts.minute}`;
}

export function dayOfWeekInTimeZone(value: Date | number = Date.now(), timeZone?: string | null) {
  const weekday = parts(value, timeZone).weekday;
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

export function formatWorkerDate(value: Date | number = Date.now(), timeZone?: string | null) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: validateWorkerTimeZone(timeZone),
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(value instanceof Date ? value : new Date(value));
}

export function addDaysToDateKey(dateKey: string, days: number) {
  const value = dateKeyParts(dateKey);
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
  date.setUTCDate(date.getUTCDate() + Math.trunc(days));
  return date.toISOString().slice(0, 10);
}

export function dayOfWeekForDateKey(dateKey: string) {
  const value = dateKeyParts(dateKey);
  return new Date(Date.UTC(value.year, value.month - 1, value.day)).getUTCDay();
}

export function zonedDateTimeToUtc(
  dateKey: string,
  timeKey: string,
  timeZone?: string | null,
) {
  const dateValue = dateKeyParts(dateKey);
  const timeValue = timeKeyParts(timeKey);
  const targetUtc = Date.UTC(
    dateValue.year,
    dateValue.month - 1,
    dateValue.day,
    timeValue.hour,
    timeValue.minute,
  );
  let candidate = targetUtc;
  const zone = validateWorkerTimeZone(timeZone);

  // Resolve the zone offset at the target instant. Repeating handles DST
  // boundaries where the first estimate lands on the other side of a change.
  for (let attempt = 0; attempt < 4; attempt++) {
    const actual = parts(candidate, zone);
    const actualAsUtc = Date.UTC(
      Number(actual.year),
      Number(actual.month) - 1,
      Number(actual.day),
      Number(actual.hour),
      Number(actual.minute),
    );
    const correction = targetUtc - actualAsUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate);
}

export function dateWindowInTimeZone(dateKey: string, timeZone?: string | null) {
  return {
    start: zonedDateTimeToUtc(dateKey, "00:00", timeZone),
    endExclusive: zonedDateTimeToUtc(addDaysToDateKey(dateKey, 1), "00:00", timeZone),
  };
}

export function weekDateKeys(dateKey: string, weekStartsOn = 1) {
  const day = dayOfWeekForDateKey(dateKey);
  const offset = (day - weekStartsOn + 7) % 7;
  const startDateKey = addDaysToDateKey(dateKey, -offset);
  return {
    startDateKey,
    endDateKey: addDaysToDateKey(startDateKey, 6),
  };
}
