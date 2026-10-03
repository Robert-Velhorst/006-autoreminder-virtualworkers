import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeLLM: vi.fn(),
  fetchWithRetry: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("../_core/llm", () => ({
  invokeLLM: mocks.invokeLLM,
  getLLMText: (result: any) => result?.choices?.[0]?.message?.content ?? "",
}));
vi.mock("../utils/retry", () => ({ fetchWithRetry: mocks.fetchWithRetry }));
vi.mock("../db", () => ({ getDb: mocks.getDb }));

import { generateAptlssForCard, normalizeGeneratedAptlssPlan } from "./aptlss-generation";
import { ScheduledJobLeaseLostError } from "../scheduledJobRuntime";

beforeEach(() => {
  mocks.invokeLLM.mockReset();
  mocks.fetchWithRetry.mockReset();
  mocks.getDb.mockReset().mockResolvedValue(null);
  vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "");
  vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "");
  vi.stubEnv("TRELLO_API_KEY", "test-key");
  vi.stubEnv("TRELLO_TOKEN", "test-token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function jsonResponse(body: unknown, ok = true, statusText = "OK") {
  return { ok, statusText, json: async () => body } as Response;
}

describe("APTLSS plan normalization", () => {
  it("does not allow a high confidence claim to exceed available evidence", () => {
    const plan = normalizeGeneratedAptlssPlan({
      summary: "Do the work",
      nextBestAction: "Start",
      stateReason: "New",
      urgencyLabel: "HIGH",
      confidenceScore: 100,
      missingInformation: [],
      steps: [{ title: "Start", estimatedMinutes: 20, category: "T", requiresFounder: false }],
    }, { id: "card-1", name: "Title only" });

    expect(plan.confidenceScore).toBe(65);
    expect(plan.needsReview).toBe(true);
  });

  it("deduplicates steps and clamps unsafe estimates", () => {
    const plan = normalizeGeneratedAptlssPlan({
      confidenceScore: 90,
      missingInformation: [],
      steps: [
        { title: " Verify evidence ", estimatedMinutes: 1, category: "quality", requiresFounder: false },
        { title: "Verify evidence", estimatedMinutes: 900, category: "quality", requiresFounder: false },
        { title: "Record outcome", estimatedMinutes: 900, category: "handoff", requiresFounder: true },
      ],
    }, { id: "card-2", name: "Evidence review", desc: "A".repeat(100) });

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].estimatedMinutes).toBe(5);
    expect(plan.steps[1].estimatedMinutes).toBe(480);
    expect(plan.steps.map((step) => step.stepNumber)).toEqual([1, 2]);
  });

  it("creates an explicit clarification step when the model returns no usable steps", () => {
    const plan = normalizeGeneratedAptlssPlan({}, { id: "card-3", name: "Unclear task" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].category).toBe("clarification");
    expect(plan.nextBestAction).toContain("Review requirements");
  });
});

