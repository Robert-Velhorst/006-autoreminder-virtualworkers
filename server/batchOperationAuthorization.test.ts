import { describe, expect, it } from "vitest";
import { findUnownedBatchTaskIds } from "./batchOperationAuthorization";

describe("batch operation task ownership", () => {
  it("reports only requested tasks that are outside the actor's assignment set", () => {
    expect(findUnownedBatchTaskIds(
      [{ taskId: "card-a:checklist-1:item-1" }, { taskId: "card-b:checklist-2:item-2" }],
      ["card-b:checklist-2:item-2", "other-card:checklist-3:item-3"],
    )).toEqual(["other-card:checklist-3:item-3"]);
  });

  it("accepts a batch when every requested task belongs to the actor", () => {
    expect(findUnownedBatchTaskIds(
      [{ taskId: "card-a" }, { taskId: "card-b" }],
      ["card-a", "card-b"],
    )).toEqual([]);
  });
});
