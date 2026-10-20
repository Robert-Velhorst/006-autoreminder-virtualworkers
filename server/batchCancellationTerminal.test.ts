import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("legacy batch cancellation", () => {
  const source = readFileSync(resolve(process.cwd(), "server/services/batch-operations-service.ts"), "utf8");

  it("treats a persisted cancellation as terminal before and between tasks", () => {
    expect(source).toContain("async function isBatchOperationCancelled");
    expect(source.match(/await isBatchOperationCancelled\(operationId\)/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("does not allow executor progress writes to overwrite a cancelled row", () => {
    const progress = source.slice(source.indexOf("async function updateBatchProgress"), source.indexOf("/**\n * Execute batch re-analysis"));

    expect(progress).toContain("current.status === 'cancelled'");
    expect(progress).toContain("ne(batchOperations.status, 'cancelled')");
  });
});
