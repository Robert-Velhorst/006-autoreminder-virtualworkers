import { describe, expect, it } from "vitest";
import type { ManagerSnapshot } from "../shared/aptlssManager";
import { orderWorkerCards, selectManagerPrimary, selectTodayQueue, workerCardIsWaiting } from "../shared/workerTodayGuidance";

const card = (cardId: string, listName: string, options: { dueAt?: string; waiting?: boolean; score?: number } = {}) => ({
  cardId,
  listName,
  primaryState: listName,
  dueAt: options.dueAt ?? null,
  overdue: false,
  priorityScore: options.score ?? 0,
  waitingReason: options.waiting ? { reason: "Waiting" } : null,
});

describe("worker today guidance", () => {
  it("uses the manager's urgent verification before any ordinary action", () => {
    const snapshot = {
      interventions: [
        { id: "ordinary", cardId: "ordinary", severity: "attention" },
        { id: "urgent", cardId: "urgent", severity: "urgent" },
      ],
      actions: [{ id: "work", cardId: "work", blocked: false }],
    } as ManagerSnapshot;
    expect(selectManagerPrimary(snapshot)).toMatchObject({ cardId: "urgent", kind: "verification" });
  });

  it("surfaces a pending completion report before ordinary attention items but not urgent conflicts", () => {
    const snapshot = {
      interventions: [
        { id: "ordinary", cardId: "ordinary", severity: "attention", issueKind: "source_check" },
        { id: "completion", cardId: "reported", severity: "attention", issueKind: "completion_report_pending" },
      ],
      actions: [{ id: "work", cardId: "work", blocked: false }],
    } as ManagerSnapshot;
    expect(selectManagerPrimary(snapshot)).toMatchObject({ cardId: "reported", kind: "verification" });
    snapshot.interventions.unshift({ id: "urgent", cardId: "urgent", severity: "urgent", issueKind: "conflicting_claims" });
    expect(selectManagerPrimary(snapshot)).toMatchObject({ cardId: "urgent", kind: "verification" });
  });

  it("applies the manager's deadline and lane ordering to the worker queue", () => {
    const cards = [
      card("doing", "DOING", { score: 90 }),
      card("hold", "ON-HOLD", { score: 20 }),
      card("deadline", "TO-DO", { dueAt: "2026-09-23T12:00:00Z" }),
    ];
    expect(orderWorkerCards(cards, "2026-09-23T08:00:00Z").map(item => item.cardId)).toEqual(["deadline", "hold", "doing"]);
    expect(cards[0].cardId).toBe("doing");
  });

  it("never repeats the manager's task as a second primary task", () => {
    const cards = [card("manager", "ON-HOLD", { waiting: true }), card("other-hold", "ON-HOLD", { waiting: true }), card("doing", "DOING")];
    const selection = selectTodayQueue(cards, "manager");
    expect(selection.related?.cardId).toBe("manager");
    expect(selection.first?.cardId).toBe("doing");
    expect(selection.next.map(item => item.cardId)).toEqual(["other-hold"]);
  });

  it("does not call another waiting task ready to continue", () => {
    const selection = selectTodayQueue([card("manager", "DOING"), card("waiting", "ON-HOLD", { waiting: true })], "manager");
    expect(selection.first).toBeNull();
    expect(selection.next.map(item => item.cardId)).toEqual(["waiting"]);
  });

  it("treats assessment-blocked work as waiting even when its Trello lane is Doing", () => {
    const blocked = { ...card("blocked", "DOING"), actionability: "blocked" };
    expect(workerCardIsWaiting(blocked)).toBe(true);
    expect(selectTodayQueue([card("manager", "DOING"), blocked], "manager").first).toBeNull();
  });
});
