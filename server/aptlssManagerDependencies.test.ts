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
  it("does not resolve an ordinal through another card", () => {
    expect(normalizeManagerDependencies("c", ["2"], steps)).toEqual(["unresolved:2"]);
  });
  it("fails closed when a number means two different steps", () => {
    expect(normalizeManagerDependencies("a", ["2"], [...steps, { id: 2, cardId: "a", stepNumber: 3 }])).toEqual(["unresolved:2"]);
  });
  it("expands a whole-card prerequisite into all of its steps", () => {
    expect(normalizeManagerDependencies("b", ["a"], steps)).toEqual(["a:147", "a:148", "a:152"]);
  });
  it("preserves explicit card and database-step references", () => {
    expect(normalizeManagerDependencies("b", ["a:148", "a:999"], steps)).toEqual(["a:148", "a:999"]);
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
