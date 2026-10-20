import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";

const io = vi.hoisted(() => ({
  getDb: vi.fn(),
  getActiveWorkerProfileResolution: vi.fn(),
  resolveWorkerOperatorContext: vi.fn(),
  fetchAuthorizedTrelloCard: vi.fn(),
  postCardComment: vi.fn(),
  logAuditAction: vi.fn(),
  setFollowUpDraftStatusForWorker: vi.fn(),
  upsertAptlssPlan: vi.fn(),
  writeChecklistToTrello: vi.fn(),
  upsertAptlssSteps: vi.fn(),
  computeAndSaveCardState: vi.fn(),
  computeAndSavePriorityScore: vi.fn(),
  invokeLLM: vi.fn(),
  upsertFollowUpDraft: vi.fn(),
  getAutopilotLevel: vi.fn(),
  getPolicyValue: vi.fn(),
}));

// Every persistence, Trello, and model boundary reachable from the tested
// mutations is replaced, so caller tests cannot fall through to live I/O.
vi.mock("../db", () => ({ getDb: io.getDb, incrementPayLogD1: vi.fn() }));
vi.mock("../workerOperatorContext", () => ({
  getActiveWorkerProfileResolution: io.getActiveWorkerProfileResolution,
  resolveWorkerOperatorContext: io.resolveWorkerOperatorContext,
}));
vi.mock("../trelloCardAccess", async importOriginal => ({
  ...(await importOriginal<typeof import("../trelloCardAccess")>()),
  fetchAuthorizedTrelloCard: io.fetchAuthorizedTrelloCard,
}));
vi.mock("../services/trello-manus", () => ({
  getWorkerCards: vi.fn(),
  getWorkerRecentActions: vi.fn(),
  getWeeklyHours: vi.fn(),
  getCardsNeedingDueDate: vi.fn(),
  getCardsNeedingDailyUpdate: vi.fn(),
  getOnHoldCards: vi.fn(),
  getWorkerCommentedCardIdsToday: vi.fn(),
  getRegisteredWebhooks: vi.fn(),
  getCardsDueToday: vi.fn(),
  getOverdueCards: vi.fn(),
  getWorkerBoards: vi.fn(),
  postCardComment: io.postCardComment,
  moveCardToDoing: vi.fn(),
  isDoingList: vi.fn(),
}));
vi.mock("../aptlssAuditDb", () => ({
  logAuditAction: io.logAuditAction,
  getCardAuditLog: vi.fn(),
  getRecentAuditLog: vi.fn(),
  countRecentActions: vi.fn(),
  pruneOldAuditLog: vi.fn(),
  recordSyncAttempt: vi.fn(),
  getRecentSyncLog: vi.fn(),
  getLastSuccessfulSync: vi.fn(),
  getSyncStats24h: vi.fn(),
}));
vi.mock("../aptlssDb", () => ({
  upsertAptlssPlan: io.upsertAptlssPlan,
  getAptlssPlan: vi.fn(),
  getAllAptlssPlans: vi.fn(),
}));
vi.mock("../aptlssEngine", () => ({
  computeAndSaveCardState: io.computeAndSaveCardState,
  computeAndSavePriorityScore: io.computeAndSavePriorityScore,
  writeChecklistToTrello: io.writeChecklistToTrello,
}));
vi.mock("../aptlssStepsDb", () => ({
  upsertAptlssSteps: io.upsertAptlssSteps,
  getOpenStepsForCard: vi.fn(),
  getAllFounderDecisionSteps: vi.fn(),
  setStepCompletionForWorker: vi.fn(),
  getCardStepProgress: vi.fn(),
  getCardState: vi.fn(),
  getAllCardStates: vi.fn(),
  getPriorityScore: vi.fn(),
  getAllPriorityScores: vi.fn(),
  getNeedsRepairCards: vi.fn(),
  getReadyForDoneCards: vi.fn(),
}));
vi.mock("../_core/llm", () => ({ invokeLLM: io.invokeLLM }));
vi.mock("../aptlssPoliciesDb", () => ({
  getAllPolicies: vi.fn(),
  upsertFollowUpDraft: io.upsertFollowUpDraft,
  getPolicyByKey: vi.fn(),
  getPolicyValue: io.getPolicyValue,
  upsertPolicy: vi.fn(),
  setPolicyEnabled: vi.fn(),
  getPendingFollowUpDrafts: vi.fn(),
  getAllFollowUpDrafts: vi.fn(),
  setFollowUpDraftStatusForWorker: io.setFollowUpDraftStatusForWorker,
  getAllWorkerPerformance: vi.fn(),
  getLatestWeeklyAnalysis: vi.fn(),
  getRecentWeeklyAnalyses: vi.fn(),
  upsertWorkerPerformance: vi.fn(),
  getAutopilotLevel: io.getAutopilotLevel,
}));
vi.mock("../replyMonitorDb", () => ({
  getPendingReplyThreads: vi.fn(),
  getAllReplyThreads: vi.fn(),
  resolveVagueReplyFlag: vi.fn(),
  getActiveVagueReplyFlags: vi.fn(),
  getAllVagueReplyFlags: vi.fn(),
  getActiveUnsignedFlags: vi.fn(),
  getAllUnsignedFlags: vi.fn(),
  MAX_REPLY_MONITOR_PAGE_SIZE: 100,
  resolveUnsignedFlag: vi.fn(),
  upsertReplyThread: vi.fn(),
  insertVagueReplyFlag: vi.fn(),
  insertUnsignedFlag: vi.fn(),
  markReplyThreadReplied: vi.fn(),
  markReplyThreadDemerited: vi.fn(),
}));
vi.mock("../trelloCardContext", () => ({ fetchCardContext: vi.fn() }));

