import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskAssignments } from "../drizzle/schema";

const database = vi.hoisted(() => ({
  getManualStepsForCard: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("./aptlssStepsDb", () => ({
  upsertCardState: vi.fn(),
  upsertPriorityScore: vi.fn(),
  getOpenStepsForCard: vi.fn(),
  getManualStepsForCard: database.getManualStepsForCard,
  countDependentCards: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: database.getDb }));

import { writeChecklistToTrello, type AptlssStepInput, type TrelloCardContext } from "./aptlssEngine";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("APTLSS checklist creation concurrency", () => {
  beforeEach(() => {
    database.getManualStepsForCard.mockReset().mockResolvedValue([]);
    database.getDb.mockReset().mockResolvedValue(null);
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "");
    vi.stubEnv("TRELLO_API_KEY", "test-key");
    vi.stubEnv("TRELLO_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    {
      label: "pilot-owned",
      assignments: [{ taskId: "card-race", vaId: 9, status: "assigned" }],
      expectedError: "pilot worker",
    },
    {
      label: "unassigned",
      assignments: [],
      expectedError: "ownership is missing",
    },
    {
      label: "ambiguous",
      assignments: [
        { taskId: "card-race", vaId: 10, status: "assigned" },
        { taskId: "card-race:checklist-1:item-1", vaId: 11, status: "in_progress" },
      ],
      expectedError: "ownership is ambiguous",
    },
  ])("blocks checklist provider calls for $label ownership", async ({ assignments, expectedError }) => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "9");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
    database.getDb.mockResolvedValue({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async (count: number) => table === taskAssignments ? assignments.slice(0, count) : [],
          }),
        }),
      }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const context = { id: "card-race", checklists: [] } as unknown as TrelloCardContext;
    const steps: AptlssStepInput[] = [{
      stepNumber: 1,
      title: "Review the case evidence",
      estimatedMinutes: 15,
      category: "T",
      requiresRobert: false,
    }];

    await expect(writeChecklistToTrello(9, "card-race", context, steps)).rejects.toThrow(expectedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serializes syncs for one card and reuses the checklist created by the first sync", async () => {
    const remoteChecklists: Array<{
      id: string;
      name: string;
      checkItems: Array<{ id: string; name: string; state: "incomplete" }>;
    }> = [];
    let checklistCreates = 0;
    let itemCreates = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.pathname === "/1/cards/card-race/checklists" && method === "GET") {
        return jsonResponse(remoteChecklists);
      }

      if (url.pathname === "/1/checklists" && method === "POST") {
        checklistCreates += 1;
        const checklist = {
          id: `checklist-${checklistCreates}`,
          name: "APTLSS Execution Checklist",
          checkItems: [] as Array<{ id: string; name: string; state: "incomplete" }>,
        };
        remoteChecklists.push(checklist);
        return jsonResponse({ id: checklist.id, name: checklist.name });
      }

      const checklistItemsPath = url.pathname.match(/^\/1\/checklists\/([^/]+)\/checkItems$/);
      if (checklistItemsPath && method === "POST") {
        const checklist = remoteChecklists.find((entry) => entry.id === checklistItemsPath[1]);
        if (!checklist) return jsonResponse({ error: "missing checklist" }, 404);
        itemCreates += 1;
        const body = JSON.parse(String(init?.body)) as { name: string };
        const item = {
          id: `check-item-${itemCreates}`,
          name: body.name,
          state: "incomplete" as const,
        };
        checklist.checkItems.push(item);
        return jsonResponse(item);
      }

      if (checklistItemsPath && method === "GET") {
        const checklist = remoteChecklists.find((entry) => entry.id === checklistItemsPath[1]);
        return checklist ? jsonResponse(checklist.checkItems) : jsonResponse([], 404);
      }

      throw new Error(`Unexpected mocked Trello request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const context = {
      id: "card-race",
      checklists: [],
    } as unknown as TrelloCardContext;
    const steps: AptlssStepInput[] = [{
      stepNumber: 1,
      title: "Review the case evidence",
      estimatedMinutes: 15,
      category: "T",
      requiresRobert: false,
    }];

    const results = await Promise.all([
      writeChecklistToTrello(1, "card-race", context, steps),
      writeChecklistToTrello(1, "card-race", context, steps),
    ]);

    expect(checklistCreates).toBe(1);
    expect(itemCreates).toBe(1);
    expect(remoteChecklists).toHaveLength(1);
    expect(remoteChecklists[0].checkItems).toHaveLength(1);
    expect(results.map((result) => result.checklistId)).toEqual([
      "checklist-1",
      "checklist-1",
    ]);
    expect(results.map((result) => result.stepCheckItemIds[1])).toEqual([
      "check-item-1",
      "check-item-1",
    ]);
  });
});
