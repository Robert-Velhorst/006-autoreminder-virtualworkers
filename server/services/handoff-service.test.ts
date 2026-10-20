import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDb } = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("../db", () => ({ getDb }));

import { saveHandoffNote } from "./handoff-service";

describe("saveHandoffNote", () => {
  beforeEach(() => {
    getDb.mockReset();
  });

  it("does not report success when no assignment belongs to the worker", async () => {
    const where = vi.fn().mockResolvedValue([{ affectedRows: 0 }]);
    const set = vi.fn().mockReturnValue({ where });
    getDb.mockResolvedValue({ update: vi.fn().mockReturnValue({ set }) });

    await expect(saveHandoffNote("unassigned-task", 7, "Ready for review")).resolves.toBe(false);
  });

  it("reports success only after updating the worker-owned assignment", async () => {
    const where = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    const set = vi.fn().mockReturnValue({ where });
    getDb.mockResolvedValue({ update: vi.fn().mockReturnValue({ set }) });

    await expect(saveHandoffNote("assigned-task", 7, "Ready for review")).resolves.toBe(true);
  });
});
