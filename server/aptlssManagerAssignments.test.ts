import { describe, expect, it } from "vitest";
import { taskAssignments, vaProfiles } from "../drizzle/schema";
import { assessManagerAssignmentCoverage, parseManagerAssignmentReference, readManagerAssignmentState } from "./aptlssManagerAssignments";

const state = (assignments: Array<{ taskId: string; status: "assigned" | "in_progress" | "blocked" }>) => ({
  profile: { id: 3, founderId: 9, status: "active" as const },
  assignments,
  truncated: false,
  complete: true,
  fingerprint: "assignment-hash",
});

describe("manager authoritative task assignments", () => {
  it("resolves one active profile while ignoring inactive history and rejects multiple active profiles", async () => {
    const readState = (profiles: Array<{ id: number; founderId: number; status: "active" | "inactive" }>) => {
      const db = {
        select: () => {
          let table: unknown;
          const query: any = {
            from: (value: unknown) => { table = value; return query; },
            where: () => query,
            orderBy: () => query,
            limit: () => query,
            then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
              Promise.resolve(table === vaProfiles ? profiles : table === taskAssignments ? [] : []).then(resolve, reject),
          };
          return query;
        },
      };
      return readManagerAssignmentState(db as never, 22);
    };

    const uniqueActive = await readState([
      { id: 3, founderId: 9, status: "active" },
      { id: 2, founderId: 8, status: "inactive" },
    ]);
    expect(uniqueActive).toMatchObject({ profile: { id: 3, founderId: 9 }, complete: true });

    const ambiguous = await readState([
      { id: 3, founderId: 9, status: "active" },
      { id: 4, founderId: 10, status: "active" },
    ]);
    expect(ambiguous).toMatchObject({ profile: null, complete: false });
  });

  it("parses only card IDs and documented checklist task IDs", () => {
    expect(parseManagerAssignmentReference("card-1")).toEqual({ cardId: "card-1", checklistId: null, checkItemId: null });
    expect(parseManagerAssignmentReference("card-1:list-2:item-3")).toEqual({ cardId: "card-1", checklistId: "list-2", checkItemId: "item-3" });
    expect(parseManagerAssignmentReference(":list:item")).toBeNull();
    expect(parseManagerAssignmentReference("card:list")).toBeNull();
    expect(parseManagerAssignmentReference(`${"x".repeat(65)}:list:item`)).toBeNull();
  });

  it("fails coverage when an active assignment has no APTLSS plan", () => {
    const coverage = assessManagerAssignmentCoverage(state([{ taskId: "missing-card", status: "assigned" }]), [], []);
    expect(coverage).toMatchObject({ complete: false, missingPlanCount: 1, missingStepCount: 0 });
  });

  it("requires a matching APTLSS step for a checklist-level assignment", () => {
    const plans = [{ cardId: "card-1" }];
    const noStep = assessManagerAssignmentCoverage(state([{ taskId: "card-1:list-2:item-3", status: "assigned" }]), plans, []);
    expect(noStep).toMatchObject({ complete: false, missingPlanCount: 0, missingStepCount: 1 });
    const mapped = assessManagerAssignmentCoverage(state([{ taskId: "card-1:list-2:item-3", status: "blocked" }]), plans, [
      { id: 7, cardId: "card-1", trelloChecklistId: "list-2", trelloCheckItemId: "item-3" },
    ]);
    expect(mapped.complete).toBe(true);
    expect(mapped.blockedStepIds.has(7)).toBe(true);
  });

  it("keeps blocked card assignments distinct from checklist-level blockers", () => {
    const coverage = assessManagerAssignmentCoverage(state([{ taskId: "card-1", status: "blocked" }]), [{ cardId: "card-1" }], []);
    expect(coverage.complete).toBe(true);
    expect(coverage.blockedCardIds.has("card-1")).toBe(true);
    expect(coverage.blockedStepIds.size).toBe(0);
  });
});
