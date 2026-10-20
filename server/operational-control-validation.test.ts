import { describe, expect, it } from 'vitest';
import {
  normalizeCacheRefreshInterval,
  normalizeNotificationPreferences,
  normalizeReschedulePreview,
} from './operational-control-validation';

describe('operational control validation', () => {
  it('bounds cache refresh intervals to a safe finite whole-minute range', () => {
    expect(normalizeCacheRefreshInterval(undefined)).toEqual({ ok: true, value: 60 });
    expect(normalizeCacheRefreshInterval(5)).toEqual({ ok: true, value: 5 });
    expect(normalizeCacheRefreshInterval('15')).toEqual({ ok: true, value: 15 });
    expect(normalizeCacheRefreshInterval(Number.NaN)).toEqual({ ok: false, error: 'Interval must be a whole number of minutes between 5 and 1440' });
    expect(normalizeCacheRefreshInterval(4)).toEqual({ ok: false, error: 'Interval must be a whole number of minutes between 5 and 1440' });
    expect(normalizeCacheRefreshInterval(1441)).toEqual({ ok: false, error: 'Interval must be a whole number of minutes between 5 and 1440' });
  });

  it('normalizes a sensible working schedule and rejects invalid work windows', () => {
    expect(normalizeReschedulePreview({ workStartHour: 9, workEndHour: 17, workingDays: [1, 2, 3, 4, 5] })).toEqual({
      ok: true,
      value: { workStartHour: 9, workEndHour: 17, workingDays: [1, 2, 3, 4, 5] },
    });
    expect(normalizeReschedulePreview({ workStartHour: 18, workEndHour: 9, workingDays: [1] })).toEqual({
      ok: false,
      error: 'Work end hour must be after work start hour',
    });
    expect(normalizeReschedulePreview({ workStartHour: 9, workEndHour: 17, workingDays: [7] })).toEqual({
      ok: false,
      error: 'Working days must contain weekdays from 0 through 6',
    });
  });

  it('retains existing notification values during a partial update and rejects unsafe values', () => {
    const current = {
      notificationMode: 'daily_digest' as const,
      digestTime: '17:30',
      digestTimezone: 'Europe/Amsterdam',
      urgentThresholdHours: 12,
      emailEnabled: 1,
      emailAddress: 'worker@example.com',
      inAppEnabled: 1,
    };

    expect(normalizeNotificationPreferences({ emailEnabled: false }, current, 'owner@example.com')).toEqual({
      ok: true,
      value: { ...current, emailEnabled: 0 },
    });
    expect(normalizeNotificationPreferences({ urgentThresholdHours: -1 }, current, 'owner@example.com')).toEqual({
      ok: false,
      error: 'Urgent threshold must be a whole number of hours between 1 and 720',
    });
    expect(normalizeNotificationPreferences({ digestTimezone: 'not/a-timezone' }, current, 'owner@example.com')).toEqual({
      ok: false,
      error: 'Digest timezone must be a valid IANA timezone',
    });
    expect(normalizeNotificationPreferences({ emailAddress: 'target@example.com\r\nBcc: injected@example.com' }, current, 'owner@example.com')).toEqual({
      ok: false,
      error: 'Email address must be a valid single email address',
    });
  });
});
