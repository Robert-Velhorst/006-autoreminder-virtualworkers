import { describe, expect, it } from "vitest";
import type {
  ManagerCard,
  ManagerEvidence,
  ManagerInput,
  ManagerTimeSample,
} from "../shared/aptlssManager";
import { assessManagerContext } from "./aptlssManagerEngine";

const now = "2026-09-04T10:00:00.000Z";
const step = (
  id: number,
  patch: Partial<ManagerCard["steps"][number]> = {}
): ManagerCard["steps"][number] => ({
  id,
  title: `Prepare report ${id}`,
  category: "report",
  minutes: 30,
  complete: false,
  requiresDecision: false,
  dependsOn: [],
  completionCriteria: "Report saved on the card",
  ...patch,
});
const card = (id = "a", patch: Partial<ManagerCard> = {}): ManagerCard => ({
  id,
  name: `Project ${id}`,
  url: `https://trello.com/c/${id}`,
  board: "Operations",
  list: "TODO",
  state: "TODO",
  stateReason: "Ready",
  dueAt: null,
  overdue: false,
  priority: 0,
  updatedAt: now,
  steps: [step(1)],
  waiting: null,
  ...patch,
});
const evidence = (
  id: string,
  text: string,
  kind: ManagerEvidence["kind"] = "source",
  patch: Partial<ManagerEvidence> = {}
): ManagerEvidence => ({
  id,
  cardId: "a",
  source: kind === "worker" ? "worker update" : "trello",
  text,
  observedAt: now,
  kind,
  ...patch,
});
const input = (patch: Partial<ManagerInput> = {}): ManagerInput => ({
  now,
  cards: [card()],
  evidence: [evidence("source", "Report is ready to prepare.")],
  timeSamples: [],
  sourceGaps: [],
  ...patch,
});
const sample = (
  id: number,
  minutes: number,
  patch: Partial<ManagerTimeSample> = {}
): ManagerTimeSample => ({
  id,
  minutes,
  cardId: "history",
  stepId: id,
  category: "report",
  completed: true,
  interrupted: false,
  ...patch,
});

