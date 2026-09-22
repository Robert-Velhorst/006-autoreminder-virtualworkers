import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  browserTabCollectorTokenMatches,
  hashBrowserTabCollectorToken,
} from "./browserTabHygiene";

describe("browser tab collector tokens", () => {
  it("stores and verifies one-way token hashes", () => {
    const token = "collector-secret";
    const stored = hashBrowserTabCollectorToken(token);

    expect(stored).toMatch(/^sha256:/);
    expect(stored).not.toContain(token);
    expect(browserTabCollectorTokenMatches(stored, token)).toBe(true);
    expect(browserTabCollectorTokenMatches(stored, "incorrect-token")).toBe(false);
  });

  it("accepts legacy raw values only for the controlled migration path", () => {
    expect(browserTabCollectorTokenMatches("legacy-token", "legacy-token")).toBe(true);
    expect(browserTabCollectorTokenMatches("legacy-token", "different-token")).toBe(false);
  });

  it("accepts hashes created by the additive database migration", () => {
    const hexHash = `sha256hex:${createHash("sha256").update("database-token").digest("hex")}`;
    expect(browserTabCollectorTokenMatches(hexHash, "database-token")).toBe(true);
    expect(browserTabCollectorTokenMatches(hexHash, "different-token")).toBe(false);
  });
});
