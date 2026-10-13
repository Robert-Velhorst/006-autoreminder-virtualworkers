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

  it("keeps an unclassified graph-linked record openable without treating it as proof", () => {
    const projected = projectWorkerCaseEvidence({
      id: 27,
      proofEvidenceId: 927,
      source: "gmail",
      kind: "email",
      title: "Unclassified message",
      content: "The message is available for review.",
      summary: null,
      sourceUrl: "https://mail.google.com/mail/u/0/#all/thread-27",
      observedAt,
      modifiedAt: null,
      truthClass: null,
    });

    expect(projected).toMatchObject({
      role: "linked_source",
      evidenceId: null,
      sourceUrl: "https://mail.google.com/mail/u/0/#all/thread-27",
      content: "The message is available for review.",
    });
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

  it("does not let a role override upgrade a worker assertion into source evidence", () => {
    const projected = projectWorkerCaseEvidence({
      id: 20,
      proofEvidenceId: 812,
      source: "communication",
      kind: "worker_assertion",
      title: "Worker update",
      content: "I checked the case portal.",
      summary: null,
      sourceUrl: null,
      observedAt,
      modifiedAt: null,
      truthClass: "worker_assertion",
      roleOverride: "source",
    });

    expect(projected).toMatchObject({ role: "worker_update", evidenceId: null });
  });

  it("keeps metadata-classified worker reports as updates even when the row says source", () => {
    const projected = projectWorkerCaseEvidence({
      id: 24,
      proofEvidenceId: 814,
      source: "communication",
      kind: "record",
      title: "Worker statement",
      content: "The portal showed a new deadline.",
      summary: null,
      sourceUrl: null,
      observedAt,
      modifiedAt: null,
      truthClass: "source_record",
      roleOverride: "source",
      metadataJson: JSON.stringify({ truthClass: "worker_report" }),
    });

    expect(projected).toMatchObject({ role: "worker_update", evidenceId: null });
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

  it("does not let a role override turn an internal inference into source evidence", () => {
    expect(projectWorkerCaseEvidence({
      id: 21,
      proofEvidenceId: 812,
      source: "communication",
      kind: "manager_assessment",
      title: "Internal assessment",
      content: "PRIVATE_INFERENCE_SENTINEL",
      summary: null,
      sourceUrl: null,
      observedAt,
      modifiedAt: null,
      truthClass: "system_inference",
      roleOverride: "source",
    })).toBeNull();
  });

  it.each(["model_proposal", "system_inference", "unknown", " MODEL_PROPOSAL "])(
    "excludes internal or unclassified metadata truth %s before applying role overrides",
    metadataTruthClass => {
      expect(projectWorkerCaseEvidence({
        id: 23,
        proofEvidenceId: 813,
        source: "communication",
        kind: "manager_assessment",
        title: "Internal proposal",
        content: "PRIVATE_PROPOSAL_SENTINEL",
        summary: null,
        sourceUrl: null,
        observedAt,
        modifiedAt: null,
        truthClass: null,
        roleOverride: "source",
        metadataJson: JSON.stringify({ truthClass: metadataTruthClass }),
      })).toBeNull();
    },
  );

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

  it("does not let a role override relabel a reviewed resolution as source proof", () => {
    expect(projectWorkerCaseEvidence({
      id: 25,
      proofEvidenceId: 815,
      source: "communication",
      kind: "verified_conflict_resolution",
      title: "Reviewed resolution",
      content: "The founder reviewed this discrepancy.",
      summary: null,
      sourceUrl: null,
      observedAt,
      modifiedAt: null,
      truthClass: "source_record",
      roleOverride: "source",
    })).toMatchObject({ role: "reviewed_resolution", evidenceId: null });
  });

  it.each([
    "javascript:alert(1)",
    " JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "blob:https://example.test/123",
    "vbscript:msgbox(1)",
  ])("strips unsafe source URL scheme %s", sourceUrl => {
    expect(projectWorkerCaseEvidence({
      id: 17,
      source: "gmail",
      kind: "email",
      title: "Message",
      content: "Saved preview",
      summary: null,
      sourceUrl,
      observedAt,
      modifiedAt: null,
      truthClass: "source_record",
    })).toMatchObject({ content: "Saved preview", sourceUrl: null });
  });

  it("preserves safe HTTP and HTTPS source links", () => {
    for (const sourceUrl of ["http://mail.example.test/message/1", "https://mail.example.test/message/1"]) {
      expect(projectWorkerCaseEvidence({
        id: 26,
        source: "gmail",
        kind: "email",
        title: "Message",
        content: "Saved preview",
        summary: null,
        sourceUrl,
        observedAt,
        modifiedAt: null,
        truthClass: "source_record",
      })?.sourceUrl).toBe(sourceUrl);
    }
  });

});
