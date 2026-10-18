import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { getSessionCookieOptions } from "./cookies";

function request(protocol: string, headers: Request["headers"]): Request {
  return {
    protocol,
    secure: protocol === "https",
    headers,
  } as Request;
}

describe("session cookie security", () => {
  it("uses the trusted request protocol to mark HTTPS cookies secure", () => {
    expect(getSessionCookieOptions(request("https", {})).secure).toBe(true);
  });

  it("does not trust a forwarded-proto header on an insecure request", () => {
    expect(
      getSessionCookieOptions(request("http", { "x-forwarded-proto": "https" }))
        .secure
    ).toBe(false);
  });

  it("keeps the session cookie HTTP-only and same-site", () => {
    expect(getSessionCookieOptions(request("https", {}))).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    });
  });
});
