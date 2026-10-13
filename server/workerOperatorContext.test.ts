import { describe, expect, it } from "vitest";
import { users, userWorkingHours, vaProfiles, type User } from "../drizzle/schema";
import { getActiveWorkerProfileId, getActiveWorkerProfileResolution, resolveWorkerOperatorContext, selectWorkerProfile } from "./workerOperatorContext";

function database(profiles: unknown[], hours: unknown[] = []) {
  const reads: unknown[] = [];
  const db = {
    select: () => {
      let table: unknown;
      const resultRows = () => {
        reads.push(table);
        if (table === vaProfiles) return profiles;
        if (table === userWorkingHours) return hours;
        if (table === users) return [{ name: "Selected founder" }];
        return [];
      };
      const query: any = {
        from: (value: unknown) => { table = value; return query; },
        where: () => query,
        orderBy: () => Promise.resolve(resultRows()),
        limit: () => Promise.resolve(resultRows()),
      };
      return query;
    },
  };
  return { db, reads };
}

const user = { id: 22, openId: "worker-22", name: "Worker", role: "worker" } as User;

describe("worker profile context resolution", () => {
  it("selects only a sole active profile and preserves ambiguity for multiple active profiles", () => {
    expect(selectWorkerProfile([
      { id: 3, status: "inactive" },
      { id: 4, status: "active" },
    ])).toEqual({ id: 4, status: "active" });
    expect(selectWorkerProfile([{ id: 3, status: "inactive" }])).toBeNull();
    expect(selectWorkerProfile([
      { id: 3, status: "inactive" },
      { id: 4, status: "on_leave" },
    ])).toBeNull();
    expect(selectWorkerProfile([
      { id: 3, status: "active" },
      { id: 4, status: "active" },
    ])).toBeNull();
  });

  it("returns an active profile only when the worker has exactly one active profile", async () => {
    const oneActive = database([
      { id: 3, userId: 22, status: "inactive" },
      { id: 4, userId: 22, status: "active" },
    ]);
    const inactiveOnly = database([{ id: 3, userId: 22, status: "inactive" }]);
    const ambiguous = database([
      { id: 3, userId: 22, status: "active" },
      { id: 4, userId: 22, status: "active" },
    ]);

    await expect(getActiveWorkerProfileId(22, oneActive.db as never)).resolves.toBe(4);
    await expect(getActiveWorkerProfileId(22, inactiveOnly.db as never)).resolves.toBeNull();
    await expect(getActiveWorkerProfileId(22, ambiguous.db as never)).resolves.toBeNull();
    await expect(getActiveWorkerProfileResolution(22, oneActive.db as never)).resolves.toEqual({ profileId: 4, ambiguous: false });
    await expect(getActiveWorkerProfileResolution(22, ambiguous.db as never)).resolves.toEqual({ profileId: null, ambiguous: true });
  });

  it("does not inherit founder or Trello context from a sole inactive profile", async () => {
    const { db, reads } = database([
      {
        id: 3,
        userId: 22,
        founderId: 9,
        trelloMemberId: "former-member",
        status: "inactive",
        name: "Former profile",
        timezone: "Asia/Manila",
      },
    ]);

    const context = await resolveWorkerOperatorContext(user, db as never);

    expect(context).toMatchObject({
      profileId: null,
      founderId: null,
      trelloMemberId: null,
      displayName: "Worker",
      founderName: "Founder",
      timezone: "UTC",
    });
    expect(reads).not.toContain(users);
    expect(reads.filter((table) => table === userWorkingHours)).toHaveLength(1);
  });

  it("does not attach an arbitrary founder when multiple active profiles exist", async () => {
    const { db, reads } = database([
      { id: 3, userId: 22, founderId: 9, status: "active", name: "Profile A", timezone: "Europe/Amsterdam" },
      { id: 4, userId: 22, founderId: 10, status: "active", name: "Profile B", timezone: "Asia/Manila" },
    ]);

    const context = await resolveWorkerOperatorContext(user, db as never);

    expect(context).toMatchObject({ profileId: null, founderId: null, displayName: "Worker", founderName: "Founder", timezone: "UTC" });
    expect(reads).not.toContain(users);
  });

  it("prefers the sole active profile over inactive historical profiles", async () => {
    const { db } = database([
      { id: 3, userId: 22, founderId: 9, status: "inactive", name: "Old profile", timezone: "Asia/Manila" },
      { id: 4, userId: 22, founderId: 10, status: "active", name: "Current profile", timezone: "Europe/Amsterdam" },
    ]);

    const context = await resolveWorkerOperatorContext(user, db as never);

    expect(context).toMatchObject({ profileId: 4, founderId: 10, displayName: "Current profile", founderName: "Selected founder", timezone: "Europe/Amsterdam" });
  });

  it("does not re-enable profile breaks when the worker explicitly disables scheduled breaks", async () => {
    const { db } = database([{
      id: 3,
      userId: 22,
      founderId: 9,
      status: "active",
      name: "Current profile",
      timezone: "UTC",
      breakfastTime: 9,
      breakfastDuration: 45,
      lunchTime: 12,
      lunchDuration: 45,
    }], [{
      userId: 22,
      workStartHour: 9,
      workEndHour: 18,
      timezone: "UTC",
      workingDays: "1,2,3,4,5",
      enableBreaks: 0,
      breakfastTime: "09:00",
      breakfastDuration: 45,
      lunchTime: "12:00",
      lunchDuration: 45,
    }]);

    const context = await resolveWorkerOperatorContext(user, db as never);

    expect(context.breaks).toEqual([]);
  });

  it("rejects an invalid persisted worker timezone with an actionable validation error", async () => {
    const cases = [
      database([
        { id: 3, userId: 22, founderId: 9, status: "active", name: "Current profile", timezone: "Not/AZone" },
      ]),
      database([
        { id: 3, userId: 22, founderId: 9, status: "active", name: "Current profile", timezone: "Europe/Amsterdam" },
      ], [{ timezone: "Not/AZone" }]),
    ];

    for (const { db } of cases) {
      await expect(resolveWorkerOperatorContext(user, db as never)).rejects.toMatchObject({
        code: "INVALID_WORKER_TIME_ZONE",
        message: expect.stringContaining("valid IANA time zone"),
      });
    }
  });
});
