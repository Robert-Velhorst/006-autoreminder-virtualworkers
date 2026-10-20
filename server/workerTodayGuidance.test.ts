import { describe, expect, it } from "vitest";
import type { ManagerSnapshot } from "../shared/aptlssManager";
import { orderWorkerCards, selectManagerActionForCard, selectManagerPrimary, selectTodayQueue, workerCardIsWaiting } from "../shared/workerTodayGuidance";

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

  it("replaces an unknown dependency reference with a clear blocked reason and worker action", () => {
    const snapshot = {
      interventions: [{
        id: "missing-dependency",
        cardId: "case",
        issueKind: "missing_dependency",
        severity: "urgent",
        title: "Missing dependency",
        explanation: "Dependency missing:2 is not available.",
        question: "What evidence or prior step satisfies this dependency?",
        safeAction: "Provide the missing dependency before execution.",
        evidenceIds: [],
      }],
      actions: [{ id: "dependent-action", cardId: "case", title: "Review the file", stepIds: [3], blocked: true }],
    } as unknown as ManagerSnapshot;

    const primary = selectManagerPrimary(snapshot);

    expect(primary?.intervention).toMatchObject({
      title: "Waiting for a required earlier step",
      explanation: "This task depends on an earlier step that is not identified in the current task list.",
      question: "Can you identify the earlier task this depends on, or ask your supervisor to confirm it?",
    });
    expect(primary?.intervention?.safeAction).toMatch(/keep this task on hold/i);
    expect(JSON.stringify(primary?.intervention)).not.toContain("missing:2");
    expect(selectManagerActionForCard(snapshot.actions, "case")?.blocked).toBe(true);
  });

  it("uses a known dependency task title instead of hiding it behind a generic message", () => {
    const snapshot = {
      interventions: [{
        id: "missing-dependency",
        cardId: "case",
        issueKind: "missing_dependency",
        severity: "urgent",
        title: "Missing dependency",
        explanation: "Dependency missing:2 is not available.",
        question: "What evidence or prior step satisfies this dependency?",
        safeAction: "Provide the missing dependency before execution.",
        evidenceIds: [],
      }],
      actions: [
        { id: "dependent-action", cardId: "case", title: "Review the file", stepIds: [3], blocked: true },
        { id: "prerequisite-action", cardId: "other-case", title: "Confirm the case reference", stepIds: [2], blocked: true },
      ],
    } as unknown as ManagerSnapshot;

    const primary = selectManagerPrimary(snapshot);

    expect(primary?.intervention?.title).toContain("Confirm the case reference");
    expect(primary?.intervention?.explanation).toContain("Confirm the case reference");
    expect(primary?.intervention?.safeAction).toContain("Confirm the case reference");
    expect(primary?.intervention?.safeAction).toMatch(/keep this task on hold/i);
    expect(snapshot.actions.find(action => action.id === "dependent-action")?.blocked).toBe(true);
  });

  it("does not guess a dependency title when a numeric reference is ambiguous", () => {
    const snapshot = {
      interventions: [{
        id: "missing-dependency",
        cardId: "case",
        issueKind: "missing_dependency",
        severity: "urgent",
        title: "Missing dependency",
        explanation: "Dependency missing:2 is not available.",
        question: "What evidence or prior step satisfies this dependency?",
        safeAction: "Provide the missing dependency before execution.",
        evidenceIds: [],
      }],
      actions: [
        { id: "dependent-action", cardId: "case", title: "Review the file", stepIds: [3], blocked: true },
        { id: "prerequisite-one", cardId: "case-one", title: "Check the invoice", stepIds: [2], blocked: true },
        { id: "prerequisite-two", cardId: "case-two", title: "Check the contract", stepIds: [2], blocked: true },
      ],
    } as unknown as ManagerSnapshot;

    const primary = selectManagerPrimary(snapshot);

    expect(primary?.intervention?.title).toBe("Waiting for a required earlier step");
    expect(primary?.intervention?.explanation).not.toContain("Check the invoice");
    expect(primary?.intervention?.explanation).not.toContain("Check the contract");
    expect(snapshot.actions.find(action => action.id === "dependent-action")?.blocked).toBe(true);
  });

  it("chooses an executable card action before a blocked checklist prerequisite", () => {
    const actions = [
      { id: "blocked", cardId: "case", title: "Wait for permit", blocked: true },
      { id: "ready", cardId: "case", title: "Review independent records", blocked: false },
      { id: "other", cardId: "other-case", title: "Other action", blocked: false },
    ];
    expect(selectManagerActionForCard(actions, "case")).toMatchObject({ id: "ready" });
    expect(selectManagerActionForCard(actions.slice(0, 1), "case")).toMatchObject({ id: "blocked" });
    expect(selectManagerActionForCard(actions, "missing")).toBeNull();
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

  it("aligns Now with the manager's recommended executable action across two cards", () => {
    const snapshot = {
      interventions: [],
      actions: [{ id: "recommended-action", cardId: "recommended", blocked: false }],
    } as ManagerSnapshot;
    const primary = selectManagerPrimary(snapshot);
    const selection = selectTodayQueue([card("other", "DOING"), card("recommended", "TO-DO")], primary?.cardId ?? null);

    expect(primary?.cardId).toBe("recommended");
    expect(selection.first?.cardId).toBe(primary?.cardId);
    expect(selection.next.map(item => item.cardId)).toEqual(["other"]);
  });

  it("keeps the executable manager card in Now instead of promoting waiting work", () => {
    const selection = selectTodayQueue([card("manager", "DOING"), card("waiting", "ON-HOLD", { waiting: true })], "manager");
    expect(selection.first?.cardId).toBe("manager");
    expect(selection.next.map(item => item.cardId)).toEqual(["waiting"]);
  });

  it("shows a waiting task for context when no executable task is available", () => {
    const selection = selectTodayQueue([card("waiting", "ON-HOLD", { waiting: true })], null);
    expect(selection.first?.cardId).toBe("waiting");
    expect(workerCardIsWaiting(selection.first!)).toBe(true);
  });

  it("treats assessment-blocked work as waiting even when its Trello lane is Doing", () => {
    const blocked = { ...card("blocked", "DOING"), actionability: "blocked" };
    expect(workerCardIsWaiting(blocked)).toBe(true);
    const selection = selectTodayQueue([{ ...card("manager", "DOING"), actionability: "blocked" }, blocked], "manager");
    expect(selection.first).toBeNull();
  });

  it("does not select blocked or completed work as Now when no manager action is available", () => {
    const selection = selectTodayQueue([
      { ...card("blocked-state", "TO-DO"), primaryState: "BLOCKED_BY_OTHER_CARD" },
      card("held", "ON-HOLD"),
      { ...card("finished", "DOING"), primaryState: "DONE_CONFIRMED" },
      card("ready", "DOING"),
    ], null);

    expect(selection.first?.cardId).toBe("ready");
    expect(selection.next.map(item => item.cardId)).toEqual(["blocked-state", "held"]);
    expect(selectTodayQueue([{ ...card("verify-archive", "Done"), primaryState: "NEEDS_ARCHIVE" }], null).first?.cardId).toBe("verify-archive");
  });
});
