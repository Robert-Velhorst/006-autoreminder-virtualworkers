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
  return !!card.waitingReason || /ON[\s_-]?HOLD|WAIT|BLOCK/i.test(card.listName) || /^(waiting|blocked)$/i.test(card.actionability ?? "");
}

export function selectManagerPrimary<
  TAction extends Pick<ManagerAction, "cardId" | "blocked">,
  TIntervention extends Pick<ManagerIntervention, "cardId" | "severity"> & Partial<Pick<ManagerIntervention, "issueKind">>,
>(snapshot: { actions: TAction[]; interventions: TIntervention[] } | null | undefined) {
  const intervention = snapshot?.interventions.find(item => item.severity === "urgent")
    ?? snapshot?.interventions.find(item => item.issueKind === "completion_report_pending")
    ?? snapshot?.interventions[0];
  const action = snapshot?.actions.find(item => !item.blocked);
  return intervention
    ? { cardId: intervention.cardId, kind: "verification" as const, intervention, action: null }
    : action
      ? { cardId: action.cardId, kind: "action" as const, intervention: null, action }
      : null;
}

export function orderWorkerCards<T extends QueueCard>(cards: readonly T[], now: Date | string | number): T[] {
  return [...cards].sort((left, right) => compareManagerWork(
    { id: left.cardId, state: left.primaryState ?? "", list: left.listName, dueAt: left.dueAt ?? null, overdue: !!left.overdue, priority: left.priorityScore },
    { id: right.cardId, state: right.primaryState ?? "", list: right.listName, dueAt: right.dueAt ?? null, overdue: !!right.overdue, priority: right.priorityScore },
    now,
  ));
}

export function selectTodayQueue<T extends QueueCard>(cards: readonly T[], managerCardId: string | null) {
  const secondary = managerCardId ? cards.filter(card => card.cardId !== managerCardId) : [...cards];
  const first = managerCardId
    ? secondary.find(card => !workerCardIsWaiting(card))
    : secondary[0];
  return { related: cards.find(card => card.cardId === managerCardId) ?? null, first: first ?? null, next: secondary.filter(card => card.cardId !== first?.cardId).slice(0, 3) };
}
