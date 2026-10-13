import { describe, expect, it } from "vitest";
import {
  dateKeyInTimeZone,
  dateWindowInTimeZone,
  dayOfWeekInTimeZone,
  formatWorkerDate,
  InvalidWorkerTimeZoneError,
  timeKeyInTimeZone,
  weekDateKeys,
  zonedDateTimeToUtc,
} from "../shared/workerTime";

describe("worker-local time", () => {
  const instant = new Date("2026-07-30T22:30:00.000Z");

  it("uses each worker's timezone for date, time, and weekday", () => {
    expect(dateKeyInTimeZone(instant, "Africa/Nairobi")).toBe("2026-07-31");
    expect(timeKeyInTimeZone(instant, "Africa/Nairobi")).toBe("01:30");
    expect(dayOfWeekInTimeZone(instant, "Africa/Nairobi")).toBe(5);
    expect(dateKeyInTimeZone(instant, "America/New_York")).toBe("2026-07-30");
  });

  it("rejects an invalid timezone instead of silently planning in UTC", () => {
    for (const operation of [
      () => dateKeyInTimeZone(instant, "Not/AZone"),
      () => formatWorkerDate(instant, "Not/AZone"),
      () => zonedDateTimeToUtc("2026-07-30", "09:00", "Not/AZone"),
    ]) {
      expect(operation).toThrowError(InvalidWorkerTimeZoneError);
      expect(operation).toThrow("saved worker time zone is invalid");
    }
  });

  it("keeps UTC as the default when no timezone is configured", () => {
    expect(dateKeyInTimeZone(instant)).toBe("2026-07-30");
    expect(dateKeyInTimeZone(instant, " ")).toBe("2026-07-30");
  });

  it("converts worker-local boundaries to UTC across timezone offsets", () => {
    expect(zonedDateTimeToUtc("2026-07-31", "08:00", "Africa/Nairobi").toISOString())
      .toBe("2026-07-31T05:00:00.000Z");
    expect(dateWindowInTimeZone("2026-07-31", "Africa/Nairobi")).toEqual({
      start: new Date("2026-07-30T21:00:00.000Z"),
      endExclusive: new Date("2026-07-31T21:00:00.000Z"),
    });
  });

  it("uses the correct daylight-saving offset", () => {
    expect(zonedDateTimeToUtc("2026-07-30", "09:00", "Europe/Amsterdam").toISOString())
      .toBe("2026-07-30T07:00:00.000Z");
    expect(zonedDateTimeToUtc("2026-12-30", "09:00", "Europe/Amsterdam").toISOString())
      .toBe("2026-12-30T08:00:00.000Z");
    expect(dateWindowInTimeZone("2026-03-29", "Europe/Amsterdam").endExclusive.getTime()
      - dateWindowInTimeZone("2026-03-29", "Europe/Amsterdam").start.getTime())
      .toBe(23 * 60 * 60 * 1000);
    expect(dateWindowInTimeZone("2026-10-25", "Europe/Amsterdam").endExclusive.getTime()
      - dateWindowInTimeZone("2026-10-25", "Europe/Amsterdam").start.getTime())
      .toBe(25 * 60 * 60 * 1000);
  });

  it("returns Monday-through-Sunday date keys", () => {
    expect(weekDateKeys("2026-07-30")).toEqual({
      startDateKey: "2026-07-27",
      endDateKey: "2026-08-02",
    });
  });
});
