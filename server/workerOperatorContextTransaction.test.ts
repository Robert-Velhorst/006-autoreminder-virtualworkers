import { expect, it, vi } from "vitest";
import { users, userWorkingHours } from "../drizzle/schema";
vi.mock("./db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));
import { getDb } from "./db";
import { resolveWorkerOperatorContextById } from "./workerOperatorContext";
it("uses the supplied transaction throughout and preserves canonical hour targets", async () => {
  const db = { select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () =>
    table === users ? [{ id: 2, role: "worker", name: "Joyce" }]
      : table === userWorkingHours ? [{ timezone: "Europe/Amsterdam", workStartHour: 9, workStartMinute: 15, workEndHour: 18, workEndMinute: 0, weeklyHoursMin: 30, weeklyHoursMax: 40, dailyHoursMin: 6, dailyHoursMax: 8 }]
      : [],
  }) }) }) };
  const context = await resolveWorkerOperatorContextById(2, db as never);
  expect(context).toMatchObject({ userId: 2, displayName: "Joyce", workStartTime: "09:15", weeklyHoursMin: 30, weeklyHoursMax: 40, dailyHoursMin: 6, dailyHoursMax: 8 });
  expect(getDb).not.toHaveBeenCalled();
});
