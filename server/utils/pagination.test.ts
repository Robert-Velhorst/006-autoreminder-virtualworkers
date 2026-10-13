import { describe, expect, it } from "vitest";
import { parseLimitOffset } from "./pagination";

describe("parseLimitOffset", () => {
  it("uses safe defaults for missing and invalid query values", () => {
    expect(parseLimitOffset({})).toEqual({ limit: 50, offset: 0 });
    expect(parseLimitOffset({ limit: "not-a-number", offset: "-1" })).toEqual({ limit: 50, offset: 0 });
  });

  it("caps a requested page size without changing a valid offset", () => {
    expect(parseLimitOffset({ limit: "10000", offset: "40" }, { maxLimit: 100 })).toEqual({ limit: 100, offset: 40 });
  });
});
