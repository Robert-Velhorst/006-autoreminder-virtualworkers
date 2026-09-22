import { describe, expect, it } from "vitest";
import {
  calculateBatchProgress,
  calculateBatchTerminalStatus,
  estimateBatchDuration,
} from "./services/batch-queue-processor";

describe("calculateBatchProgress", () => {
  it("counts failed tasks as processed so a completed batch reaches 100 percent", () => {
    expect(calculateBatchProgress(4, 1, 5)).toBe(100);
  });

  it("returns zero for an empty batch instead of producing NaN", () => {
    expect(calculateBatchProgress(0, 0, 0)).toBe(0);
  });

  it("reports a fully failed batch as failed rather than completed", () => {
    expect(calculateBatchTerminalStatus(0, 5, 5)).toBe("failed");
    expect(calculateBatchTerminalStatus(4, 1, 5)).toBe("completed");
  });

  it("projects an ETA from both successful and failed processed tasks", () => {
    expect(estimateBatchDuration(12, 1, 1, 4)).toBe(24);
  });

  it("withholds an ETA until at least one task has completed or failed", () => {
    expect(estimateBatchDuration(12, 0, 0, 4)).toBeUndefined();
  });
});
