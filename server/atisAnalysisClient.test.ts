import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtisAnalysisClient, canAttributeAnalysis, parseAnalysis, parseAnalysisPreview } from "../client/src/lib/atis-analysis";
import { AtisOperationClient } from "../client/src/lib/atis-operation";
import type { AtisAnalysisJob, AtisAnalysisPreview } from "../shared/atisAnalysis";

const id = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const preview = (extra: Partial<AtisAnalysisPreview> = {}): AtisAnalysisPreview => ({ id, expiresAt: new Date(Date.now() + 600_000).toISOString(), matched: 2, total: 2, remaining: 0,
  cards: [{ id: 1, name: "Private card A" }, { id: 2, name: "Private card B" }], ...extra });
const job = (state: AtisAnalysisJob["state"] = "running", extra: Partial<AtisAnalysisJob> = {}): AtisAnalysisJob => ({ id, state, matched: 2, total: 2, remaining: 0, processed: state === "completed" ? 2 : 0,
  generated: state === "completed" ? 2 : 0, fallback: 0, missing: 0, failed: 0, uncertain: 0, pending: state === "completed" ? 0 : 2,
  items: [{ cardId: 1, cardName: "Private card A", state: state === "completed" ? "generated" : "pending" }, { cardId: 2, cardName: "Private card B", state: state === "completed" ? "generated" : "calling" }], ...extra });
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
const clients: AtisAnalysisClient[] = [];
function fixture(actor = "1:admin", values = new Map<string, string>(), maxReads = 120) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const onCompleted = vi.fn();
  const onState = vi.fn();
  const client = new AtisAnalysisClient({ actor, fetch, onCompleted, onState, maxReads,
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } } });
  clients.push(client);
  return { client, fetch, onCompleted, onState, values };
}
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const confirms = (f: ReturnType<typeof fixture>) => f.fetch.mock.calls.filter(([, init]) => init?.body && JSON.parse(String(init.body)).phase === "confirm");
beforeEach(() => vi.useFakeTimers());
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("durable ATIS client admission", () => {
  it("requires a matching single-card result even when this controller owns the admitted job", () => {
    const a = job("completed", { total: 1, matched: 1, processed: 1, generated: 1, items: [{ cardId: 1, cardName: "A", state: "generated" }] });
    expect(canAttributeAnalysis(a, { mode: "single", cardId: 99 }, true)).toBe(false);
    expect(canAttributeAnalysis(a, { mode: "single", cardId: 1 }, true)).toBe(true);
    expect(canAttributeAnalysis(a, { mode: "single", cardId: 1 }, false)).toBe(true);
    expect(canAttributeAnalysis(a, { mode: "reanalyze", boardId: 7 }, false)).toBe(false);
    expect(canAttributeAnalysis(a, { mode: "reanalyze", boardId: 7 }, true)).toBe(true);
  });
  it("loads a DB-only preview without any confirmation and freezes interview guidance", async () => {
    const f = fixture(); f.fetch.mockResolvedValue(json({ preview: preview({ total: 1, matched: 1, cards: [{ id: 1, name: "Private card A" }] }) }));
    const selection = { mode: "single" as const, cardId: 1, guidance: { goal: "Reviewed goal", deliverable: "Report", successCriteria: ["Source checked"] } };
    await f.client.preview(selection);
    selection.guidance.goal = "Changed draft";
    expect(f.client.current.phase).toBe("preview");
    expect(confirms(f)).toHaveLength(0);
    expect(JSON.parse(String(f.fetch.mock.calls[0][1]?.body))).toEqual({ selection: { ...selection, guidance: { ...selection.guidance, goal: "Reviewed goal" }, limit: 1 } });
    expect(f.values.size).toBe(0);
  });

  it("does not finish on 202; polls serially and only refreshes after completion", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ preview: preview() })).mockResolvedValueOnce(json({ analysis: job("queued") }, 202))
      .mockResolvedValueOnce(json({ analysis: job() })).mockResolvedValueOnce(json({ analysis: job("completed") }));
    await f.client.preview({ mode: "pending" });
    const pending = f.client.confirm(); await settle();
    expect(f.client.current.analysis?.state).toBe("queued"); expect(f.onCompleted).not.toHaveBeenCalled();
    await f.client.confirm(); expect(confirms(f)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000); expect(f.onCompleted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000); await pending;
    expect(f.onCompleted).toHaveBeenCalledTimes(1); expect(f.values.size).toBe(0);
    expect(f.fetch.mock.calls.slice(2).every(([, init]) => !init?.method)).toBe(true);
  });

  it("recovers an ambiguous confirmation by GET of preview ID, never replaying its POST", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ preview: preview() })).mockRejectedValueOnce(new TypeError("network uncertain"));
    await f.client.preview({ mode: "pending" }); await f.client.confirm();
    expect(f.client.current.phase).toBe("paused"); expect([...f.values.values()]).toEqual([id]);
    const payload = JSON.parse(String(confirms(f)[0][1]?.body)); expect(payload.requestKey).toMatch(/^[0-9a-f-]{36}$/); expect(payload.previewId).toBe(id);
    const resumed = fixture("1:admin", f.values); resumed.fetch.mockResolvedValue(json({ analysis: job("completed") }));
    await resumed.client.resume(); expect(resumed.fetch.mock.calls[0][0]).toBe(`/api/atis/understanding/analyses/${id}`);
    expect(confirms(resumed)).toHaveLength(0); expect(resumed.onCompleted).toHaveBeenCalledTimes(1);
  });

  it("stores only a non-private UUID and does not adopt another actor's job", async () => {
    const values = new Map([["atis-analysis:v1:1:admin", id]]);
    for (const actor of ["2:admin", "1:worker"]) {
      const f = fixture(actor, values); await f.client.resume(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.client.current.phase).toBe("idle");
    }
  });

  it("does not combine a resumed foreign job cursor with an unrelated in-memory preview selection", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ preview: preview({ id: secondId }) }))
      .mockResolvedValueOnce(json({ analysis: job("completed", { matched: 8, remaining: 6, nextAfterCardId: 2 }) }));
    await f.client.preview({ mode: "reanalyze", boardId: 99 });
    f.values.set("atis-analysis:v1:1:admin", id);
    await f.client.resume();
    expect(f.client.ownsAnalysis(id)).toBe(false); expect(f.client.canNextBatch).toBe(false);
    const count = f.fetch.mock.calls.length; await f.client.nextBatch(); expect(f.fetch).toHaveBeenCalledTimes(count);
  });

  it("requires separately acknowledged recovery matching the frozen preview", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ preview: preview({ recoveryOperationId: 77 }) })).mockResolvedValueOnce(json({ analysis: job("completed") }, 202));
    await f.client.preview({ mode: "pending" });
    await f.client.confirm(); await f.client.confirm(78); expect(confirms(f)).toHaveLength(0);
    await f.client.confirm(77);
    expect(JSON.parse(String(confirms(f)[0][1]?.body)).acknowledgeInterruptedOperationId).toBe(77);
  });

  it("keeps an ambiguous 404 locked until explicit unknown-outcome acknowledgement, never replaying confirmation", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ preview: preview() })).mockRejectedValueOnce(new TypeError("uncertain"))
      .mockResolvedValueOnce(json({ error: "Not found" }, 404)).mockResolvedValueOnce(json({ preview: preview({ id: secondId }) }));
    await f.client.preview({ mode: "pending" }); await f.client.confirm(); await f.client.resume();
    expect(f.client.current.unknownOutcome).toBe(true); expect([...f.values.values()]).toEqual([id]);
    await f.client.preview({ mode: "pending" }); await f.client.reviewUnknownOutcome({ mode: "pending" }, false);
    expect(f.fetch).toHaveBeenCalledTimes(3); expect(confirms(f)).toHaveLength(1);
    await f.client.reviewUnknownOutcome({ mode: "pending" }, true);
    expect(f.client.current.phase).toBe("preview"); expect(f.client.current.preview?.id).toBe(secondId); expect(confirms(f)).toHaveLength(1);
  });

  it("uses persisted item outcomes rather than treating fallback/missing/uncertain as generated", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ preview: preview() })).mockResolvedValueOnce(json({ analysis: job("interrupted", {
      processed: 1, generated: 0, fallback: 1, uncertain: 1, pending: 0,
      items: [{ cardId: 1, cardName: "A", state: "fallback" }, { cardId: 2, cardName: "B", state: "uncertain" }],
    }) }, 202));
    await f.client.preview({ mode: "reanalyze", forceAll: true }); await f.client.confirm();
    expect(f.client.current.analysis).toMatchObject({ state: "interrupted", generated: 0, fallback: 1, uncertain: 1 }); expect(f.onCompleted).not.toHaveBeenCalled();
    expect([...f.values.values()]).toEqual([id]);
  });

  it("requires a separate explicit next-batch preview and confirm with unchanged filters and stable cursor", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ preview: preview({ matched: 8, remaining: 6, nextAfterCardId: 2 }) }))
      .mockResolvedValueOnce(json({ analysis: job("completed", { matched: 8, remaining: 6, nextAfterCardId: 2 }) }, 202))
      .mockResolvedValueOnce(json({ preview: preview({ id: secondId }) }));
    await f.client.preview({ mode: "reanalyze", boardId: 7 }); await f.client.confirm();
    expect(f.client.canNextBatch).toBe(true); expect(confirms(f)).toHaveLength(1);
    await f.client.nextBatch(); expect(JSON.parse(String(f.fetch.mock.calls[2][1]?.body))).toEqual({ selection: { mode: "reanalyze", boardId: 7, limit: 100, afterCardId: 2 } });
    expect(f.client.current.phase).toBe("preview"); expect(confirms(f)).toHaveLength(1);
  });

  it("never silently confirms an expired or empty preview", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ preview: preview({ expiresAt: new Date(Date.now() - 1).toISOString() }) }));
    await f.client.preview({ mode: "pending" }); await f.client.confirm(); expect(confirms(f)).toHaveLength(0);
    f.fetch.mockResolvedValueOnce(json({ preview: preview({ total: 0, cards: [] }) }));
    await f.client.preview({ mode: "pending" }); await f.client.confirm(); expect(confirms(f)).toHaveLength(0);
  });

  it("refreshes an expired next-batch preview without losing the advanced cursor", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ preview: preview({ matched: 8, remaining: 6, nextAfterCardId: 2 }) }))
      .mockResolvedValueOnce(json({ analysis: job("completed", { matched: 8, remaining: 6, nextAfterCardId: 2 }) }, 202))
      .mockResolvedValueOnce(json({ preview: preview({ id: secondId, expiresAt: new Date(Date.now() + 1000).toISOString() }) }))
      .mockResolvedValueOnce(json({ preview: preview({ id: secondId }) }));
    await f.client.preview({ mode: "reanalyze", boardId: 7 }); await f.client.confirm(); await f.client.nextBatch();
    await vi.advanceTimersByTimeAsync(1001); await f.client.confirm(); expect(confirms(f)).toHaveLength(1);
    await f.client.refreshPreview();
    expect(JSON.parse(String(f.fetch.mock.calls[3][1]?.body)).selection).toEqual({ mode: "reanalyze", boardId: 7, limit: 100, afterCardId: 2 });
  });

  it("respects status Retry-After and read cooldown without claiming server failure", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ preview: preview() })).mockResolvedValueOnce(json({ analysis: job() }, 202))
      .mockResolvedValueOnce(json({ error: "limited" }, 429, { "Retry-After": "10" })).mockResolvedValueOnce(json({ analysis: job("completed") }));
    await f.client.preview({ mode: "pending" }); const pending = f.client.confirm(); await settle();
    await vi.advanceTimersByTimeAsync(2000); await pending; expect(f.client.current.phase).toBe("paused");
    expect(f.client.current.analysis?.state).toBe("running"); const count = f.fetch.mock.calls.length;
    await f.client.resume(); expect(f.fetch).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(10_000); await f.client.resume(); expect(f.onCompleted).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After on successful pending reads too", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ preview: preview() })).mockResolvedValueOnce(json({ analysis: job() }, 202, { "Retry-After": "10" }))
      .mockResolvedValueOnce(json({ analysis: job("completed") }));
    await f.client.preview({ mode: "pending" }); const pending = f.client.confirm(); await settle();
    await vi.advanceTimersByTimeAsync(9000); expect(f.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); await pending; expect(f.onCompleted).toHaveBeenCalledTimes(1);
  });

  it("bounded polling and pause never cancel the server or POST a retry", async () => {
    const f = fixture("1:admin", new Map(), 0); f.fetch.mockResolvedValueOnce(json({ preview: preview() })).mockResolvedValueOnce(json({ analysis: job() }, 202));
    await f.client.preview({ mode: "pending" }); await f.client.confirm(); expect(f.client.current.phase).toBe("paused"); expect(f.onCompleted).not.toHaveBeenCalled(); expect(confirms(f)).toHaveLength(1);
    expect(f.client.current.message).toContain("has not been cancelled");
  });

  it("actor disposal aborts observation without any completion callback or more requests", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ preview: preview() })).mockResolvedValueOnce(json({ analysis: job() }, 202));
    await f.client.preview({ mode: "pending" }); const pending = f.client.confirm(); await settle(); f.client.dispose();
    await pending; await vi.advanceTimersByTimeAsync(60_000); expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.onCompleted).not.toHaveBeenCalled();
  });

  it("rejects malformed progress/oversized selection DTOs", () => {
    expect(() => parseAnalysis(job("running", { total: 101 }))).toThrow();
    expect(() => parseAnalysis(job("running", { items: [] }))).toThrow();
    expect(() => parseAnalysisPreview(preview({ id: "not-a-uuid" }))).toThrow();
  });

  it("keeps Home sync but never silently chains the old process POST", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ operations: [] })).mockResolvedValueOnce(json({ operation: { id: 1, kind: "sync", state: "completed" } }, 202));
    const sync = new AtisOperationClient({ fetch, chainUnderstanding: false, onState: vi.fn(), onCompleted: vi.fn() });
    await sync.resume(); await sync.startSync(); expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([path]) => path)).toEqual(["/api/atis/sync"]); sync.stop();
  });
});
