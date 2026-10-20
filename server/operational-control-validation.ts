export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];
export interface NotificationPreferenceValues {
  notificationMode: 'disabled' | 'daily_digest' | 'priority_only';
  digestTime: string;
  digestTimezone: string;
  urgentThresholdHours: number;
  emailEnabled: number;
  emailAddress: string | null;
  inAppEnabled: number;
}

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferenceValues = {
  notificationMode: 'priority_only',
  digestTime: '08:00',
  digestTimezone: 'Europe/Amsterdam',
  urgentThresholdHours: 24,
  emailEnabled: 1,
  emailAddress: null as string | null,
  inAppEnabled: 1,
};

function wholeNumber(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export function normalizeCacheRefreshInterval(value: unknown): ValidationResult<number> {
  if (value === undefined) return { ok: true, value: 60 };
  const interval = wholeNumber(value);
  if (interval == null || interval < 5 || interval > 1440) {
    return { ok: false, error: 'Interval must be a whole number of minutes between 5 and 1440' };
  }
  return { ok: true, value: interval };
}

export function normalizeReschedulePreview(input: Record<string, unknown>): ValidationResult<{
  workStartHour: number;
  workEndHour: number;
  workingDays: number[];
}> {
  const workStartHour = input.workStartHour === undefined ? 9 : wholeNumber(input.workStartHour);
  const workEndHour = input.workEndHour === undefined ? 17 : wholeNumber(input.workEndHour);
  if (workStartHour == null || workStartHour < 0 || workStartHour > 23 ||
      workEndHour == null || workEndHour < 1 || workEndHour > 24) {
    return { ok: false, error: 'Work hours must be whole hours between 00:00 and 24:00' };
  }
  if (workEndHour <= workStartHour) {
    return { ok: false, error: 'Work end hour must be after work start hour' };
  }

  const sourceDays = input.workingDays === undefined ? DEFAULT_WORKING_DAYS : input.workingDays;
  if (!Array.isArray(sourceDays)) {
    return { ok: false, error: 'Working days must contain weekdays from 0 through 6' };
  }
  const workingDays = [...new Set(sourceDays.map(wholeNumber))];
  if (workingDays.length === 0 || workingDays.some(day => day == null || day < 0 || day > 6)) {
    return { ok: false, error: 'Working days must contain weekdays from 0 through 6' };
  }

  return {
    ok: true,
    value: { workStartHour, workEndHour, workingDays: workingDays as number[] },
  };
}

function isIanaTimezone(value: string) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isSingleEmailAddress(value: string) {
  return value.length <= 254 && !/[\r\n]/.test(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function normalizeNotificationPreferences(
  input: Record<string, unknown>,
  current: NotificationPreferenceValues | undefined,
  userEmail: string | null | undefined,
): ValidationResult<NotificationPreferenceValues> {
  const base = current ?? { ...DEFAULT_NOTIFICATION_PREFERENCES, emailAddress: userEmail ?? null };
  const notificationMode = input.notificationMode === undefined ? base.notificationMode : input.notificationMode;
  if (notificationMode !== 'disabled' && notificationMode !== 'daily_digest' && notificationMode !== 'priority_only') {
    return { ok: false, error: 'Invalid notification mode' };
  }

  const digestTime = input.digestTime === undefined ? base.digestTime : input.digestTime;
  if (typeof digestTime !== 'string' || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(digestTime)) {
    return { ok: false, error: 'Invalid digest time format. Use HH:MM' };
  }

  const digestTimezone = input.digestTimezone === undefined ? base.digestTimezone : input.digestTimezone;
  if (typeof digestTimezone !== 'string' || !isIanaTimezone(digestTimezone)) {
    return { ok: false, error: 'Digest timezone must be a valid IANA timezone' };
  }

  const urgentThresholdHours = input.urgentThresholdHours === undefined
    ? base.urgentThresholdHours
    : wholeNumber(input.urgentThresholdHours);
  if (urgentThresholdHours == null || urgentThresholdHours < 1 || urgentThresholdHours > 720) {
    return { ok: false, error: 'Urgent threshold must be a whole number of hours between 1 and 720' };
  }

  const emailEnabled = input.emailEnabled === undefined ? base.emailEnabled : input.emailEnabled === false ? 0 : 1;
  const requestedEmail = input.emailAddress === undefined ? base.emailAddress : input.emailAddress;
  if (requestedEmail != null && (typeof requestedEmail !== 'string' || !isSingleEmailAddress(requestedEmail))) {
    return { ok: false, error: 'Email address must be a valid single email address' };
  }
  const inAppEnabled = input.inAppEnabled === undefined ? base.inAppEnabled : input.inAppEnabled === false ? 0 : 1;

  return {
    ok: true,
    value: {
      notificationMode,
      digestTime,
      digestTimezone,
      urgentThresholdHours,
      emailEnabled,
      emailAddress: requestedEmail,
      inAppEnabled,
    },
  };
}
