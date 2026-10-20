import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { ManagerCard, ManagerSnapshot } from "../shared/aptlssManager";
import {
  managerReviewProposalIdentity,
  summarizeManagerAcceptance,
  prepareManagerCorrection,
  filterApplicableManagerCorrections,
  managerCorrectionInputSchema,
  selectApplicableManagerCorrections,
} from "./aptlssManagerReviewService";
import type { ManagerPlanImpact } from "../shared/aptlssManagerPlanImpact";

const now = new Date("2026-09-05T10:00:00Z");
const card: ManagerCard = {
  id: "card-a",
  name: "Invoice A",
  url: null,
  board: "Accounts",
  list: "Doing",
  state: "READY",
  stateReason: "Ready",
  dueAt: null,
  overdue: false,
  priority: 50,
  updatedAt: now.toISOString(),
  steps: [],
  waiting: null,
};
function snapshot(): ManagerSnapshot {
  return {
    version: 1,
    runId: 1,
    trigger: "test",
    assessedAt: now.toISOString(),
    cards: [card],
    actions: [
      {
        id: "a",
        cardId: card.id,
        title: "Verify payment",
        where: "Invoice",
        kind: "verify",
        stepIds: [1],
        dependsOn: [],
        minutes: {
          low: 5,
          likely: 10,
          high: 15,
          samples: 0,
          basis: "estimate",
        },
        reason: "Check source",
        completionCriteria: "Record proof",
        evidenceIds: ["source:a"],
        notBefore: null,
        blocked: false,
        priority: 80,
        draft: null,
      },
    ],
    assessments: [],
    interventions: [],
    sourceGaps: [],
    changes: [],
    policy: { enabled: true, intervalMinutes: 5, mode: "shadow" },
    nextCheckAt: null,
    proposal: {
      version: 2,
      dateKey: "2026-09-05",
      generatedAt: now.toISOString(),
      blocks: [],
      robertItems: [],
      unscheduledCards: [],
      auditTrail: [],
      constraints: { startTime: "09:00", endTime: "18:00", breaks: [] },
      planHealth: {
        confidence: 0,
        scheduledMinutes: 0,
        availableMinutes: 540,
        overlaps: 0,
        gaps: 540,
      },
    },
    evidence: [
      {
        id: "source:a",
        cardId: card.id,
        source: "trello",
        kind: "source",
        text: "Invoice A is unpaid.",
        observedAt: now.toISOString(),
        metadata: {
          truthClass: "source_record",
          sourceRevision: "r1",
          sourceDate: now.toISOString(),
        },
      },
    ],
  };
}
const knowledge = () => ({
  scope: "card" as const,
  cardId: card.id,
  topic: "payment-verification",
  evidenceIds: ["source:a"],
  conditions: { state: "READY" },
  validUntil: "2026-09-20T10:00:00Z",
});
function correction() {
  return {
    id: 1,
    vaId: 7,
    reviewId: 10,
    createdBy: 99,
    createdAt: now,
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    ...prepareManagerCorrection({
      knowledge: knowledge(),
      correction: "Check payment proof before preparing this invoice reply.",
      snapshot: snapshot(),
      now,
    }),
  };
}
const context = () => ({
  vaId: 7,
  card,
  evidence: snapshot().evidence,
  now,
  topic: "payment-verification",
  actionKind: "verify" as const,
});

