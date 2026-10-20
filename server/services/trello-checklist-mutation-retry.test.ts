import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const { fetchWithRetry, getDb } = vi.hoisted(() => ({
  fetchWithRetry: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("../utils/retry", () => ({ fetchWithRetry }));
vi.mock("../db", () => ({ getDb }));

import { assertAptlssJobOwnership, TrelloChecklistSyncService } from "./trello-checklist-sync";
import { ScheduledJobLeaseLostError, type ScheduledJobOwnershipReader } from "../scheduledJobRuntime";

describe("Trello checklist scheduled ownership", () => {
  beforeEach(() => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "");
    getDb.mockReset().mockResolvedValue(null);
    fetchWithRetry.mockReset().mockResolvedValue({
      ok: true, json: async () => ({ id: "checklist-owned", name: "Checklist" }),
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([false, true])("forwards the optional ownership reader (provided=%s)", async (provided) => {
    const reader = provided ? { select: vi.fn() } as ScheduledJobOwnershipReader : undefined;
    const context = {
      signal: new AbortController().signal,
      assertOwnership: vi.fn(async (_reader?: ScheduledJobOwnershipReader) => {}),
    };
    await assertAptlssJobOwnership(context, reader);
    expect(context.assertOwnership).toHaveBeenCalledTimes(1);
    expect(context.assertOwnership).toHaveBeenCalledWith(reader);
    expect(context.assertOwnership.mock.calls[0][0]).toBe(reader);
    expect(getDb).not.toHaveBeenCalled();
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it("rejects cancellation before and after the reader-backed ownership check", async () => {
    const reader = { select: vi.fn() } as ScheduledJobOwnershipReader;
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      assertOwnership: vi.fn(async () => { controller.abort(); }),
    };
    await expect(assertAptlssJobOwnership(context, reader)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(context.assertOwnership).toHaveBeenCalledTimes(1);
    expect(context.assertOwnership).toHaveBeenCalledWith(reader);
    context.assertOwnership.mockClear();
    await expect(assertAptlssJobOwnership(context, reader)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(context.assertOwnership).not.toHaveBeenCalled();
  });

  const mutations = [
    ["create", (service: TrelloChecklistSyncService) => service.createChecklist("owned-card", "Checklist")],
    ["add", (service: TrelloChecklistSyncService) => service.addChecklistItem("checklist-owned", "Step", "bottom", "owned-card")],
    ["complete", (service: TrelloChecklistSyncService) => service.updateChecklistItemState("owned-card", "item-owned", "complete")],
    ["delete", (service: TrelloChecklistSyncService) => service.deleteChecklist("checklist-owned", "owned-card")],
  ] as const;

  it.each(mutations)("fences %s immediately before its provider write", async (_name, mutate) => {
    const loss = new ScheduledJobLeaseLostError();
    const service = new TrelloChecklistSyncService({ apiKey: "key", token: "token" }, {
      signal: new AbortController().signal,
      assertOwnership: vi.fn().mockRejectedValue(loss),
    });
    await expect(mutate(service)).rejects.toBe(loss);
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it.each(mutations)("carries cancellation and a timeout into %s without mutation retries", async (_name, mutate) => {
    const controller = new AbortController();
    const service = new TrelloChecklistSyncService({ apiKey: "key", token: "token" }, {
      signal: controller.signal,
      assertOwnership: vi.fn().mockResolvedValue(undefined),
    });
    await mutate(service);
    const [, init, options] = fetchWithRetry.mock.calls[0];
    expect(options.maxRetries).toBe(0);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
    controller.abort();
    expect(init.signal.aborted).toBe(true);
  });

  it("stops between item writes without reconciliation or sync-record writes", async () => {
    const controller = new AbortController();
    const execute = vi.fn();
    getDb.mockResolvedValue({ execute });
    const calls: string[] = [];
    fetchWithRetry.mockImplementation(async (_url, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (!init?.method) return { ok: true, json: async () => [] };
      if (calls.length === 2) return { ok: true, json: async () => ({ id: "checklist-owned", name: "Checklist" }) };
      controller.abort();
      return { ok: true, json: async () => ({ id: "item-owned", name: "Step" }) };
    });
    const service = new TrelloChecklistSyncService({ apiKey: "key", token: "token" }, {
      signal: controller.signal, assertOwnership: vi.fn().mockResolvedValue(undefined),
    });
    await expect(service.syncChecklistToCard("owned-card", [
      { step: "First", timeMinutes: 10, aptlssType: "T" },
      { step: "Second", timeMinutes: 10, aptlssType: "T" },
    ])).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(calls).toEqual(["GET", "POST", "POST"]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["PUT", "DELETE"])("does not reconcile or swallow ownership loss during %s", async (failedMethod) => {
    const controller = new AbortController();
    const execute = vi.fn();
    getDb.mockResolvedValue({ execute });
    const itemName = "[✅ Task] Review (10m)";
    const checklists = [
      { id: "new", name: "Checklist · v1", checkItems: [{ id: "item-1", name: itemName, state: "incomplete" }] },
      { id: "old", name: "Checklist · v1", checkItems: [] },
    ];
    const calls: string[] = [];
    fetchWithRetry.mockImplementation(async (_url, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(method);
      if (method === failedMethod) {
        controller.abort();
        throw new Error("Cancelled provider request");
      }
      if (method === "PUT") checklists[0].name = "Checklist · v2";
      return { ok: true, json: async () => structuredClone(checklists) };
    });
    const service = new TrelloChecklistSyncService({ apiKey: "key", token: "token" }, {
      signal: controller.signal, assertOwnership: vi.fn().mockResolvedValue(undefined),
    });
    await expect(service.syncChecklistToCard("owned-card", [
      { step: "Review", timeMinutes: 10, aptlssType: "T" },
    ], { checklistName: "Checklist", sourceRevision: 2, replaceExisting: true }))
      .rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(calls).toEqual(failedMethod === "PUT" ? ["GET", "GET", "PUT"] : ["GET", "GET", "PUT", "DELETE"]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fences and propagates lease loss at the durable sync record", async () => {
    const controller = new AbortController();
    const execute = vi.fn();
    getDb.mockResolvedValueOnce(null).mockImplementation(async () => {
      controller.abort();
      return { execute };
    });
    fetchWithRetry.mockResolvedValue({ ok: true, json: async () => [{
      id: "checklist-owned", name: "Checklist", checkItems: [{ id: "item-owned", name: "[✅ Task] Review (10m)", state: "incomplete" }],
    }] });
    const service = new TrelloChecklistSyncService({ apiKey: "key", token: "token" }, {
      signal: controller.signal, assertOwnership: vi.fn().mockResolvedValue(undefined),
    });
    await expect(service.syncChecklistToCard("owned-card", [
      { step: "Review", timeMinutes: 10, aptlssType: "T" },
    ], { checklistName: "Checklist" })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(execute).not.toHaveBeenCalled();
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  });
});

describe("TrelloChecklistSyncService mutation retries", () => {
  const service = new TrelloChecklistSyncService({
    apiKey: "key",
    token: "token",
  });

  beforeEach(() => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "");
    getDb.mockResolvedValue(null);
    fetchWithRetry.mockReset();
    fetchWithRetry.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "checklist-1", name: "Checklist" }),
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["createChecklist", () => service.createChecklist("card-1", "Checklist")],
    ["addChecklistItem", () => service.addChecklistItem("checklist-1", "Step")],
    [
      "updateChecklistItemState",
      () => service.updateChecklistItemState("card-1", "item-1", "complete"),
    ],
    ["deleteChecklist", () => service.deleteChecklist("checklist-1")],
  ])(
    "%s does not automatically retry a Trello mutation",
    async (_name, invoke) => {
      await invoke();

      expect(fetchWithRetry).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: expect.stringMatching(/POST|PUT|DELETE/),
        }),
        expect.objectContaining({ maxRetries: 0 })
      );
    }
  );

  it("does not append to a staged checklist whose contents were changed after interruption", async () => {
    const checklistName = "APTLSS Execution Checklist";
    const expectedItem = "[✅ Task] Confirm the deadline (10m)";
    const hash = createHash("sha256")
      .update(JSON.stringify([expectedItem]))
      .digest("hex");
    const stagedName = `${checklistName} [sync v7-${hash.slice(0, 20)}]`;
    const checklists = [
      {
        id: "staged-1",
        name: stagedName,
        checkItems: [
          {
            id: "changed-1",
            name: "[✅ Task] Different item (10m)",
            state: "incomplete",
          },
        ],
      },
    ];
    const calls: Array<{ method: string; path: string }> = [];

    fetchWithRetry.mockImplementation(
      async (rawUrl: string | URL, init?: RequestInit) => {
        const url = new URL(String(rawUrl));
        const method = init?.method ?? "GET";
        calls.push({ method, path: url.pathname });

        if (url.pathname === "/1/cards/card-1/checklists" && method === "GET") {
          return { ok: true, json: async () => structuredClone(checklists) };
        }
        if (
          url.pathname === "/1/cards/card-1/checklists" &&
          method === "POST"
        ) {
          const body = JSON.parse(String(init?.body)) as { name: string };
          checklists.push({ id: "staged-2", name: body.name, checkItems: [] });
          return {
            ok: true,
            json: async () => ({ id: "staged-2", name: body.name }),
          };
        }
        if (
          url.pathname === "/1/checklists/staged-1/checkItems" &&
          method === "POST"
        ) {
          const body = JSON.parse(String(init?.body)) as { name: string };
          checklists[0].checkItems.push({
            id: "changed-2",
            name: body.name,
            state: "incomplete",
          });
          return {
            ok: true,
            json: async () => ({ id: "changed-2", name: body.name }),
          };
        }
        throw new Error(
          `Unexpected mocked Trello request: ${method} ${url.pathname}`
        );
      }
    );

    const result = await service.syncChecklistToCard(
      "card-1",
      [{ step: "Confirm the deadline", timeMinutes: 10, aptlssType: "T" }],
      { checklistName, replaceExisting: true, sourceRevision: 7 }
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "A staged checklist no longer matches this plan. Verify or remove it manually before retrying."
    );
    expect(calls.every(call => call.method === "GET")).toBe(true);
    expect(checklists[0].checkItems).toHaveLength(1);
  });
});
