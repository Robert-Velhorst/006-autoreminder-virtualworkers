import { describe, expect, it } from "vitest";
import type { ManagerInput } from "../shared/aptlssManager";
import { managerInputFingerprint, managerSafeText } from "./aptlssManagerService";

const input: ManagerInput = {
  now: "2026-09-04T10:00:00Z",
  cards: [{ id:"a",name:"A",url:null,board:"B",list:"DOING",state:"DOING",stateReason:"Ready",dueAt:null,overdue:false,priority:10,updatedAt:"2026-09-04T09:00:00Z",steps:[],waiting:null }],
  evidence: [{ id:"e",cardId:"a",source:"trello",text:"Ready",observedAt:"2026-09-04T09:00:00Z",kind:"source" }],
  timeSamples: [], sourceGaps: [],
};

describe("APTLSS manager service safeguards", () => {
  it("redacts provider credentials and bounded sensitive assignments", () => {
    const text = managerSafeText("Authorization: Bearer abc.def.ghi password=hunter2 api_key=sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("abc.def.ghi");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("sk-proj-");
  });

  it("keeps source fingerprints stable across polling time while time signals can change", () => {
    const first = managerInputFingerprint(input, { worker: 1 });
    const later = managerInputFingerprint({ ...input, now:"2026-09-04T10:01:00Z" }, { worker: 1 });
    expect(later.sourceHash).toBe(first.sourceHash);
    expect(later.inputHash).toBe(first.inputHash);
  });

  it("changes the fingerprint when evidence or worker scope changes", () => {
    const first = managerInputFingerprint(input, { worker: 1 });
    expect(managerInputFingerprint({ ...input, evidence:[{...input.evidence[0],text:"Changed"}] }, {worker:1}).sourceHash).not.toBe(first.sourceHash);
    expect(managerInputFingerprint(input, { worker: 2 }).sourceHash).not.toBe(first.sourceHash);
  });
});
