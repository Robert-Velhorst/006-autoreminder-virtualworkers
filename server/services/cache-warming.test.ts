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
});
