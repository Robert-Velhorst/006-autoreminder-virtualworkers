import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKER_HOUR_TARGETS,
  workerHourTargetsFromSettings,
} from "./workerOperatorContext";

describe("worker hour targets", () => {
  it("uses the configured worker or founder target range", () => {
    expect(workerHourTargetsFromSettings({
      weeklyHoursMin: 32,
      weeklyHoursMax: 38,
      dailyHoursMin: "6.50",
      dailyHoursMax: "7.50",
    })).toEqual({
      weeklyHoursMin: 32,
      weeklyHoursMax: 38,
      dailyHoursMin: 6.5,
      dailyHoursMax: 7.5,
    });
  });

  it("uses stable operating defaults for malformed or incomplete settings", () => {
    expect(workerHourTargetsFromSettings({ weeklyHoursMin: 70, weeklyHoursMax: 40 }))
      .toEqual(DEFAULT_WORKER_HOUR_TARGETS);
  });
});
