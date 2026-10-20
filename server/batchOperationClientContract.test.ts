import { describe, expect, it } from "vitest";
import {
  normalizeBatchOperationResponse,
  getBatchTaskPosition,
  selectBatchOperationForPause,
} from "../client/src/lib/batch-operations-client";

describe("batch operation client contract", () => {
  it("preserves persisted progress and provides an empty task detail list when the API has no per-task payload", () => {
    const operation = normalizeBatchOperationResponse({
      jobId: "batch-1",
      operationType: "reschedule",
      status: "running",
      progress: 60,
      totalTasks: 5,
      completedTasks: 3,
      failedTasks: 0,
      currentTaskIndex: 3,
      currentTaskName: "Card three",
      estimatedTimeSeconds: 120,
      elapsedTimeSeconds: 72,
      createdAt: "2026-08-15T07:00:00.000Z",
    });

    expect(operation).toMatchObject({
      progress: 60,
      completedTasks: 3,
      failedTasks: 0,
      currentTaskIndex: 3,
      elapsedTimeSeconds: 72,
      estimatedTimeSeconds: 120,
      tasks: [],
    });
    expect(operation.createdAt).toBeInstanceOf(Date);
  });

  it("selects the operation requested by the user instead of an unrelated running job", () => {
    const operations = [
      { jobId: "batch-primary", status: "running" as const },
      { jobId: "batch-selected", status: "running" as const },
    ];

    expect(selectBatchOperationForPause(operations, "batch-selected")?.jobId).toBe("batch-selected");
    expect(selectBatchOperationForPause(operations)?.jobId).toBe("batch-primary");
  });

  it("keeps the server task position one-based for direct operator display", () => {
    expect(getBatchTaskPosition(1, 3)).toBe(1);
    expect(getBatchTaskPosition(3, 3)).toBe(3);
    expect(getBatchTaskPosition(0, 3)).toBe(1);
  });
});
