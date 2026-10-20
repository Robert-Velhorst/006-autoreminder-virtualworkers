import { describe, expect, it } from "vitest";
import { shouldRetryQuery } from "../client/src/lib/query-retry";

describe("shouldRetryQuery", () => {
  it("does not retry client failures that cannot succeed without a user correction", () => {
    expect(shouldRetryQuery(0, { data: { httpStatus: 401 } })).toBe(false);
    expect(shouldRetryQuery(0, { data: { httpStatus: 404 } })).toBe(false);
    expect(shouldRetryQuery(0, { data: { httpStatus: 429 } })).toBe(false);
  });

  it("retries one transient failure, then stops", () => {
    expect(shouldRetryQuery(0, { data: { httpStatus: 503 } })).toBe(true);
    expect(shouldRetryQuery(0, new Error("network unavailable"))).toBe(true);
    expect(shouldRetryQuery(1, { data: { httpStatus: 503 } })).toBe(false);
  });
});
