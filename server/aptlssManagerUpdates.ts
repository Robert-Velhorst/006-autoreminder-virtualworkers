import type { ManagerEvidence } from "../shared/aptlssManager";

export const managerWorkerOutcomes = ["Update", "Action needed", "No action needed", "Cannot access source", "Need Robert's decision"] as const;
export type ManagerWorkerOutcome = (typeof managerWorkerOutcomes)[number];

export type ManagerUpdateFields = {
  outcome?: ManagerWorkerOutcome;
  deadlineDate?: string | null;
  sourceEvidenceId?: string | null;
  sourceDescription?: string | null;
};

export function normalizeManagerUpdateFields(fields: ManagerUpdateFields = {}) {
  const outcome = fields.outcome ?? "Update";
  if (!managerWorkerOutcomes.includes(outcome)) throw new Error("Choose a valid result.");
  const deadlineDate = fields.deadlineDate?.trim() || null;
  if (deadlineDate) {
    const date = new Date(`${deadlineDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadlineDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== deadlineDate) {
      throw new Error("Enter a valid calendar date for the stated deadline.");
    }
  }
  const sourceEvidenceId = fields.sourceEvidenceId?.trim() || null;
  const sourceDescription = fields.sourceDescription?.trim() || null;
  if (sourceEvidenceId && sourceEvidenceId.length > 256) throw new Error("The selected source reference is too long.");
  if (sourceDescription && sourceDescription.length > 512) throw new Error("The source description is too long.");
  return { outcome, deadlineDate, sourceEvidenceId, sourceDescription };
}

export function assertManagerUpdateSource(evidence: ManagerEvidence[], cardId: string, sourceEvidenceId: string | null) {
  if (sourceEvidenceId && !evidence.some(item => item.id === sourceEvidenceId && item.cardId === cardId && item.kind === "source")) {
    throw new Error("The selected source is not linked to this task. Refresh and choose a current source.");
  }
}

export function managerUpdateEvidenceText(detail: string, input: ManagerUpdateFields) {
  const fields = normalizeManagerUpdateFields(input);
  const lines = [detail];
  if (fields.outcome !== "Update") lines.push(`Worker-reported result: ${fields.outcome}`);
  if (fields.deadlineDate) lines.push(`Worker-reported deadline date: ${fields.deadlineDate}`);
  if (fields.sourceEvidenceId) lines.push(`Worker-cited source: ${fields.sourceEvidenceId}`);
  if (fields.sourceDescription) lines.push(`Worker-described source: ${fields.sourceDescription}`);
  return lines.join("\n");
}
