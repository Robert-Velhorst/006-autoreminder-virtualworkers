import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ManagerCoach from "../client/src/components/ManagerCoach";
import { ManagerVerificationDetails } from "../client/src/components/ManagerVerificationDetails";
import ManagerVerificationFollowups from "../client/src/components/ManagerVerificationFollowups";
import type { ManagerIntervention } from "../shared/aptlssManager";
import { trpc } from "../client/src/lib/trpc";

const previousReact = (globalThis as any).React;
beforeAll(() => Object.assign(globalThis, { React }));
afterAll(() => {
  if (previousReact === undefined) delete (globalThis as any).React;
  else Object.assign(globalThis, { React: previousReact });
});

const mocks = vi.hoisted(() => {
  const invalidate = () => undefined;
  return {
    managerStatus: {} as any,
    queue: {} as any,
    evidence: {} as any,
    followups: {} as any,
    mutation: { isPending: false, mutate: () => undefined } as any,
    resolveMutation: { isPending: false, mutate: () => undefined, error: null as Error | null } as any,
    utils: { operator: {
      getManagerStatus: { invalidate }, getDailyPlan: { invalidate }, getWorkQueueContext: { invalidate },
      getVerificationFollowups: { invalidate }, getCardEvidence: { invalidate },
    } },
  };
});

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => mocks.utils,
    operator: {
      getManagerStatus: { useQuery: () => mocks.managerStatus },
      getWorkQueueContext: { useQuery: () => mocks.queue },
      getCardEvidence: { useQuery: vi.fn(() => mocks.evidence) },
      getVerificationFollowups: { useQuery: vi.fn(() => mocks.followups) },
      runManager: { useMutation: () => mocks.mutation },
      submitManagerUpdate: { useMutation: () => mocks.mutation },
      reportManagerActionCompletion: { useMutation: () => mocks.mutation },
      resolveVerificationFollowup: { useMutation: () => mocks.resolveMutation },
    },
  },
}));

vi.mock("@/hooks/useWebSocket", () => ({ useWebSocket: () => ({ status: { connected: false } }) }));
vi.mock("sonner", () => ({ toast: { error: () => undefined, success: () => undefined, info: () => undefined } }));

const card = { id: "card-1", name: "Prepare the client case file", url: "https://trello.com/c/example", board: "Client work", list: "Doing" };
const sentinel = "RAW_MODEL_CHAIN_OF_THOUGHT_SENTINEL";

function setManagerStatus(snapshot: any) {
  mocks.managerStatus = {
    data: { snapshot, policy: { enabled: true, mode: "shadow", intervalMinutes: 5 }, checkedAt: null, lastSuccessfulAt: null },
    error: null, isFetching: false, isLoading: false,
  };
  mocks.queue = { data: { cards: [] }, error: null, isLoading: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.managerStatus = {};
  mocks.queue = {};
  mocks.evidence = {};
  mocks.followups = {};
  mocks.mutation = { isPending: false, mutate: () => undefined };
  mocks.resolveMutation = { isPending: false, mutate: () => undefined, error: null };
});

