import { describe, expect, it, vi } from "vitest";
import { runCodexCascade } from "./aptlssManagerCodexCascade";
const input = JSON.stringify({ cards: [{ id: "c1", actions: [], evidence: [
  { id: "e1", text: "The current version is revised." },
  { id: "e2", text: "The previous version is obsolete." },
] }] });
const result = (status = "adequate", reason = "none", evidenceIds: string[] = []) => ({
  text: JSON.stringify({ claims: [], actions: [], interventions: [], contextCheck: { status, reason, evidenceIds } }),
  usage: { input_tokens: 100, output_tokens: 20 },
});
const deeper = () => result("needs_more_reasoning", "chronology", ["e1", "e2"]);

describe("Luna adaptive reasoning", () => {
  it("starts low and stops immediately on an adequate validated result", async () => {
    const execute = vi.fn().mockResolvedValue(result());
    const r = await runCodexCascade(input, new AbortController().signal, execute);
    expect(execute.mock.calls.map(c => c[0])).toEqual(["low"]);
    expect(r).toMatchObject({ status: "completed", effort: "low", attempts: [{ effort: "low", outcome: "accepted", inputTokens: 100, outputTokens: 20 }] });
    expect(JSON.parse(r.text!)).toEqual({ claims: [], actions: [], interventions: [] });
  });
  it("escalates sequentially only as far as needed for context", async () => {
    const execute = vi.fn().mockResolvedValueOnce(deeper()).mockResolvedValueOnce(result());
    const r = await runCodexCascade(input, new AbortController().signal, execute);
    expect(execute.mock.calls.map(c => c[0])).toEqual(["low", "medium"]);
    expect(execute.mock.calls[1][1]).toContain("chronology");
    expect(r.attempts.map(a => a.outcome)).toEqual(["context_review", "accepted"]);
    expect(r.effort).toBe("medium");
  });
  it("uses high only after both lower stages need deeper reasoning", async () => {
    const execute = vi.fn().mockResolvedValueOnce(deeper()).mockResolvedValueOnce(deeper()).mockResolvedValueOnce(result());
    const r = await runCodexCascade(input, new AbortController().signal, execute);
    expect(execute.mock.calls.map(c => c[0])).toEqual(["low", "medium", "high"]);
    expect(r.status).toBe("completed");
  });
  it("never exceeds high and never accepts an unresolved high-stage assessment", async () => {
    const execute = vi.fn().mockResolvedValue(deeper());
    const r = await runCodexCascade(input, new AbortController().signal, execute);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(r.status).toBe("rejected");
    expect(r).not.toHaveProperty("text");
  });
  it("does not escalate to invent missing evidence", async () => {
    const execute = vi.fn().mockResolvedValue(result("missing_evidence", "missing_evidence"));
    const r = await runCodexCascade(input, new AbortController().signal, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(r.attempts[0].outcome).toBe("missing_evidence");
  });
  it("repairs malformed output at the next level without accepting the first candidate", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ text: "not JSON" }).mockResolvedValueOnce(result());
    const r = await runCodexCascade(input, new AbortController().signal, execute);
    expect(execute.mock.calls.map(c => c[0])).toEqual(["low", "medium"]);
    expect(r.attempts[0].outcome).toBe("invalid_output");
    expect(r.status).toBe("completed");
  });
  it("applies exact citation validation at every effort", async () => {
    const bad = JSON.parse(result().text);
    bad.claims = [{ cardId: "c1", subject: "Version", topic: "status", value: "revised", citations: [{ evidenceId: "e1", quote: "Invented source passage" }] }];
    const execute = vi.fn().mockResolvedValue({ text: JSON.stringify(bad) });
    const r = await runCodexCascade(input, new AbortController().signal, execute);
    expect(r.status).toBe("rejected");
    expect(r.attempts.map(a => a.outcome)).toEqual(["invalid_output", "invalid_output", "invalid_output"]);
  });
  it("does not escalate a prohibited claim to get around an authority check", async () => {
    const bad = JSON.parse(result().text);
    bad.claims = [{ cardId: "c1", subject: "Version", topic: "status", value: "send now", citations: [{ evidenceId: "e1", quote: "The current version is revised." }] }];
    const execute = vi.fn().mockResolvedValue({ text: JSON.stringify(bad) });
    const r = await runCodexCascade(input, new AbortController().signal, execute);
    expect(r.status).toBe("rejected"); expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each(["unauthenticated", "limited", "unavailable", "rejected", "unexpected process error"])("does not escalate %s", async failure => {
    const execute = vi.fn().mockRejectedValue(new Error(failure));
    const r = await runCodexCascade(input, new AbortController().signal, execute);
    expect(execute).toHaveBeenCalledTimes(1); expect(r.status).not.toBe("completed");
  });
  it("does not count duplicated source text as independent context", async () => {
    const repeated = JSON.parse(input); repeated.cards[0].evidence[1].text = repeated.cards[0].evidence[0].text;
    const execute = vi.fn().mockResolvedValueOnce(deeper()).mockResolvedValueOnce(result());
    const r = await runCodexCascade(JSON.stringify(repeated), new AbortController().signal, execute);
    expect(r.attempts[0].outcome).toBe("invalid_output");
  });
  it("does not accept completed output after cancellation", async () => {
    const controller = new AbortController();
    const execute = vi.fn().mockImplementation(async () => { controller.abort(); return result(); });
    const r = await runCodexCascade(input, controller.signal, execute);
    expect(r.status).toBe("unavailable"); expect(execute).toHaveBeenCalledTimes(1);
  });
  it("starts a new assessment at low even after a prior high result", async () => {
    const execute = vi.fn().mockResolvedValueOnce(deeper()).mockResolvedValueOnce(deeper()).mockResolvedValue(result());
    await runCodexCascade(input, new AbortController().signal, execute);
    await runCodexCascade(input, new AbortController().signal, execute);
    expect(execute.mock.calls.map(c => c[0])).toEqual(["low", "medium", "high", "low"]);
  });
});
