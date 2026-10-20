import { describe, expect, it } from "vitest";
import { shouldPollBatchOperations } from "../client/src/hooks/useBatchOperations";

describe("batch operation polling", () => {
  it("polls only while a batch operation is pending or running", () => {
    expect(shouldPollBatchOperations([])).toBe(false);
    expect(shouldPollBatchOperations([{ status: "completed" }])).toBe(false);
    expect(shouldPollBatchOperations([{ status: "failed" }])).toBe(false);
    expect(shouldPollBatchOperations([{ status: "pending" }])).toBe(true);
    expect(shouldPollBatchOperations([{ status: "running" }])).toBe(true);
  });
});
