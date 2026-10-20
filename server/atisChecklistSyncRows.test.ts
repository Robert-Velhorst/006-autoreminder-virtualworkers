import { describe, expect, it } from "vitest";
import { normalizeChecklistSyncCardIds, toChecklistSyncCards } from "./atisChecklistSyncRows";

describe("ATIS checklist sync row normalization", () => {
  it("keeps only positive unique card IDs", () => {
    expect(normalizeChecklistSyncCardIds([4, "4", 9, 0, -1, "bad"])).toEqual([4, 9]);
  });

  it("keeps only rows with a Trello card and a non-empty parsed checklist", () => {
    expect(toChecklistSyncCards([
      { id: 4, trello_id: "trello-4", aptlssChecklist: '[{"step":"First step","timeMinutes":15,"aptlssType":"A"}]' },
      { id: 5, trello_id: "trello-5", aptlssChecklist: "not json" },
      { id: 6, trello_id: "", aptlssChecklist: "[]" },
      { id: 7, trello_id: "trello-7", aptlssChecklist: '[{"name":"Generated step","estimatedMinutes":20,"priority":"T"}]' },
      { id: 8, trello_id: "trello-8", aptlssChecklist: '[{"name":"Malformed","estimatedMinutes":20,"priority":"X"}]' },
    ])).toEqual([
      { cardId: 4, trelloId: "trello-4", checklist: [{ step: "First step", timeMinutes: 15, aptlssType: "A" }] },
      { cardId: 7, trelloId: "trello-7", checklist: [{ step: "Generated step", timeMinutes: 20, aptlssType: "T" }] },
    ]);
  });
});
