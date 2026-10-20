import { describe, expect, it } from "vitest";
import { ATIS_JOB_KEYS, presentAtisOperation, summarizeAtisResult } from "./atisOperations";
import { ScheduledJobLeaseLostError } from "./scheduledJobRuntime";

const run = (overrides = {}) => ({ id: 7, jobKey: ATIS_JOB_KEYS.sync, status: "running", detail: JSON.stringify({
  version: 1, kind: "sync", ownerUserId: 2, request: {},
}), errorMessage: null, ...overrides }) as any;

describe("ATIS persistent operation presentation", () => {
  it("only reports a running operation with a live original lease", () => {
    expect(presentAtisOperation(run(), true).state).toBe("running");
    expect(presentAtisOperation(run(), false).state).toBe("interrupted");
    expect(presentAtisOperation(run({ status: "abandoned" }), true).state).toBe("interrupted");
  });
  it("does not treat missing or unknown metadata as known work", () => {
    for (const detail of [null, "broken", '{"version":99}', '{"version":1,"kind":"sync","ownerUserId":0}']) {
      expect(presentAtisOperation(run({ detail }), true).state).toBe("interrupted");
    }
    expect(() => presentAtisOperation(run({ jobKey: "another-job" }), true)).toThrow();
  });
  it("distinguishes lease loss from failure and sanitizes both", () => {
    expect(presentAtisOperation(run({ status: "error", errorMessage: new ScheduledJobLeaseLostError().message }), false).state).toBe("interrupted");
    expect(presentAtisOperation(run({ status: "error", errorMessage: "secret provider URL" }), false).state).toBe("interrupted");
    const operation = presentAtisOperation(run({ status: "error", errorMessage: "ATIS operation failed" }), false);
    expect(operation.state).toBe("failed");
    expect(JSON.stringify(operation)).not.toContain("secret");
  });
  it("only exposes bounded counts and canonical understanding references", () => {
    expect(summarizeAtisResult("sync", { success: true, newCards: 3, totalCards: Infinity,
      newBoards: -1, totalBoards: "6", secret: "credential", detail: "private" })).toEqual({ success: true, newCards: 3 });
    expect(summarizeAtisResult("understanding", { cardId: 2, understanding: "private", understandingUrl: "https://evil" }))
      .toEqual({ cardId: 2, understandingUrl: "/api/atis/card/2/understanding" });
  });
});
