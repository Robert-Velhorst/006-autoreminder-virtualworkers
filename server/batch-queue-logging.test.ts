import { format } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateBatchOperation: vi.fn(), emitToUser: vi.fn() }));
vi.mock("./db/scheduling.js", () => ({ updateBatchOperation: mocks.updateBatchOperation }));
vi.mock("./services/websocket.js", () => ({ websocketService: { emitToUser: mocks.emitToUser } }));
vi.mock("./_core/llm.js", () => ({ invokeLLM: vi.fn() }));
import { batchQueueProcessor } from "./services/batch-queue-processor";

beforeEach(() => { vi.resetAllMocks(); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe("batch persistence log boundary", () => {
  it.each([false, true])("preserves pause persistence and notification when storage rejection=%s", async reject => {
    // A fresh processor with queue execution stubbed isolates the public pause flow.
    const processor = new (batchQueueProcessor.constructor as new () => typeof batchQueueProcessor)();
    vi.spyOn(processor as any, "processQueue").mockResolvedValue(undefined);
    const jobId = "ddeb27fb-d9a0-4624-be4d-4615062daed4";
    mocks.updateBatchOperation.mockResolvedValue(undefined);
    await processor.enqueueJob(jobId, "synthetic-owner", "reschedule", ["synthetic-task"]);
    processor.getJobProgress(jobId)!.status = "running";
    if (reject) mocks.updateBatchOperation.mockRejectedValue(new Error("synthetic-private-query\r\nforged\x1b[2J"));
    await expect(processor.pauseJob(jobId)).resolves.toBeUndefined();
    expect(mocks.updateBatchOperation).toHaveBeenCalledTimes(2);
    expect(mocks.updateBatchOperation).toHaveBeenLastCalledWith(jobId, expect.objectContaining({ status: "running", progress: 0, completedTasks: 0, failedTasks: 0 }));
    expect(processor.getJobProgress(jobId)?.isPaused).toBe(true);
    expect(mocks.emitToUser).toHaveBeenCalledWith("synthetic-owner", "batch:paused", expect.objectContaining({ jobId, isPaused: true }));
    if (reject) {
      expect(console.error).toHaveBeenCalledExactlyOnceWith("[Batch] Failed to persist progress");
      await expect(processor.resumeJob(jobId)).resolves.toBeUndefined();
      expect(processor.getJobProgress(jobId)?.isPaused).toBe(false);
      expect(mocks.emitToUser).toHaveBeenCalledWith("synthetic-owner", "batch:resumed", expect.objectContaining({ jobId, isPaused: false }));
      await expect(processor.cancelJob(jobId)).resolves.toBeUndefined();
      expect(processor.getJobProgress(jobId)?.status).toBe("cancelled");
      const rendered = vi.mocked(console.error).mock.calls.map(args => format(...args)).join("\n");
      expect(rendered).not.toContain("synthetic-private-query");
      for (const args of vi.mocked(console.error).mock.calls) {
        expect(args).toEqual(["[Batch] Failed to persist progress"]);
        expect(format(...args)).not.toMatch(/[\r\n\x1b]/);
      }
    } else expect(console.error).not.toHaveBeenCalled();
  });

  it("retains initialized progress when the first persistence attempt rejects", async () => {
    const processor = new (batchQueueProcessor.constructor as new () => typeof batchQueueProcessor)();
    vi.spyOn(processor as any, "processQueue").mockResolvedValue(undefined);
    mocks.updateBatchOperation.mockRejectedValue(new Error("synthetic-private-query\r\nforged"));
    await expect(processor.enqueueJob("synthetic-job", "synthetic-owner", "reschedule", ["synthetic-task"])).resolves.toBeUndefined();
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledExactlyOnceWith("[Batch] Failed to persist progress"));
    expect(processor.getJobProgress("synthetic-job")).toEqual(expect.objectContaining({ status: "pending", totalTasks: 1 }));
    expect(mocks.emitToUser).not.toHaveBeenCalled();
  });
});
