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

const knownMetadataTruthClasses = new Set([
  "source_record",
  "worker_assertion",
  "worker_report",
  "system_inference",
  "model_proposal",
  "human_decision",
  "unknown",
]);

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
  const metadata = safeMetadata(input.metadataJson);
  const kind = typeof input.kind === "string" ? input.kind.trim().toLowerCase() : "";
  if (!kind) return null;
  const rawMetadataTruthClass = metadata?.truthClass;
  const metadataTruthClass = typeof rawMetadataTruthClass === "string"
    ? rawMetadataTruthClass.trim().toLowerCase()
    : null;
  const truthClass = typeof input.truthClass === "string" ? input.truthClass.trim().toLowerCase() : input.truthClass;
  if (truthClass !== undefined && truthClass !== null
    && truthClass !== "source_record" && truthClass !== "worker_assertion" && truthClass !== "system_inference") return null;
  if ((rawMetadataTruthClass !== undefined && typeof rawMetadataTruthClass !== "string")
    || (metadataTruthClass !== null && !knownMetadataTruthClasses.has(metadataTruthClass))) return null;
  if (truthClass === "system_inference"
    || kind === "system_inference"
    || kind === "model_proposal"
    || metadataTruthClass === "system_inference"
    || metadataTruthClass === "model_proposal"
    || metadataTruthClass === "unknown") return null;

  const workerAssertion = truthClass === "worker_assertion"
    || kind === "worker_assertion"
    || kind === "worker_update"
    || metadataTruthClass === "worker_assertion"
    || metadataTruthClass === "worker_report";
  const reviewedResolution = kind === "verified_conflict_resolution"
    || kind === "human_decision"
    || metadataTruthClass === "human_decision";
  if (workerAssertion && reviewedResolution) return null;

  const sourceRecord = truthClass === "source_record" || metadataTruthClass === "source_record";
  const role: WorkerCaseEvidenceRole = workerAssertion
    ? "worker_update"
    : reviewedResolution
      ? "reviewed_resolution"
      : input.roleOverride === "source_preview" || input.roleOverride === "linked_source"
        ? input.roleOverride
        : input.proofEvidenceId !== undefined && !sourceRecord
          ? "linked_source"
          : "source";
  const content = input.content?.trim() || null;
  const summaryOnlyDrivePlaceholder = input.source === "google_drive"
    && content === "Google Drive file metadata collected for cross-source work verification.";
  const contentScope = safeContentScope(metadata);
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

function safeMetadata(metadataJson: string | null | undefined): Record<string, unknown> | null {
  if (!metadataJson) return null;
  try {
    const value: unknown = JSON.parse(metadataJson);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeContentScope(metadata: Record<string, unknown> | null) {
  const scope = metadata?.contentScope;
  return scope === "portal_notice" || scope === "message_preview" ? scope : null;
}
