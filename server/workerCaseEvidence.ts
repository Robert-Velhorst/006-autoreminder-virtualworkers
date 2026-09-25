import type { EvidenceTruth } from "./aptlssEvidenceGraph";

export type WorkerCaseEvidenceRole = "source" | "source_preview" | "linked_source" | "worker_update" | "reviewed_resolution";

export type WorkerCaseEvidenceInput = {
  id: number;
  recordKey?: string;
  proofEvidenceId?: number | null;
  source: string;
  kind: string;
  title: string;
  content: string | null;
  summary: string | null;
  sourceUrl: string | null;
  observedAt: Date;
  modifiedAt: Date | null;
  truthClass?: EvidenceTruth | null;
  roleOverride?: WorkerCaseEvidenceRole;
  contentNote?: string | null;
  statusLabel?: string | null;
  metadataJson?: string | null;
  contentHash?: string;
  linkMethod?: string;
  matchReason?: string;
};

export type WorkerCaseEvidence = {
  id: string;
  evidenceId: number | null;
  source: string;
  role: WorkerCaseEvidenceRole;
  title: string;
  content: string | null;
  sourceUrl: string | null;
  observedAt: Date;
  modifiedAt: Date | null;
  contentNote: string | null;
  statusLabel: string | null;
};

function safeSourceUrl(value: string | null) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function projectWorkerCaseEvidence(input: WorkerCaseEvidenceInput): WorkerCaseEvidence | null {
  const truthClass = input.truthClass
    ?? (input.kind === "worker_assertion" ? "worker_assertion" : input.kind === "system_inference" ? "system_inference" : "source_record");
  if (truthClass === "system_inference" || input.kind === "system_inference" || input.kind === "model_proposal") return null;

  const role: WorkerCaseEvidenceRole = input.roleOverride ?? (truthClass === "worker_assertion"
    ? "worker_update"
    : input.kind === "verified_conflict_resolution" ? "reviewed_resolution" : "source");
  const content = input.content?.trim() || null;
  const summaryOnlyDrivePlaceholder = input.source === "google_drive"
    && content === "Google Drive file metadata collected for cross-source work verification.";
  const contentScope = input.metadataJson ? safeContentScope(input.metadataJson) : null;
  const contentNote = input.contentNote?.trim()
    || (input.source === "google_drive" ? "File details only; open the Drive file to review its contents."
      : input.source === "gmail" && contentScope === "portal_notice" ? "Portal notice only; open the email to read the underlying correspondence."
        : input.source === "gmail" && contentScope === "message_preview" ? "Email preview only; open the original for the full message."
          : null);

  return {
    id: input.recordKey ?? `evidence:${input.id}`,
    evidenceId: role === "source" ? (input.proofEvidenceId === undefined ? input.id : input.proofEvidenceId) : null,
    source: input.source,
    role,
    title: input.title,
    content: summaryOnlyDrivePlaceholder ? null : content,
    sourceUrl: safeSourceUrl(input.sourceUrl),
    observedAt: input.observedAt,
    modifiedAt: input.modifiedAt,
    contentNote: summaryOnlyDrivePlaceholder ? "File details only; open the Drive file to review its contents." : contentNote,
    statusLabel: input.statusLabel?.trim() || null,
  };
}

function safeContentScope(metadataJson: string) {
  try {
    const value: unknown = JSON.parse(metadataJson);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const scope = (value as Record<string, unknown>).contentScope;
    return scope === "portal_notice" || scope === "message_preview" ? scope : null;
  } catch {
    return null;
  }
}
