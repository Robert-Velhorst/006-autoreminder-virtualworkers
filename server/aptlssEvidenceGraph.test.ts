import { describe, expect, it } from "vitest";
import {
  buildEvidenceNaturalKey,
  calculateEvidenceConfidence,
  normalizeEvidenceDraft,
  resolveEvidenceConflict,
} from "./aptlssEvidenceGraph";

describe("APTLSS evidence graph", () => {
  it("normalizes evidence without discarding the original detail", () => {
    const evidence = normalizeEvidenceDraft({
      source: "gmail",
      sourceId: " message-42 ",
      kind: "email",
      title: "  Client approval  ",
      summary: "  Client confirmed delivery Friday.  ",
      content: "Original email body with the exact waiting reason.",
      observedAt: "2026-08-21T09:00:00.000Z",
      contentHash: "abc123",
    });

    expect(evidence).toMatchObject({
      sourceId: "message-42",
      title: "Client approval",
      summary: "Client confirmed delivery Friday.",
      content: "Original email body with the exact waiting reason.",
    });
    expect(buildEvidenceNaturalKey(evidence)).toBe("gmail:message-42:abc123");
  });

  it("marks a worker assertion that conflicts with source evidence for verification", () => {
    expect(resolveEvidenceConflict({
      sourceTruth: "source_record",
      sourceObservedAt: "2026-08-21T09:00:00.000Z",
      assertedTruth: "worker_assertion",
      assertedAt: "2026-08-21T10:00:00.000Z",
      contradictsSource: true,
    })).toEqual({
      status: "needs_verification",
      winner: "source_record",
      requiresFollowUp: true,
    });
  });

  it("uses corroboration, freshness, consistency and verified outcomes without inflating confidence", () => {
    expect(calculateEvidenceConfidence({
      coverage: 1,
      corroboration: 1,
      freshness: 1,
      consistency: 1,
      verifiedOutcomeRate: 1,
      sampleSize: 20,
    })).toEqual({ score: 99, band: "high", ceiling: 99 });

    expect(calculateEvidenceConfidence({
      coverage: 0.4,
      corroboration: 0,
      freshness: 0.8,
      consistency: 0.5,
      verifiedOutcomeRate: 0,
      sampleSize: 0,
    })).toMatchObject({ band: "low", ceiling: 74 });
  });
});