describe("worker-facing APTLSS presentation", () => {
  it("renders actionable fixed guidance without model assessment text or provider diagnostics", () => {
    setManagerStatus({
      executionReady: true,
      cards: [card],
      actions: [],
      interventions: [{
        id: "issue-1", cardId: card.id, issueKind: "conflicting_claims", severity: "urgent",
        title: `${sentinel}: internal title`, explanation: `${sentinel}: private analysis`,
        question: `${sentinel}: hidden reasoning`, safeAction: `${sentinel}: provider response`, evidenceIds: ["evidence-1"],
        verification: {
          issues: [{ id: "issue-2", severity: "urgent", title: sentinel, question: sentinel, explanation: sentinel, evidenceIds: ["evidence-1"] }],
          passages: [], comparisons: [],
        },
      }],
      evidence: [{ id: "evidence-1", cardId: card.id, kind: "source", source: "gmail", text: "The cited records show different payment statuses.", observedAt: "2026-09-25T10:00:00.000Z", url: "https://mail.google.com/mail/u/0/#all/example" }],
      applied: false,
      semanticReview: { provider: "codex-subscription", attempts: [{ outcome: "invalid_output", reason: "validation" }], rawAssessment: sentinel },
    });

    const html = renderToStaticMarkup(React.createElement(ManagerCoach));
    expect(html).not.toContain(sentinel);
    expect(html).not.toContain("codex-subscription");
    expect(html).toContain("Compare the cited sources");
    expect(html).toContain("Which source is authoritative, and from what date does that information apply?");
    expect(html).toContain("Compare the cited sources and record which information applies and from when.");
    expect(html).toContain("Open original source");
  });

  it("uses source-check guidance for a legacy intervention without an issue type", () => {
    setManagerStatus({
      executionReady: true,
      cards: [card],
      actions: [],
      interventions: [{
        id: "legacy-issue", cardId: card.id, severity: "urgent",
        title: `${sentinel}: internal title`, explanation: `${sentinel}: private analysis`,
        question: `${sentinel}: hidden reasoning`, safeAction: `${sentinel}: provider response`, evidenceIds: ["evidence-1"],
      }],
      evidence: [{ id: "evidence-1", cardId: card.id, kind: "source", source: "gmail", text: "Inbox preview", observedAt: "2026-09-25T10:00:00.000Z", url: "https://mail.google.com/mail/u/0/#all/example" }],
      applied: false,
    });

    const html = renderToStaticMarkup(React.createElement(ManagerCoach));
    expect(html).toContain("Read the full correspondence");
    expect(html).toContain("What does the message ask you to do, and does it include a deadline?");
    expect(html).not.toContain("Check the linked work record");
    expect(html).not.toContain(sentinel);
  });

  it("uses a task-based next instruction instead of raw model action fields", () => {
    setManagerStatus({
      executionReady: true, cards: [card], interventions: [], applied: false,
      actions: [{
        id: "action-1", cardId: card.id, kind: "work", title: `${sentinel}: private analysis`,
        reason: `${sentinel}: private rationale`, where: `${sentinel}: model route`, blocked: false,
        stepIds: [1], minutes: { low: 10, likely: 20, high: 30 }, completionCriteria: `${sentinel}: hidden payload`,
      }],
      evidence: [],
    });

    const html = renderToStaticMarkup(React.createElement(ManagerCoach));
    expect(html).not.toContain(sentinel);
    expect(html).toContain(card.name);
    expect(html).toContain("Continue the recorded work step");
    expect(html).toContain("Open the linked task, complete its next recorded step, and report what the task record shows.");
    expect(html).toContain("Estimated 10-30 min");
  });

  it("hides internal issue text in worker evidence details while keeping cited passages", () => {
    const intervention = {
      id: "issue-1", cardId: card.id, severity: "urgent", title: "Worker-facing title", explanation: "Worker-facing explanation",
      question: "Worker-facing question", safeAction: "Worker-facing action", evidenceIds: ["evidence-1"],
      verification: {
        issues: [{ id: "issue-2", severity: "urgent", title: sentinel, question: sentinel, explanation: sentinel, evidenceIds: [] }],
        passages: [{ evidenceId: "evidence-1", source: "gmail", kind: "source", quote: "The source says the deadline is Friday.", sender: "Office", sourceDate: "2026-09-25T10:00:00.000Z", sourceRevision: "revision-1", observedAt: "2026-09-25T10:00:00.000Z", effectiveFrom: null }],
        comparisons: [],
      },
    } as unknown as ManagerIntervention;

    const workerHtml = renderToStaticMarkup(React.createElement(ManagerVerificationDetails, { intervention, workerFacing: true }));
    expect(workerHtml).not.toContain(sentinel);
    expect(workerHtml).not.toContain("Other questions to resolve");
    expect(workerHtml).toContain("The source says the deadline is Friday.");

    const founderHtml = renderToStaticMarkup(React.createElement(ManagerVerificationDetails, { intervention }));
    expect(founderHtml).toContain(sentinel);
  });

  it("replaces raw verification failure details with a worker-safe recovery instruction", () => {
    setManagerStatus(null);
    mocks.evidence = { data: [], error: null, isLoading: false, isFetching: false, refetch: () => undefined };
    mocks.followups = { data: [{ id: 7, conflictId: null, title: "Review this follow-up", question: "Which original record confirms the current status?" }], error: null, isLoading: false };
    mocks.resolveMutation = { isPending: false, mutate: () => undefined, error: new Error(`${sentinel}: database/provider stack`) };

    const html = renderToStaticMarkup(React.createElement(ManagerVerificationFollowups, { cardId: card.id }));
    expect(html).not.toContain(sentinel);
    expect(html).not.toContain("database/provider stack");
    expect(html).toContain("save this update. Your note is still here.");
    expect(html).toContain("Try again, or contact your supervisor if the problem continues.");
    expect(html).toContain("Which original record confirms the current status?");
    expect(html).toContain("What did you find?");
  });

  it("does not mount pilot-only queries or cached content for a non-pilot worker", () => {
    setManagerStatus(null);
    mocks.managerStatus.error = { message: "Manager pilot requires an explicitly allowlisted worker, valid APTLSS_MANAGER_PILOT_WORKER_IDS, and APTLSS_MANAGER_SHADOW_ONLY=true.", data: { code: "FORBIDDEN" } };
    mocks.evidence = { data: [{ title: sentinel }] };
    const html = renderToStaticMarkup(React.createElement(ManagerVerificationFollowups, { cardId: card.id }));
    expect(html).toBe("");
    expect(trpc.operator.getCardEvidence.useQuery).not.toHaveBeenCalled();
    expect(trpc.operator.getVerificationFollowups.useQuery).not.toHaveBeenCalled();
  });

  it("waits for availability before mounting pilot-only queries", () => {
    const html = renderToStaticMarkup(React.createElement(ManagerVerificationFollowups, { cardId: card.id }));
    expect(html).toContain("Checking task follow-up availability");
    expect(trpc.operator.getCardEvidence.useQuery).not.toHaveBeenCalled();
    expect(trpc.operator.getVerificationFollowups.useQuery).not.toHaveBeenCalled();
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "INTERNAL_SERVER_ERROR"])("does not hide unrelated %s failures", code => {
    setManagerStatus(null);
    mocks.managerStatus.error = { message: sentinel, data: { code } };
    const html = renderToStaticMarkup(React.createElement(ManagerVerificationFollowups, { cardId: card.id }));
    expect(html).toContain("Task follow-up status could not be loaded");
    expect(html).not.toContain(sentinel);
    expect(trpc.operator.getCardEvidence.useQuery).not.toHaveBeenCalled();
  });

  it("handles pilot revocation between status and follow-up reads without a retry instruction", () => {
    setManagerStatus(null);
    mocks.evidence = { data: [], error: { message: "Manager pilot requires an explicitly allowlisted worker, valid APTLSS_MANAGER_PILOT_WORKER_IDS, and APTLSS_MANAGER_SHADOW_ONLY=true.", data: { code: "FORBIDDEN" } } };
    mocks.followups = { data: [] };
    expect(renderToStaticMarkup(React.createElement(ManagerVerificationFollowups, { cardId: card.id }))).toBe("");
  });
});
