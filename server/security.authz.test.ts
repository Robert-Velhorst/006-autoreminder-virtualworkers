import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function createContext(user: TrpcContext["user"] = null): TrpcContext {
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => undefined } as TrpcContext["res"],
  };
}

describe("sensitive tRPC authorization", () => {
  it("rejects anonymous checklist mutations and interview state operations", async () => {
    const caller = appRouter.createCaller(createContext());
    const unauthorized = (promise: Promise<unknown>) =>
      expect(promise).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await unauthorized(caller.aptlss.syncCheckItem({ trelloCheckItemId: "known-item", state: "complete" }));
    await unauthorized(caller.interview.getState({ cardId: "known-card" }));
    await unauthorized(caller.interview.cancel({ cardId: "known-card" }));
  });

  it("does not allow a non-worker user to mutate checklist state", async () => {
    const user = {
      id: 1,
      openId: "test-user",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "test",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as NonNullable<TrpcContext["user"]>;
    const caller = appRouter.createCaller(createContext(user));

    await expect(caller.aptlss.syncCheckItem({ trelloCheckItemId: "known-item", state: "complete" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
