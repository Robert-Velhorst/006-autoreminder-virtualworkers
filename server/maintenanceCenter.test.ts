import { describe, expect, it } from "vitest";
import { MAINTENANCE_JOB_DEFINITIONS } from "./maintenanceCenter";

describe("maintenance center registry", () => {
  it("uses unique durable keys and bounded positive intervals", () => {
    const keys = MAINTENANCE_JOB_DEFINITIONS.map((job) => job.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const job of MAINTENANCE_JOB_DEFINITIONS) {
      expect(job.defaultIntervalMinutes).toBeGreaterThanOrEqual(job.minimumIntervalMinutes);
      expect(job.defaultEstimateMs).toBeGreaterThan(0);
    }
  });

  it("keeps provider-mutating and idle preload jobs disabled by default", () => {
    expect(MAINTENANCE_JOB_DEFINITIONS.find((job) => job.key === "webhook_sync")?.defaultEnabled).toBe(false);
    expect(MAINTENANCE_JOB_DEFINITIONS.find((job) => job.key === "database_preload")?.defaultEnabled).toBe(false);
  });
});
