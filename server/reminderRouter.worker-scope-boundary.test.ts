import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({
  approveAndSendReminder: vi.fn(),
  closeCommitment: vi.fn(),
  confirmReminderRetry: vi.fn(),
  createReminder: vi.fn(),
  getReminderDashboard: vi.fn(),
  processDueReminders: vi.fn(),
  updateReminderPolicy: vi.fn(),
  getActiveWorkerProfileResolution: vi.fn(),
}));

vi.mock("./reminderOrchestration", () => ({
  approveAndSendReminder: mocks.approveAndSendReminder,
  closeCommitment: mocks.closeCommitment,
  confirmReminderRetry: mocks.confirmReminderRetry,
  createReminder: mocks.createReminder,
  getReminderDashboard: mocks.getReminderDashboard,
  processDueReminders: mocks.processDueReminders,
  updateReminderPolicy: mocks.updateReminderPolicy,
}));

vi.mock("./workerOperatorContext", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./workerOperatorContext")>();
  return {
    ...actual,
    getActiveWorkerProfileResolution: mocks.getActiveWorkerProfileResolution,
  };
});

import { reminderRouter } from "./reminderRouter";

function context(role: string, id: number): TrpcContext {
  return {
    user: {
      id,
      openId: `${role}-${id}`,
      email: `${role}@example.test`,
      name: role,
      loginMethod: "local",
      role: role as "admin" | "worker" | "user",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastSignedIn: new Date("2026-01-01T00:00:00.000Z"),
    },
  } as TrpcContext;
}

const createInput = {
  title: "Follow up on the case",
  dueAt: new Date("2026-09-30T12:00:00.000Z"),
  assignedUserId: 99,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActiveWorkerProfileResolution.mockImplementation(
    async (userId: number) => ({
      profileId: userId === 42 ? 7 : null,
      ambiguous: false,
    })
  );
  mocks.createReminder.mockResolvedValue({ scheduleId: 12 });
  mocks.processDueReminders.mockResolvedValue({ claimed: 0 });
});

describe("reminder router worker-scope boundary", () => {
  it("binds worker-created reminders to the authenticated worker, not the submitted recipient", async () => {
    const caller = reminderRouter.createCaller(context("worker", 42));

    await caller.create(createInput);

    expect(mocks.createReminder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42, role: "worker" }),
      expect.objectContaining({ assignedUserId: 42 })
    );
    expect(mocks.createReminder.mock.calls[0]?.[1]).not.toMatchObject({
      assignedUserId: 99,
    });
    expect(mocks.processDueReminders).not.toHaveBeenCalled();
  });

  it("keeps founder/admin selection explicit and forwards the selected worker unchanged", async () => {
    const caller = reminderRouter.createCaller(context("admin", 7));

    await caller.create(createInput);

    expect(mocks.createReminder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, role: "admin" }),
      expect.objectContaining({ assignedUserId: 99 })
    );
    expect(mocks.processDueReminders).toHaveBeenCalledWith(expect.any(Date), 50, 7);
  });

  it("scopes an admin's manual due run to that admin's workspace", async () => {
    const caller = reminderRouter.createCaller(context("admin", 7));

    await caller.runDueNow();

    expect(mocks.processDueReminders).toHaveBeenCalledWith(expect.any(Date), 50, 7);
  });

  it("rejects inactive workers before reading or mutating reminder data", async () => {
    const caller = reminderRouter.createCaller(context("worker", 99));

    await expect(caller.dashboard()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.create(createInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(mocks.getReminderDashboard).not.toHaveBeenCalled();
    expect(mocks.createReminder).not.toHaveBeenCalled();
  });

  it.each(["user", "founder"])(
    "rejects the non-operator role %s at the router boundary",
    async role => {
      const caller = reminderRouter.createCaller(context(role, 7));

      await expect(caller.dashboard()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(caller.create(createInput)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      expect(mocks.getReminderDashboard).not.toHaveBeenCalled();
      expect(mocks.createReminder).not.toHaveBeenCalled();
    }
  );

  it("keeps the global due runner unavailable to workers", async () => {
    const caller = reminderRouter.createCaller(context("worker", 42));

    await expect(caller.runDueNow()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(mocks.processDueReminders).not.toHaveBeenCalled();
  });
});
