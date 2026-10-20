import { describe, expect, it } from "vitest";
import {
  BRIEFING_SETTINGS_DEFAULTS,
  briefingSettingsKey,
  normalizeBriefingSettings,
  shouldRunBriefingAt,
  validateBriefingSettings,
} from "./briefingSettings";

describe("briefing settings", () => {
  it("uses safe defaults when stored settings are malformed", () => {
    expect(normalizeBriefingSettings("not-json")).toEqual(BRIEFING_SETTINGS_DEFAULTS);
    expect(normalizeBriefingSettings({ morningBriefingTime: "8am" })).toEqual(BRIEFING_SETTINGS_DEFAULTS);
  });

  it("accepts a complete valid configuration and scopes its storage by founder", () => {
    const settings = normalizeBriefingSettings({
      morningBriefingEnabled: false,
      morningBriefingTime: "07:45",
      eodReportEnabled: true,
      eodReportTime: "17:30",
    });

    expect(settings).toEqual({
      morningBriefingEnabled: false,
      morningBriefingTime: "07:45",
      eodReportEnabled: true,
      eodReportTime: "17:30",
    });
    expect(briefingSettingsKey(42)).toBe("briefingSettings:42");
  });

  it("matches only the configured local time", () => {
    expect(shouldRunBriefingAt("07:45", 7, 45)).toBe(true);
    expect(shouldRunBriefingAt("07:45", 7, 46)).toBe(false);
    expect(shouldRunBriefingAt("07:45", 8, 45)).toBe(false);
  });

  it("rejects incomplete writes instead of replacing settings with defaults", () => {
    expect(() => validateBriefingSettings({
      morningBriefingEnabled: true,
      morningBriefingTime: "08:00",
    })).toThrow("Briefing settings require enabled flags and valid HH:MM times.");
  });
});
