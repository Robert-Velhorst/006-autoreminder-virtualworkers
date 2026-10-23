import { describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { runCodexBridge } from "../scripts/run-codex-bridge";
import { resolveCodexBridgePaths } from "../shared/codex-bridge-paths.mjs";

const env = {
  CODEX_HOME: resolve("mock-bridge/synthetic-codex-auth"),
  APTLSS_CODEX_EXECUTABLE: "mock-official-codex",
  APTLSS_CODEX_QUEUE_DIR: resolve("mock-bridge/queue"),
  APTLSS_CODEX_PRIVATE_DIR: resolve("mock-bridge/manager-private"),
  APTLSS_CODEX_LLM_PRIVATE_DIR: resolve("mock-bridge/llm-private"),
};
const untilAborted = (signal: AbortSignal) => new Promise<void>(done => {
  if (signal.aborted) return done();
  signal.addEventListener("abort", () => done(), { once: true });
});

describe("private subscription bridge lifecycle", () => {
  it("rejects an outside bridge root even when all transport directories are inside the workspace", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => resolveCodexBridgePaths({ ...env, APTLSS_CODEX_BRIDGE_ROOT: resolve("../outside-bridge") }))
        .toThrow("inside the application workspace");
    } finally { vi.unstubAllEnvs(); }
  });
  it("runs both protocols with separate private work and queue identities, then joins shutdown", async () => {
    const controller = new AbortController();
    let started = 0;
    const manager = vi.fn(async (_queue: string, _work: string, _executable: string, signal: AbortSignal) => {
      started++; await untilAborted(signal);
    });
    const llm = vi.fn(async (_queue: string, _work: string, _executable: string, signal: AbortSignal) => {
      started++; expect(started).toBe(2); controller.abort(); await untilAborted(signal);
    });
    await runCodexBridge(env, controller.signal, { manager, llm });
    expect(manager.mock.calls[0].slice(0, 3)).toEqual([env.APTLSS_CODEX_QUEUE_DIR, env.APTLSS_CODEX_PRIVATE_DIR, env.APTLSS_CODEX_EXECUTABLE]);
    expect(llm.mock.calls[0].slice(0, 3)).toEqual([join(env.APTLSS_CODEX_QUEUE_DIR, "llm-v1"), env.APTLSS_CODEX_LLM_PRIVATE_DIR, env.APTLSS_CODEX_EXECUTABLE]);
    expect(manager.mock.calls[0][3].aborted).toBe(true);
  });

  it("does not report a failed protocol healthy and waits for its peer to stop", async () => {
    let stopped = false;
    await expect(runCodexBridge(env, new AbortController().signal, {
      manager: async () => { throw new Error("synthetic startup failure"); },
      llm: async (_queue, _work, _executable, signal) => { await untilAborted(signal); stopped = true; },
    })).rejects.toThrow("synthetic startup failure");
    expect(stopped).toBe(true);
  });

  it("rejects a silent protocol exit instead of leaving a partial bridge running", async () => {
    await expect(runCodexBridge(env, new AbortController().signal, {
      manager: async () => {},
      llm: async (_queue, _work, _executable, signal) => untilAborted(signal),
    })).rejects.toThrow("stopped unexpectedly");
  });

  it("does not start either runner after cancellation or without an executable", async () => {
    const manager = vi.fn(), llm = vi.fn();
    const controller = new AbortController(); controller.abort();
    await expect(runCodexBridge(env, controller.signal, { manager, llm })).rejects.toThrow();
    await expect(runCodexBridge({}, new AbortController().signal, { manager, llm })).rejects.toThrow("APTLSS_CODEX_EXECUTABLE");
    expect(manager).not.toHaveBeenCalled(); expect(llm).not.toHaveBeenCalled();
  });
});