describe("meaningful manager proposal identity", () => {
  it("ignores repeated evidence polling but retains changed source dates", () => {
    const a = snapshot(),
      b = snapshot();
    b.evidence[0].observedAt = "2026-09-05T11:00:00Z";
    expect(managerReviewProposalIdentity(a)).toBe(
      managerReviewProposalIdentity(b)
    );
    b.evidence[0].metadata!.sourceDate = "2026-09-05T11:00:00Z";
    expect(managerReviewProposalIdentity(a)).not.toBe(
      managerReviewProposalIdentity(b)
    );
  });
  it("ignores verification passage observation clocks, not retained source dates", () => {
    const a = snapshot();
    a.interventions = [
      {
        id: "check",
        cardId: card.id,
        severity: "urgent",
        title: "Check source",
        question: "Which source applies?",
        explanation: "Source comparison",
        safeAction: "Pause",
        evidenceIds: ["source:a"],
        verification: {
          issues: [],
          passages: [
            {
              evidenceId: "source:a",
              source: "trello",
              kind: "source",
              quote: "Invoice A is unpaid.",
              sender: null,
              sourceDate: null,
              observedAt: now.toISOString(),
              effectiveFrom: null,
            },
          ],
        },
      },
    ];
    const b = structuredClone(a);
    b.interventions[0].verification!.passages[0].observedAt =
      "2026-09-05T11:00:00Z";
    expect(managerReviewProposalIdentity(a)).toBe(
      managerReviewProposalIdentity(b)
    );
    b.interventions[0].verification!.passages[0].sourceDate =
      "2026-09-05T11:00:00Z";
    expect(managerReviewProposalIdentity(a)).not.toBe(
      managerReviewProposalIdentity(b)
    );
  });
  const impact = (): ManagerPlanImpact => ({
    version: 1,
    assessedAt: now.toISOString(),
    dateKey: "2026-09-05",
    timezone: "UTC",
    baseline: "same_day_plan",
    scheduleChanged: true,
    requiresReview: false,
    assumptions: [],
    deadlines: [
      {
        cardId: card.id,
        dueAt: "2026-09-06T12:00:00Z",
        before: {
          blockIds: ["a"],
          unscheduledActionIds: [],
          latestScheduledEndAt: now.toISOString(),
          slackMinutes: 100,
          status: "within_deadline",
        },
        after: {
          blockIds: ["a"],
          unscheduledActionIds: [],
          latestScheduledEndAt: now.toISOString(),
          slackMinutes: 90,
          status: "within_deadline",
        },
        movement: "later",
        assumptionIds: [],
      },
    ],
    dependencies: [
      {
        actionId: "a",
        dependency: "b",
        completionRecorded: false,
        before: {
          scheduled: true,
          startAt: now.toISOString(),
          predecessorEndAt: now.toISOString(),
          ordering: "before_start",
        },
        after: {
          scheduled: true,
          startAt: now.toISOString(),
          predecessorEndAt: now.toISOString(),
          ordering: "before_start",
        },
        assumptionIds: [],
      },
    ],
    buffer: {
      before: null,
      after: {
        unallocatedMinutes: 10,
        largestWindowMinutes: 10,
        additionalHighEstimateMinutes: 5,
        afterHighEstimatesMinutes: 5,
        minimumKnownDeficitMinutes: 0,
        unknownEstimateBlockIds: [],
      },
      unallocatedDeltaMinutes: null,
      reservations: [],
      assumptionIds: [],
    },
    protectedBlocks: [],
    alternative: {
      kind: "keep_current_plan",
      available: true,
      blockIds: [],
      deadlineRiskCardIds: [],
      dependencyRiskActionIds: [],
      buffer: null,
      limitation: "",
    },
    risks: [],
    limitations: [],
  });
  it("ignores shifted impact clocks, numeric slack and assumption timestamps", () => {
    const a = snapshot();
    a.proposal!.planningImpact = impact();
    const b = structuredClone(a),
      p = b.proposal!.planningImpact!;
    p.assessedAt = "2026-09-05T11:00:00Z";
    p.deadlines[0].after.latestScheduledEndAt = "2026-09-05T11:00:00Z";
    p.deadlines[0].after.slackMinutes = 30;
    p.dependencies[0].after.startAt = "2026-09-05T11:00:00Z";
    p.assumptions.push({
      id: "clock",
      inputPath: "now",
      value: "2026-09-05T11:00:00Z",
      limitation: "",
    });
    expect(managerReviewProposalIdentity(a)).toBe(
      managerReviewProposalIdentity(b)
    );
  });
  it.each([
    "risk",
    "review",
    "deadline",
    "movement",
    "dependency",
    "completion",
    "buffer",
  ])("separates consequential impact %s changes", change => {
    const a = snapshot();
    a.proposal!.planningImpact = impact();
    const b = structuredClone(a),
      p = b.proposal!.planningImpact!;
    if (change === "risk")
      p.risks.push({
        code: "late",
        subjectId: card.id,
        requiresReview: true,
        detail: "Late",
        assumptionIds: [],
      });
    if (change === "review") p.requiresReview = true;
    if (change === "deadline") p.deadlines[0].after.status = "after_deadline";
    if (change === "movement") p.deadlines[0].movement = "earlier";
    if (change === "dependency") p.dependencies[0].after.ordering = "violated";
    if (change === "completion") p.dependencies[0].completionRecorded = true;
    if (change === "buffer") p.buffer.after.minimumKnownDeficitMinutes = 5;
    expect(managerReviewProposalIdentity(a)).not.toBe(
      managerReviewProposalIdentity(b)
    );
  });
  it("ignores poll, run, assessment and next-check timestamps", () => {
    const a = snapshot(),
      b = snapshot();
    b.runId = 999;
    b.assessedAt = "2026-09-06T12:00:00Z";
    b.nextCheckAt = "2026-09-06T12:05:00Z";
    b.trigger = "poll";
    expect(managerReviewProposalIdentity(a)).toBe(
      managerReviewProposalIdentity(b)
    );
  });
  it("ignores timing sample count when the recommended range is unchanged", () => {
    const a = snapshot(),
      b = snapshot();
    b.actions[0].minutes.samples = 99;
    expect(managerReviewProposalIdentity(a)).toBe(
      managerReviewProposalIdentity(b)
    );
  });
  it.each([
    "blocked",
    "dependency",
    "duration",
    "source",
    "revision",
    "priority",
    "quote",
    "notBefore",
  ])("changes identity for meaningful %s changes", change => {
    const a = snapshot(),
      b = snapshot();
    if (change === "blocked") b.actions[0].blocked = true;
    if (change === "dependency") b.actions[0].dependsOn = ["prior"];
    if (change === "duration") b.actions[0].minutes.likely = 30;
    if (change === "source") b.evidence[0].text = "Invoice A is paid.";
    if (change === "revision") b.evidence[0].metadata!.sourceRevision = "r2";
    if (change === "priority") b.actions[0].priority = 100;
    if (change === "quote")
      b.actions[0].completionCriteria = "Source proof and date required";
    if (change === "notBefore") b.actions[0].notBefore = "2026-09-06T10:00:00Z";
    expect(managerReviewProposalIdentity(a)).not.toBe(
      managerReviewProposalIdentity(b)
    );
  });
  it("retains meaningful action ordering", () => {
    const a = snapshot();
    a.actions.push({
      ...a.actions[0],
      id: "b",
      cardId: "card-b",
      title: "Verify approval",
    });
    const b = structuredClone(a);
    b.actions.reverse();
    expect(managerReviewProposalIdentity(a)).not.toBe(
      managerReviewProposalIdentity(b)
    );
  });
  it("is invariant to evidence array ordering", () => {
    const a = snapshot();
    a.evidence.push({
      ...a.evidence[0],
      id: "source:b",
      text: "Invoice B is unpaid.",
    });
    const b = structuredClone(a);
    b.evidence.reverse();
    expect(managerReviewProposalIdentity(a)).toBe(
      managerReviewProposalIdentity(b)
    );
  });
});

