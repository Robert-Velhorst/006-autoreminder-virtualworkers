import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPendingRequestQueueCap } from "./requestQueueCapacity";

describe("server request queue capacity", () => {
  it("uses a bounded default and clamps unsafe configuration", () => {
    expect(getPendingRequestQueueCap({})).toBe(500);
    expect(getPendingRequestQueueCap({ MAX_PENDING_REQUESTS: "25" })).toBe(25);
    expect(getPendingRequestQueueCap({ MAX_PENDING_REQUESTS: "0" })).toBe(500);
    expect(getPendingRequestQueueCap({ MAX_PENDING_REQUESTS: "999999" })).toBe(10_000);
  });

  it("rejects excess server requests before extending the wait queue", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("const MAX_PENDING_REQUESTS = getPendingRequestQueueCap();");
    expect(source).toContain("if (waitQueue.length >= MAX_PENDING_REQUESTS)");
  });
});