describe("APTLSS generation retries", () => {
  it("fences a late LLM result before checklist synchronization", async () => {
    const controller = new AbortController();
    mocks.invokeLLM.mockImplementation(async () => {
      controller.abort();
      return { choices: [{ message: { content: JSON.stringify({ steps: [{ title: "Review" }] }) } }] };
    });
    await expect(generateAptlssForCard({ id: "card-late", name: "Late plan" }, {
      validateBeforeGenerate: false,
    }, {
      signal: controller.signal,
      assertOwnership: vi.fn().mockResolvedValue(undefined),
    })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.invokeLLM).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });

  it("stops waiting for an in-flight LLM on cancellation and ignores its later result", async () => {
    const controller = new AbortController();
    let resolveModel!: (value: unknown) => void;
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => { started = resolve; });
    mocks.invokeLLM.mockImplementation(() => {
      started();
      return new Promise((resolve) => { resolveModel = resolve; });
    });
    const generating = generateAptlssForCard({ id: "card-inflight", name: "In-flight plan" }, {
      validateBeforeGenerate: false,
    }, { signal: controller.signal, assertOwnership: vi.fn().mockResolvedValue(undefined) });
    const rejected = expect(generating).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    await modelStarted;
    controller.abort();
    await rejected;
    resolveModel({ choices: [{ message: { content: JSON.stringify({ steps: [{ title: "Review" }] }) } }] });
    await Promise.resolve();
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });

  it("propagates cancellation during checklist creation without adding items or recording sync", async () => {
    const controller = new AbortController();
    const execute = vi.fn();
    mocks.getDb.mockResolvedValue({ execute });
    mocks.invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ steps: [{ title: "Review" }] }) } }] });
    mocks.fetchWithRetry.mockImplementation(async (_url, init?: RequestInit) => {
      if (init?.method === "POST") {
        controller.abort();
        throw new Error("Provider request aborted");
      }
      return jsonResponse([]);
    });
    await expect(generateAptlssForCard({ id: "card-abort", name: "Interrupted write" }, {
      validateBeforeGenerate: false,
    }, {
      signal: controller.signal,
      assertOwnership: vi.fn().mockResolvedValue(undefined),
    })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not succeed on a partial checklist and repairs it before returning success", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const plan = {
      summary: "Review and record the case response",
      nextBestAction: "Read the source message",
      stateReason: "The source message needs review",
      urgencyLabel: "HIGH",
      confidenceScore: 100,
      missingInformation: [],
      steps: [
        {
          title: "Read the source message",
          estimatedMinutes: 15,
          category: "T",
          requiresFounder: false,
          blockedBy: null,
          completionCriteria: "The request and deadline are recorded.",
          riskIfSkipped: "A deadline could be missed.",
          recommendedDecision: null,
        },
        {
          title: "Record the requested follow-up",
          estimatedMinutes: 10,
          category: "T",
          requiresFounder: false,
          blockedBy: null,
          completionCriteria: "The follow-up is recorded against the case.",
          riskIfSkipped: "The case may not be followed up.",
          recommendedDecision: null,
        },
        {
          title: "Link the reviewed message to the case",
          estimatedMinutes: 5,
          category: "T",
          requiresFounder: false,
          blockedBy: null,
          completionCriteria: "The source message is linked to the case.",
          riskIfSkipped: "The evidence may be difficult to find.",
          recommendedDecision: null,
        },
      ],
    };
    mocks.invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(plan) } }] });

    const remoteChecklists: Array<{
      id: string;
      name: string;
      checkItems: Array<{ id: string; name: string; state: "incomplete" }>;
    }> = [];
    let itemWrites = 0;
    mocks.fetchWithRetry.mockImplementation(async (rawUrl: string | URL, init?: RequestInit) => {
      const url = new URL(String(rawUrl));
      const method = init?.method ?? "GET";

      if (url.pathname === "/1/cards/card-1/checklists" && method === "GET") {
        return jsonResponse(structuredClone(remoteChecklists));
      }
      if (url.pathname === "/1/cards/card-1/checklists" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { name: string };
        const checklist = { id: "checklist-1", name: body.name, checkItems: [] };
        remoteChecklists.push(checklist);
        return jsonResponse({ id: checklist.id, name: checklist.name });
      }
      if (url.pathname === "/1/checklists/checklist-1/checkItems" && method === "POST") {
        itemWrites += 1;
        if (itemWrites === 2) return jsonResponse({}, false, "Injected mid-checklist failure");

        const body = JSON.parse(String(init?.body)) as { name: string };
        const item = { id: `item-${itemWrites}`, name: body.name, state: "incomplete" as const };
        remoteChecklists[0].checkItems.push(item);
        return jsonResponse({ id: item.id, name: item.name });
      }

      throw new Error(`Unexpected mocked Trello request: ${method} ${url.pathname}`);
    });

    const sourceCard = {
      id: "card-1",
      name: "Case response",
      desc: "A sufficiently detailed case description that provides evidence context for a reliable plan.",
      actions: [{ type: "commentCard", data: { text: "Review the new case message." } }],
      attachments: [{ name: "case-document.pdf" }],
    };

    await expect(generateAptlssForCard(sourceCard)).rejects.toThrow("Injected mid-checklist failure");
    expect(remoteChecklists).toHaveLength(1);
    expect(remoteChecklists[0].checkItems).toHaveLength(1);

    const retryCard = {
      ...sourceCard,
      checklists: [{ ...remoteChecklists[0], checkItems: [...remoteChecklists[0].checkItems] }],
    };
    const retryResult = await generateAptlssForCard(retryCard);

    expect(retryResult.success).toBe(true);
    expect(retryResult.appliedToTrello).toBe(true);
    expect(retryResult.checklistId).toBe("checklist-1");
    expect(mocks.invokeLLM).toHaveBeenCalledTimes(2);
    expect(remoteChecklists[0].checkItems.map((item) => item.name)).toEqual([
      "[✅ Task] Read the source message (15m)",
      "[✅ Task] Record the requested follow-up (10m)",
      "[✅ Task] Link the reviewed message to the case (5m)",
    ]);
    expect(itemWrites).toBe(4);
  });

  it("reuses an existing checklist only when its successful sync record matches it", async () => {
    const execute = vi.fn().mockResolvedValue([[
      { trello_checklist_id: "checklist-2", items_synced: 2, synced_at: new Date() },
    ]]);
    mocks.getDb.mockResolvedValue({ execute });

    const result = await generateAptlssForCard({
      id: "card-2",
      name: "Completed plan",
      checklists: [{
        id: "checklist-2",
        name: "APTLSS Execution Checklist",
        checkItems: [
          { id: "item-1", name: "Review", state: "complete" },
          { id: "item-2", name: "Record", state: "complete" },
        ],
      }],
    });

    expect(result.reusedExistingChecklist).toBe(true);
    expect(result.appliedToTrello).toBe(false);
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
  });
});
