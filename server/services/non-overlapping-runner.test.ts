import { describe, expect, it } from "vitest";
import { createNonOverlappingRunner } from "./non-overlapping-runner";

describe("createNonOverlappingRunner", () => {
  it("coalesces ticks until the active run settles", async () => {
    let release!: () => void;
    let calls = 0;
    const runner = createNonOverlappingRunner(async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => { release = resolve; });
      }
    });

    const first = runner();
    await expect(runner()).resolves.toBe(false);
    expect(calls).toBe(1);

    release();
    await expect(first).resolves.toBe(true);
    await expect(runner()).resolves.toBe(true);
    expect(calls).toBe(2);
  });

  it("releases the next tick after a failure", async () => {
    let calls = 0;
    const runner = createNonOverlappingRunner(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient failure");
    });

    await expect(runner()).rejects.toThrow("transient failure");
    await expect(runner()).resolves.toBe(true);
    expect(calls).toBe(2);
  });
});
