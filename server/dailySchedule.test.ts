import { describe, expect, it } from "vitest";
import { normalizeDailySchedule } from "./dailySchedule";

describe("normalizeDailySchedule", () => {
  it("does not present a late break as breakfast", () => {
    const result = normalizeDailySchedule({
      startTime: "08:00",
      endTime: "23:00",
      breaks: [{ name: "Breakfast", startTime: "22:00", durationMinutes: 30 }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.breaks[0].name).toBe("Evening break");
    }
  });

  it("rejects a break outside the configured workday", () => {
    const result = normalizeDailySchedule({
      startTime: "08:00",
      endTime: "18:00",
      breaks: [{ name: "Lunch", startTime: "17:45", durationMinutes: 30 }],
    });

    expect(result).toEqual({ ok: false, error: "Lunch must end within the workday" });
  });
});