describe("aggregated proposal acceptance", () => {
  const input = () => ({
    sample: Array.from({ length: 100 }, () => ({
      verdict: "correct" as "correct" | "incorrect" | "insufficient",
    })),
    workingDays: 5,
    critical: 0,
    unreviewedUrgent: 0,
    safetyVerified: true,
  });
  it("accepts the measured distinct sample without a raw-run capacity trap", () => {
    expect(summarizeManagerAcceptance(input())).toMatchObject({
      eligible: true,
      reviewed: 100,
      correct: 100,
    });
  });
  it.each([0, 1, 2, 3])(
    "requires at least 98 supported correct proposals with %s errors",
    errors => {
      const x = input();
      x.sample.slice(0, errors).forEach(r => {
        r.verdict = "incorrect";
      });
      expect(summarizeManagerAcceptance(x).eligible).toBe(errors <= 2);
    }
  );
  it("does not count insufficient evidence as correct", () => {
    const x = input();
    x.sample.slice(0, 3).forEach(r => {
      r.verdict = "insufficient";
    });
    expect(summarizeManagerAcceptance(x).eligible).toBe(false);
  });
  it.each(["critical", "urgent", "days", "sample", "safety"])(
    "keeps the %s gate closed",
    flag => {
      const x = input();
      if (flag === "critical") x.critical = 1;
      if (flag === "urgent") x.unreviewedUrgent = 1;
      if (flag === "days") x.workingDays = 4;
      if (flag === "sample") x.sample.pop();
      if (flag === "safety") x.safetyVerified = false;
      expect(summarizeManagerAcceptance(x).eligible).toBe(false);
    }
  );
});

