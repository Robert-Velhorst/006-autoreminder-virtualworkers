import { describe, expect, it } from "vitest";
import { aggregateManagerTimeSamples, managerTimingPredictions } from "./aptlssManagerTiming";

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 4, 10, minutes));

describe("historical timing projections", () => {
  const action = { cardId: "card-a", stepIds: [11], minutes: { low: 5, likely: 10, high: 20, samples: 1, basis: "source context" }, title: "private source context", evidenceIds: ["private"] };
  const expected = { cardId: "card-a", stepIds: [11], minutes: { low: 5, likely: 10, high: 20 } };
  it("accepts both decoded MySQL JSON and JSON strings without retaining source context", () => {
    expect(managerTimingPredictions([action])).toEqual([expected]);
    expect(managerTimingPredictions(JSON.stringify([action]))).toEqual([expected]);
  });
  it.each([null, undefined, "not-json", "null", "{}", 1])("ignores unavailable or malformed action arrays: %j", value => {
    expect(managerTimingPredictions(value)).toEqual([]);
  });
  it.each([
    null, {}, { ...action, cardId: 1 }, { ...action, stepIds: null },
    { ...action, stepIds: ["11"] }, { ...action, stepIds: [0] },
    { ...action, minutes: null }, { ...action, minutes: { low: -1, likely: 10, high: 20 } },
    { ...action, minutes: { low: 12, likely: 10, high: 20 } },
    { ...action, minutes: { low: 5, likely: 30, high: 20 } },
    { ...action, minutes: { low: 5, likely: Infinity, high: 20 } },
    { ...action, minutes: { low: "5", likely: 10, high: 20 } },
  ])("rejects malformed estimates but preserves other valid actions: %j", value => {
    expect(managerTimingPredictions([value, action])).toEqual([expected]);
  });
  it("preserves prediction order and does not mutate historical values", () => {
    const second = { ...action, stepIds: [12], minutes: { low: 10, likely: 15, high: 20 } };
    const source = [action, second];
    const before = JSON.stringify(source);
    const result = managerTimingPredictions(source);
    expect(result.map(row => row.stepIds[0])).toEqual([11, 12]);
    result[0].stepIds.push(99);
    result[0].minutes.low = 0;
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe("manager timing sample aggregation", () => {
  it("combines sessions per completed worker step and indexes interruptions once", () => {
    const result = aggregateManagerTimeSamples(
      [
        { id: 1, aptlssStepId: 11, cardId: "card-a", category: "client_work", startTime: at(-30), endTime: at(-5), durationSeconds: 1500, durationMinutes: null },
        { id: 2, aptlssStepId: 11, cardId: "card-a", category: "client_work", startTime: at(-5), endTime: at(10), durationSeconds: 900, durationMinutes: null },
        { id: 3, aptlssStepId: 12, cardId: "card-a", category: "client_work", startTime: at(-20), endTime: at(-8), durationSeconds: 720, durationMinutes: null },
        { id: 4, aptlssStepId: 13, cardId: "card-a", category: "client_work", startTime: at(-15), endTime: at(-5), durationSeconds: 600, durationMinutes: null },
        { id: 5, aptlssStepId: 11, cardId: "card-b", category: "client_work", startTime: at(-10), endTime: at(-1), durationSeconds: 540, durationMinutes: null },
        { id: 6, aptlssStepId: null, cardId: null, category: "waiting", startTime: at(-10), endTime: at(-6), durationSeconds: 240, durationMinutes: null },
        { id: 7, aptlssStepId: 11, cardId: "card-a", category: "break", startTime: at(-5), endTime: at(-2), durationSeconds: 180, durationMinutes: null },
        { id: 8, aptlssStepId: 11, cardId: "card-a", category: "client_work", startTime: at(-20), endTime: at(-1), durationSeconds: 13 * 3600, durationMinutes: null },
      ],
      [
        { id: 11, cardId: "card-a", category: "research", status: "complete" },
        { id: 12, cardId: "card-a", category: "research", status: "complete" },
        { id: 13, cardId: "card-a", category: "research", status: "open" },
      ],
      [{ timeEntryId: 2, eventType: "pause" }],
    );

    expect(result.samples).toEqual([
      expect.objectContaining({
        id: 11,
        cardId: "card-a",
        stepId: 11,
        category: "research",
        minutes: 40,
        interrupted: true,
        startedAt: at(-30).toISOString(),
        completedAt: at(10).toISOString(),
      }),
      expect.objectContaining({
        id: 12,
        minutes: 12,
        interrupted: false,
      }),
    ]);
    expect(result.timeSummary).toEqual({ waitingMinutes: 7, interruptedMinutes: 15 });
  });

  it("does not turn an active or malformed timer into a completed sample", () => {
    const result = aggregateManagerTimeSamples(
      [
        { id: 1, aptlssStepId: 11, cardId: "card-a", category: "client_work", startTime: at(0), endTime: null, durationSeconds: null, durationMinutes: null },
        { id: 2, aptlssStepId: 11, cardId: "card-a", category: "client_work", startTime: "invalid", endTime: at(10), durationSeconds: 600, durationMinutes: null },
      ],
      [{ id: 11, cardId: "card-a", category: "research", status: "complete" }],
      [],
    );

    expect(result.samples).toEqual([]);
    expect(result.timeSummary).toEqual({ waitingMinutes: 0, interruptedMinutes: 0 });
  });

  it("keeps interrupted open work out of execution samples while retaining its interruption time", () => {
    const result = aggregateManagerTimeSamples(
      [
        { id: 1, aptlssStepId: 11, cardId: "card-a", category: "client_work", startTime: at(-30), endTime: at(-22), durationSeconds: 480, durationMinutes: null },
        { id: 2, aptlssStepId: null, cardId: null, category: "waiting", startTime: at(-20), endTime: at(-15), durationSeconds: 300, durationMinutes: null },
        { id: 3, aptlssStepId: null, cardId: null, category: "break", startTime: at(-10), endTime: at(-7), durationSeconds: 180, durationMinutes: null },
      ],
      [{ id: 11, cardId: "card-a", category: "research", status: "open" }],
      [
        { timeEntryId: 1, eventType: "pause" },
        { timeEntryId: 2, eventType: "pause" },
        { timeEntryId: 3, eventType: "pause" },
      ],
    );

    expect(result.samples).toEqual([]);
    expect(result.timeSummary).toEqual({ waitingMinutes: 8, interruptedMinutes: 8 });
  });

  it("recognizes the persisted timer-pause marker without requiring a separate event row", () => {
    const result = aggregateManagerTimeSamples(
      [
        { id: 4, aptlssStepId: 11, cardId: "card-a", category: "client_work", startTime: at(-30), endTime: at(-22), durationSeconds: 480, durationMinutes: null, notes: "Reviewed correspondence (paused)" },
      ],
      [{ id: 11, cardId: "card-a", category: "research", status: "complete" }],
      [],
    );

    expect(result.samples).toEqual([
      expect.objectContaining({ id: 11, minutes: 8, interrupted: true }),
    ]);
    expect(result.timeSummary).toEqual({ waitingMinutes: 0, interruptedMinutes: 8 });
  });

  it("keeps duplicate entry and event rows idempotent across work and waiting summaries", () => {
    const workEntry = { id: 4, aptlssStepId: 11, cardId: "card-a", category: "client_work", startTime: at(-30), endTime: at(-22), durationSeconds: 480, durationMinutes: null, notes: "(paused)" };
    const waitingEntry = { id: 5, aptlssStepId: null, cardId: null, category: "waiting", startTime: at(-20), endTime: at(-16), durationSeconds: 240, durationMinutes: null };
    const result = aggregateManagerTimeSamples(
      [workEntry, { ...workEntry }, waitingEntry, { ...waitingEntry }],
      [{ id: 11, cardId: "card-a", category: "research", status: "complete" }],
      [{ timeEntryId: 4, eventType: "pause" }, { timeEntryId: 4, eventType: "pause" }],
    );

    expect(result.samples).toEqual([
      expect.objectContaining({ id: 11, minutes: 8, interrupted: true }),
    ]);
    expect(result.timeSummary).toEqual({ waitingMinutes: 4, interruptedMinutes: 8 });
  });

  it("does not double-count overlapping sessions, waiting time, or interruptions", () => {
    const result = aggregateManagerTimeSamples(
      [
        { id: 1, aptlssStepId: 11, cardId: "card-a", category: "client_work", startTime: at(0), endTime: at(30), durationSeconds: 1800, durationMinutes: null },
        { id: 2, aptlssStepId: 11, cardId: "card-a", category: "client_work", startTime: at(20), endTime: at(40), durationSeconds: 1200, durationMinutes: null },
        { id: 3, aptlssStepId: null, cardId: null, category: "waiting", startTime: at(0), endTime: at(30), durationSeconds: 1800, durationMinutes: null },
        { id: 4, aptlssStepId: null, cardId: null, category: "break", startTime: at(20), endTime: at(40), durationSeconds: 1200, durationMinutes: null },
      ],
      [{ id: 11, cardId: "card-a", category: "research", status: "complete" }],
      [{ timeEntryId: 1, eventType: "pause" }, { timeEntryId: 2, eventType: "interrupt" }],
    );

    expect(result.samples).toEqual([
      expect.objectContaining({ id: 11, minutes: 40, interrupted: true }),
    ]);
    expect(result.timeSummary).toEqual({ waitingMinutes: 40, interruptedMinutes: 40 });
  });
});
