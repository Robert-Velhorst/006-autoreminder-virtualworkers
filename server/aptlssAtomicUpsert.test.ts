import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "..");

describe("APTLSS current-state persistence", () => {
  it("uses atomic upserts for plan, card state, and priority state", () => {
    const plans = fs.readFileSync(path.join(workspaceRoot, "server/aptlssDb.ts"), "utf8");
    const states = fs.readFileSync(path.join(workspaceRoot, "server/aptlssStepsDb.ts"), "utf8");

    expect(plans).toContain(".onDuplicateKeyUpdate");
    expect(plans).not.toContain("db.delete(aptlssPlans)");
    expect(states).toContain(".insert(cardStates)");
    expect(states).toContain(".insert(priorityScores)");
    expect(states).not.toContain("db.delete(cardStates)");
    expect(states).not.toContain("db.delete(priorityScores)");
  });
});
