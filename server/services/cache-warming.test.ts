import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("../db", () => ({
  getDb: mocks.getDb,
}));

import { warmUpCache } from "./cache-warming";

describe("cache warming", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shares one database preload when callers overlap", async () => {
    let releaseFirstQuery: ((value: unknown[]) => void) | undefined;
    const firstQuery = new Promise<unknown[]>((resolve) => {
      releaseFirstQuery = resolve;
    });
    const select = vi.fn(() => ({
      from: () => Object.assign(firstQuery, { limit: () => firstQuery }),
    }));
    mocks.getDb.mockResolvedValue({ select });

    const first = warmUpCache();
    const second = warmUpCache();
    await Promise.resolve();

    expect(select).toHaveBeenCalledTimes(1);

    releaseFirstQuery?.([]);
    await Promise.all([first, second]);
  });

  it("clears a failed shared preload without an unhandled cleanup rejection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getDb.mockRejectedValueOnce(new Error("Synthetic database outage"));
    const first = warmUpCache();
    expect(warmUpCache()).toBe(first);
    await expect(first).rejects.toThrow("Synthetic database outage");
    await new Promise(resolve => setTimeout(resolve, 0));
    mocks.getDb.mockResolvedValue({ select: () => ({
      from: () => Object.assign(Promise.resolve([]), { limit: async () => [] }),
    }) });
    const recovered = warmUpCache();
    expect(recovered).not.toBe(first);
    await expect(recovered).resolves.toMatchObject({ mode: "database_buffer_preload" });
  });
});
