import { describe, expect, it } from "vitest";
import { didUpdateSingleTaskAssignment } from "./taskAssignmentMutation";

describe("didUpdateSingleTaskAssignment", () => {
  it("accepts the MySQL update result for exactly one owned assignment", () => {
    expect(didUpdateSingleTaskAssignment([{ affectedRows: 1 }])).toBe(true);
  });

  it("rejects missing or multi-row updates", () => {
    expect(didUpdateSingleTaskAssignment([{ affectedRows: 0 }])).toBe(false);
    expect(didUpdateSingleTaskAssignment([{ affectedRows: 2 }])).toBe(false);
  });
});
