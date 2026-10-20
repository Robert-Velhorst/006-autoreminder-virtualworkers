import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduledJobLeaseLostError } from "../scheduledJobRuntime";
import { initializeWebhookAutoRegister, registerWebhookForBoard, removeWebhookForBoard, setWebhookCallbackUrl, stopWebhookAutoRegister, syncWebhooks } from "./webhook-auto-register";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../db", () => ({ getDb: mocks.getDb }));

import { atisBoards } from "../../drizzle/schema.postgres";

const board = { trelloId: "board-1", name: "Board" };
const stored = { trelloWebhookId: "webhook-old", modelId: "board-old", modelType: "board" };

function harness(boards = [board], storedWebhooks: typeof stored[] = [], loseAfter?: string) {
  let owned = true;
  let executes = 0;
  const trace: string[] = [];
  const controller = new AbortController();
  const context = { signal: controller.signal, assertOwnership: vi.fn(async () => {
    trace.push("checkpoint");
    if (!owned) throw new ScheduledJobLeaseLostError();
  }) };
  const touch = (event: string) => {
    trace.push(event);
    if (event === loseAfter) owned = false;
  };
  const selectBoards = vi.fn(async () => { touch("boards-read"); return boards; });
  const execute = vi.fn(async () => {
    if (++executes === 1) { touch("stored-read"); return { rows: storedWebhooks }; }
    touch("local-write");
    return { rows: [], rowCount: 1 };
  });
  const select = () => {
    const query: any = {
      from: (table: unknown) => table === atisBoards ? selectBoards() : query,
      where: () => query,
      limit: () => query,
      then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(execute()).then(result => result.rows ?? []).then(resolve, reject),
    };
    return query;
  };
  mocks.getDb.mockResolvedValue({ select,
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => execute() }) }),
    delete: () => ({ where: () => execute() }),
    execute,
  });
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    touch(`provider-${options.method}`);
    return { ok: true, json: async () => {
      touch("provider-body");
      return { id: "webhook-new", active: true };
    } };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { context, controller, execute, selectBoards, fetchMock, trace, lose: () => { owned = false; } };
}

