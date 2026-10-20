import { describe, expect, it } from "vitest";
import type { TrpcContext } from "./_core/context";
import { appRouter } from "./routers";

function workerContext(): TrpcContext {
  return {
    user: {
      id: 42,
      openId: "worker-42",
      email: "worker@example.com",
      name: "Worker",
      loginMethod: "local",
      role: "worker",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

describe("reminder maintenance authorization", () => {
  it("does not let a worker trigger the system-wide due-reminder run", async () => {
    const caller = appRouter.createCaller(workerContext());
    await expect(caller.reminders.runDueNow()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
