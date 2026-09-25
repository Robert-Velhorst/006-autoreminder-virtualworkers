import { describe, expect, it } from "vitest";
import type {
  ManagerAction,
  ManagerCard,
  ManagerResult,
} from "../shared/aptlssManager";
import type {
  OperatorDailyPlanPayload,
  OperatorPlanBlock,
} from "./operatorDailyPlan";
import type { WorkerOperatorContext } from "./workerOperatorContext";
import { reconcileManagerPlan } from "./aptlssManagerPlan";

const worker: WorkerOperatorContext = {
  userId: 1,
  profileId: null,
  founderId: null,
  trelloMemberId: null,
  displayName: "Worker",
  founderName: "Robert",
  timezone: "Europe/Amsterdam",
  workStartTime: "09:00",
  workEndTime: "18:00",
  workingDays: [1, 2, 3, 4, 5],
  breaks: [],
};
const now = new Date("2026-09-04T08:00:00Z"); // Friday, 10:00 Amsterdam.
function action(id: string, extra: Partial<ManagerAction> = {}): ManagerAction {
  return {
    id,
    cardId: id,
    title: `Do ${id}`,
    where: "Trello",
    kind: "work",
    stepIds: [],
    dependsOn: [],
    minutes: { low: 20, likely: 30, high: 60, samples: 0, basis: "estimate" },
    reason: `Ready ${id}`,
    completionCriteria: "Evidence attached",
    evidenceIds: [`source-${id}`],
    notBefore: null,
    blocked: false,
    priority: 50,
    draft: null,
    ...extra,
  };
}
function card(id: string, extra: Partial<ManagerCard> = {}): ManagerCard {
  return {
    id,
    name: `Card ${id}`,
    url: null,
    board: "Board",
    list: "Doing",
    state: "READY",
    stateReason: "Ready",
    dueAt: null,
    overdue: false,
    priority: 50,
    updatedAt: now.toISOString(),
    steps: [],
    waiting: null,
    ...extra,
  };
}
function block(
  id: string,
  extra: Partial<OperatorPlanBlock> = {}
): OperatorPlanBlock {
  return {
    id,
    cardId: id,
    cardName: `Card ${id}`,
    cardUrl: null,
    boardName: "Board",
    listName: "Doing",
    startTime: "09:00",
    endTime: "09:30",
    action: `Do ${id}`,
    stepIds: [],
    priority: "MEDIUM",
    score: 50,
    state: "READY",
    status: "planned",
    notes: "Original notes",
    flags: [],
    ...extra,
  };
}
function saved(blocks: OperatorPlanBlock[]): OperatorDailyPlanPayload {
  return {
    version: 2,
    dateKey: "2026-09-04",
    generatedAt: "2026-09-04T06:00:00Z",
    blocks,
    robertItems: [],
    unscheduledCards: [],
    constraints: { startTime: "09:00", endTime: "18:00", breaks: [] },
    planHealth: {
      confidence: 80,
      scheduledMinutes: 0,
      availableMinutes: 540,
      overlaps: 0,
      gaps: 540,
    },
    auditTrail: [],
  };
}
function run(
  actions: ManagerAction[],
  extra: Partial<Parameters<typeof reconcileManagerPlan>[0]> = {}
) {
  const result: ManagerResult = {
    version: 1,
    assessedAt: now.toISOString(),
    assessments: [],
    actions,
    interventions: [],
    sourceGaps: [],
  };
  return reconcileManagerPlan({
    result,
    cards: actions.map(a => card(a.cardId)),
    existing: null,
    worker,
    now,
    activeTimer: null,
    ...extra,
  });
}

