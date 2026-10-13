import { describe, expect, it } from "vitest";
import { classifyBrowserCollectorImport } from "./operator-data-transfer-ownership.mjs";

const collector = {
  id: 8,
  vaId: 3,
  collectorId: "collector-a",
  captureSequence: 7,
  collectorLabel: "Worker browser",
  totalTabs: 2,
  pinnedTabs: 0,
  windowCount: 1,
  tabsJson: "[]",
};

describe("browser collector data-transfer ownership", () => {
  it("allows a new collector row", () => {
    expect(classifyBrowserCollectorImport([], collector)).toEqual({ action: "insert" });
  });

  it("refuses to transfer a collector to another worker", () => {
    expect(classifyBrowserCollectorImport([collector], { ...collector, vaId: 4 })).toMatchObject({
      action: "conflict",
      reason: "collector belongs to a different worker",
    });
  });

  it("refuses a primary-key collision with a different collector", () => {
    expect(classifyBrowserCollectorImport([collector], { ...collector, collectorId: "collector-b" })).toMatchObject({
      action: "conflict",
      reason: "row ID or collector ID belongs to another collector",
    });
  });

  it("skips older and identical exports without rewinding freshness", () => {
    expect(classifyBrowserCollectorImport([collector], { ...collector, captureSequence: 6 })).toMatchObject({
      action: "skip",
      reason: "exported browser snapshot is older than the target",
    });
    expect(classifyBrowserCollectorImport([collector], collector)).toMatchObject({
      action: "skip",
      reason: "identical collector snapshot already exists",
    });
  });

  it("rejects different data at the same sequence and accepts a newer sequence", () => {
    expect(classifyBrowserCollectorImport([collector], { ...collector, tabsJson: "[{}]" })).toMatchObject({
      action: "conflict",
      reason: "same collector sequence contains different data",
    });
    expect(classifyBrowserCollectorImport([collector], { ...collector, captureSequence: 8 })).toMatchObject({
      action: "update",
      existing: collector,
    });
  });
});
