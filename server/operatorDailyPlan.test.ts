import { describe, expect, it } from "vitest";
import { replanFutureBlocks, type OperatorPlanBlock, validateOperatorPlanBlocks } from "./operatorDailyPlan";

const block = (id: string, startTime: string, endTime: string, status: OperatorPlanBlock["status"] = "planned"): OperatorPlanBlock => ({
  id,
  startTime,
  endTime,
  cardId: id,
  cardName: id,
  cardUrl: null,
  boardName: "Board",
  listName: "TO DO",
  action: "Act",
  stepIds: [],
  priority: "MEDIUM",
  score: 1,
  state: "NEW",
  status,
  notes: "",
  flags: [],
});

describe("operator daily plan replanning", () => {
  it("keeps completed and active blocks fixed while moving only future planned work", () => {
    const result = replanFutureBlocks({
      blocks: [
        block("done", "09:00", "10:00", "done"),
        block("active", "10:00", "11:00", "active"),
        block("first", "11:00", "12:00"),
        block("second", "12:00", "13:00"),
      ],
      schedule: { startTime: "09:00", endTime: "15:00", breaks: [{ name: "Lunch", startTime: "12:00", durationMinutes: 30 }] },
      nowTime: "10:30",
    });

    expect(result.blocks.find((item) => item.id === "done")).toMatchObject({ startTime: "09:00", endTime: "10:00", status: "done" });
    expect(result.blocks.find((item) => item.id === "active")).toMatchObject({ startTime: "10:00", endTime: "11:00", status: "active" });
    expect(result.blocks.find((item) => item.id === "first")).toMatchObject({ startTime: "11:00", endTime: "12:00", status: "planned" });
    expect(result.blocks.find((item) => item.id === "second")).toMatchObject({ startTime: "12:30", endTime: "13:30", status: "planned" });
    expect(result.unscheduled).toEqual([]);
  });

  it("rejects manual plan updates outside the protected worker schedule", () => {
    expect(() => validateOperatorPlanBlocks({
      blocks: [block("outside", "08:30", "09:30")],
      schedule: { startTime: "09:00", endTime: "17:00", breaks: [] },
    })).toThrow("within configured working windows");
  });
});
