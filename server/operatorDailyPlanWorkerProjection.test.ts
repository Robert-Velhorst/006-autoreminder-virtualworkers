import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  generate: vi.fn(),
  update: vi.fn(),
}));

vi.mock("./operatorDailyPlan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./operatorDailyPlan")>();
  return {
    ...actual,
    getOperatorDailyPlan: mocks.get,
    generateOperatorDailyPlan: mocks.generate,
    updateOperatorDailyPlan: mocks.update,
  };
});

vi.mock("./workerOperatorContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workerOperatorContext")>()),
  getActiveWorkerProfileResolution: async (userId: number) => ({ profileId: userId, ambiguous: false }),
  getActiveWorkerProfileId: async (userId: number) => userId,
  resolveWorkerOperatorContext: async (user: { id: number }) => ({ userId: user.id }),
}));

import { operatorRouter } from "./operatorRouter";
import { toWorkerOperatorDailyPlan } from "./operatorDailyPlan";
import { WorkerDailyPlanContent, WorkerTaskStepRow } from "../client/src/pages/worker/WorkerOperator";

const SENSITIVE = {
  founderRecommendation: "WORKER_PLAN_FOUNDER_RECOMMENDATION_8f2c",
  decisionRationale: "WORKER_PLAN_DECISION_RATIONALE_51bd",
  blockRationale: "WORKER_PLAN_BLOCK_RATIONALE_9a30",
  unscheduledRationale: "WORKER_PLAN_UNSCHEDULED_RATIONALE_6de1",
  rowRationale: "WORKER_PLAN_ROW_RATIONALE_b705",
  confidence: 876543219,
  score: 765432198,
};

const OPERATIONAL_STEP = "Request the missing case document and record the response.";
const DATE_KEY = "2026-09-25";
const WORKER_ID = 73;

describe("Worker task step status", () => {
  const step = { id: 1, stepNumber: 1, title: "Approve the checked follow-up", status: "complete",
    category: "internal_work", requiresRobert: true, decisionDueAt: "2026-10-01T09:00:00Z",
    decisionDeferred: false, completionCriteria: null, riskIfSkipped: null };
  it.each([false, true])("completed decision is done even when deferred is %s", decisionDeferred => {
    const html = renderToStaticMarkup(createElement(WorkerTaskStepRow, { step: { ...step, decisionDeferred } }));
    expect(html).toContain("Done");
    expect(html).not.toMatch(/Waiting for founder decision|Deferred|>Decision</);
  });
  it("completed status overrides a stale blocked manager action", () => {
    const html = renderToStaticMarkup(createElement(WorkerTaskStepRow, {
      step, action: { kind: "work", blocked: true, reason: "Stale private rationale" },
    }));
    expect(html).toContain("Done");
    expect(html).not.toMatch(/Waiting|Ready|Stale private rationale/);
  });
  it.each([false, true])("open decision retains its hold when deferred is %s", decisionDeferred => {
    const html = renderToStaticMarkup(createElement(WorkerTaskStepRow, { step: { ...step, status: "open", decisionDeferred } }));
    expect(html).toContain("Waiting for founder decision");
    expect(html).toContain(decisionDeferred ? "Deferred" : "Decision");
    expect(html).not.toContain("Done");
  });
});

function storedPlan() {
  const schedule = {
    version: 2 as const,
    dateKey: DATE_KEY,
    generatedAt: "2026-09-25T08:00:00.000Z",
    blocks: [
      {
        id: "block-with-step",
        startTime: "09:00",
        endTime: "09:45",
        cardId: "case-73-a",
        cardName: "Assigned case 73-A",
        cardUrl: "https://trello.example/cards/case-73-a",
        boardName: "Operations",
        listName: "DOING",
        action: OPERATIONAL_STEP,
        stepIds: [7301],
        priority: "HIGH",
        score: SENSITIVE.score,
        state: "INTERNAL_STATE_SENTINEL",
        status: "planned" as const,
        notes: SENSITIVE.blockRationale,
        flags: ["Robert", "INTERNAL_FLAG_SENTINEL"],
      },
      {
        id: "block-without-step",
        startTime: "10:00",
        endTime: "10:30",
        cardId: "case-73-b",
        cardName: "Assigned case 73-B",
        cardUrl: null,
        boardName: "Operations",
        listName: "TO-DO",
        action: SENSITIVE.founderRecommendation,
        stepIds: [],
        priority: "MEDIUM",
        score: SENSITIVE.score,
        state: "INTERNAL_STATE_SENTINEL",
        status: "planned" as const,
        notes: SENSITIVE.blockRationale,
        flags: ["INTERNAL_FLAG_SENTINEL"],
      },
    ],
    robertItems: [{
      stepId: 7302,
      cardId: "case-73-a",
      cardName: "Assigned case 73-A",
      decision: SENSITIVE.founderRecommendation,
    }],
    unscheduledCards: [{
      cardId: "case-73-c",
      cardName: "Assigned case 73-C",
      reason: SENSITIVE.unscheduledRationale,
    }],
    planHealth: {
      confidence: SENSITIVE.confidence,
      scheduledMinutes: 75,
      availableMinutes: 480,
      overlaps: 0,
      gaps: 405,
    },
    constraints: { startTime: "09:00", endTime: "17:00", breaks: [] },
    auditTrail: [{ at: "2026-09-25T08:00:00.000Z", action: "generated", detail: SENSITIVE.decisionRationale }],
    planningImpact: { reason: SENSITIVE.decisionRationale },
  };
  const scheduleJson = JSON.stringify(schedule);
  return {
    id: 730,
    vaId: WORKER_ID,
    dateKey: DATE_KEY,
    scheduleJson,
    dailySummary: SENSITIVE.rowRationale,
    topPriority: SENSITIVE.founderRecommendation,
    totalScheduledMinutes: 75,
    robertItemsCount: 1,
    autoGenerated: true,
    generatedAt: new Date("2026-09-25T08:00:00.000Z"),
    createdAt: new Date("2026-09-25T08:00:00.000Z"),
    schedule,
  } as never;
}

