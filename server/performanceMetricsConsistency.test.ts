import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("performance metric contracts", () => {
  it("uses the request queue's actual deduplicated count in every API-savings calculation", () => {
    const legacy = readFileSync(new URL("./routes/performance-optimization.ts", import.meta.url), "utf8");
    const metrics = readFileSync(new URL("./routes/metrics.ts", import.meta.url), "utf8");

    expect(legacy).toContain("deduplicatedRequests: queueMetrics.deduplicatedRequests");
    expect(legacy).toContain("const queueDeduplicationRate = queueMetrics.deduplicationRate;");
    expect(legacy).toContain("const apiCallsSaved = cacheStats.hits + queueMetrics.deduplicatedRequests;");
    expect(metrics).toContain("cacheStats.hits + queueMetrics.deduplicatedRequests");
  });

  it("keeps the WebSocket empty state numeric instead of rendering NaN", () => {
    const component = readFileSync(new URL("../client/src/components/PerformanceMetrics.tsx", import.meta.url), "utf8");

    expect(component).toContain("metrics.websocket.totalUsers > 0");
  });
});
