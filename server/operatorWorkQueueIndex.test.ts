import { describe, expect, it } from "vitest";
import { indexWorkQueueSteps } from "./operatorWorkQueueIndex";

describe("indexWorkQueueSteps", () => {
  it("groups steps once by card without dropping their original order", () => {
    const grouped = indexWorkQueueSteps([
      { cardId: "card-a", title: "First" },
      { cardId: "card-b", title: "Only" },
      { cardId: "card-a", title: "Second" },
    ]);

    expect(grouped.get("card-a")?.map((step) => step.title)).toEqual(["First", "Second"]);
    expect(grouped.get("card-b")?.map((step) => step.title)).toEqual(["Only"]);
    expect(grouped.get("missing")).toBeUndefined();
  });
});
