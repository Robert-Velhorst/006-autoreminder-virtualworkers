import { describe, expect, it } from "vitest";
import { calculateScheduledTargetSeconds } from "./complianceMetrics";
import {
  dateKeyInTimeZone,
  dateWindowInTimeZone,
  dayOfWeekForDateKey,
  dayOfWeekInTimeZone,
  zonedDateTimeToUtc,
} from "../shared/workerTime";

describe("working-day and timezone scheduling", () => {
  it("maps date keys to weekdays independently of the host timezone", () => {
    const week = [
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
    ];

    expect(week.map(dayOfWeekForDateKey)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it("uses the worker's local date and weekday at UTC day boundaries", () => {
    const instant = new Date("2026-07-30T22:30:00.000Z");

    expect(dateKeyInTimeZone(instant, "Africa/Nairobi")).toBe("2026-07-31");
    expect(dayOfWeekInTimeZone(instant, "Africa/Nairobi")).toBe(5);
    expect(dateKeyInTimeZone(instant, "America/New_York")).toBe("2026-07-30");
    expect(dayOfWeekInTimeZone(instant, "America/New_York")).toBe(4);
  });

  it("calculates working-day targets and excludes configured non-working days", () => {
    const schedule = {
      workStartTime: "08:00",
      workEndTime: "17:00",
      workingDays: [1, 2, 3, 4, 5],
      breaks: [{ startTime: "12:00", durationMinutes: 60 }],
    };

    expect(calculateScheduledTargetSeconds(schedule, "2026-09-18")).toBe(8 * 3600);
    expect(calculateScheduledTargetSeconds(schedule, "2026-09-19")).toBe(0);
    expect(calculateScheduledTargetSeconds(schedule, "2026-09-20")).toBe(0);
  });

  it("builds local-day UTC windows with the correct DST duration", () => {
    const springForward = dateWindowInTimeZone("2026-03-29", "Europe/Amsterdam");
    const fallBack = dateWindowInTimeZone("2026-10-25", "Europe/Amsterdam");

    expect(springForward.start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect((springForward.endExclusive.getTime() - springForward.start.getTime()) / 3_600_000).toBe(23);
    expect(fallBack.start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect((fallBack.endExclusive.getTime() - fallBack.start.getTime()) / 3_600_000).toBe(25);
  });

  it("converts local working times using the date-specific timezone offset", () => {
    expect(zonedDateTimeToUtc("2026-07-30", "09:00", "Europe/Amsterdam").toISOString())
      .toBe("2026-07-30T07:00:00.000Z");
    expect(zonedDateTimeToUtc("2026-12-30", "09:00", "Europe/Amsterdam").toISOString())
      .toBe("2026-12-30T08:00:00.000Z");
  });
});
