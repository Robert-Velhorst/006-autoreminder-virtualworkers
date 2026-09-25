import { describe, expect, it } from "vitest";
import { users, userWorkingHours, vaProfiles, type User } from "../drizzle/schema";
import { resolveWorkerOperatorContext, selectWorkerProfile } from "./workerOperatorContext";

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
  it("selects the sole active profile and only falls back when one historical profile exists", () => {
    expect(selectWorkerProfile([
      { id: 3, status: "inactive" },
      { id: 4, status: "active" },
    ])).toEqual({ id: 4, status: "active" });
    expect(selectWorkerProfile([{ id: 3, status: "inactive" }])).toEqual({ id: 3, status: "inactive" });
    expect(selectWorkerProfile([
      { id: 3, status: "inactive" },
      { id: 4, status: "on_leave" },
    ])).toBeNull();
    expect(selectWorkerProfile([
      { id: 3, status: "active" },
      { id: 4, status: "active" },
    ])).toBeNull();
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
});
