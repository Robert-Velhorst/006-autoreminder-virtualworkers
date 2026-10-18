import { describe, expect, it } from "vitest";
import { areNotificationsEnabled } from "./notificationPolicy";

describe("areNotificationsEnabled", () => {
  it("defaults to disabled, including in production", () => {
    expect(areNotificationsEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(areNotificationsEnabled({})).toBe(false);
  });

  it("requires an explicit exact true opt-in", () => {
    expect(areNotificationsEnabled({ NOTIFICATIONS_ENABLED: "true" })).toBe(
      true
    );
    expect(areNotificationsEnabled({ NOTIFICATIONS_ENABLED: "false" })).toBe(
      false
    );
    expect(areNotificationsEnabled({ NOTIFICATIONS_ENABLED: "TRUE" })).toBe(
      false
    );
    expect(areNotificationsEnabled({ NOTIFICATIONS_ENABLED: "1" })).toBe(false);
  });
});