describe("assessManagerContext", () => {
  it("withholds every executable action when collection explicitly reports incomplete work coverage", () => {
    const result = assessManagerContext(input({ executionCoverageComplete: false }));

    expect(result.executionCoverageComplete).toBe(false);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions.every(action => action.blocked)).toBe(true);
  });

  it("returns deterministic chronological open work without mutating the input", () => {
    const data = input({
      cards: [
        card("a", { steps: [step(9, { complete: true }), step(7), step(2)] }),
      ],
    });
    const before = structuredClone(data);
    const result = assessManagerContext(data);
    expect(result.actions.map(a => a.stepIds)).toEqual([[7], [2]]);
    expect(result.actions[1].dependsOn).toContain(result.actions[0].id);
    expect(result.actions[1].blocked).toBe(true);
    expect(result.actions[0]).toMatchObject({
      where: "https://trello.com/c/a",
      completionCriteria: "Report saved on the card",
      blocked: false,
    });
    expect(assessManagerContext(data)).toEqual(result);
    expect(data).toEqual(before);
  });

  it("topologically orders explicit dependencies before imposing chronological sequence", () => {
    const result = assessManagerContext(
      input({
        cards: [
          card("a", {
            steps: [
              step(3, { dependsOn: ["2"] }),
              step(1, { complete: true }),
              step(2, { dependsOn: ["1"] }),
            ],
          }),
        ],
      })
    );
    expect(result.actions.map(a => a.stepIds)).toEqual([[2], [3]]);
    expect(result.actions[0].blocked).toBe(false);
    expect(result.interventions).toEqual([]);
  });

  it("keeps work blocked when a completed founder decision was rejected", () => {
    const result = assessManagerContext(input({
      cards: [card("a", { steps: [
        step(1, { complete: true, requiresDecision: true, decisionRejected: true }),
        step(2, { dependsOn: ["1"] }),
      ] })],
    }));
    const followUp = result.actions.find(action => action.stepIds.includes(2));
    expect(result.actions.some(action => action.stepIds.includes(1))).toBe(false);
    expect(followUp).toMatchObject({
      blocked: true,
      reason: 'The founder rejected prerequisite "Prepare report 1". Ask the founder for a new direction before continuing.',
    });
    expect(followUp?.dependsOn).toContain("rejected:a:1");
  });

  it("keeps sequential work blocked after a rejected decision when no explicit edge exists", () => {
    const result = assessManagerContext(input({
      cards: [card("a", { steps: [
        step(1, { complete: true, requiresDecision: true, decisionRejected: true }),
        step(2),
      ] })],
    }));
    expect(result.actions.find(action => action.stepIds.includes(2))).toMatchObject({
      blocked: true,
      dependsOn: ["rejected:a:1"],
    });
  });

  it("honors cross-card dependencies even when the dependent card is urgent", () => {
    const result = assessManagerContext(
      input({
        cards: [
          card("a", {
            dueAt: "2026-09-03",
            steps: [step(1, { dependsOn: ["b:2"] })],
          }),
          card("b", { steps: [step(2)] }),
        ],
      })
    );
    const work = result.actions.filter(a => a.kind === "work");
    expect(work.map(a => a.cardId)).toEqual(["a", "b"]);
    expect(work[0].dependsOn).toContain(work[1].id);
    expect(work[0].blocked).toBe(true);
  });

  it.each([
    [["2"], ["1"]],
    [["missing"], []],
  ] as string[][][])(
    "interrupts cycles or missing dependencies without offering unsafe work: %j",
    dependencies => {
      const result = assessManagerContext(
        input({
          cards: [
            card("a", {
              steps: [
                step(1, { dependsOn: dependencies }),
                step(2, { dependsOn: dependencies.includes("2") ? ["1"] : [] }),
              ],
            }),
          ],
        })
      );
      expect(
        result.interventions.some(i => /depend|cycle/i.test(i.explanation))
      ).toBe(true);
      expect(
        result.actions.filter(a => a.kind === "work").every(a => a.blocked)
      ).toBe(true);
      expect(result.interventions[0].question).toContain("?");
    }
  );

  it("ranks urgent due first, then ON-HOLD, DOING, TODO for equal risk", () => {
    const result = assessManagerContext(
      input({
        cards: [
          card("todo"),
          card("doing", { list: "DOING" }),
          card("hold", { list: "ON-HOLD" }),
          card("urgent", { dueAt: "2026-09-04T12:00:00Z" }),
        ],
        evidence: [],
      })
    );
    expect(result.assessments.map(a => a.cardId)).toEqual([
      "urgent",
      "hold",
      "doing",
      "todo",
    ]);
  });

  it.each([
    ["Invoice has not been paid.", "I paid the invoice."],
    ["De factuur is nog niet betaald.", "De factuur is betaald."],
    ["Approval is pending.", "The client approved it."],
    ["Nog geen akkoord ontvangen.", "De klant heeft akkoord gegeven."],
    ["The task is not completed.", "The task is completed."],
    ["Het werk is nog niet afgerond.", "Het werk is afgerond."],
    ["Status: ON-HOLD.", "Status: DOING."],
    ["Deadline: 2026-09-05.", "Deadline is now 2026-09-10."],
  ])(
    "interrupts consequential source/worker contradictions: %s / %s",
    (source, worker) => {
      const result = assessManagerContext(
        input({
          evidence: [
            evidence("s", source, "source", {
              observedAt: "2026-09-03T10:00:00Z",
            }),
            evidence("w", worker, "worker"),
          ],
        })
      );
      const intervention = result.interventions.find(
        i => i.severity === "urgent"
      );
      expect(intervention).toBeDefined();
      expect(intervention!.issueKind).toBe("conflicting_claims");
      expect(intervention!.evidenceIds).toEqual(
        expect.arrayContaining(["s", "w"])
      );
      expect(intervention!.question).toContain("?");
      expect(result.actions[0].kind).toBe("verify");
      expect(
        result.actions.filter(a => a.kind === "work").every(a => a.blocked)
      ).toBe(true);
      expect(result.assessments[0].confidence).toBeLessThan(60);
    }
  );

  it("labels a notification with unknown contents as a source check, not a proved contradiction", () => {
    const result = assessManagerContext(input({
      evidence: [evidence("notice", "A message is waiting in your portal.", "source", { source: "gmail" })],
    }));
    expect(result.interventions[0]).toMatchObject({ issueKind: "source_check", severity: "attention" });
    expect(result.interventions[0].title).not.toMatch(/conflict/i);
    expect(result.actions.filter(action => action.kind === "work").every(action => action.blocked)).toBe(true);
  });

  it("keeps only the exactly reported work step open until its source-backed state changes", () => {
    const baseline = assessManagerContext(input());
    const actionId = baseline.actions.find(action => action.kind === "work")!.id;
    const reported = evidence("worker-report", "I recorded the comparison.", "worker", {
      metadata: { truthClass: "worker_report", reportKind: "completion", actionId },
    });
    const result = assessManagerContext(input({ evidence: [evidence("source", "Requirements document."), reported] }));

    expect(result.actions.find(action => action.id === actionId)).toMatchObject({
      blocked: true,
      reason: expect.stringMatching(/remains open/i),
    });
    expect(result.interventions).toContainEqual(expect.objectContaining({
      issueKind: "completion_report_pending",
      evidenceIds: ["worker-report"],
    }));

    const unrelated = assessManagerContext(input({ evidence: [
      evidence("source", "Requirements document."),
      evidence("worker-report", "I recorded the comparison.", "worker", {
        metadata: { truthClass: "worker_report", reportKind: "completion", actionId: "another-action" },
      }),
    ] }));
    expect(unrelated.actions.find(action => action.kind === "work")?.reason).not.toMatch(/completion was reported/i);
    expect(unrelated.interventions.some(item => item.issueKind === "completion_report_pending")).toBe(false);

    const sourceConfirmed = assessManagerContext(input({
      cards: [card("a", { steps: [step(1, { complete: true })] })],
      evidence: [evidence("source", "Comparison saved on the card."), reported],
    }));
    expect(sourceConfirmed.actions.some(action => action.id === actionId)).toBe(false);
    expect(sourceConfirmed.interventions.some(item => item.issueKind === "completion_report_pending")).toBe(false);
  });

  it.each([
    ["Invoice is unpaid.", "The invoice has not been paid yet."],
    ["De factuur is niet betaald.", "Ik heb de factuur nog niet betaald."],
    ["Approval is pending.", "It has not been approved."],
    ["Nog geen akkoord.", "Er is nog geen akkoord ontvangen."],
    ["Task not completed.", "I have not completed the task."],
    ["Werk niet afgerond.", "Ik ben nog niet klaar."],
  ])(
    "does not invert negated assertions into positive claims: %s",
    (source, worker) => {
      const result = assessManagerContext(
        input({
          evidence: [evidence("s", source), evidence("w", worker, "worker")],
        })
      );
      expect(result.interventions.filter(i => i.severity === "urgent")).toEqual(
        []
      );
      expect(result.assessments[0].state).not.toBe("DONE");
    }
  );

  it("does not let a late ingestion timestamp or newest worker message erase a dated contradiction", () => {
    const result = assessManagerContext(
      input({
        evidence: [
          evidence("s", "Invoice unpaid as of 2026-09-03."),
          evidence("w", "On 2026-08-01 I paid the invoice.", "worker", {
            observedAt: "2026-09-04T09:59:59Z",
          }),
        ],
      })
    );
    expect(result.interventions.some(i => i.severity === "urgent")).toBe(true);
    expect(result.assessments[0].explanation).toMatch(/verif|conflict/i);
  });

  it("compares worker deadlines and completion against structured card facts", () => {
    const result = assessManagerContext(
      input({
        cards: [card("a", { dueAt: "2026-09-06" })],
        evidence: [
          evidence(
            "w",
            "Deadline: 2026-09-09. The task is completed.",
            "worker"
          ),
        ],
      })
    );
    expect(
      result.interventions.some(
        i => i.severity === "urgent" && i.evidenceIds.includes("w")
      )
    ).toBe(true);
    expect(result.actions.find(a => a.stepIds.includes(1))?.blocked).toBe(true);
  });

  it("retains waiting follow-up timing and drafts communication for review only", () => {
    const result = assessManagerContext(
      input({
        cards: [
          card("a", {
            list: "ON-HOLD",
            waiting: {
              reason: "Waiting for supplier quote",
              action: "Email supplier for the quote",
              followUpAt: "2026-09-07T08:00:00Z",
              category: "external",
              confidence: 99,
            },
          }),
        ],
      })
    );
    const followUp = result.actions.find(a => a.kind === "follow_up")!;
    expect(followUp.notBefore).toBe("2026-09-07T08:00:00.000Z");
    expect(followUp.blocked).toBe(true);
    expect(followUp.draft).toMatch(/quote/i);
    expect(followUp.completionCriteria).toMatch(/review|send/i);
    expect(
      result.actions.filter(a => a.kind === "work").every(a => a.blocked)
    ).toBe(true);
  });

  it("makes overdue follow-ups actionable but never sends or assumes the dependency resolved", () => {
    const result = assessManagerContext(
      input({
        cards: [
          card("a", {
            waiting: {
              reason: "Client reply",
              action: "Ask client",
              followUpAt: "2026-09-03T08:00:00Z",
              category: "external",
              confidence: 90,
            },
          }),
        ],
      })
    );
    expect(result.actions.find(a => a.kind === "follow_up")?.blocked).toBe(
      false
    );
    expect(result.actions.find(a => a.kind === "work")?.blocked).toBe(true);
  });

  it.each([
    "Send the client an email",
    "Mail de klant",
    "Submit the application",
    "Pay the invoice",
  ])("prepares externally consequential steps as drafts: %s", title => {
    const action = assessManagerContext(
      input({ cards: [card("a", { steps: [step(1, { title })] })] })
    ).actions.find(a => a.kind === "draft")!;
    expect(action.kind).toBe("draft");
    expect(action.draft).toBeTruthy();
    expect(action.completionCriteria).toMatch(/review/i);
  });

  it("exposes absent and stale evidence without inventing calibrated confidence", () => {
    const missing = assessManagerContext(
      input({ evidence: [], sourceGaps: ["Email not connected"] })
    );
    const stale = assessManagerContext(
      input({
        evidence: [
          evidence("s", "Report ready", "source", {
            observedAt: "2026-01-01T00:00:00Z",
          }),
        ],
      })
    );
    expect(missing.assessments[0].confidence).toBe(0);
    expect(missing.assessments[0].uncertainties.join(" ")).toMatch(
      /missing|no source/i
    );
    expect(missing.sourceGaps).toContain("Email not connected");
    expect(stale.assessments[0].uncertainties.join(" ")).toMatch(/stale/i);
    expect(stale.assessments[0].confidence).toBeLessThanOrEqual(35);
  });

  it.each([
    "garbage",
    "2026-02-30T10:00:00Z",
    "2026-09-04T25:00:00Z",
    "2026-09-04T10:00:00",
  ])("rejects invalid or timezone-ambiguous clock input: %s", value => {
    expect(() => assessManagerContext(input({ now: value }))).toThrow(/now/i);
  });

  it("invalid dates cannot silently release waiting or masquerade as fresh evidence", () => {
    const result = assessManagerContext(
      input({
        cards: [
          card("a", {
            dueAt: "2026-02-30",
            waiting: {
              reason: "Reply",
              action: "Ask",
              followUpAt: "bad",
              category: "reply",
              confidence: 90,
            },
          }),
        ],
        evidence: [
          evidence("bad", "Approved", "source", {
            observedAt: "2026-02-30T12:00:00Z",
          }),
        ],
      })
    );
    expect(result.actions.find(a => a.kind === "follow_up")?.blocked).toBe(
      true
    );
    expect(result.assessments[0].confidence).toBe(0);
    expect(result.assessments[0].uncertainties.join(" ")).toMatch(/invalid/i);
  });

  it("learns robust step durations only from comparable completed uninterrupted samples", () => {
    const records = [
      sample(1, 20),
      sample(2, 25),
      sample(3, 30),
      sample(4, 1000),
      sample(5, 1, { completed: false }),
      sample(6, 2, { interrupted: true }),
      sample(7, 400, { stepId: null }),
      sample(8, 3, { category: "email" }),
    ];
    const minutes = assessManagerContext(input({ timeSamples: records }))
      .actions[0].minutes;
    expect(minutes.likely).toBeGreaterThanOrEqual(20);
    expect(minutes.likely).toBeLessThanOrEqual(30);
    expect(minutes.high).toBeLessThan(100);
    expect(minutes.samples).toBe(4);
    expect(minutes.basis).toMatch(/completed|personal/i);
  });

  it("does not count duplicate samples or partial entries as completed whole tasks", () => {
    const result = assessManagerContext(
      input({
        timeSamples: [
          sample(1, 2, { completed: false }),
          sample(2, 3, { interrupted: true }),
          sample(3, 120, { stepId: null }),
          sample(3, 120, { stepId: null }),
        ],
      })
    );
    expect(result.actions[0].minutes.samples).toBe(0);
    expect(result.actions[0].minutes.basis).toMatch(/initial/i);
    expect(result.actions[0].minutes.likely).toBe(30);
  });

  it("keeps estimates provisional with fewer than three comparable completions", () => {
    const minutes = assessManagerContext(
      input({ timeSamples: [sample(1, 10), sample(1, 10)] })
    ).actions[0].minutes;
    expect(minutes.samples).toBe(1);
    expect(minutes.basis).toMatch(/initial|provisional/i);
    expect(minutes.low).toBeLessThan(minutes.high);
  });

  it("keeps IDs bounded and stable across clock changes and unrelated cards", () => {
    const data = input({ cards: [card("a".repeat(300))] });
    const a = assessManagerContext(data).actions[0];
    const b = assessManagerContext({
      ...data,
      now: "2026-09-05T10:00:00Z",
      cards: [...data.cards, card("b")],
    }).actions.find(x => x.cardId === data.cards[0].id)!;
    expect(a.id).toBe(b.id);
    expect(a.id.length).toBeLessThanOrEqual(100);
  });

  it("reports bounded-input truncation instead of claiming complete coverage", () => {
    const result = assessManagerContext(
      input({
        evidence: Array.from({ length: 5000 }, (_, i) =>
          evidence(`s${i}`, "Report ready")
        ),
      })
    );
    expect(result.sourceGaps.join(" ")).toMatch(/limit|truncat/i);
    expect(result.assessments[0].confidence).toBeLessThan(60);
  });
});