describe("reconcileManagerPlan", () => {
  it("reserves the remaining estimate for an overrunning timer without rewriting its block", () => {
    const active = block("a", { status: "active" });
    const { plan } = run([action("a"), action("b")], {
      existing: saved([active]),
      activeTimer: { cardId: "a", planBlockId: "a" },
    });
    expect(plan.blocks[0]).toEqual(active);
    expect(plan.blocks.filter(b => b.cardId === "a")).toHaveLength(1);
    expect(plan.blocks[1]).toMatchObject({
      cardId: "b",
      startTime: "10:30",
      endTime: "11:00",
    });
  });

  it("protects timer-linked planned blocks and reserves time even without an action estimate", () => {
    const active = block("a");
    const { plan } = run([action("b")], {
      existing: saved([active]),
      activeTimer: { cardId: "a", planBlockId: "a" },
    });
    expect(plan.blocks[0]).toEqual(active);
    expect(plan.blocks[1].startTime).toBe("10:30");
  });

  it("uses gaps before future protected blocks and replaces future planned work", () => {
    const protectedBlock = block("kept", {
      status: "done",
      startTime: "12:00",
      endTime: "13:00",
    });
    const { plan } = run([action("new")], {
      existing: saved([
        protectedBlock,
        block("removed", { startTime: "14:00", endTime: "15:00" }),
      ]),
    });
    expect(plan.blocks).toHaveLength(2);
    expect(plan.blocks[0]).toMatchObject({ cardId: "new", startTime: "10:00" });
    expect(plan.blocks[1]).toEqual(protectedBlock);
  });

  it("preserves done, skipped, active and already-started blocks exactly and never repeats their tasks", () => {
    const originals = [
      block("done", { status: "done", startTime: "08:00", endTime: "08:15" }),
      block("skipped", {
        status: "skipped",
        startTime: "08:15",
        endTime: "08:30",
      }),
      block("past", { startTime: "09:45", endTime: "10:15" }),
      block("active", {
        status: "active",
        startTime: "10:15",
        endTime: "10:45",
      }),
    ];
    const { plan } = run(
      originals.map(b => action(b.id)),
      { existing: saved(originals) }
    );
    expect(plan.blocks).toEqual(originals);
  });

  it("fits whole durations around overlapping breaks without reversing supplied order", () => {
    const { plan } = run(
      [
        action("large", {
          minutes: {
            low: 60,
            likely: 90,
            high: 120,
            samples: 1,
            basis: "history",
          },
        }),
        action("small"),
      ],
      {
        worker: {
          ...worker,
          breaks: [
            { name: "Lunch", startTime: "11:00", durationMinutes: 60 },
            { name: "Rest", startTime: "11:30", durationMinutes: 60 },
          ],
        },
      }
    );
    expect(plan.blocks.map(b => [b.cardId, b.startTime, b.endTime])).toEqual([
      ["large", "12:30", "14:00"],
      ["small", "14:00", "14:30"],
    ]);
    expect(plan.planHealth.availableMinutes).toBe(450);
    expect(plan.planHealth.overlaps).toBe(0);
  });

  it("uses the actual worker date, weekday, and fractional timezone offset", () => {
    const { plan } = run([action("a")], {
      now: new Date("2026-09-03T23:30:00Z"),
      worker: { ...worker, timezone: "Asia/Kathmandu", workStartTime: "05:00" },
    });
    expect(plan.dateKey).toBe("2026-09-04");
    expect(plan.blocks[0].startTime).toBe("05:15");
    const off = run([action("a")], {
      now: new Date("2026-09-04T23:30:00Z"),
      worker: { ...worker, timezone: "Asia/Kathmandu" },
    }).plan;
    expect(off.dateKey).toBe("2026-09-05");
    expect(off.blocks).toEqual([]);
    expect(off.unscheduledCards[0].reason).toMatch(/working day|protected/i);
    expect(off.planHealth.availableMinutes).toBe(0);
  });

  it("honors notBefore but does not mistake a scheduled prerequisite for completion", () => {
    const { plan } = run([
      action("second", { dependsOn: ["first"] }),
      action("first", { notBefore: "2026-09-04T09:00:00Z" }),
    ]);
    expect(plan.blocks.map(b => [b.cardId, b.startTime, b.endTime])).toEqual([
      ["first", "11:00", "11:30"],
    ]);
    expect(plan.unscheduledCards[0].reason).toMatch(/dependenc.*complet/i);
  });

  it("never converts a missing, skipped or cyclic dependency into executable work", () => {
    const { plan } = run(
      [
        action("a", { dependsOn: ["b"] }),
        action("b", { dependsOn: ["a"] }),
        action("missing", { dependsOn: ["unknown"] }),
        action("afterSkip", { dependsOn: ["skip"] }),
        action("skip"),
      ],
      { existing: saved([block("skip", { status: "skipped" })]) }
    );
    expect(plan.blocks.map(b => b.id)).toEqual(["skip"]);
    expect(plan.unscheduledCards).toHaveLength(4);
    expect(plan.unscheduledCards.every(c => /dependenc/i.test(c.reason))).toBe(
      true
    );
  });

  it("does not truncate work when no full window fits and explains downstream failure", () => {
    const { plan } = run(
      [action("long"), action("dependent", { dependsOn: ["long"] })],
      {
        worker: { ...worker, workEndTime: "10:20" },
      }
    );
    expect(plan.blocks).toEqual([]);
    expect(plan.unscheduledCards).toHaveLength(2);
    expect(plan.unscheduledCards[0].reason).toMatch(/30.*minute|full.*window/i);
    expect(plan.unscheduledCards[1].reason).toMatch(/dependenc/i);
  });

  it("allows verification but not normal execution for blocked actions or blocked cards", () => {
    const { plan } = run(
      [
        action("work", { cardId: "a", blocked: true }),
        action("verify", { cardId: "a", blocked: true, kind: "verify" }),
        action("unsafe", { cardId: "a" }),
      ],
      {
        cards: [
          card("a", {
            state: "WAITING_ON_CLIENT",
            stateReason: "Awaiting approval",
          }),
        ],
      }
    );
    expect(plan.blocks.map(b => b.action)).toEqual(["Do verify"]);
    expect(plan.unscheduledCards).toHaveLength(2);
    expect(plan.unscheduledCards[0].reason).toContain("Awaiting approval");
  });

  it("reports changed waiting reasons and source ids even with no block changes", () => {
    const a = action("a", { blocked: true, reason: "Need input" });
    const before = run([a], {
      cards: [card("a", { state: "WAITING", stateReason: "Awaiting quote" })],
    });
    const after = run([a], {
      existing: before.plan,
      cards: [
        card("a", {
          state: "WAITING",
          stateReason: "Awaiting signed contract",
        }),
      ],
    });
    expect(after.plan.blocks).toEqual([]);
    expect(after.changes.join(" ")).toContain("Awaiting signed contract");
    expect(after.changes.join(" ")).toContain("source-a");
    expect(after.changes.join(" ")).toContain("Need input");
  });

  it("retains stable action ids when times change and produces no repeat churn", () => {
    const actions = [action("a"), action("b")];
    const first = run(actions);
    const repeat = run(actions, {
      existing: first.plan,
      result: {
        version: 1,
        assessedAt: "2026-09-04T08:01:00Z",
        actions,
        assessments: [],
        interventions: [],
        sourceGaps: [],
      },
    });
    expect(repeat.changes).toEqual([]);
    expect(repeat.plan).toEqual({
      ...first.plan,
      planningImpact: repeat.plan.planningImpact,
    });
    expect(repeat.plan.planningImpact.scheduleChanged).toBe(false);
    const moved = run(actions, {
      existing: first.plan,
      worker: {
        ...worker,
        breaks: [{ name: "Break", startTime: "10:00", durationMinutes: 30 }],
      },
    });
    expect(moved.plan.blocks.map(b => b.id)).toEqual(
      first.plan.blocks.map(b => b.id)
    );
    expect(moved.plan.blocks[0].startTime).toBe("10:30");
  });

  it("records added, moved and removed blocks against the same-day plan without treating removed work as done", () => {
    const existing = saved([
      block("old", { startTime: "10:30", endTime: "11:00" }),
      block("a", { startTime: "11:00", endTime: "11:30" }),
    ]);
    const { plan, changes } = run([action("a"), action("new")], {
      existing,
      worker: { ...worker, breaks: [{ name: "Break", startTime: "11:00", durationMinutes: 30 }] },
    });
    expect(plan.planningImpact?.planChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "moved", blockId: "a", before: { startTime: "11:00", endTime: "11:30" } }),
      expect.objectContaining({ kind: "added", blockId: "new", before: null }),
      expect.objectContaining({ kind: "removed", blockId: "old", after: null }),
    ]));
    expect(plan.planningImpact?.availabilityChanged).toBe(true);
    expect(plan.planningImpact?.planChanges?.find(change => change.blockId === "old")?.reason).toMatch(/needs review/i);
    expect(plan.blocks.some(item => item.id === "old")).toBe(false);
    expect(changes.join(" ")).toContain("No longer scheduled: Card old");
    expect(changes.join(" ")).toContain("does not mark the work complete");
  });

  it("records updated content without inventing a slot movement and keeps protected work out of the change list", () => {
    const { plan } = run([action("a")], { existing: saved([
      block("a", { startTime: "10:00", endTime: "10:30" }),
      block("done", { startTime: "09:00", endTime: "09:30", status: "done" }),
    ]) });
    expect(plan.planningImpact?.planChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "updated", blockId: "a", before: { startTime: "10:00", endTime: "10:30" }, after: { startTime: "10:00", endTime: "10:30" } }),
    ]));
    expect(plan.planningImpact?.planChanges?.some(change => change.blockId === "done")).toBe(false);
    expect(plan.planningImpact?.protectedBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ blockId: "done", preservedExactly: true }),
    ]));
  });

  it("does not mutate any input", () => {
    const actions = [action("a")];
    const existing = saved([block("past")]);
    const before = JSON.stringify({ actions, existing, worker });
    run(actions, { existing });
    expect(JSON.stringify({ actions, existing, worker })).toBe(before);
  });
});

