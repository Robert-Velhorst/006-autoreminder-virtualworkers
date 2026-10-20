import { createHash } from "node:crypto";
import { appSettings, vaProfiles } from "../drizzle/schema.postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  resolveWorkerContext: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./workerOperatorContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workerOperatorContext")>();
  return { ...actual, resolveWorkerOperatorContextById: mocks.resolveWorkerContext };
});

import {
  browserTabCollectorTokenMatches,
  hashBrowserTabCollectorToken,
  resolveBrowserTabCollectorWorker,
} from "./browserTabHygiene";

function database(
  scopedRows: unknown[],
  options: { legacyTokenRows?: unknown[]; activeProfiles?: unknown[] } = {},
) {
  let appSettingsReads = 0;
  const db = {
    select: vi.fn(() => {
      let table: unknown;
      const resolveRows = () => {
        if (table === appSettings) {
          appSettingsReads += 1;
          return appSettingsReads === 1 ? scopedRows : options.legacyTokenRows ?? [];
        }
        if (table === vaProfiles) return options.activeProfiles ?? [];
        return [];
      };
      const query: any = {
        from: (value: unknown) => { table = value; return query; },
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve(resolveRows()).then(resolve, reject),
        catch: (reject: (error: unknown) => unknown) => Promise.resolve(resolveRows()).catch(reject),
      };
      return query;
    }),
  };
  return db;
}

describe("browser tab collector tokens", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores and verifies one-way token hashes", () => {
    const token = "collector-secret";
    const stored = hashBrowserTabCollectorToken(token);

    expect(stored).toMatch(/^sha256:/);
    expect(stored).not.toContain(token);
    expect(browserTabCollectorTokenMatches(stored, token)).toBe(true);
    expect(browserTabCollectorTokenMatches(stored, "incorrect-token")).toBe(false);
  });

  it("accepts legacy raw values only for the controlled migration path", () => {
    expect(browserTabCollectorTokenMatches("legacy-token", "legacy-token")).toBe(true);
    expect(browserTabCollectorTokenMatches("legacy-token", "different-token")).toBe(false);
  });

  it("accepts hashes created by the additive database migration", () => {
    const hexHash = `sha256hex:${createHash("sha256").update("database-token").digest("hex")}`;
    expect(browserTabCollectorTokenMatches(hexHash, "database-token")).toBe(true);
    expect(browserTabCollectorTokenMatches(hexHash, "different-token")).toBe(false);
  });

  it("rejects a previously issued token when its worker no longer has an active profile", async () => {
    const db = database([{ vaId: 42, value: hashBrowserTabCollectorToken("collector-secret") }]);
    mocks.getDb.mockResolvedValue(db);
    mocks.resolveWorkerContext.mockResolvedValue({ profileId: null });

    await expect(resolveBrowserTabCollectorWorker("collector-secret")).resolves.toBeNull();
    expect(mocks.resolveWorkerContext).toHaveBeenCalledWith(42, db);
  });

  it("accepts a scoped token only for one active worker owner", async () => {
    const db = database([{ vaId: 42, value: hashBrowserTabCollectorToken("collector-secret") }]);
    mocks.getDb.mockResolvedValue(db);
    mocks.resolveWorkerContext.mockResolvedValue({ profileId: 6 });

    await expect(resolveBrowserTabCollectorWorker("collector-secret")).resolves.toBe(42);
  });

  it("rejects a token that matches multiple worker owners", async () => {
    const token = hashBrowserTabCollectorToken("collector-secret");
    const db = database([{ vaId: 42, value: token }, { vaId: 43, value: token }]);
    mocks.getDb.mockResolvedValue(db);

    await expect(resolveBrowserTabCollectorWorker("collector-secret")).resolves.toBeNull();
    expect(mocks.resolveWorkerContext).not.toHaveBeenCalled();
  });

  it("rejects the retired global token as soon as a worker-scoped token exists", async () => {
    const db = database(
      [{ vaId: 42, value: hashBrowserTabCollectorToken("replacement-token") }],
      {
        legacyTokenRows: [{ value: "retired-global-token" }],
        activeProfiles: [{ userId: 42, status: "active" }],
      },
    );
    mocks.getDb.mockResolvedValue(db);

    await expect(resolveBrowserTabCollectorWorker("retired-global-token")).resolves.toBeNull();
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(mocks.resolveWorkerContext).not.toHaveBeenCalled();
  });
});
