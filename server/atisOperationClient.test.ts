import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtisOperationClient, ATIS_POLL_INTERVAL_MS, canStartAtisOperation, type AtisOperation } from "../client/src/lib/atis-operation";

const operation = (state: AtisOperation["state"] = "running", kind: AtisOperation["kind"] = "sync", id = 8): AtisOperation => ({ id, kind, state });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const clients: AtisOperationClient[] = [];
function setup(maxStatusReads = 120) {
  const onState = vi.fn();
  const onCompleted = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ operations: [] }));
  const client = new AtisOperationClient({ onState, onCompleted, fetch, maxStatusReads });
  clients.push(client);
  return { client, onState, onCompleted, fetch };
}
const tick = () => vi.advanceTimersByTimeAsync(ATIS_POLL_INTERVAL_MS);
const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const posts = (fetch: ReturnType<typeof setup>["fetch"]) => fetch.mock.calls.filter(([, init]) => init?.method === "POST");

beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const client of clients.splice(0)) client.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Home async ATIS operation client", () => {
  it("does not finish or refresh on 202; chains analysis only after sync completion and polls both serially", async () => {
    const { client, fetch, onCompleted } = setup();
    await client.resume();
    let syncReads = 0;
    fetch.mockImplementation(async (path, init) => {
      if (init?.method === "POST") return json({ operation: operation("running", String(path).endsWith("/sync") ? "sync" : "understanding", String(path).endsWith("/sync") ? 8 : 9) }, 202);
      if (String(path).endsWith("/8")) return json({ operation: operation(++syncReads === 1 ? "running" : "completed") });
      return json({ operation: { ...operation("completed", "understanding", 9), result: { processed: 4, failed: 1 } } });
    });
    const work = client.startSync();
    await settle();
    expect(client.current.status).toBe("running");
    expect(onCompleted).not.toHaveBeenCalled();
    expect(posts(fetch)).toHaveLength(1);
    expect(canStartAtisOperation(client.current)).toBe(false);
    await tick();
    expect(onCompleted).not.toHaveBeenCalled();
    await tick();
    expect(onCompleted).toHaveBeenCalledExactlyOnceWith(operation("completed"));
    expect(posts(fetch)).toHaveLength(2);
    expect(client.current.operation?.kind).toBe("understanding");
    expect(canStartAtisOperation(client.current)).toBe(false);
    await tick(); await work;
    expect(onCompleted).toHaveBeenCalledTimes(2);
    expect(client.current.status).toBe("completed");
    expect(canStartAtisOperation(client.current)).toBe(true);
    expect(JSON.parse(String(posts(fetch)[1][1]?.body))).toEqual({ limit: 50 });
    for (const [, init] of fetch.mock.calls) {
      expect(init?.credentials).toBe("include");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("does not overlap polls or duplicate a POST when callbacks are invoked repeatedly", async () => {
    const { client, fetch } = setup();
    await client.resume();
    let complete!: (response: Response) => void;
    const pendingStatus = new Promise<Response>(resolve => { complete = resolve; });
    fetch.mockImplementation(async (_path, init) => init?.method === "POST" ? json({ operation: operation() }, 202) : pendingStatus);
    const work = client.startSync(); await settle();
    await client.startSync(); await client.resume();
    await tick();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(2); // initial discovery + one in-flight read
    expect(posts(fetch)).toHaveLength(1);
    complete(json({ operation: operation("failed") }));
    await work;
    expect(client.current.status).toBe("failed");
  });

  it.each(["failed", "interrupted"] as const)("shows server-confirmed %s without refresh, chaining or automatic restart", async state => {
    const { client, fetch, onCompleted } = setup();
    await client.resume();
    fetch.mockResolvedValue(json({ operation: operation(state) }, 202));
    await client.startSync();
    expect(client.current.status).toBe(state);
    expect(onCompleted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posts(fetch)).toHaveLength(1);
    expect(canStartAtisOperation(client.current)).toBe(true); // Only another explicit user action may start work.
  });

  it.each(["network", "timeout", "503", "401", "malformed", "identity mismatch"])("retains running work as unconfirmed after a %s status read error", async failure => {
    const { client, fetch, onCompleted } = setup();
    await client.resume();
    fetch.mockImplementation(async (_path, init) => {
      if (init?.method === "POST") return json({ operation: operation() }, 202);
      if (failure === "network") throw new Error("private-provider-error");
      if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError");
      if (failure === "malformed") return new Response("not-json");
      if (failure === "identity mismatch") return json({ operation: operation("completed", "sync", 99) });
      return json({ error: "private-provider-error" }, Number(failure));
    });
    const work = client.startSync(); await settle(); await tick(); await work;
    expect(client.current.status).toBe("unconfirmed");
    expect(client.current.operation).toEqual(operation());
    expect(client.current.message).not.toMatch(/failed|private-provider-error/i);
    expect(onCompleted).not.toHaveBeenCalled();
    expect(canStartAtisOperation(client.current)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posts(fetch)).toHaveLength(1);
  });

  it("a lost POST response never retries automatically and recovery only discovers existing work", async () => {
    const { client, fetch, onCompleted } = setup();
    await client.resume();
    fetch.mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
    await client.startSync();
    expect(client.current.status).toBe("unconfirmed");
    expect(onCompleted).not.toHaveBeenCalled();
    await client.startSync();
    expect(posts(fetch)).toHaveLength(1);
    fetch.mockResolvedValueOnce(json({ operations: [operation()] }))
      .mockResolvedValueOnce(json({ operation: operation("completed") }));
    const resume = client.resume(); await settle(); await tick(); await resume;
    expect(onCompleted).toHaveBeenCalledOnce();
    expect(posts(fetch)).toHaveLength(1);
  });

  it("bounds status polling, keeps the duplicate button disabled and resumes the known ID on explicit request", async () => {
    const { client, fetch, onCompleted } = setup(2);
    await client.resume();
    fetch.mockImplementation(async () => json({ operation: operation() }, 202));
    const work = client.startSync(); await settle(); await tick(); await tick(); await work;
    expect(client.current.status).toBe("unconfirmed");
    expect(client.current.message).toContain("Status checks paused");
    expect(canStartAtisOperation(client.current)).toBe(false);
    expect(onCompleted).not.toHaveBeenCalled();
    expect(fetch.mock.calls.filter(([path]) => path === "/api/atis/operations/8")).toHaveLength(2);
    fetch.mockImplementation(async (_path, init) => json({ operation: init?.method === "POST"
      ? operation("completed", "understanding", 9) : operation("completed") }));
    await client.resume();
    expect(onCompleted).toHaveBeenCalledTimes(2);
    expect(posts(fetch)).toHaveLength(2); // Only the original sync and its now-confirmed analysis continuation.
  });

  it("reload recovery polls active operations without starting new sync or analysis", async () => {
    const { client, fetch, onCompleted } = setup();
    fetch.mockResolvedValueOnce(json({ operations: [operation()] }))
      .mockResolvedValueOnce(json({ operation: operation("completed") }));
    const recovery = client.resume(); await settle();
    expect(onCompleted).not.toHaveBeenCalled();
    expect(client.current.status).toBe("running");
    await tick(); await recovery;
    expect(posts(fetch)).toHaveLength(0);
    expect(onCompleted).toHaveBeenCalledExactlyOnceWith(operation("completed"));
  });

  it.each(["sync", "understanding"] as const)("reload preserves retained interrupted %s without treating it as malformed or posting", async kind => {
    const { client, fetch, onCompleted } = setup();
    fetch.mockResolvedValueOnce(json({ operations: [operation("interrupted", kind)] }));
    await client.resume();
    expect(client.current.status).toBe("interrupted");
    expect(client.current.operation).toEqual(operation("interrupted", kind));
    expect(client.current.message).toContain("Completion is unverified");
    expect(onCompleted).not.toHaveBeenCalled();
    expect(canStartAtisOperation(client.current)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(posts(fetch)).toHaveLength(0);
  });

  it.each(["sync", "understanding"] as const)("sends a matching recovery acknowledgement only for an explicit restart of %s", async kind => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json({ operations: [operation("interrupted", kind)] }));
    await client.resume();
    expect(posts(fetch)).toHaveLength(0);
    fetch.mockResolvedValueOnce(json({ operation: operation("failed", kind, 10) }, 202));
    await client.acknowledgeAndRestart();
    expect(posts(fetch)).toHaveLength(1);
    expect(posts(fetch)[0][0]).toBe(kind === "sync" ? "/api/atis/sync" : "/api/atis/understanding/process");
    expect(JSON.parse(String(posts(fetch)[0][1]?.body))).toEqual({
      ...(kind === "understanding" ? { limit: 50 } : {}), acknowledgeInterruptedOperationId: 8,
    });
  });

  it("shows a POST recovery-required 409 as interrupted without automatically acknowledging it", async () => {
    const { client, fetch, onCompleted } = setup(); await client.resume();
    fetch.mockResolvedValueOnce(json({ operation: operation("interrupted"), error: "Recovery required" }, 409));
    await client.startSync();
    expect(client.current.status).toBe("interrupted");
    expect(onCompleted).not.toHaveBeenCalled();
    expect(posts(fetch)).toHaveLength(1);
    expect(posts(fetch)[0][1]?.body).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posts(fetch)).toHaveLength(1);
  });

  it("a differing-request 409 is explicitly not started and never treats the conflicting job as this request's success", async () => {
    const { client, fetch, onCompleted } = setup(); await client.resume();
    fetch.mockResolvedValueOnce(json({ operation: operation("running", "understanding", 77),
      requestedNotStarted: true, error: "A different request is already running" }, 409));
    await client.startUnderstanding();
    expect(client.current.status).toBe("unconfirmed");
    expect(client.current.message).toContain("Your request was not started");
    expect(client.current.operation?.id).toBe(77);
    expect(canStartAtisOperation(client.current)).toBe(false);
    expect(onCompleted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posts(fetch)).toHaveLength(1);
    fetch.mockResolvedValueOnce(json({ operation: operation("completed", "understanding", 77) }));
    await client.resume();
    expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/atis/operations/77");
    expect(client.current.message).toContain("Your different request was not started");
    expect(onCompleted).not.toHaveBeenCalled();
    expect(posts(fetch)).toHaveLength(1);
  });

  it("resumes multiple active operations serially and retains a confirmed failure", async () => {
    const { client, fetch, onCompleted } = setup();
    fetch.mockResolvedValueOnce(json({ operations: [operation(), operation("running", "understanding", 9)] }))
      .mockResolvedValueOnce(json({ operation: operation("failed") }))
      .mockResolvedValueOnce(json({ operation: operation("completed", "understanding", 9) }));
    const recovery = client.resume(); await settle(); await tick();
    expect(canStartAtisOperation(client.current)).toBe(false);
    await tick(); await recovery;
    expect(client.current.status).toBe("failed");
    expect(onCompleted).toHaveBeenCalledExactlyOnceWith(operation("completed", "understanding", 9));
    expect(posts(fetch)).toHaveLength(0);
  });

  it("uses the returned duplicate operation ID, not an invented local job", async () => {
    const { client, fetch } = setup(); await client.resume();
    fetch.mockResolvedValueOnce(json({ operation: operation("running", "understanding", 77) }, 202))
      .mockResolvedValueOnce(json({ operation: operation("completed", "understanding", 77) }));
    const work = client.startSync(); await settle(); await tick(); await work;
    expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/atis/operations/77");
    expect(posts(fetch)).toHaveLength(1);
  });

  it("rejects legacy synchronous response counts rather than claiming 202 has finished", async () => {
    const { client, fetch, onCompleted } = setup(); await client.resume();
    fetch.mockResolvedValueOnce(json({ totalCards: 20 }, 202));
    await client.startSync();
    expect(client.current.status).toBe("unconfirmed");
    expect(onCompleted).not.toHaveBeenCalled();
    expect(posts(fetch)).toHaveLength(1);
  });

  it("passes caller cancellation through to the fetch wrapper and cancels local polling only", async () => {
    const { client, fetch, onCompleted } = setup(); await client.resume();
    fetch.mockResolvedValueOnce(json({ operation: operation() }, 202));
    const caller = new AbortController();
    const work = client.startSync(caller.signal); await settle();
    const signal = posts(fetch)[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    caller.abort(); await work;
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onCompleted).not.toHaveBeenCalled();
    expect(posts(fetch)).toHaveLength(1);
    expect(fetch.mock.calls).toHaveLength(2);
  });
});
