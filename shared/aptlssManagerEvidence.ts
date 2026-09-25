import type { ManagerCard } from "./aptlssManager";

export type ManagerTruthClass =
  | "source_record"
  | "worker_report"
  | "human_decision"
  | "model_proposal"
  | "unknown";
export type ManagerEvidenceMetadata = {
  sender?: string | null;
  sourceDate?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  sourceRevision?: string | null;
  sourceRecordId?: string | null;
  contentScope?: "portal_notice" | "message_preview";
  supersedesEvidenceIds?: string[];
  truthClass?: ManagerTruthClass;
  essential?: boolean;
  authority?: "authoritative" | "reported" | "unverified";
  outcome?: string | null;
  deadlineDate?: string | null;
  sourceEvidenceId?: string | null;
};
export type ManagerGraphConflict = {
  id: string;
  cardId: string;
  evidenceIds: string[];
  status?: string;
  severity?: string;
  topic?: string;
  explanation?: string;
};
export type ManagerFact = {
  subject: string;
  topic: string;
  value: string;
  quote: string;
  evidenceId: string;
  cardId: string;
  sender: string | null;
  source: string;
  observedAt: string;
  sourceDate: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourceRevision: string | null;
  truthClass: ManagerTruthClass;
  support: "explicit" | "unverified" | "unknown";
  sourceField?: string;
};
export type ManagerReliability = {
  coverage: "sufficient" | "missing" | "partial";
  freshness: "current" | "stale" | "unknown";
  conflicts: "none_detected" | "unresolved";
  support: "direct" | "reported" | "proposed" | "unknown";
  calibrated: false;
  reasons: string[];
};

export const MANAGER_DAY = 86_400_000;
export function validManagerDate(value: string | null | undefined): boolean {
  if (!value) return false;
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    return false;
  return value.length === 10 || validManagerTimestamp(value);
}
export function validManagerTimestamp(
  value: string | null | undefined
): boolean {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(
      value
    )
  )
    return false;
  // Validate the local calendar date, not the UTC date after applying its offset.
  return (
    validManagerDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value))
  );
}
type WorkOrder = Pick<
  ManagerCard,
  "id" | "state" | "list" | "dueAt" | "overdue" | "priority"
>;
function workRank(card: WorkOrder, now: number) {
  if (
    card.overdue ||
    (validManagerDate(card.dueAt) &&
      Date.parse(card.dueAt!) < now + MANAGER_DAY)
  )
    return 0;
  const state = `${card.state} ${card.list}`.toUpperCase();
  if (/ON[\s_-]?HOLD|WAIT|BLOCK/.test(state)) return 1;
  if (/DOING|PROGRESS/.test(state)) return 2;
  return 3;
}
export function compareManagerWork(
  a: WorkOrder,
  b: WorkOrder,
  now: Date | string | number
): number {
  const time =
    now instanceof Date
      ? now.getTime()
      : typeof now === "string"
        ? Date.parse(now)
        : now;
  const due = (c: WorkOrder) =>
    validManagerDate(c.dueAt) ? Date.parse(c.dueAt!) : Number.MAX_SAFE_INTEGER;
  return (
    workRank(a, time) - workRank(b, time) ||
    due(a) - due(b) ||
    (Number.isFinite(b.priority) ? b.priority : 0) -
      (Number.isFinite(a.priority) ? a.priority : 0) ||
    a.id.localeCompare(b.id)
  );
}
