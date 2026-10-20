import { describe, expect, it } from "vitest";
import { PASSWORD_MIN_LENGTH, validatePassword } from "./passwordPolicy";

describe("password policy", () => {
  it("uses one twelve-character minimum for locally managed accounts", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(() => validatePassword("shortpwd")).toThrow("Password must be at least 12 characters");
    expect(() => validatePassword("123456789012")).not.toThrow();
  });
});
