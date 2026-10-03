import { describe, expect, it } from "vitest";
import type { ManagerSnapshot } from "../shared/aptlssManager";
import { managerHistoryHash, managerHistoryPatch, restoreManagerHistorySnapshot } from "./aptlssManagerHistory";

const fixture = (): ManagerSnapshot => ({
  version: 1, assessedAt: "2026-09-04T10:00:00.000Z", runId: 7, trigger: "scheduled",
  executionCoverageComplete: true, assessments: [], actions: [], interventions: [], sourceGaps: [],
  cards: [], evidence: [{ id: "source:1", cardId: "card:1", source: "trello", kind: "source",
    observedAt: "2026-09-04T09:00:00.000Z", text: "Retained synthetic source passage. ".repeat(8000) }],
  changes: [], policy: { enabled: true, intervalMinutes: 5, mode: "shadow" },
  nextCheckAt: "2026-09-04T10:05:00.000Z", proposalHash: "unchanged-proposal", implementationDigest: "controlled-build",
});
const nextCheck = (base: ManagerSnapshot): ManagerSnapshot => ({ ...structuredClone(base), runId: 0,
  assessedAt: "2026-09-04T10:06:00.000Z", nextCheckAt: "2026-09-04T10:11:00.000Z", trigger: "manual" });
const roundTrip = (base: ManagerSnapshot, next: ManagerSnapshot) => restoreManagerHistorySnapshot(JSON.stringify(base), base.runId, {
  baseSnapshotHash: managerHistoryHash(base), snapshotHash: managerHistoryHash({ ...next, runId: base.runId }),
  snapshotPatchJson: managerHistoryPatch(base, next)!,
});

describe("lossless manager history checks", () => {
  it("retains exact current timestamps and trigger without duplicating the source dossier", () => {
    const base = fixture(), next = nextCheck(base), patch = managerHistoryPatch(base, next)!;
    expect(Buffer.byteLength(patch)).toBeLessThan(400);
    expect(patch).not.toContain("Retained synthetic");
    expect(roundTrip(base, next)).toEqual({ ...next, runId: base.runId });
  });

  it("reconstructs each check from the immutable base, not a previous check chain", () => {
    const base = fixture(), first = nextCheck(base), second = nextCheck(first);
    second.assessedAt = "2026-09-04T10:07:00.000Z";
    expect(roundTrip(base, second)).toEqual({ ...second, runId: base.runId });
    expect(roundTrip(base, first)).toEqual({ ...first, runId: base.runId });
  });

  it.each([
    ["coverage", (s: ManagerSnapshot) => { s.executionCoverageComplete = false; }],
    ["sources", (s: ManagerSnapshot) => { s.evidence[0].text += " A new authoritative fact."; }],
    ["observations", (s: ManagerSnapshot) => { s.evidence[0].observedAt = "2026-09-04T10:05:00.000Z"; }],
    ["decisions", (s: ManagerSnapshot) => { s.proposalHash = "changed-proposal"; }],
    ["policy", (s: ManagerSnapshot) => { s.policy.intervalMinutes = 10; }],
    ["build", (s: ManagerSnapshot) => { s.implementationDigest = "new-build"; }],
    ["assignment", (s: ManagerSnapshot) => { s.assignmentFingerprint = "new-assignment"; }],
    ["change explanation", (s: ManagerSnapshot) => { s.changes = ["A newly required action"]; }],
    ["semantic retry", (s: ManagerSnapshot) => { s.semanticReview = { success: false, sourceHash: "source",
      attemptedAt: "2026-09-04T10:06:00.000Z", retryAfter: "2026-09-04T10:08:00.000Z", failures: 1 }; }],
    ["unknown future field", (s: ManagerSnapshot) => { Object.assign(s, { futureSafetyRule: "new" }); }],
  ] as const)("requires a new full run for changed %s", (_name, change) => {
    const base = fixture(), next = nextCheck(base); change(next);
    expect(managerHistoryPatch(base, next)).toBeNull();
  });

  it("never compacts active/applied plans or missing review identity", () => {
    const base = fixture(), next = nextCheck(base);
    for (const change of [(s: ManagerSnapshot) => { s.applied = true; },
      (s: ManagerSnapshot) => { s.policy.mode = "active"; },
      (s: ManagerSnapshot) => { delete s.proposalHash; }]) {
      const changed = structuredClone(next); change(changed);
      expect(managerHistoryPatch(base, changed)).toBeNull();
    }
  });

  it("uses full storage when indirection would be larger", () => {
    const base = fixture(), next = nextCheck(base);
    base.evidence = []; next.evidence = [];
    base.changes = next.changes = ["Retained explanation. ".repeat(1000)];
    expect(managerHistoryPatch(base, next)).toBeNull();
    base.evidence = fixture().evidence; next.evidence = fixture().evidence;
    base.changes = next.changes = ["large clock update".repeat(5000)];
    expect(managerHistoryPatch(base, next)).toBeNull();
  });

  it("retains proposal clocks exactly but never merges changed slots or capacity", () => {
    const base = fixture();
    base.proposal = { version: 2, dateKey: "2026-09-04", generatedAt: base.assessedAt,
      blocks: [{ id: "work:1", startTime: "11:00", endTime: "11:20", cardId: "card:1", cardName: "Requirements",
        cardUrl: null, boardName: "Fixture", listName: "TO DO", action: "Review requirements", stepIds: [1], priority: "high",
        score: 100, state: "TO DO", status: "planned", notes: "", flags: [] }],
      robertItems: [], unscheduledCards: [], constraints: { startTime: "09:00", endTime: "18:00", breaks: [] },
      planHealth: { confidence: 0, scheduledMinutes: 20, availableMinutes: 540, overlaps: 0, gaps: 0 },
      auditTrail: [{ at: base.assessedAt, action: "proposed", detail: "Requirements work" }] };
    const next = nextCheck(base);
    next.proposal!.generatedAt = next.assessedAt;
    next.proposal!.auditTrail[0].at = next.assessedAt;
    expect(roundTrip(base, next)).toEqual({ ...next, runId: base.runId });
    next.proposal!.blocks[0].startTime = "11:05";
    expect(managerHistoryPatch(base, next)).toBeNull();
    next.proposal!.blocks[0].startTime = "11:00";
    next.proposal!.planHealth.availableMinutes--;
    expect(managerHistoryPatch(base, next)).toBeNull();
  });

  it.each(["base", "patch", "hash", "unknown key", "version", "prototype key"])("fails closed for corrupt %s", corruption => {
    const base = fixture(), next = nextCheck(base);
    const check = { baseSnapshotHash: managerHistoryHash(base), snapshotHash: managerHistoryHash({ ...next, runId: base.runId }),
      snapshotPatchJson: managerHistoryPatch(base, next)! };
    let baseJson = JSON.stringify(base);
    if (corruption === "base") baseJson = baseJson.replace("controlled-build", "different-build");
    if (corruption === "patch") check.snapshotPatchJson = check.snapshotPatchJson.replace("10:06", "10:08");
    if (corruption === "hash") check.snapshotHash = "bad";
    if (corruption === "unknown key") check.snapshotPatchJson = check.snapshotPatchJson.replace('"trigger":', '"actions":[],"trigger":');
    if (corruption === "version") check.snapshotPatchJson = check.snapshotPatchJson.replace('"version":1', '"version":2');
    if (corruption === "prototype key") check.snapshotPatchJson = check.snapshotPatchJson.replace('"trigger":', '"__proto__":{},"trigger":');
    expect(() => restoreManagerHistorySnapshot(baseJson, base.runId, check)).toThrow(/integrity check/);
  });
});
