import { describe, expect, it } from "vitest";
import type { ManagerEvidence } from "../shared/aptlssManager";
import { assertManagerUpdateSource, managerUpdateEvidenceText, normalizeManagerUpdateFields } from "./aptlssManagerUpdates";

const source = { id: "email:1040", cardId: "email:1040", kind: "source", source: "gmail", text: "Notification", observedAt: "2026-09-16T07:04:35.000Z" } as ManagerEvidence;

describe("structured worker answers", () => {
  it("retains a dated outcome and cited source separately from the worker narrative", () => {
    const fields = normalizeManagerUpdateFields({ outcome: "Action needed", deadlineDate: "2026-09-25", sourceEvidenceId: source.id, sourceDescription: "Correspondence in the SKGZ portal" });
    expect(fields).toEqual({ outcome: "Action needed", deadlineDate: "2026-09-25", sourceEvidenceId: source.id, sourceDescription: "Correspondence in the SKGZ portal" });
    expect(managerUpdateEvidenceText("Reply requested after review.", fields)).toContain("Worker-reported deadline date: 2026-09-25");
  });

  it("rejects impossible dates and sources not linked to the same task", () => {
    expect(() => normalizeManagerUpdateFields({ deadlineDate: "2026-02-30" })).toThrow(/valid calendar date/);
    expect(() => assertManagerUpdateSource([source], "other-card", source.id)).toThrow(/not linked/);
    expect(() => assertManagerUpdateSource([{ ...source, kind: "worker" }], source.cardId, source.id)).toThrow(/not linked/);
    expect(() => assertManagerUpdateSource([source], source.cardId, source.id)).not.toThrow();
  });

  it("does not treat an uncited worker report as a source fact", () => {
    expect(managerUpdateEvidenceText("I could not open the portal.", { outcome: "Cannot access source" })).toBe("I could not open the portal.\nWorker-reported result: Cannot access source");
  });
});
