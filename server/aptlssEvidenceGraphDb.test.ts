import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./aptlssEvidenceGraphDb.ts", import.meta.url), "utf8");

describe("APTLSS evidence graph database boundaries", () => {
  it("verifies card ownership before a worker links evidence", () => {
    expect(source).toContain("eq(aptlssPlans.vaId, vaId)");
    expect(source).toContain("Evidence can only be linked to a card in this worker scope");
  });

  it("requires both conflict evidence records to be linked in the same worker scope", () => {
    expect(source).toContain("Evidence conflict is outside this worker scope");
    expect(source).toContain("eq(aptlssEvidenceSubjectLinks.vaId, vaId)");
    expect(source).toContain("The conflict must compare a source record with a worker assertion");
  });

  it("does not perform an external side effect while recording evidence", () => {
    expect(source).not.toMatch(/fetch\(|axios|trello\.com|gmail\.google/i);
  });
});