function step(
  id: number,
  extra: Partial<ManagerCard["steps"][number]> = {}
): ManagerCard["steps"][number] {
  return {
    id,
    title: `Step ${id}`,
    category: "work",
    minutes: 30,
    complete: false,
    requiresDecision: false,
    dependsOn: [],
    completionCriteria: null,
    ...extra,
  };
}

describe("planning reliability regressions", () => {
  it("does not present assessment scores as calibrated plan confidence", () => {
    const { plan } = run([], {
      result: {
        version: 1,
        assessedAt: now.toISOString(),
        actions: [],
        interventions: [],
        sourceGaps: [],
        assessments: [
          {
            cardId: "a",
            state: "READY",
            explanation: "Ready",
            confidence: 95,
            uncertainties: [],
            evidenceIds: [],
            actions: [],
          },
        ],
      },
    });
    expect(plan.planHealth.confidence).toBe(0);
  });
  it.each([
    ["tomorrow UTC", "2026-09-05T08:00:00Z"],
    ["tomorrow local", "2026-09-05T00:15:00+02:00"],
    ["next month", "2026-10-04T08:00:00Z"],
    ["next year", "2027-01-01T08:00:00Z"],
  ])("does not schedule %s today", (_, notBefore) => {
    const { plan } = run([
      action("a", { notBefore, kind: "follow_up", blocked: true }),
    ]);
    expect(plan.blocks).toEqual([]);
    expect(plan.unscheduledCards[0].reason).toMatch(/date|today|not before/i);
  });

  it.each([
    ["yesterday's later clock", "2026-09-03T17:00:00+02:00", "10:00"],
    ["same instant in offset", "2026-09-04T14:45:00+05:45", "11:00"],
    ["UTC previous date, local today", "2026-09-03T23:30:00Z", "10:00"],
    ["seconds round upward", "2026-09-04T08:00:01Z", "10:01"],
    ["milliseconds round upward", "2026-09-04T08:00:00.001Z", "10:01"],
  ])("honors the complete instant for %s", (_, notBefore, startTime) => {
    expect(run([action("a", { notBefore })]).plan.blocks[0].startTime).toBe(
      startTime
    );
  });

  it.each([
    "",
    "bad date",
    "2026-09-04",
    "2026-09-04T11:00:00",
    "2026-02-30T11:00:00Z",
    "2026-09-04T24:00:00Z",
  ])("rejects invalid or ambiguous notBefore %s", notBefore => {
    const { plan } = run([action("a", { notBefore })]);
    expect(plan.blocks).toEqual([]);
    expect(plan.unscheduledCards[0].reason).toMatch(/invalid|timezone|verify/i);
  });

  it("rounds now upward rather than placing new work in the past", () => {
    expect(
      run([action("a")], { now: new Date("2026-09-04T08:00:42Z") }).plan
        .blocks[0].startTime
    ).toBe("10:01");
  });

  it.each([
    [
      "Europe/Amsterdam",
      "2026-03-29T00:45:00Z",
      "2026-03-29T01:15:00Z",
      "03:15",
    ],
    [
      "Europe/Amsterdam",
      "2026-10-25T00:45:00Z",
      "2026-10-25T01:15:00Z",
      "02:45",
    ],
    [
      "America/New_York",
      "2026-03-08T06:45:00Z",
      "2026-03-08T07:15:00Z",
      "03:15",
    ],
    ["Asia/Kathmandu", "2026-09-04T03:00:00Z", "2026-09-04T04:00:00Z", "09:45"],
  ])(
    "uses real instants across %s transitions at %s",
    (timezone, at, notBefore, startTime) => {
      const { plan } = run([action("a", { notBefore })], {
        now: new Date(at),
        worker: {
          ...worker,
          timezone,
          workingDays: [0, 1, 2, 3, 4, 5, 6],
          workStartTime: "00:00",
          workEndTime: "18:00",
        },
      });
      expect(plan.blocks[0].startTime).toBe(startTime);
      expect(plan.blocks[0].endTime > plan.blocks[0].startTime).toBe(true);
    }
  );

  it("does not invent a spring-forward clock time or shorten the estimated duration", () => {
    const { plan } = run([action("a")], {
      now: new Date("2026-03-29T00:45:00Z"),
      worker: {
        ...worker,
        workingDays: [0],
        workStartTime: "01:00",
        workEndTime: "05:00",
      },
    });
    expect(plan.blocks[0]).toMatchObject({
      startTime: "03:00",
      endTime: "03:30",
    });
  });

  it("does not reuse yesterday's blocks across a local date rollover", () => {
    const { plan } = run([action("a")], {
      existing: saved([block("past", { status: "active" })]),
      now: new Date("2026-09-04T23:00:00Z"),
      worker: { ...worker, workingDays: [6] },
    });
    expect(plan.dateKey).toBe("2026-09-05");
    expect(plan.blocks.map(b => b.id)).toEqual(["a"]);
  });

  it.each(["done", "skipped", "active", "planned"] as const)(
    "protects %s by step, not the entire card",
    status => {
      const original = block("old", { cardId: "a", status, stepIds: [1] });
      const { plan } = run(
        [
          action("renamed", { cardId: "a", stepIds: [1] }),
          action("later", { cardId: "a", stepIds: [2] }),
        ],
        {
          existing: saved([original]),
        }
      );
      expect(plan.blocks.map(b => b.id)).toEqual(["old", "later"]);
      expect(plan.blocks[0]).toEqual(original);
    }
  );

  it("does not protect another card with the same numeric step id", () => {
    const { plan } = run([action("b", { stepIds: [1] })], {
      existing: saved([block("a", { stepIds: [1], status: "done" })]),
    });
    expect(plan.blocks.map(b => b.id)).toEqual(["a", "b"]);
  });

  it("uses an explicit timer block id without preserving sibling blocks", () => {
    const kept = block("timer", {
      cardId: "a",
      stepIds: [1],
      startTime: "11:00",
      endTime: "11:30",
    });
    const { plan } = run([action("later", { cardId: "a", stepIds: [2] })], {
      existing: saved([
        kept,
        block("obsolete", {
          cardId: "a",
          startTime: "12:00",
          endTime: "13:00",
        }),
      ]),
      activeTimer: { cardId: "a", planBlockId: "timer" },
    });
    expect(plan.blocks.map(b => b.id)).toEqual(["later", "timer"]);
    expect(plan.blocks.find(b => b.id === "timer")).toEqual(kept);
  });

  it("does not fall back to card identity when the explicit timer block id is missing", () => {
    const { plan } = run([action("new", { cardId: "a" })], {
      existing: saved([
        block("obsolete", {
          cardId: "a",
          startTime: "11:00",
          endTime: "12:00",
        }),
      ]),
      activeTimer: { cardId: "a", planBlockId: "missing" },
    });
    expect(plan.blocks.map(b => b.id)).toEqual(["new"]);
  });

  it("card-only timer fallback selects one block, not all future blocks", () => {
    const kept = block("timer", {
      cardId: "a",
      stepIds: [1],
      startTime: "10:00",
      endTime: "10:30",
    });
    const { plan } = run([action("later", { cardId: "a", stepIds: [2] })], {
      existing: saved([
        kept,
        block("obsolete", {
          cardId: "a",
          startTime: "12:00",
          endTime: "13:00",
        }),
      ]),
      activeTimer: { cardId: "a", planBlockId: null },
    });
    expect(plan.blocks.map(b => b.id)).toEqual(["timer", "later"]);
    expect(plan.blocks[1].startTime).toBe("10:30");
  });

  it("does not link null timer card ids to every cardless block", () => {
    const { plan } = run([action("a")], {
      existing: saved([
        block("obsolete", {
          cardId: null,
          startTime: "11:00",
          endTime: "12:00",
        }),
      ]),
      activeTimer: { cardId: null, planBlockId: null },
    });
    expect(plan.blocks.map(b => b.id)).toEqual(["a"]);
  });

  it.each(["active", "skipped", "planned"] as const)(
    "does not consider a preserved %s dependency completed",
    status => {
      const { plan } = run([action("next", { dependsOn: ["previous"] })], {
        existing: saved([block("previous", { status })]),
      });
      expect(plan.blocks.map(b => b.id)).toEqual(["previous"]);
      expect(plan.unscheduledCards[0].reason).toMatch(/dependenc.*complet/i);
    }
  );

  it("accepts an actually done dependency absent from current actions", () => {
    const { plan } = run([action("next", { dependsOn: ["previous"] })], {
      existing: saved([block("previous", { status: "done" })]),
    });
    expect(plan.blocks.map(b => b.id)).toEqual(["previous", "next"]);
  });

  it("accepts completed source steps without rescheduling them", () => {
    const { plan } = run(
      [
        action("previous", { cardId: "a", stepIds: [1] }),
        action("next", { cardId: "a", stepIds: [2], dependsOn: ["previous"] }),
      ],
      {
        cards: [card("a", { steps: [step(1, { complete: true }), step(2)] })],
      }
    );
    expect(plan.blocks.map(b => b.id)).toEqual(["next"]);
  });

  it("rechecks actual step dependencies even when action dependencies are absent", () => {
    const { plan } = run([action("next", { cardId: "a", stepIds: [2] })], {
      cards: [card("a", { steps: [step(1), step(2, { dependsOn: ["1"] })] })],
    });
    expect(plan.blocks).toEqual([]);
    expect(plan.unscheduledCards[0].reason).toMatch(/dependenc/i);
  });

  it.each([false, true])(
    "checks cross-card source completion (%s)",
    complete => {
      const { plan } = run([action("next", { cardId: "a", stepIds: [2] })], {
        cards: [
          card("b", { steps: [step(1, { complete })] }),
          card("a", { steps: [step(2, { dependsOn: ["b:1"] })] }),
        ],
      });
      expect(plan.blocks.map(b => b.id)).toEqual(complete ? ["next"] : []);
    }
  );

  it.each(["verify", "follow_up"] as const)(
    "does not waive real dependencies for %s",
    kind => {
      const { plan } = run([
        action("first"),
        action("next", { kind, blocked: true, dependsOn: ["first"] }),
      ]);
      expect(plan.blocks.map(b => b.id)).toEqual(["first"]);
      expect(plan.unscheduledCards[0].reason).toMatch(/dependenc.*complet/i);
    }
  );

  it("never promotes a stale blocked work action just because its prerequisite is planned", () => {
    const { plan } = run([
      action("first"),
      action("next", { blocked: true, dependsOn: ["first"] }),
    ]);
    expect(plan.blocks.map(b => b.id)).toEqual(["first"]);
  });

  it("counts all actual overlap pairs including nested preserved intervals", () => {
    const originals = [
      block("outer", { status: "done", startTime: "09:00", endTime: "13:00" }),
      block("inner", {
        status: "skipped",
        startTime: "10:00",
        endTime: "10:30",
      }),
      block("last", { status: "done", startTime: "10:30", endTime: "11:00" }),
    ];
    const { plan } = run([action("new")], { existing: saved(originals) });
    expect(plan.planHealth.overlaps).toBe(2);
    expect(plan.blocks.slice(0, 3)).toEqual(originals);
    expect(plan.blocks[3].startTime).toBe("13:00");
  });

  it("does not count touching blocks as overlapping", () => {
    expect(run([action("a"), action("b")]).plan.planHealth.overlaps).toBe(0);
  });

  it.each([
    ["before shift", "08:00", 90, "10:00", 510],
    ["after shift", "19:00", 60, "10:00", 540],
    ["current break", "09:45", 45, "10:30", 495],
    ["exact boundary", "10:30", 30, "10:00", 510],
  ])(
    "clips and respects %s breaks",
    (_, startTime, durationMinutes, expectedStart, available) => {
      const { plan } = run([action("a")], {
        worker: {
          ...worker,
          breaks: [{ name: "Break", startTime, durationMinutes }],
        },
      });
      expect(plan.blocks[0].startTime).toBe(expectedStart);
      expect(plan.planHealth.availableMinutes).toBe(available);
      expect(plan.planHealth.overlaps).toBe(0);
    }
  );

  it("does not schedule after the end of the shift", () => {
    expect(
      run([action("a")], { now: new Date("2026-09-04T17:00:00Z") }).plan.blocks
    ).toEqual([]);
  });

  it("retains a still-valid future slot instead of pulling it forward", () => {
    const first = run([action("a", { notBefore: "2026-09-04T10:00:00Z" })]);
    const repeat = run([action("a")], {
      existing: first.plan,
      now: new Date("2026-09-04T08:15:00Z"),
    });
    expect(repeat.plan.blocks[0].startTime).toBe("12:00");
    expect(repeat.changes).toEqual([]);
    expect(repeat.plan).toEqual({
      ...first.plan,
      planningImpact: repeat.plan.planningImpact,
    });
    expect(repeat.plan.planningImpact.scheduleChanged).toBe(false);
  });

  it("retains result ordering rather than resorting actions by priority or available gaps", () => {
    const { plan } = run([
      action("first", { priority: 1, notBefore: "2026-09-04T10:00:00Z" }),
      action("second", { priority: 99 }),
    ]);
    expect(plan.blocks.map(b => [b.id, b.startTime])).toEqual([
      ["first", "12:00"],
      ["second", "12:30"],
    ]);
  });

  it("respects a changed result order despite existing future slots", () => {
    const a = action("a"),
      b = action("b");
    const first = run([a, b], { now: new Date("2026-09-04T06:00:00Z") });
    const second = run([b, a], {
      existing: first.plan,
      now: new Date("2026-09-04T06:00:00Z"),
    });
    expect(second.plan.blocks.map(b => b.id)).toEqual(["b", "a"]);
    expect(second.plan.planHealth.overlaps).toBe(0);
  });

  it("is idempotent with blocked dependencies and preserved same-card work", () => {
    const actions = [
      action("next", { cardId: "a", stepIds: [2], dependsOn: ["previous"] }),
    ];
    const first = run(actions, {
      existing: saved([
        block("previous", { cardId: "a", stepIds: [1], status: "active" }),
      ]),
    });
    const second = run(actions, { existing: first.plan });
    expect(second.plan).toEqual({
      ...first.plan,
      planningImpact: second.plan.planningImpact,
    });
    expect(second.plan.planningImpact.scheduleChanged).toBe(false);
    expect(second.changes).toEqual([]);
  });

  it("does not borrow an unrelated same-card step estimate for an explicit timer", () => {
    const { plan } = run(
      [
        action("later", {
          cardId: "a",
          stepIds: [2],
          minutes: {
            low: 60,
            likely: 120,
            high: 180,
            samples: 0,
            basis: "estimate",
          },
        }),
      ],
      {
        existing: saved([block("running", { cardId: "a", stepIds: [1] })]),
        activeTimer: { cardId: "a", planBlockId: "running" },
      }
    );
    expect(plan.blocks.find(b => b.id === "later")?.startTime).toBe("10:30");
  });

  it("does not reserve extra time for a completed timer-linked block", () => {
    const { plan } = run([action("later")], {
      existing: saved([block("done", { status: "done" })]),
      activeTimer: { cardId: "done", planBlockId: "done" },
    });
    expect(plan.blocks.find(b => b.id === "later")?.startTime).toBe("10:00");
  });

  it("prefers an active block over an earlier future block for card-only timer fallback", () => {
    const active = block("running", {
      status: "active",
      cardId: "a",
      startTime: "10:30",
      endTime: "11:00",
    });
    const { plan } = run([], {
      existing: saved([
        block("obsolete", {
          cardId: "a",
          startTime: "10:00",
          endTime: "10:30",
        }),
        active,
      ]),
      activeTimer: { cardId: "a", planBlockId: null },
    });
    expect(plan.blocks).toEqual([active]);
  });

  it("protects an entire multi-step block without suppressing unrelated work", () => {
    const kept = block("kept", {
      cardId: "a",
      stepIds: [1, 2],
      status: "done",
    });
    const { plan } = run(
      [
        action("repeat", { cardId: "a", stepIds: [2] }),
        action("unrelated", { cardId: "a", stepIds: [3] }),
      ],
      {
        existing: saved([kept]),
      }
    );
    expect(plan.blocks.map(b => b.id)).toEqual(["kept", "unrelated"]);
  });

  it("requires all steps of a dependency action to be complete", () => {
    const { plan } = run(
      [
        action("previous", { cardId: "a", stepIds: [1, 2], blocked: true }),
        action("next", { dependsOn: ["previous"] }),
      ],
      {
        cards: [
          card("a", { steps: [step(1, { complete: true }), step(2)] }),
          card("next"),
        ],
      }
    );
    expect(plan.blocks).toEqual([]);
    expect(
      plan.unscheduledCards.find(c => c.cardId === "next")?.reason
    ).toMatch(/dependenc.*complet/i);
  });

  it("accepts done step evidence even when the dependency action id changed", () => {
    const { plan } = run(
      [
        action("renamed", { cardId: "a", stepIds: [1] }),
        action("next", { dependsOn: ["renamed"] }),
      ],
      {
        existing: saved([
          block("original", { cardId: "a", stepIds: [1], status: "done" }),
        ]),
      }
    );
    expect(plan.blocks.map(b => b.id)).toEqual(["original", "next"]);
  });

  it("resolves dependency steps on card ids containing colons", () => {
    const { plan } = run([action("next", { cardId: "a", stepIds: [2] })], {
      cards: [
        card("email:123", { steps: [step(-123, { complete: true })] }),
        card("a", { steps: [step(2, { dependsOn: ["email:123:-123"] })] }),
      ],
    });
    expect(plan.blocks.map(b => b.id)).toEqual(["next"]);
  });

  it("does not claim today's future work completed from a different card's step", () => {
    const { plan } = run([action("next", { cardId: "a", stepIds: [2] })], {
      cards: [
        card("a", { steps: [step(1), step(2, { dependsOn: ["1"] })] }),
        card("b", { steps: [step(1, { complete: true })] }),
      ],
    });
    expect(plan.blocks).toEqual([]);
  });

  it("preserves all history on a protected non-working day", () => {
    const kept = [
      block("active", { status: "active" }),
      block("done", { status: "done" }),
      block("skipped", { status: "skipped" }),
    ];
    const { plan } = run([action("new")], {
      existing: saved(kept),
      worker: { ...worker, workingDays: [] },
    });
    expect(plan.blocks).toEqual(kept);
    expect(plan.unscheduledCards).toHaveLength(1);
    expect(plan.planHealth.availableMinutes).toBe(0);
  });

  it("does not create a slot when merged breaks cover the entire shift", () => {
    const { plan } = run([action("a")], {
      worker: {
        ...worker,
        breaks: [
          { name: "Morning", startTime: "08:00", durationMinutes: 300 },
          { name: "Afternoon", startTime: "12:00", durationMinutes: 420 },
        ],
      },
    });
    expect(plan.blocks).toEqual([]);
    expect(plan.planHealth.availableMinutes).toBe(0);
  });

  it("merges touching breaks and schedules exactly at their end", () => {
    const { plan } = run([action("a")], {
      worker: {
        ...worker,
        breaks: [
          { name: "First", startTime: "10:00", durationMinutes: 30 },
          { name: "Second", startTime: "10:30", durationMinutes: 30 },
        ],
      },
    });
    expect(plan.blocks[0].startTime).toBe("11:00");
    expect(plan.planHealth.availableMinutes).toBe(480);
  });

  it("keeps exact-fit work ending at shift end", () => {
    expect(
      run([action("a")], { worker: { ...worker, workEndTime: "10:30" } }).plan
        .blocks[0].endTime
    ).toBe("10:30");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects non-finite duration %s",
    likely => {
      const { plan } = run([
        action("a", {
          minutes: { low: 5, likely, high: 60, basis: "estimate", samples: 0 },
        }),
      ]);
      expect(plan.blocks).toEqual([]);
      expect(plan.unscheduledCards[0].reason).toMatch(/invalid.*duration/i);
    }
  );

  it("does not create duplicate blocks for duplicate action ids", () => {
    const a = action("a");
    expect(run([a, a]).plan.blocks).toHaveLength(1);
  });

  it("does not schedule the same source step twice under different action ids", () => {
    const { plan } = run([
      action("first", { cardId: "a", stepIds: [1] }),
      action("duplicate", { cardId: "a", stepIds: [1] }),
      action("later", { cardId: "a", stepIds: [2] }),
    ]);
    expect(plan.blocks.map(b => b.id)).toEqual(["first", "later"]);
  });

  it("does not churn when persisted JSON object keys have a different order", () => {
    const actions = [action("a")];
    const first = run(actions);
    const { blocks, ...rest } = first.plan;
    const existing = { blocks, ...rest };
    const repeat = run(actions, { existing });
    expect(repeat.plan).toEqual({
      ...existing,
      planningImpact: repeat.plan.planningImpact,
    });
    expect(repeat.changes).toEqual([]);
    expect(repeat.plan.planningImpact.scheduleChanged).toBe(false);
  });

  it("does not count zero-duration preserved markers as overlaps", () => {
    const { plan } = run([], {
      existing: saved([
        block("work", { status: "done", startTime: "09:00", endTime: "11:00" }),
        block("marker", {
          status: "skipped",
          startTime: "10:00",
          endTime: "10:00",
        }),
      ]),
    });
    expect(plan.planHealth.overlaps).toBe(0);
    expect(plan.blocks).toHaveLength(2);
  });
});

describe("manager planning impact preflight", () => {
  it("blocks changes when a running timer has no retained block instead of inventing free time", () => {
    const { plan } = run([action("a")], {
      activeTimer: { cardId: "unmapped", planBlockId: "missing" },
    });
    expect(
      plan.planningImpact.risks.find(
        risk => risk.code === "active_timer_unmapped"
      )
    ).toMatchObject({ subjectId: "missing", requiresReview: true });
    expect(plan.planningImpact.requiresReview).toBe(true);
  });
  it("permits a simple safe proposal without inventing a deadline requirement", () => {
    const { plan } = run([action("a")]);
    expect(plan.planningImpact.requiresReview).toBe(false);
    expect(plan.planningImpact.deadlines[0].after.status).toBe(
      "deadline_not_provided"
    );
  });

  it("does not treat ordinary future backlog as today's capacity constraint", () => {
    const { plan } = run(
      [
        action("future", {
          minutes: {
            low: 60,
            likely: 600,
            high: 660,
            basis: "estimate",
            samples: 0,
          },
        }),
      ],
      {
        cards: [card("future", { dueAt: "2026-10-04T10:00:00Z" })],
      }
    );
    expect(plan.blocks).toEqual([]);
    expect(plan.planningImpact.deadlines[0].after.status).toBe("unscheduled");
    expect(
      plan.planningImpact.risks.find(r => r.code === "deadline_unscheduled")
    ).toMatchObject({ requiresReview: false });
    expect(plan.planningImpact.requiresReview).toBe(false);
  });

  it("requires review when unfinished work due today has no slot", () => {
    const { plan } = run(
      [
        action("today", {
          minutes: {
            low: 60,
            likely: 600,
            high: 660,
            basis: "estimate",
            samples: 0,
          },
        }),
      ],
      {
        cards: [card("today", { dueAt: "2026-09-04T16:00:00Z" })],
      }
    );
    expect(
      plan.planningImpact.risks.find(r => r.code === "deadline_unscheduled")
        ?.requiresReview
    ).toBe(true);
    expect(plan.planningImpact.requiresReview).toBe(true);
  });

  it("discloses inherited unknown estimates without blanket-blocking safe additions", () => {
    const { plan } = run([action("a")], {
      existing: saved([
        block("legacy", {
          status: "active",
          startTime: "10:00",
          endTime: "10:30",
        }),
      ]),
    });
    expect(
      plan.planningImpact.risks.find(r => r.code === "buffer_unknown")
    ).toMatchObject({ requiresReview: false });
    expect(plan.planningImpact.requiresReview).toBe(false);
  });

  it("does not hide unscheduled steps behind an earlier completed block on the same card", () => {
    const { plan } = run(
      [action("remaining", { cardId: "a", blocked: true })],
      {
        cards: [card("a", { dueAt: "2026-09-04T16:00:00Z" })],
        existing: saved([block("completed", { cardId: "a", status: "done" })]),
      }
    );
    expect(plan.planningImpact.deadlines[0].after).toMatchObject({
      status: "unscheduled",
      blockIds: ["completed"],
      unscheduledActionIds: ["remaining"],
    });
  });

  it("includes retained-block dependency inputs even without a new matching action", () => {
    const { plan } = run([], {
      cards: [card("a", { steps: [step(1, { dependsOn: ["external:99"] })] })],
      existing: saved([
        block("retained", { cardId: "a", stepIds: [1], status: "active" }),
      ]),
    });
    expect(plan.planningImpact.dependencies[0]).toMatchObject({
      actionId: "retained",
      dependency: "external:99",
      completionRecorded: false,
      after: { ordering: "unknown" },
    });
    const ids = new Set(plan.planningImpact.assumptions.map(a => a.id));
    expect(
      plan.planningImpact.dependencies[0].assumptionIds.every(id => ids.has(id))
    ).toBe(true);
  });

  it("compares deadline movement and a retained-plan alternative using exact input references", () => {
    const existing = saved([
      block("a", { startTime: "10:00", endTime: "10:30" }),
    ]);
    const original = structuredClone(existing);
    const { plan } = run([action("new"), action("a")], {
      existing,
      cards: [card("new"), card("a", { dueAt: "2026-09-04T08:45:00Z" })],
    });
    const impact = plan.planningImpact;
    expect(existing).toEqual(original);
    expect(impact.deadlines.find(item => item.cardId === "a")).toMatchObject({
      movement: "later",
      before: {
        latestScheduledEndAt: "2026-09-04T08:30:00.000Z",
        slackMinutes: 15,
        status: "within_deadline",
      },
      after: {
        latestScheduledEndAt: "2026-09-04T09:00:00.000Z",
        slackMinutes: -15,
        status: "after_deadline",
      },
    });
    expect(impact.alternative).toMatchObject({
      kind: "keep_current_plan",
      available: true,
      blockIds: ["a"],
      deadlineRiskCardIds: [],
    });
    expect(
      impact.risks.some(
        risk => risk.code === "deadline_regression" && risk.subjectId === "a"
      )
    ).toBe(true);
    expect(impact.requiresReview).toBe(true);
    expect(impact.assumptions.find(a => a.id === "card:a")).toMatchObject({
      inputPath: "cards[1]",
      value: { dueAt: "2026-09-04T08:45:00Z" },
    });
  });

  it("does not manufacture deadlines or historical completion from a planned dependency", () => {
    const { plan } = run([action("a"), action("b", { dependsOn: ["a"] })], {
      existing: saved([
        block("b", { startTime: "10:00", endTime: "10:30" }),
        block("a", { startTime: "11:00", endTime: "11:30" }),
      ]),
      cards: [card("a", { dueAt: "2026-09-04" }), card("b")],
    });
    expect(
      plan.planningImpact.deadlines.find(item => item.cardId === "a")?.after
    ).toMatchObject({ status: "unknown", slackMinutes: null });
    expect(
      plan.planningImpact.deadlines.find(item => item.cardId === "b")?.after
        .status
    ).toBe("deadline_not_provided");
    expect(plan.planningImpact.dependencies[0]).toMatchObject({
      actionId: "b",
      dependency: "a",
      completionRecorded: false,
      before: { ordering: "violated" },
      after: { scheduled: false, ordering: "unscheduled" },
    });
    expect(plan.planningImpact.alternative.dependencyRiskActionIds).toEqual([
      "b",
    ]);
  });

  it("subtracts merged breaks, protected occupancy and explicit overrun reservations from buffer", () => {
    const active = block("active", { status: "active" });
    const { plan } = run([action("new")], {
      existing: saved([active]),
      activeTimer: { cardId: "active", planBlockId: "active" },
      worker: {
        ...worker,
        workEndTime: "12:00",
        breaks: [
          { name: "First", startTime: "11:00", durationMinutes: 30 },
          { name: "Second", startTime: "11:15", durationMinutes: 30 },
        ],
      },
    });
    expect(plan.planningImpact.buffer).toMatchObject({
      before: { unallocatedMinutes: 45 },
      after: {
        unallocatedMinutes: 15,
        additionalHighEstimateMinutes: null,
        afterHighEstimatesMinutes: null,
        minimumKnownDeficitMinutes: 15,
        unknownEstimateBlockIds: ["active"],
      },
      unallocatedDeltaMinutes: -30,
      reservations: [
        {
          blockId: "active",
          startTime: "10:00",
          endTime: "10:30",
          basis: "planner_fallback_30_minutes",
        },
      ],
    });
    expect(plan.planningImpact.protectedBlocks[0]).toMatchObject({
      blockId: "active",
      preservedExactly: true,
      reasons: ["non_planned_status", "already_started", "active_timer"],
    });
    expect(
      plan.planningImpact.risks.some(risk => risk.code === "buffer_unknown")
    ).toBe(true);
    expect(
      plan.planningImpact.risks.find(
        risk => risk.code === "high_estimate_buffer_deficit"
      )?.requiresReview
    ).toBe(true);
  });

  it("reports a high-estimate deficit without describing estimates as calibrated facts", () => {
    const { plan } = run([action("a")], {
      worker: { ...worker, workEndTime: "10:30" },
    });
    expect(plan.planningImpact.buffer.after).toMatchObject({
      unallocatedMinutes: 0,
      additionalHighEstimateMinutes: 30,
      afterHighEstimatesMinutes: -30,
    });
    expect(
      plan.planningImpact.risks.some(
        risk => risk.code === "high_estimate_buffer_deficit"
      )
    ).toBe(true);
    expect(
      plan.planningImpact.assumptions.find(a => a.id === "action:a")?.limitation
    ).toContain("not calibrated");
  });

  it("reports missing duration support instead of treating a baseline block as free buffer", () => {
    const { plan } = run([], {
      existing: saved([
        block("unknown", {
          status: "active",
          startTime: "10:00",
          endTime: "11:00",
        }),
      ]),
    });
    expect(plan.planningImpact.buffer.before).toMatchObject({
      unallocatedMinutes: 420,
      additionalHighEstimateMinutes: null,
      afterHighEstimatesMinutes: null,
      unknownEstimateBlockIds: ["unknown"],
    });
  });

  it("does not compare another day's slots as today's baseline or fabricate a keep-plan option", () => {
    const { plan } = run([action("a")], {
      existing: { ...saved([block("old")]), dateKey: "2026-09-03" },
    });
    expect(plan.planningImpact.baseline).toBe("different_day_plan");
    expect(plan.planningImpact.buffer.before).toBeNull();
    expect(plan.planningImpact.alternative).toMatchObject({
      available: false,
      blockIds: [],
      buffer: null,
    });
    expect(
      plan.planningImpact.deadlines[0].before.latestScheduledEndAt
    ).toBeNull();
  });
});
