import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import { reminderRouter } from "./reminderRouter";

const orchestration = vi.hoisted(() => ({
  approveAndSendReminder: vi.fn(),
  closeCommitment: vi.fn(),
  confirmReminderRetry: vi.fn(),
  createReminder: vi.fn(),
  getReminderDashboard: vi.fn(),
  processDueReminders: vi.fn(),
  updateReminderPolicy: vi.fn(),
  getActiveWorkerProfileId: vi.fn(),
}));

vi.mock("./reminderOrchestration", () => orchestration);
vi.mock("./workerOperatorContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workerOperatorContext")>();
  return {
    ...actual,
    getActiveWorkerProfileId: orchestration.getActiveWorkerProfileId,
    getActiveWorkerProfileResolution: async (userId: number) => ({
      profileId: userId === 42 ? 7 : null,
      ambiguous: false,
    }),
  };
});

function context(role: "admin" | "worker" | "user", id = 42): TrpcContext {
  return {
    user: {
      id,
      openId: `${role}-${id}`,
      email: `${role}@example.com`,
      name: role,
      loginMethod: "local",
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

const createInput = {
  title: "Follow up on the case",
  dueAt: new Date("2026-09-30T12:00:00.000Z"),
  assignedUserId: 99,
};

const policyInput = {
  enabled: true,
  inAppEnabled: true,
  emailEnabled: false,
  maxPerDay: 4,
  minIntervalMinutes: 60,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  timezone: "Europe/Amsterdam",
  allowWeekends: false,
};

describe("reminder router authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orchestration.getActiveWorkerProfileId.mockImplementation(async (userId: number) => userId === 42 ? 7 : null);
    orchestration.createReminder.mockResolvedValue({ id: 7 });
    orchestration.processDueReminders.mockResolvedValue({ processed: 0 });
  });

  it("does not let a worker trigger the system-wide due-reminder run", async () => {
    const caller = reminderRouter.createCaller(context("worker"));
    await expect(caller.runDueNow()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(orchestration.processDueReminders).not.toHaveBeenCalled();
  });

  it("allows an admin to invoke the system-wide due-reminder run", async () => {
    const caller = reminderRouter.createCaller(context("admin", 1));

    await caller.runDueNow();

    expect(orchestration.processDueReminders).toHaveBeenCalledOnce();
  });

  it("binds a worker-created reminder to the caller and does not process all due reminders", async () => {
    const caller = reminderRouter.createCaller(context("worker", 42));

    await caller.create(createInput);

    expect(orchestration.createReminder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42, role: "worker" }),
      expect.objectContaining({ assignedUserId: 42 }),
    );
    expect(orchestration.processDueReminders).not.toHaveBeenCalled();
  });

  it("allows an admin to create for a selected worker and run due reminders", async () => {
    const caller = reminderRouter.createCaller(context("admin", 1));

    await caller.create(createInput);

    expect(orchestration.createReminder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, role: "admin" }),
      expect.objectContaining({ assignedUserId: 99 }),
    );
    expect(orchestration.processDueReminders).toHaveBeenCalledOnce();
  });

  it("rejects unrelated authenticated roles before calling reminder operations", async () => {
    const caller = reminderRouter.createCaller(context("user"));

    await expect(caller.create(createInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.runDueNow()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(orchestration.createReminder).not.toHaveBeenCalled();
    expect(orchestration.processDueReminders).not.toHaveBeenCalled();
  });

  it("denies an inactive worker before reminder policy changes can be written", async () => {
    const caller = reminderRouter.createCaller(context("worker", 99));

    await expect(caller.updatePolicy(policyInput)).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(orchestration.updateReminderPolicy).not.toHaveBeenCalled();
  });

  describe.each(["admin", "worker"] as const)("%s reminder policy timezone validation", role => {
    it.each([
      "America/New_Yorkk", "Europe/Amsterdamm", "Mars/Olympus", "GMT+2",
      "+01:00", "-05:00", "", "   ", "a".repeat(65),
    ])("rejects invalid or non-IANA timezone %j before any persistence", async timezone => {
      const caller = reminderRouter.createCaller(context(role, role === "worker" ? 42 : 1));
      await expect(caller.updatePolicy({ ...policyInput, timezone })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(orchestration.updateReminderPolicy).not.toHaveBeenCalled();
      expect(orchestration.createReminder).not.toHaveBeenCalled();
      expect(orchestration.approveAndSendReminder).not.toHaveBeenCalled();
      expect(orchestration.confirmReminderRetry).not.toHaveBeenCalled();
      expect(orchestration.closeCommitment).not.toHaveBeenCalled();
      expect(orchestration.processDueReminders).not.toHaveBeenCalled();
    });

    it.each([
      "UTC", "America/New_York", "Europe/Amsterdam", "Asia/Kolkata",
      "Pacific/Chatham", "Etc/GMT+5", "  Europe/Amsterdam  ",
    ])("allows Intl-supported timezone %j and preserves existing trimming", async timezone => {
      const ctx = context(role, role === "worker" ? 42 : 1);
      const caller = reminderRouter.createCaller(ctx);
      orchestration.updateReminderPolicy.mockResolvedValue({ success: true });
      await expect(caller.updatePolicy({ ...policyInput, timezone })).resolves.toEqual({ success: true });
      expect(orchestration.updateReminderPolicy).toHaveBeenCalledExactlyOnceWith(
        ctx.user, { ...policyInput, timezone: timezone.trim() },
      );
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: timezone.trim() })
        .formatToParts(new Date("2026-10-21T12:00:00.000Z"))).not.toThrow();
    });
  });
});