import { aptlssRouter, trelloRouter } from "./manus-trello-aptlss";

type Actor = NonNullable<TrpcContext["user"]>;

const context = (user: Actor | null) =>
  ({
    req: {},
    res: {},
    user,
  }) as TrpcContext;

const worker: Actor = { id: 41, role: "worker", name: "Aisha Worker" };
const admin: Actor = { id: 7, role: "admin", name: "Robert" };

const expectNoExternalOrPersistentWrites = () => {
  expect(io.fetchAuthorizedTrelloCard).not.toHaveBeenCalled();
  expect(io.postCardComment).not.toHaveBeenCalled();
  expect(io.logAuditAction).not.toHaveBeenCalled();
  expect(io.setFollowUpDraftStatusForWorker).not.toHaveBeenCalled();
  expect(io.upsertAptlssPlan).not.toHaveBeenCalled();
  expect(io.writeChecklistToTrello).not.toHaveBeenCalled();
  expect(io.upsertAptlssSteps).not.toHaveBeenCalled();
  expect(io.computeAndSaveCardState).not.toHaveBeenCalled();
  expect(io.computeAndSavePriorityScore).not.toHaveBeenCalled();
  expect(io.invokeLLM).not.toHaveBeenCalled();
  expect(io.upsertFollowUpDraft).not.toHaveBeenCalled();
  expect(io.getDb).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  io.getActiveWorkerProfileResolution.mockImplementation(
    async (userId: number) => ({
      profileId: userId,
      ambiguous: false,
    })
  );
  io.fetchAuthorizedTrelloCard.mockResolvedValue({
    id: "card-1",
    idMembers: ["member-1"],
  });
  io.postCardComment.mockResolvedValue({
    id: "comment-1",
    date: "2026-09-26T12:00:00.000Z",
  });
  io.logAuditAction.mockResolvedValue(undefined);
  vi.stubEnv("TRELLO_API_KEY", "test-key");
  vi.stubEnv("TRELLO_TOKEN", "test-token");
});

afterEach(() => vi.unstubAllEnvs());

describe("manus-trello-aptlss route safety regressions (mock-only)", () => {
  it("uses the authenticated worker as the actor and audit owner, not caller-supplied identity fields", async () => {
    const caller = trelloRouter.createCaller(context(worker));
    const reviewedText =
      "I checked the source and recorded the next step.\n~ Aisha";
    const forgedInput = {
      cardId: "card-1",
      text: reviewedText,
      vaId: 999,
      workerId: 999,
      workerName: "Impersonated User",
    } as { cardId: string; text: string };

    await expect(caller.postComment(forgedInput)).resolves.toEqual({
      id: "comment-1",
      date: "2026-09-26T12:00:00.000Z",
    });

    expect(io.fetchAuthorizedTrelloCard).toHaveBeenCalledWith(
      worker,
      "card-1",
      {
        fields: "id,idMembers",
      }
    );
    expect(io.postCardComment).toHaveBeenCalledWith(
      "card-1",
      reviewedText,
      "test-key",
      "test-token"
    );
    expect(io.logAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        vaId: worker.id,
        cardId: "card-1",
        source: "manual",
        approved: true,
      })
    );
    expect(io.logAuditAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ vaId: 999 })
    );
  });

  it("requires the authenticated worker's explicit comment confirmation before any Trello or audit write", async () => {
    const caller = trelloRouter.createCaller(context(worker));

    await expect(
      caller.postComment({ cardId: "card-1", text: "Unreviewed draft" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expectNoExternalOrPersistentWrites();
  });

  it("rejects automated follow-up posting for workers and admins without touching I/O", async () => {
    const workerCaller = aptlssRouter.createCaller(context(worker));
    const adminCaller = aptlssRouter.createCaller(context(admin));

    await expect(
      workerCaller.postFollowUpToTrello({ id: 23 })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: /posting is disabled/i,
    });
    await expect(
      adminCaller.postFollowUpToTrello({ id: 23 })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: /posting is disabled/i,
    });

    expectNoExternalOrPersistentWrites();
  });

  it("blocks pilot checklist, day-plan, and plan mutations before database, Trello, or model I/O", async () => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", String(worker.id));
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
    io.getAutopilotLevel.mockResolvedValue(3);
    const caller = aptlssRouter.createCaller(context(worker));

    await expect(
      caller.syncCheckItem({ trelloCheckItemId: "check-1", state: "complete" })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: /paused in shadow mode/i,
    });
    await expect(caller.planMyDay()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: /disabled for this shadow pilot/i,
    });
    await expect(
      caller.upsertAptlssPlan({ cardId: "card-1", planJson: '{"steps":[]}' })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: /shadow-only.*prohibited/i,
    });

    expect(io.getAutopilotLevel).not.toHaveBeenCalled();
    expectNoExternalOrPersistentWrites();
  });
});
