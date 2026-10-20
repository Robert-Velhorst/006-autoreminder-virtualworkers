import type { Request } from "express";
import { vaProfiles, type User } from "../../drizzle/schema.postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("../db", () => ({ getDb: mocks.getDb }));

import { requireActiveWorkerProfile, resolveWorkerProfileId } from "./auth";

function makeDb(profiles: unknown[]) {
  const db = {
    select: vi.fn(() => {
      let table: unknown;
      const rows = () => table === vaProfiles ? profiles : [];
      const query: any = {
        from: (value: unknown) => { table = value; return query; },
        where: () => query,
        orderBy: () => Promise.resolve(rows()),
        limit: () => Promise.resolve(rows()),
      };
      return query;
    }),
  };
  return db;
}

const worker = { id: 42, openId: "worker-42", name: "Worker", role: "worker" } as User;
const request = (user: User) => ({ user }) as unknown as Request;

function response() {
  const result = {
    status: vi.fn(function (this: any) { return this; }),
    json: vi.fn(),
  };
  return result;
}

describe("resolveWorkerProfileId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the sole active profile and ignores a worker-supplied profile id", async () => {
    const db = makeDb([
      { id: 3, status: "inactive" },
      { id: 4, status: "active" },
    ]);
    mocks.getDb.mockResolvedValue(db);

    await expect(resolveWorkerProfileId(request(worker), 999)).resolves.toBe(4);
  });

  it("does not resolve a worker to an inactive profile", async () => {
    mocks.getDb.mockResolvedValue(makeDb([{ id: 3, status: "inactive" }]));
    await expect(resolveWorkerProfileId(request(worker))).resolves.toBeNull();

    mocks.getDb.mockResolvedValue(makeDb([
      { id: 3, status: "inactive" },
      { id: 4, status: "on_leave" },
    ]));
    await expect(resolveWorkerProfileId(request(worker))).resolves.toBeNull();
  });

  it("fails closed when multiple active profiles make the worker identity ambiguous", async () => {
    mocks.getDb.mockResolvedValue(makeDb([
      { id: 3, status: "active" },
      { id: 4, status: "active" },
    ]));

    await expect(resolveWorkerProfileId(request(worker))).resolves.toBeNull();
  });

  it("preserves explicit admin profile selection without a worker-profile lookup", async () => {
    const admin = { ...worker, role: "admin" } as User;

    await expect(resolveWorkerProfileId(request(admin), "17")).resolves.toBe(17);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns no worker profile when the database is unavailable", async () => {
    mocks.getDb.mockResolvedValue(null);

    await expect(resolveWorkerProfileId(request(worker))).resolves.toBeNull();
  });
});

describe("requireActiveWorkerProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows a worker with exactly one active profile", async () => {
    mocks.getDb.mockResolvedValue(makeDb([{ id: 7, status: "active" }]));
    const res = response();
    const next = vi.fn();

    await requireActiveWorkerProfile(request(worker), res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects an inactive or ambiguous worker profile before the route runs", async () => {
    for (const profiles of [
      [{ id: 7, status: "inactive" }],
      [{ id: 7, status: "active" }, { id: 8, status: "active" }],
    ]) {
      mocks.getDb.mockResolvedValue(makeDb(profiles));
      const res = response();
      const next = vi.fn();

      await requireActiveWorkerProfile(request(worker), res as any, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: "An active worker profile is required" });
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("fails closed with service unavailable when the profile store cannot be checked", async () => {
    mocks.getDb.mockResolvedValue(null);
    const res = response();
    const next = vi.fn();

    await requireActiveWorkerProfile(request(worker), res as any, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "Worker access could not be verified" });
    expect(next).not.toHaveBeenCalled();
  });

  it("does not expose profile-store diagnostics when verification throws", async () => {
    mocks.getDb.mockRejectedValue(new Error("database-password-or-stack-sentinel"));
    const res = response();
    const next = vi.fn();

    await requireActiveWorkerProfile(request(worker), res as any, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "Worker access could not be verified" });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain("database-password-or-stack-sentinel");
    expect(next).not.toHaveBeenCalled();
  });

  it("preserves admin access without a worker-profile lookup", async () => {
    const admin = { ...worker, role: "admin" } as User;
    const res = response();
    const next = vi.fn();

    await requireActiveWorkerProfile(request(admin), res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});
