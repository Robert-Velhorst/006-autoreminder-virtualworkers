import type { ManagerAction, ManagerIntervention } from "./aptlssManager";
import { compareManagerWork } from "./aptlssManagerEvidence";

type QueueCard = {
  cardId: string;
  listName: string;
  primaryState: string | null;
  dueAt?: string | null;
  overdue?: boolean;
  priorityScore: number;
  actionability?: string | null;
  waitingReason: unknown | null;
};

export function workerCardIsWaiting(card: QueueCard) {
  return !!card.waitingReason || /ON[\s_-]?HOLD|WAIT|BLOCK/i.test(`${card.primaryState ?? ""} ${card.listName}`) || /^(waiting|blocked)$/i.test(card.actionability ?? "");
}

type DependencyAction = Pick<ManagerAction, "cardId" | "blocked"> & Partial<Pick<ManagerAction, "id" | "title" | "stepIds">>;
type GuidanceIntervention = Pick<ManagerIntervention, "cardId" | "severity"> & Partial<Pick<ManagerIntervention, "issueKind" | "title" | "explanation" | "question" | "safeAction">>;

function dependencyReference(intervention: GuidanceIntervention) {
  const match = intervention.explanation?.match(/(?:dependency|prerequisite)\s+(.+?)\s+is not available\.?$/i);
  const explanationReference = match?.[1]?.trim().replace(/^["'“]|["'”]$/g, "");
  if (explanationReference) return explanationReference;

  const titleMatch = intervention.title?.match(/^(?:missing dependency|blocked by prerequisite)\s*[:\-]\s*(.+)$/i);
  return titleMatch?.[1]?.trim().replace(/^["'“]|["'”]$/g, "") ?? null;
}

function isOpaqueDependencyReference(value: string) {
  return /^\d+$/.test(value)
    || /^(?:missing|action|step|card|rejected|cycle|dependency|ref|id|task)[:_#-]/i.test(value)
    || /^(?:step|task|card|dependency)\s+#?\d+$/i.test(value)
    || /^\d+(?::\d+)+$/.test(value)
    || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)
    || /^[0-9a-f]{24,}$/i.test(value);
}

function knownDependencyTitle(reference: string, actions: readonly DependencyAction[]) {
  const byActionId = actions.find(action => action.id === reference)?.title?.trim();
  if (byActionId && !isOpaqueDependencyReference(byActionId)) return byActionId;

  const cardStep = reference.match(/^(.+):(\d+)$/);
  const numericStep = reference.match(/^(?:(?:missing|dependency|step)[:_-])?(\d+)$/i);
  const candidates = cardStep && !/^(?:missing|dependency|step)$/i.test(cardStep[1])
    ? actions.filter(action => action.cardId === cardStep[1] && action.stepIds?.includes(Number(cardStep[2])))
    : numericStep
      ? actions.filter(action => action.stepIds?.includes(Number(numericStep[1])))
      : [];
  if (candidates.length !== 1) return null;
  const title = candidates[0].title?.trim();
  return title && !isOpaqueDependencyReference(title) ? title : null;
}

function workerFacingIntervention<T extends GuidanceIntervention>(intervention: T, actions: readonly DependencyAction[]): T {
  if (intervention.issueKind !== "missing_dependency") return intervention;

  const reference = dependencyReference(intervention);
  const dependencyTitle = reference
    ? isOpaqueDependencyReference(reference)
      ? knownDependencyTitle(reference, actions)
      : reference
    : null;
  if (dependencyTitle) {
    return {
      ...intervention,
      title: `Waiting for: ${dependencyTitle}`,
      explanation: `This task cannot start until "${dependencyTitle}" is available and confirmed complete.`,
      question: `Is "${dependencyTitle}" complete? If not, update that task or ask your supervisor to confirm the prerequisite.`,
      safeAction: `Open "${dependencyTitle}" and confirm its status. Keep this task on hold until the prerequisite is verified; do not mark it complete.`,
    } as T;
  }

  return {
    ...intervention,
    title: "Waiting for a required earlier step",
    explanation: "This task depends on an earlier step that is not identified in the current task list.",
    question: "Can you identify the earlier task this depends on, or ask your supervisor to confirm it?",
    safeAction: "Check the related work item for the prerequisite. If you cannot identify or verify it, keep this task on hold and ask your supervisor.",
  } as T;
}

function workerCardIsComplete(card: QueueCard) {
  const state = card.primaryState?.trim().toUpperCase();
  if (state === "NEEDS_ARCHIVE") return false;
  if (state) return /^(DONE_CONFIRMED|DONE|COMPLETE|COMPLETED|CLOSED|ARCHIVED)$/.test(state);
  return /^(done|complete|completed|closed|archive|archived)$/i.test(card.listName.trim());
}

export function selectManagerPrimary<
  TAction extends DependencyAction,
  TIntervention extends GuidanceIntervention,
>(snapshot: { actions: TAction[]; interventions: TIntervention[] } | null | undefined) {
  const intervention = snapshot?.interventions.find(item => item.severity === "urgent")
    ?? snapshot?.interventions.find(item => item.issueKind === "completion_report_pending")
    ?? snapshot?.interventions[0];
  const action = snapshot?.actions.find(item => !item.blocked);
  return intervention
    ? { cardId: intervention.cardId, kind: "verification" as const, intervention: workerFacingIntervention(intervention, snapshot?.actions ?? []), action: null }
    : action
      ? { cardId: action.cardId, kind: "action" as const, intervention: null, action }
      : null;
}

export function selectManagerActionForCard<
  TAction extends Pick<ManagerAction, "cardId" | "blocked">,
>(actions: readonly TAction[] | null | undefined, cardId: string) {
  const cardActions = actions?.filter(action => action.cardId === cardId) ?? [];
  return cardActions.find(action => !action.blocked) ?? cardActions[0] ?? null;
}

export function orderWorkerCards<T extends QueueCard>(cards: readonly T[], now: Date | string | number): T[] {
  return [...cards].sort((left, right) => compareManagerWork(
    { id: left.cardId, state: left.primaryState ?? "", list: left.listName, dueAt: left.dueAt ?? null, overdue: !!left.overdue, priority: left.priorityScore },
    { id: right.cardId, state: right.primaryState ?? "", list: right.listName, dueAt: right.dueAt ?? null, overdue: !!right.overdue, priority: right.priorityScore },
    now,
  ));
}

export function selectTodayQueue<T extends QueueCard>(cards: readonly T[], managerCardId: string | null) {
  const executionQueue = cards.filter(card => !workerCardIsComplete(card));
  const managerCard = managerCardId ? executionQueue.find(card => card.cardId === managerCardId) : null;
  const managerCardIsReady = !!managerCard && !workerCardIsWaiting(managerCard);
  const secondary = managerCardId ? executionQueue.filter(card => card.cardId !== managerCardId) : executionQueue;
  const first = managerCardIsReady
    ? managerCard
    : secondary.find(card => !workerCardIsWaiting(card))
      ?? secondary.find(card => workerCardIsWaiting(card) && card.actionability !== "blocked");
  return { related: cards.find(card => card.cardId === managerCardId) ?? null, first: first ?? null, next: secondary.filter(card => card.cardId !== first?.cardId).slice(0, 3) };
}
