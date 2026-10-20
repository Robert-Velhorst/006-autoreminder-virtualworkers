import { describe, expect, it } from "vitest";
import { didUpdateSingleTaskAssignment } from "./taskAssignmentMutation";

describe("didUpdateSingleTaskAssignment", () => {
  it("accepts the PostgreSQL update result for exactly one owned assignment", () => {
    expect(didUpdateSingleTaskAssignment({ rowCount: 1 })).toBe(true);
  });

  it("rejects missing or multi-row updates", () => {
    for (const result of [undefined, null, {}, { rowCount: null }, { rowCount: 0 }, { rowCount: 2 }, { rowCount: "1" }, [{ affectedRows: 1 }]]) {
      expect(didUpdateSingleTaskAssignment(result)).toBe(false);
    }
  });
});
