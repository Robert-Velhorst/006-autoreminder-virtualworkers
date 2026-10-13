import { describe, expect, it } from "vitest";
import { getTrustedProxyHops } from "./trustedProxy";

describe("trusted proxy configuration", () => {
  it("defaults to the single deployed reverse-proxy hop", () => {
    expect(getTrustedProxyHops({})).toBe(1);
  });

  it("accepts a bounded explicit proxy-hop count and rejects unsafe values", () => {
    expect(getTrustedProxyHops({ TRUST_PROXY_HOPS: "2" })).toBe(2);
    expect(getTrustedProxyHops({ TRUST_PROXY_HOPS: "0" })).toBe(1);
    expect(getTrustedProxyHops({ TRUST_PROXY_HOPS: "99" })).toBe(1);
  });
});
