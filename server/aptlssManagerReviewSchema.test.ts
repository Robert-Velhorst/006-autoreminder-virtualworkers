import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import * as schema from "../drizzle/schema";

describe("manager review history and scoped correction schema", () => {
  it("provides append-only trial start/close events with immutable run boundaries", () => {
    expect(schema).toHaveProperty("aptlssManagerTrialEvents");
    const table = getTableConfig((schema as any).aptlssManagerTrialEvents);
    expect(table.columns.map(c => c.name)).toEqual(expect.arrayContaining([
      "trialKey", "event", "afterRunId", "implementationDigest", "actorId", "reason", "createdAt",
    ]));
    expect(table.indexes.some(i => i.config.unique)).toBe(true);
  });

  it("stores bounded scoped guidance with pinned evidence and revocation provenance", () => {
    expect(schema).toHaveProperty("aptlssManagerCorrections");
    const table = getTableConfig((schema as any).aptlssManagerCorrections);
    expect(table.columns.map(c => c.name)).toEqual(expect.arrayContaining([
      "vaId", "reviewId", "scope", "cardId", "topic", "conditionsJson", "evidenceJson", "validFrom", "validUntil",
      "correction", "createdBy", "revokedAt", "revokedBy", "revocationReason",
    ]));
    expect(table.foreignKeys).toHaveLength(1);
  });

  it("indexes worker/proposal lookups rather than requiring bounded raw history", () => {
    expect(getTableConfig(schema.aptlssManagerRuns).indexes.map(i => i.config.name)).toContain("aptlss_manager_runs_proposal_idx");
    expect(getTableConfig(schema.aptlssManagerReviews).indexes.map(i => i.config.name)).toContain("aptlss_manager_reviews_proposal_idx");
  });
});
