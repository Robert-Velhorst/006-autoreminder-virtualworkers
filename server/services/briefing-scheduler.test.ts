import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaProfiles, users, timeEntries } from "../../drizzle/schema.postgres";
import { ScheduledJobLeaseLostError } from "../scheduledJobRuntime";

const controls = vi.hoisted(() => ({ getDb: vi.fn(), settings: vi.fn(), ownership: vi.fn(),
  run: vi.fn(), morning: vi.fn(), eod: vi.fn(), consent: vi.fn(), contexts: [] as unknown[] }));
vi.mock("../db", () => ({ getDb: controls.getDb }));
vi.mock("../briefingSettings", () => ({ getBriefingSettings: controls.settings, shouldRunBriefingAt: () => true }));
vi.mock("../scheduledJobRuntime", async importOriginal => {
  const actual = await importOriginal<typeof import("../scheduledJobRuntime")>();
  return { ScheduledJobLeaseLostError: actual.ScheduledJobLeaseLostError, runScheduledJob: controls.run };
});
vi.mock("./email", () => ({ sendMorningBriefing: controls.morning, sendEODReport: controls.eod }));
vi.mock("./recipientEmailConsent", () => ({ hasRecipientEmailConsent: controls.consent }));
import { processScheduledBriefings } from "./briefing-scheduler";

describe("scheduled briefing ownership at the email boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    controls.settings.mockResolvedValue({ morningBriefingEnabled: true, eodReportEnabled: true });
    controls.ownership.mockResolvedValue(undefined);
    controls.consent.mockResolvedValue(true);
    controls.morning.mockResolvedValue(true); controls.eod.mockResolvedValue(true);
    controls.contexts.length = 0;
    controls.run.mockImplementation(async (_input, work) => {
      const context = { signal: new AbortController().signal, assertOwnership: controls.ownership };
      controls.contexts.push(context);
      return work(context);
    });
    controls.getDb.mockResolvedValue({ select: () => ({ from: (table: unknown) => ({ where: () => {
      const rows = table === vaProfiles ? [{ id: 1, userId: 2, founderId: 3, timezone: "UTC",
        status: "active", name: "Synthetic worker", email: "worker@example.invalid" }]
        : table === users ? [{ id: 3, email: "founder@example.invalid" }] : [];
      return Object.assign(Promise.resolve(rows), { limit: async () => rows });
    } }) }) });
  });
  afterEach(() => vi.restoreAllMocks());
  it.each([2, 3])("honors recipient %s opt-out independently", async userId => {
    controls.consent.mockImplementation(async id => id !== userId);
    await processScheduledBriefings();
    expect(controls.morning).toHaveBeenCalledTimes(userId === 2 ? 0 : 1);
    expect(controls.eod).toHaveBeenCalledTimes(userId === 3 ? 0 : 1);
  });
  it("does not create jobs when neither recipient has persisted consent", async () => {
    controls.consent.mockResolvedValue(false);
    await processScheduledBriefings();
    expect(controls.run).not.toHaveBeenCalled();
    expect(controls.morning).not.toHaveBeenCalled();
    expect(controls.eod).not.toHaveBeenCalled();
  });
  it.each([2, 3])("rechecks recipient %s consent at delivery", async userId => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reads = new Map<number, number>();
    controls.consent.mockImplementation(async id => {
      const count = (reads.get(id) ?? 0) + 1;
      reads.set(id, count);
      return id !== userId || count === 1;
    });
    await processScheduledBriefings();
    expect(userId === 2 ? controls.morning : controls.eod).not.toHaveBeenCalled();
  });
  it("checks ownership immediately before each provider call", async () => {
    await processScheduledBriefings();
    expect(controls.morning).toHaveBeenCalledTimes(1); expect(controls.eod).toHaveBeenCalledTimes(1);
    expect(controls.ownership).toHaveBeenCalledTimes(2);
    expect(controls.ownership.mock.invocationCallOrder[0]).toBeLessThan(controls.morning.mock.invocationCallOrder[0]);
    expect(controls.ownership.mock.invocationCallOrder[1]).toBeLessThan(controls.eod.mock.invocationCallOrder[0]);
    expect(controls.morning.mock.calls[0][2]).toBe(controls.contexts[0]);
    expect(controls.eod.mock.calls[0][2]).toBe(controls.contexts[1]);
  });
  it("does not send a morning email after ownership loss", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    controls.ownership.mockRejectedValue(new Error("Synthetic lease loss"));
    await processScheduledBriefings();
    expect(controls.morning).not.toHaveBeenCalled(); expect(controls.eod).not.toHaveBeenCalled();
  });
  it.each(["morning", "eod"])("propagates a %s email lease error instead of swallowing it", async kind => {
    const error = new ScheduledJobLeaseLostError();
    (kind === "morning" ? controls.morning : controls.eod).mockRejectedValue(error);
    await expect(processScheduledBriefings()).rejects.toBe(error);
    if (kind === "morning") expect(controls.eod).not.toHaveBeenCalled();
  });
  it("rechecks ownership after collecting end-of-day records", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    controls.settings.mockResolvedValue({ morningBriefingEnabled: false, eodReportEnabled: true });
    const database = await controls.getDb();
    const from = database.select().from;
    database.select = () => ({ from: (table: unknown) => {
      if (table === timeEntries) controls.ownership.mockRejectedValue(new Error("Synthetic lease lost during report read"));
      return from(table);
    } });
    await processScheduledBriefings();
    expect(controls.ownership).toHaveBeenCalledTimes(1);
    expect(controls.eod).not.toHaveBeenCalled();
  });
});
