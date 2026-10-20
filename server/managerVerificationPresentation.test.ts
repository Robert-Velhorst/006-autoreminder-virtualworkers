import { describe, expect, it } from "vitest";
import type { ManagerIntervention } from "../shared/aptlssManager";
import { groupManagerVerificationPassages } from "../shared/managerVerificationPresentation";

type Passage = NonNullable<ManagerIntervention["verification"]>["passages"][number];
const base: Passage = {
  evidenceId: "evidence:1:card", source: "gmail", kind: "source", quote: "Read the correspondence.",
  sender: "Office", sourceDate: "2026-09-16T07:00:00.000Z", observedAt: "2026-09-16T07:01:00.000Z",
  effectiveFrom: null, sourceRevision: "revision-one", sourceRecordId: "gmail-message-1",
};

describe("worker source previews", () => {
  it("joins passages from one retained revision without counting them as separate sources", () => {
    const records = groupManagerVerificationPassages([
      base, { ...base, evidenceId: "evidence:2:card", quote: "The reply is due Friday." },
      { ...base, evidenceId: "evidence:3:card", quote: "The reply is due Friday." },
      { ...base, quote: "Status: pending" },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].quotes).toEqual(["Read the correspondence.", "The reply is due Friday."]);
  });

  it("retains separate revisions and legacy records without revision identity", () => {
    expect(groupManagerVerificationPassages([
      base, { ...base, evidenceId: "evidence:2:card", sourceRevision: "revision-two" },
      { ...base, evidenceId: "evidence:4:card", sourceRecordId: "gmail-message-2" },
      { ...base, evidenceId: "email:1040", sourceRevision: null },
      { ...base, evidenceId: "email:1041", sourceRevision: null },
    ])).toHaveLength(5);
  });
});
