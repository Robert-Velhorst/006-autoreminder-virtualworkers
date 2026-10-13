export const APTLSS_EVIDENCE_ENGINE_VERSION = "1.0.0";

export type EvidenceSource = "gmail" | "google_drive" | "trello" | "communication";
export type EvidenceTruth = "source_record" | "worker_assertion" | "system_inference";

export type EvidenceDraft = {
  source: EvidenceSource;
  sourceId: string;
  kind: string;
  title: string;
  summary?: string | null;
  content?: string | null;
  observedAt: string;
  contentHash: string;
  sourceUrl?: string | null;
  sourceContainerId?: string | null;
  modifiedAt?: string | null;
  metadataJson?: string | null;
};

export type EvidenceConflictInput = {
  sourceTruth: EvidenceTruth;
  sourceObservedAt: string;
  assertedTruth: EvidenceTruth;
  assertedAt: string;
  contradictsSource: boolean;
};

export type EvidenceConfidenceInput = {
  coverage: number;
  corroboration: number;
  freshness: number;
  consistency: number;
  verifiedOutcomeRate: number;
  sampleSize: number;
};

function trimRequired(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function trimOptional(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function clampUnit(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function normalizeEvidenceDraft(input: EvidenceDraft): EvidenceDraft {
  const observedAt = new Date(input.observedAt);
  if (Number.isNaN(observedAt.valueOf())) throw new Error("observedAt must be a valid timestamp");

  return {
    ...input,
    sourceId: trimRequired(input.sourceId, "sourceId"),
    kind: trimRequired(input.kind, "kind"),
    title: trimRequired(input.title, "title"),
    summary: trimOptional(input.summary),
    content: trimOptional(input.content),
    observedAt: observedAt.toISOString(),
    contentHash: trimRequired(input.contentHash, "contentHash"),
    sourceUrl: trimOptional(input.sourceUrl),
    sourceContainerId: trimOptional(input.sourceContainerId),
    modifiedAt: input.modifiedAt ? new Date(input.modifiedAt).toISOString() : null,
    metadataJson: trimOptional(input.metadataJson),
  };
}

export function buildEvidenceNaturalKey(input: EvidenceDraft) {
  return `${input.source}:${input.sourceId}:${input.contentHash}`;
}

export function resolveEvidenceConflict(input: EvidenceConflictInput) {
  if (!input.contradictsSource) {
    return { status: "consistent" as const, winner: input.assertedTruth, requiresFollowUp: false };
  }

  // Source records remain authoritative; an operator can explain a discrepancy but cannot erase it.
  return {
    status: "needs_verification" as const,
    winner: input.sourceTruth,
    requiresFollowUp: true,
  };
}

export function calculateEvidenceConfidence(input: EvidenceConfidenceInput) {
  const coverage = clampUnit(input.coverage);
  const corroboration = clampUnit(input.corroboration);
  const freshness = clampUnit(input.freshness);
  const consistency = clampUnit(input.consistency);
  const outcomeRate = clampUnit(input.verifiedOutcomeRate);
  const sampleSize = Math.max(0, Math.floor(input.sampleSize));

  const weighted = (
    coverage * 0.32
    + corroboration * 0.2
    + freshness * 0.18
    + consistency * 0.2
    + outcomeRate * 0.1
  );
  const ceiling = sampleSize >= 12 && corroboration >= 0.75
    ? 99
    : sampleSize >= 4 && corroboration >= 0.5
      ? 92
      : 74;
  const score = Math.min(ceiling, Math.max(1, Math.round(weighted * 100)));
  const band = score >= 90 ? "high" : score >= 70 ? "medium" : "low";
  return { score, band, ceiling };
}
