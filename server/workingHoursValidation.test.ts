import { describe, expect, it } from 'vitest';
import { validateWorkingHoursSettings } from './workingHoursValidation';

const validSettings = {
  workStartHour: 9,
  workStartMinute: 0,
  workEndHour: 18,
  workEndMinute: 0,
  breakfastTime: '09:00',
  breakfastDuration: 45,
  lunchTime: '15:00',
  lunchDuration: 45,
  dinnerTime: '20:00',
  dinnerDuration: 120,
  shortBreakInterval: 120,
  shortBreakDuration: 10,
  longBreakInterval: 240,
  longBreakDuration: 30,
  workingDays: '1,2,3,4,5',
  timezone: 'Europe/Amsterdam',
  country: 'NL',
  weeklyHoursMin: 40,
  weeklyHoursMax: 45,
  dailyHoursMin: 8,
  dailyHoursMax: 9,
};

describe('validateWorkingHoursSettings', () => {
  it('accepts a complete, schedulable work configuration', () => {
    expect(validateWorkingHoursSettings(validSettings)).toEqual({ ok: true });
  });

  it.each([
    [{ workStartHour: 18, workEndHour: 9 }, 'Work end must be after work start'],
    [{ breakfastTime: '28:99' }, 'Breakfast time must be a valid HH:MM value'],
    [{ workingDays: '1,2,8' }, 'Working days must contain one or more days from 0 through 6'],
    [{ timezone: 'Not/A-Timezone' }, 'Timezone must be a valid IANA timezone'],
    [{ weeklyHoursMin: 50, weeklyHoursMax: 40 }, 'Weekly minimum cannot exceed weekly maximum'],
    [{ dailyHoursMin: 10, dailyHoursMax: 8 }, 'Daily minimum cannot exceed daily maximum'],
  ])('rejects invalid schedule input %#', (overrides, expectedError) => {
    expect(validateWorkingHoursSettings({ ...validSettings, ...overrides })).toEqual({
      ok: false,
      error: expectedError,
    });
  });
});
