import { describe, expect, it } from "vitest";
import {
  decodeHaiFeedCursor,
  encodeHaiFeedCursor,
  hashHaiConnectorToken,
} from "./haiConnector";

describe("HAI worker-control connector", () => {
  it("hashes credentials without retaining the bearer value", () => {
    const token = "vwc_hai_example-credential";
    const digest = hashHaiConnectorToken(token);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(token);
    expect(hashHaiConnectorToken(token)).toBe(digest);
  });

  it("round-trips a monotonic feed cursor", () => {
    const cursor = encodeHaiFeedCursor(42);
    expect(cursor).not.toContain("42");
    expect(decodeHaiFeedCursor(cursor)).toBe(42);
    expect(decodeHaiFeedCursor(undefined)).toBe(0);
  });

  it("rejects malformed and negative cursors", () => {
    expect(() => decodeHaiFeedCursor("not-a-cursor")).toThrow("Invalid HAI feed cursor");
    const negative = Buffer.from(JSON.stringify({ v: 1, eventId: -1 })).toString("base64url");
    expect(() => decodeHaiFeedCursor(negative)).toThrow("Invalid HAI feed cursor");
  });
});
