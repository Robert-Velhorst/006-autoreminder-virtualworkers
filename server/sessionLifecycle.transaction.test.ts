import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduledJobs, users } from "../drizzle/schema.postgres";
import { timerTestDatabase, type TestRow } from "./test/timerDatabase";

const controls = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("./db", () => ({ getDb: async () => controls.db }));
import { withSessionIdentity } from "./sessionLifecycle";

const account = { id: 7, openId: "identity-transaction-owner", role: "admin", sessionEpoch: "3" };
let store: ReturnType<typeof timerTestDatabase>;
beforeEach(() => {
  store = timerTestDatabase(new Map<unknown, TestRow[]>([[users, [{ ...account }]], [scheduledJobs, []]]));
  controls.db = store.db;
});
afterEach(() => { controls.db = undefined; vi.restoreAllMocks(); });

describe("session identity transaction callback (transactional synthetic row store)", () => {
  it("supplies the already-open transaction and preserves one-argument callers", async () => {
    const result = await withSessionIdentity(account.openId, { userId: account.id, sessionEpoch: account.sessionEpoch },
      async (user, tx) => {
        expect(tx).toBe(store.db);
        await tx.insert(scheduledJobs).values({ id: "owned-schedule", createdBy: user.openId,
          cardIds: "[]", settings: "{}", scheduledTime: new Date(), status: "pending" });
        return user.id;
      });
    expect(result).toBe(account.id);
    expect(store.db.transaction).toHaveBeenCalledTimes(1);
    expect(store.rows.get(scheduledJobs)).toHaveLength(1);
    await expect(withSessionIdentity(account.openId, undefined, async user => user.id)).resolves.toBe(account.id);
  });

  it("does not call the writer after identity revocation", async () => {
    const writer = vi.fn(async () => undefined);
    await expect(withSessionIdentity(account.openId, { userId: account.id, sessionEpoch: "2" }, writer))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(writer).not.toHaveBeenCalled();
    expect(store.rows.get(scheduledJobs)).toEqual([]);
  });

  it("rolls back callback writes when the callback fails", async () => {
    await expect(withSessionIdentity(account.openId, undefined, async (user, tx) => {
      await tx.insert(scheduledJobs).values({ id: "rolled-back-schedule", createdBy: user.openId,
        cardIds: "[]", settings: "{}", scheduledTime: new Date(), status: "pending" });
      throw new Error("synthetic persistence failure");
    })).rejects.toThrow("synthetic persistence failure");
    expect(store.db.transaction).toHaveBeenCalledTimes(1);
    expect(store.rows.get(scheduledJobs)).toEqual([]);
  });
});
