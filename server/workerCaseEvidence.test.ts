import { describe, expect, it } from "vitest";
import { projectWorkerCaseEvidence } from "./workerCaseEvidence";

const observedAt = new Date("2026-09-25T10:00:00.000Z");

describe("worker case evidence projection", () => {
  it("returns an allowlisted source record without internal metadata", () => {
    const projected = projectWorkerCaseEvidence({
      id: 12,
      source: "gmail",
      kind: "email",
      title: "Original message",
      content: "The deadline is Friday.",
      summary: "Email preview",
      sourceUrl: "https://mail.google.com/mail/u/0/#all/thread-12",
      observedAt,
      modifiedAt: null,
      truthClass: "source_record",
      metadataJson: JSON.stringify({ internalReasoning: "PRIVATE_AI_THOUGHT_SENTINEL" }),
      contentHash: "PRIVATE_HASH_SENTINEL",
      linkMethod: "automatic",
      matchReason: "PRIVATE_MATCH_REASON_SENTINEL",
    });

    expect(projected).toEqual({
      id: "evidence:12",
      evidenceId: 12,
      source: "gmail",
      role: "source",
      title: "Original message",
      content: "The deadline is Friday.",
      sourceUrl: "https://mail.google.com/mail/u/0/#all/thread-12",
      observedAt,
      modifiedAt: null,
      contentNote: null,
      statusLabel: null,
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_");
  });

  it("keeps worker reports distinct from source records", () => {
    expect(projectWorkerCaseEvidence({
      id: 13,
      source: "communication",
      kind: "worker_assertion",
      title: "Worker update",
      content: "I checked the case portal.",
      summary: null,
      sourceUrl: null,
      observedAt,
      modifiedAt: null,
      truthClass: "worker_assertion",
    })).toMatchObject({ id: "evidence:13", evidenceId: null, role: "worker_update", content: "I checked the case portal." });
  });

  it("does not display summaries that may contain generated text", () => {
    expect(projectWorkerCaseEvidence({
      id: 18,
      source: "gmail",
      kind: "email",
      title: "Original message",
      content: null,
      summary: "PRIVATE_AI_SUMMARY_SENTINEL",
      sourceUrl: null,
      observedAt,
      modifiedAt: null,
      truthClass: "source_record",
    })).toMatchObject({ content: null });
    expect(JSON.stringify(projectWorkerCaseEvidence({
      id: 18,
      source: "gmail",
      kind: "email",
      title: "Original message",
      content: null,
      summary: "PRIVATE_AI_SUMMARY_SENTINEL",
      sourceUrl: null,
      observedAt,
      modifiedAt: null,
      truthClass: "source_record",
    }))).not.toContain("PRIVATE_AI_SUMMARY_SENTINEL");
  });

  it("labels source previews without exposing their internal scope metadata", () => {
    const projected = projectWorkerCaseEvidence({
      id: 19,
      recordKey: "mail:19",
      proofEvidenceId: null,
      source: "gmail",
      kind: "email_preview",
      title: "A message is ready in your portal",
      content: "Open the portal to read the message.",
      summary: null,
      sourceUrl: "https://mail.google.com/mail/u/0/#all/thread-19",
      observedAt,
      modifiedAt: null,
      roleOverride: "source_preview",
      statusLabel: "Pending review",
      metadataJson: JSON.stringify({ contentScope: "portal_notice", aiReasoning: "PRIVATE" }),
    });
    expect(projected).toMatchObject({
      id: "mail:19",
      evidenceId: null,
      role: "source_preview",
      contentNote: "Portal notice only; open the email to read the underlying correspondence.",
      statusLabel: "Pending review",
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE");
  });

  it("excludes model-generated evidence even if its kind resembles a source", () => {
    expect(projectWorkerCaseEvidence({
      id: 14,
      source: "communication",
      kind: "record",
      title: "PRIVATE_AI_THOUGHT_SENTINEL",
      content: "PRIVATE_AI_THOUGHT_SENTINEL",
      summary: null,
      sourceUrl: null,
      observedAt,
      modifiedAt: null,
      truthClass: "system_inference",
      metadataJson: "PRIVATE_AI_THOUGHT_SENTINEL",
    })).toBeNull();
  });

  it("fails closed for legacy rows explicitly marked as system inference", () => {
    expect(projectWorkerCaseEvidence({
      id: 15,
      source: "communication",
      kind: "system_inference",
      title: "Internal assessment",
      content: "Do not show this to the worker.",
      summary: null,
      sourceUrl: null,
      observedAt,
      modifiedAt: null,
      truthClass: null,
    })).toBeNull();
  });

  it("labels recorded resolutions separately so they cannot be used as source proof", () => {
    expect(projectWorkerCaseEvidence({
      id: 16,
      source: "communication",
      kind: "verified_conflict_resolution",
      title: "Verified resolution",
      content: "The founder reviewed this discrepancy.",
      summary: null,
      sourceUrl: null,
      observedAt,
      modifiedAt: null,
      truthClass: "source_record",
    })).toMatchObject({ role: "reviewed_resolution" });
  });

  it("rejects non-web source links", () => {
    expect(projectWorkerCaseEvidence({
      id: 17,
      source: "gmail",
      kind: "email",
      title: "Message",
      content: "Saved preview",
      summary: null,
      sourceUrl: "javascript:alert(1)",
      observedAt,
      modifiedAt: null,
      truthClass: "source_record",
    })).toMatchObject({ content: "Saved preview", sourceUrl: null });
  });
});
