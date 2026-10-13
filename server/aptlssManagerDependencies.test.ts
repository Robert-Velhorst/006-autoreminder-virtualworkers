import { describe, expect, it } from "vitest";
import { normalizeManagerDependencies } from "./aptlssManagerDependencies";

const steps = [
  { id: 147, cardId: "a", stepNumber: 1 },
  { id: 148, cardId: "a", stepNumber: 2 },
  { id: 152, cardId: "a", stepNumber: 6 },
  { id: 200, cardId: "b", stepNumber: 1 },
];

describe("persisted manager dependency references", () => {
  it("maps generated step numbers to persisted IDs on the same card", () => {
    expect(normalizeManagerDependencies("a", ["2", "6"], steps)).toEqual(["a:148", "a:152"]);
  });
  it("retains unambiguous legacy database IDs", () => {
    expect(normalizeManagerDependencies("a", ["148"], steps)).toEqual(["a:148"]);
  });
  it("resolves explicit Step labels by ordinal, never by database ID", () => {
    expect(normalizeManagerDependencies("a", ["Step 2", " step 6 ", "Step 148"], steps)).toEqual(["a:148", "a:152", "unresolved:Step 148"]);
  });
  it("resolves a regenerated ordinal against its active step, not obsolete history", () => {
    const regenerated = [
      { id: 147, cardId: "a", stepNumber: 1, status: "obsolete" },
      { id: 245, cardId: "a", stepNumber: 1, status: "open" },
    ];
    expect(normalizeManagerDependencies("a", ["Step 1"], regenerated)).toEqual(["a:245"]);
    expect(normalizeManagerDependencies("a", ["1"], regenerated)).toEqual(["a:245"]);
  });
  it("does not treat a direct reference to an obsolete step as satisfied", () => {
    const history = [{ id: 147, cardId: "a", stepNumber: 1, status: "obsolete" }];
    expect(normalizeManagerDependencies("b", ["a:147"], history)).toEqual(["unresolved:a:147"]);
    expect(normalizeManagerDependencies("b", ["147"], history)).toEqual(["unresolved:147"]);
  });
  it("rejects a qualified reference when its exact step is missing from current records", () => {
    expect(normalizeManagerDependencies("b", ["a:999"], steps)).toEqual(["unresolved:a:999"]);
    expect(normalizeManagerDependencies("b", ["missing-card:999"], steps)).toEqual(["unresolved:missing-card:999"]);
  });
  it("expands a card prerequisite to all current steps but not obsolete history", () => {
    const history = [
      { id: 147, cardId: "a", stepNumber: 1, status: "obsolete" },
      { id: 245, cardId: "a", stepNumber: 1, status: "complete" },
      { id: 246, cardId: "a", stepNumber: 2, status: "open" },
    ];
    expect(normalizeManagerDependencies("b", ["a"], history)).toEqual(["a:245", "a:246"]);
    expect(normalizeManagerDependencies("b", ["a"], history.slice(0, 1))).toEqual(["unresolved:a"]);
  });
  it("does not resolve an ordinal through another card", () => {
    expect(normalizeManagerDependencies("c", ["2"], steps)).toEqual(["unresolved:2"]);
  });
  it("fails closed when a number means two different steps", () => {
    expect(normalizeManagerDependencies("a", ["2"], [...steps, { id: 2, cardId: "a", stepNumber: 3 }])).toEqual(["unresolved:2"]);
  });
  it("fails closed when a bare number collides with another card's database step ID", () => {
    const colliding = [
      { id: 147, cardId: "a", stepNumber: 1, status: "open" },
      { id: 200, cardId: "b", stepNumber: 147, status: "complete" },
    ];
    expect(normalizeManagerDependencies("b", ["147"], colliding)).toEqual(["unresolved:147"]);
  });
  it("resolves an unambiguous legacy database step ID on another card", () => {
    const crossCard = [
      { id: 147, cardId: "a", stepNumber: 1, status: "open" },
      { id: 200, cardId: "b", stepNumber: 1, status: "open" },
    ];
    expect(normalizeManagerDependencies("b", ["147"], crossCard)).toEqual(["a:147"]);
  });
  it("expands a whole-card prerequisite into all of its steps", () => {
    expect(normalizeManagerDependencies("b", ["a"], steps)).toEqual(["a:147", "a:148", "a:152"]);
  });
  it("preserves exact references and marks missing database-step IDs unresolved", () => {
    expect(normalizeManagerDependencies("b", ["a:148", "a:999"], steps)).toEqual(["a:148", "unresolved:a:999"]);
  });
  it("retains missing cards and free-text blockers as unresolved", () => {
    expect(normalizeManagerDependencies("a", ["absent-card", "Await approval"], steps)).toEqual(["unresolved:absent-card", "unresolved:Await approval"]);
  });
  it("deduplicates equivalent references without mutating source records", () => {
    const before = structuredClone(steps);
    expect(normalizeManagerDependencies("a", ["2", "148", "a:148"], steps)).toEqual(["a:148"]);
    expect(steps).toEqual(before);
  });
});
