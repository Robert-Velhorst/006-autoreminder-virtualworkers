import { describe, expect, it } from "vitest";
import { aggregateManagerTimeSamples } from "./aptlssManagerTiming";

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 4, 10, minutes));

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