describe("webhook scheduled ownership fence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("TRELLO_API_KEY", "test-key");
    vi.stubEnv("TRELLO_TOKEN", "test-token");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    setWebhookCallbackUrl("https://example.invalid/api/trello-webhook");
  });
  afterEach(() => {
    stopWebhookAutoRegister();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rejects an aborted context without any database or provider work", async () => {
    const state = harness();
    state.controller.abort();
    await expect(syncWebhooks(state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it("does not interpret an unavailable database as an empty authoritative inventory", async () => {
    const state = harness([board], [stored]);
    mocks.getDb.mockResolvedValue(undefined);
    await expect(syncWebhooks(state.context)).rejects.toThrow(/unavailable/i);
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it("does not delete webhooks when the board inventory read fails", async () => {
    const state = harness([board], [stored]);
    state.selectBoards.mockRejectedValue(new Error("Synthetic board query failure"));
    await expect(syncWebhooks(state.context)).rejects.toThrow(/inventory/i);
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it("does not create webhooks when the existing registry read fails", async () => {
    const state = harness([board], [stored]);
    state.execute.mockRejectedValueOnce(new Error("Synthetic registry query failure"));
    await expect(syncWebhooks(state.context)).rejects.toThrow(/registry/i);
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it.each(["POST", "DELETE"])("does not report success or continue after local registry persistence fails following %s", async method => {
    const state = method === "POST" ? harness([board, { ...board, trelloId: "next" }])
      : harness([], [stored, { ...stored, modelId: "next", trelloWebhookId: "next" }]);
    state.execute.mockResolvedValueOnce({ rows: method === "POST" ? [] : [stored, { ...stored, modelId: "next", trelloWebhookId: "next" }] })
      .mockRejectedValueOnce(new Error("Synthetic registry persistence failure"));
    await expect(syncWebhooks(state.context)).rejects.toThrow(/persist/i);
    expect(state.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["boards-read", "stored-read"])("propagates loss after %s without treating reads as empty results", async event => {
    const state = harness([board], [stored], event);
    await expect(syncWebhooks(state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it.each(["POST", "DELETE"])("checkpoints immediately before provider %s", async method => {
    const state = method === "POST" ? harness() : harness([], [stored]);
    state.context.assertOwnership.mockImplementation(async () => {
      if (state.context.assertOwnership.mock.calls.length === 7) throw new ScheduledJobLeaseLostError();
    });
    await expect(syncWebhooks(state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.fetchMock).not.toHaveBeenCalled();
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["provider-POST", "provider-body"])("stops local storage and later mutations after loss during %s", async event => {
    const state = harness([board], [stored], event);
    await expect(syncWebhooks(state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.fetchMock).toHaveBeenCalledTimes(1);
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it("does not remove the local record or continue after ownership loss during DELETE", async () => {
    const state = harness([], [stored, { ...stored, trelloWebhookId: "next", modelId: "next" }], "provider-DELETE");
    await expect(syncWebhooks(state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.fetchMock).toHaveBeenCalledTimes(1);
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["POST", "DELETE"])("fences the local write following provider %s after slow database acquisition", async method => {
    const state = method === "POST" ? harness() : harness([], [stored]);
    const db = await mocks.getDb();
    mocks.getDb.mockReset().mockResolvedValue(db).mockResolvedValueOnce(db).mockResolvedValueOnce(db)
      .mockImplementationOnce(async () => { state.lose(); return db; });
    await expect(syncWebhooks(state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.fetchMock).toHaveBeenCalledTimes(1);
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["POST", "DELETE"])("does not count success or continue after loss during the local write following %s", async method => {
    const state = method === "POST"
      ? harness([board, { ...board, trelloId: "next" }], [], "local-write")
      : harness([], [stored, { ...stored, trelloWebhookId: "next", modelId: "next" }], "local-write");
    await expect(syncWebhooks(state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.fetchMock).toHaveBeenCalledTimes(1);
    expect(state.execute).toHaveBeenCalledTimes(2);
  });

  it("propagates explicit lease loss thrown by a provider operation", async () => {
    const state = harness();
    state.fetchMock.mockRejectedValue(new ScheduledJobLeaseLostError());
    await expect(syncWebhooks(state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
  });

  it("propagates an aborted request rather than incrementing ordinary errors", async () => {
    const state = harness();
    state.fetchMock.mockImplementation(async (_url, options) => {
      state.controller.abort();
      expect(options.signal?.aborted).toBe(true);
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(syncWebhooks(state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
  });

  it("propagates loss during existing-webhook fallback lookup", async () => {
    const state = harness([board], [stored]);
    state.fetchMock.mockResolvedValueOnce({ ok: false, text: async () => "A webhook with that callback, model, and token already exists" } as any)
      .mockImplementationOnce(async () => { state.lose(); return { ok: true, json: async () => [] } as any; });
    await expect(syncWebhooks(state.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.fetchMock).toHaveBeenCalledTimes(2);
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it("checkpoints every successful provider and local mutation and retains authentication", async () => {
    const state = harness([board], [stored]);
    await expect(syncWebhooks(state.context)).resolves.toEqual({ registered: 1, removed: 1, errors: 0 });
    for (const [index, event] of state.trace.entries()) {
      if ((event.startsWith("provider-") && event !== "provider-body") || event === "local-write") {
        expect(state.trace[index - 1]).toBe("checkpoint");
      }
    }
    for (const [url, options] of state.fetchMock.mock.calls) {
      expect(new URL(url).searchParams.get("key")).toBe("test-key");
      expect(new URL(url).searchParams.get("token")).toBe("test-token");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("keeps ordinary provider failures as errors while ownership is intact", async () => {
    const state = harness();
    state.fetchMock.mockRejectedValue(new Error("Provider unavailable"));
    await expect(syncWebhooks(state.context)).resolves.toEqual({ registered: 0, removed: 0, errors: 1 });
  });

  it("keeps automatic registration disabled by default and in development", async () => {
    const state = harness();
    await initializeWebhookAutoRegister("https://example.invalid");
    vi.stubEnv("NODE_ENV", "development");
    await initializeWebhookAutoRegister("https://example.invalid", true);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(state.fetchMock).not.toHaveBeenCalled();
  });

  it("preserves manual registration and removal without context", async () => {
    const state = harness();
    state.execute.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(registerWebhookForBoard("board-1", "Board")).resolves.toBe(true);
    state.execute.mockResolvedValue({ rows: [{ trelloWebhookId: "webhook-new" }] });
    await expect(removeWebhookForBoard("board-1")).resolves.toBe(true);
    expect(state.fetchMock.mock.calls.map(([, options]) => options.method)).toEqual(["POST", "DELETE"]);
  });
});