describe("controlled founder correction knowledge", () => {
  const sourceFingerprint = (value: unknown): string => {
    const canonical = (item: unknown): string =>
      Array.isArray(item)
        ? `[${item.map(canonical).join(",")}]`
        : item && typeof item === "object"
          ? `{${Object.entries(item)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
              .join(",")}}`
          : (JSON.stringify(item) ?? "null");
    return createHash("sha256").update(canonical(value)).digest("hex");
  };
  it.each([
    "worker_report",
    "system_inference",
    "model_proposal",
    "unknown",
  ] as const)(
    "rejects outer source records semantically classified as %s at ingestion",
    truthClass => {
      const snap = snapshot();
      snap.evidence[0].metadata!.truthClass = truthClass;
      expect(() =>
        prepareManagerCorrection({
          knowledge: knowledge(),
          correction: "Check source proof",
          snapshot: snap,
          now,
        })
      ).toThrow(/source/i);
    }
  );
  it.each([
    "worker_report",
    "system_inference",
    "model_proposal",
    "unknown",
  ] as const)(
    "rejects legacy pinned %s records at applicability even when fingerprints match",
    truthClass => {
      const row = correction(),
        ctx = context(),
        pins = JSON.parse(row.evidenceJson);
      expect(sourceFingerprint(ctx.evidence[0])).toBe(pins[0].fingerprint);
      ctx.evidence[0].metadata!.truthClass = truthClass;
      pins[0].fingerprint = sourceFingerprint(ctx.evidence[0]);
      row.evidenceJson = JSON.stringify(pins);
      expect(
        selectApplicableManagerCorrections([row], ctx).corrections
      ).toEqual([]);
    }
  );
  it("pins source evidence and produces bounded guidance, never factual authority", () => {
    const applicable = filterApplicableManagerCorrections(
      [correction()],
      context()
    );
    expect(applicable).toHaveLength(1);
    expect(applicable[0]).toMatchObject({
      id: 1,
      topic: "payment-verification",
      knowledgeClass: "scoped_guidance",
      doesNotResolveConflicts: true,
    });
    expect(applicable[0]).not.toHaveProperty("truthClass");
    expect(applicable[0]).not.toHaveProperty("confidence");
  });
  it.each([
    "worker",
    "card",
    "topic",
    "state",
    "source",
    "revision",
    "missing",
    "expired",
    "future",
    "revoked",
  ])("does not apply a %s mismatch", mismatch => {
    const row = correction(),
      ctx = context();
    if (mismatch === "worker") ctx.vaId = 8;
    if (mismatch === "card") ctx.card = { ...card, id: "another-card" };
    if (mismatch === "topic") ctx.topic = "approval";
    if (mismatch === "state") ctx.card = { ...card, state: "WAITING" };
    if (mismatch === "source") ctx.evidence[0].text = "Invoice A is paid.";
    if (mismatch === "revision")
      ctx.evidence[0].metadata!.sourceRevision = "r2";
    if (mismatch === "missing") ctx.evidence = [];
    if (mismatch === "expired") ctx.now = new Date("2026-09-21T10:00:00Z");
    if (mismatch === "future") ctx.now = new Date("2026-09-04T10:00:00Z");
    if (mismatch === "revoked")
      Object.assign(row, { revokedAt: now, revokedBy: 99 });
    expect(filterApplicableManagerCorrections([row], ctx)).toEqual([]);
  });
  it("requires explicit conditions for worker scope", () => {
    expect(() =>
      managerCorrectionInputSchema.parse({
        ...knowledge(),
        scope: "worker",
        cardId: undefined,
        conditions: {},
      })
    ).toThrow();
  });
  it.each(["boardName", "listName", "actionKind"] as const)(
    "requires the %s condition to match",
    field => {
      const rule = {
        ...knowledge(),
        conditions: { [field]: field === "actionKind" ? "draft" : "Other" },
      };
      const row = {
        ...correction(),
        ...prepareManagerCorrection({
          knowledge: rule,
          correction: "Check payment evidence",
          snapshot: snapshot(),
          now,
        }),
      };
      expect(filterApplicableManagerCorrections([row], context())).toEqual([]);
    }
  );
  it("does not accept a global correction scope", () => {
    expect(() =>
      managerCorrectionInputSchema.parse({ ...knowledge(), scope: "global" })
    ).toThrow();
  });
  it.each(["unknown-id", "worker-report", "proposal"])(
    "rejects unsupported correction evidence %s",
    kind => {
      const snap = snapshot();
      const input = knowledge();
      if (kind === "unknown-id") input.evidenceIds = ["missing"];
      if (kind === "worker-report") snap.evidence[0].kind = "worker";
      if (kind === "proposal")
        snap.evidence[0].metadata!.truthClass = "model_proposal";
      expect(() =>
        prepareManagerCorrection({
          knowledge: input,
          correction: "Check source proof",
          snapshot: snap,
          now,
        })
      ).toThrow();
    }
  );
  it.each([
    "2026-09-01T00:00:00Z",
    "2027-09-01T00:00:00Z",
    "tomorrow",
    "2026-09-20T10:00:00",
  ])("rejects unbounded or invalid expiry %s", validUntil => {
    expect(() =>
      prepareManagerCorrection({
        knowledge: { ...knowledge(), validUntil },
        correction: "Check source proof",
        snapshot: snapshot(),
        now,
      })
    ).toThrow();
  });
  it("fails closed on malformed stored correction conditions or evidence", () => {
    expect(
      filterApplicableManagerCorrections(
        [{ ...correction(), conditionsJson: "{" }],
        context()
      )
    ).toEqual([]);
    expect(
      filterApplicableManagerCorrections(
        [{ ...correction(), evidenceJson: "[]" }],
        context()
      )
    ).toEqual([]);
  });
  it("withholds conflicting guidance for the same topic rather than choosing a winner", () => {
    const first = correction();
    const second = {
      ...first,
      id: 2,
      correction: "Skip the payment proof check for this invoice.",
    };
    expect(
      filterApplicableManagerCorrections([first, second], context())
    ).toEqual([]);
  });
  it("deduplicates equivalent guidance instead of treating copies as conflicting", () => {
    const first = correction();
    expect(
      filterApplicableManagerCorrections(
        [first, { ...first, id: 2 }],
        context()
      )
    ).toHaveLength(1);
  });
  it("does not mutate the snapshot or correction rows", () => {
    const row = correction(),
      ctx = context(),
      before = structuredClone({ row, ctx });
    filterApplicableManagerCorrections([row], ctx);
    expect({ row, ctx }).toEqual(before);
  });
  it("hashes expiry and revocation even when no guidance remains", () => {
    const row = correction(),
      ctx = context();
    const initial = selectApplicableManagerCorrections([row], ctx);
    const expired = selectApplicableManagerCorrections([row], {
      ...ctx,
      now: new Date("2026-10-01T00:00:00Z"),
    });
    const revoked = selectApplicableManagerCorrections(
      [{ ...row, revokedAt: now }],
      ctx
    );
    expect(expired.corrections).toEqual([]);
    expect(revoked.corrections).toEqual([]);
    expect(expired.learningStateHash).not.toBe(initial.learningStateHash);
    expect(revoked.learningStateHash).not.toBe(initial.learningStateHash);
  });
  it("does not change learning hash for a repeated applicable poll", () => {
    const row = correction(),
      ctx = context();
    expect(
      selectApplicableManagerCorrections([row], ctx).learningStateHash
    ).toBe(
      selectApplicableManagerCorrections([row], {
        ...ctx,
        now: new Date(now.getTime() + 60000),
      }).learningStateHash
    );
  });
  it("fails closed without throwing on corrupt stored dates", () => {
    const row = { ...correction(), validUntil: new Date("invalid") };
    expect(
      selectApplicableManagerCorrections([row], context()).corrections
    ).toEqual([]);
  });
});