const worker = () => operatorRouter.createCaller({
  req: {},
  res: {},
  user: { id: WORKER_ID, openId: "worker-73", role: "worker" },
} as TrpcContext);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("React", React);
  vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "");
  vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
  const plan = storedPlan();
  mocks.get.mockResolvedValue(plan);
  mocks.generate.mockResolvedValue(plan);
  mocks.update.mockResolvedValue(plan);
});
afterEach(() => vi.unstubAllGlobals());

describe("worker daily-plan projection", () => {
  it("keeps founder recommendations, rationale, scores, and raw storage out of worker plan APIs", async () => {
    const caller = worker();
    const read = await caller.getDailyPlan({ dateKey: DATE_KEY });
    const generated = await caller.generateDailyPlan({ dateKey: DATE_KEY, force: true });
    const updated = await caller.updateDailyPlan({
      version: 2,
      dateKey: DATE_KEY,
      generatedAt: "2026-09-25T08:00:00.000Z",
      blocks: storedPlan().schedule.blocks,
      robertItems: storedPlan().schedule.robertItems,
      unscheduledCards: storedPlan().schedule.unscheduledCards,
      planHealth: storedPlan().schedule.planHealth,
      constraints: storedPlan().schedule.constraints,
      auditTrail: storedPlan().schedule.auditTrail,
      expectedPlanVersion: "a".repeat(64),
    });

    for (const response of [read, generated, updated]) {
      expect(response).toMatchObject({
        dateKey: DATE_KEY,
        schedule: {
          blocks: [
            {
              cardName: "Assigned case 73-A",
              startTime: "09:00",
              endTime: "09:45",
              action: OPERATIONAL_STEP,
              priority: "HIGH",
              status: "planned",
            },
            {
              cardName: "Assigned case 73-B",
              action: "Open the task and record the next concrete action.",
            },
          ],
          planHealth: { scheduledMinutes: 75, availableMinutes: 480, gaps: 405 },
          constraints: { startTime: "09:00", endTime: "17:00" },
        },
      });
      expect(response).not.toHaveProperty("scheduleJson");
      expect(response).not.toHaveProperty("dailySummary");
      expect(response).not.toHaveProperty("topPriority");
      expect(response?.schedule).not.toHaveProperty("robertItems");
      expect(response?.schedule).not.toHaveProperty("auditTrail");
      expect(response?.schedule).not.toHaveProperty("planningImpact");
      expect(response?.schedule?.planHealth).not.toHaveProperty("confidence");
      expect(response?.schedule?.blocks[0]).not.toHaveProperty("score");
      expect(response?.schedule?.blocks[0]).not.toHaveProperty("notes");
      expect(response?.schedule?.blocks[0]).not.toHaveProperty("flags");
      expect(JSON.stringify(response)).not.toContain(SENSITIVE.founderRecommendation);
      expect(JSON.stringify(response)).not.toContain(SENSITIVE.decisionRationale);
      expect(JSON.stringify(response)).not.toContain(SENSITIVE.blockRationale);
      expect(JSON.stringify(response)).not.toContain(SENSITIVE.unscheduledRationale);
      expect(JSON.stringify(response)).not.toContain(SENSITIVE.rowRationale);
      expect(JSON.stringify(response)).not.toContain(String(SENSITIVE.confidence));
      expect(JSON.stringify(response)).not.toContain(String(SENSITIVE.score));
    }
  });

  it("renders the worker API plan without displaying hidden plan fields", async () => {
    const response = await worker().getDailyPlan({ dateKey: DATE_KEY });
    expect(response).not.toBeNull();
    const html = renderToStaticMarkup(createElement(WorkerDailyPlanContent, { plan: response!.schedule, timeZone: "Europe/Amsterdam" }));

    expect(html).toContain("Assigned case 73-A");
    expect(html).toContain("09:00");
    expect(html).toContain(OPERATIONAL_STEP);
    expect(html).toContain("Planned");
    expect(html).toContain("No time block is scheduled for this item today.");
    expect(html).not.toContain(SENSITIVE.founderRecommendation);
    expect(html).not.toContain(SENSITIVE.decisionRationale);
    expect(html).not.toContain(SENSITIVE.blockRationale);
    expect(html).not.toContain(SENSITIVE.unscheduledRationale);
    expect(html).not.toContain(SENSITIVE.rowRationale);
    expect(html).not.toContain(String(SENSITIVE.confidence));
    expect(html).not.toContain(String(SENSITIVE.score));
    expect(html).not.toContain("Decision details");
  });

  it("does not mutate persisted or founder-facing source data while projecting a worker response", () => {
    const original = storedPlan();
    const projected = toWorkerOperatorDailyPlan(original);

    expect(JSON.parse(original.scheduleJson).robertItems[0].decision).toBe(SENSITIVE.founderRecommendation);
    expect(original.schedule.planHealth.confidence).toBe(SENSITIVE.confidence);
    expect(projected?.schedule).not.toHaveProperty("robertItems");
    expect(projected?.schedule.planHealth).not.toHaveProperty("confidence");
  });
});
