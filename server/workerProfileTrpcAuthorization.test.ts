import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const profileState = vi.hoisted(() => ({
  profilesByUser: {} as Record<number, Array<{ id: number; status: string }>>,
  lookupErrors: {} as Record<number, boolean>,
  lookup: vi.fn(),
}));

vi.mock("./workerOperatorContext", async importOriginal => {
  const actual = await importOriginal<typeof import("./workerOperatorContext")>();
  return {
    ...actual,
    getActiveWorkerProfileResolution: vi.fn(async (userId: number) => {
      profileState.lookup(userId);
      if (profileState.lookupErrors[userId]) throw new Error("Profile store unavailable");
      const profiles = profileState.profilesByUser[userId] ?? [];
      return {
        profileId: actual.selectWorkerProfile(profiles)?.id ?? null,
        ambiguous: profiles.filter(profile => profile.status === "active").length > 1,
      };
    }),
  };
});

import { activeWorkerProcedure, operatorAccountProcedure, router } from "./_core/trpc";
import { operatorRouter } from "./operatorRouter";

const handlers = {
  account: vi.fn(() => "account handler"),
  worker: vi.fn(() => "worker handler"),
};

const accountTestRouter = router({
  run: operatorAccountProcedure.query(({ ctx }) => handlers.account(ctx.user.id)),
});
const workerTestRouter = router({
  run: activeWorkerProcedure.query(({ ctx }) => handlers.worker(ctx.user.id)),
});

function context(id: number, role: "admin" | "worker" | "user"): TrpcContext {
  return {
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: { id, openId: `test-${id}`, role } as TrpcContext["user"],
  };
}

beforeEach(() => {
  profileState.profilesByUser = {};
  profileState.lookupErrors = {};
  profileState.lookup.mockClear();
  handlers.account.mockClear();
  handlers.worker.mockClear();
});

describe("tRPC active worker profile authorization", () => {
  it.each([
    { label: "no profile", profiles: [] },
    { label: "inactive-only profile", profiles: [{ id: 31, status: "inactive" }] },
    { label: "multiple active profiles", profiles: [
      { id: 31, status: "active" },
      { id: 32, status: "active" },
    ] },
  ])("denies a worker with $label before tRPC or operator handlers run", async ({ profiles }) => {
    profileState.profilesByUser[17] = profiles;
    const worker = context(17, "worker");

    const ambiguous = profiles.filter(profile => profile.status === "active").length > 1;
    const denialCode = ambiguous ? "PRECONDITION_FAILED" : "FORBIDDEN";
    await expect(accountTestRouter.createCaller(worker).run()).rejects.toMatchObject({
      code: denialCode,
      ...(ambiguous ? { message: expect.stringMatching(/profile is ambiguous/i) } : {}),
    });
    await expect(workerTestRouter.createCaller(worker).run()).rejects.toMatchObject({ code: denialCode });
    await expect(operatorRouter.createCaller(worker).getDailyPlanEditingPolicy()).rejects.toMatchObject({ code: denialCode });

    expect(handlers.account).not.toHaveBeenCalled();
    expect(handlers.worker).not.toHaveBeenCalled();
    expect(profileState.lookup).toHaveBeenCalledTimes(3);
  });

  it("allows a worker with exactly one active profile through both shared procedures and operatorRouter", async () => {
    profileState.profilesByUser[17] = [
      { id: 31, status: "inactive" },
      { id: 32, status: "active" },
    ];
    const worker = context(17, "worker");

    await expect(accountTestRouter.createCaller(worker).run()).resolves.toBe("account handler");
    await expect(workerTestRouter.createCaller(worker).run()).resolves.toBe("worker handler");
    await expect(operatorRouter.createCaller(worker).getDailyPlanEditingPolicy())
      .resolves.toMatchObject({ editable: expect.any(Boolean) });

    expect(handlers.account).toHaveBeenCalledTimes(1);
    expect(handlers.worker).toHaveBeenCalledTimes(1);
    expect(profileState.lookup).toHaveBeenCalledTimes(3);
  });

  it("preserves operator-account admin bypass while keeping worker-only procedures worker-only", async () => {
    const admin = context(1, "admin");

    await expect(accountTestRouter.createCaller(admin).run()).resolves.toBe("account handler");
    await expect(workerTestRouter.createCaller(admin).run()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(operatorRouter.createCaller(admin).getDailyPlanEditingPolicy()).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(profileState.lookup).not.toHaveBeenCalled();
    expect(handlers.account).toHaveBeenCalledTimes(1);
    expect(handlers.worker).not.toHaveBeenCalled();
  });

  it("fails closed if active-profile verification itself errors", async () => {
    profileState.lookupErrors[17] = true;
    const worker = context(17, "worker");

    await expect(accountTestRouter.createCaller(worker).run()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to verify the active worker profile",
    });
    await expect(workerTestRouter.createCaller(worker).run()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to verify the active worker profile",
    });

    expect(handlers.account).not.toHaveBeenCalled();
    expect(handlers.worker).not.toHaveBeenCalled();
  });
});
