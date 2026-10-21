import { describe, expect, it } from "vitest";
import { getLoginUrl } from "../client/src/const";

describe("external login initiation", () => {
  it("uses the same-origin server initiation endpoint without browser-generated state", () => {
    expect(getLoginUrl()).toBe("/api/oauth/start");
    expect(getLoginUrl()).not.toContain("state=");
    expect(new URL(getLoginUrl(), "https://dashboard.example.com").origin)
      .toBe("https://dashboard.example.com");
  });
});
