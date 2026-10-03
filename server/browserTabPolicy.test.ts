import { describe, expect, it } from "vitest";
import {
  browserTabLabelFromOrigin,
  evaluateBrowserTabHygiene,
  normalizeBrowserTabOrigin,
  normalizeBrowserTabPolicy,
} from "../shared/browserTabPolicy";

const policy = normalizeBrowserTabPolicy({
  maxOpenTabs: 5,
  warningMinutesBeforeEnd: 30,
  staleAfterMinutes: 10,
});

describe("browser tab hygiene policy", () => {
  it("reduces supported web URLs to a canonical origin without credentials or page details", () => {
    expect(normalizeBrowserTabOrigin("https://worker:private@EXAMPLE.test:443/case/123?token=secret#notes"))
      .toBe("https://example.test/");
    expect(normalizeBrowserTabOrigin("http://localhost:3057/worker?session=secret"))
      .toBe("http://localhost:3057/");
  });

  it("keeps file URLs generic and rejects unsupported or malformed schemes", () => {
    expect(normalizeBrowserTabOrigin("file:///C:/private/case.pdf?secret=1#page=3")).toBe("file:///");
    expect(browserTabLabelFromOrigin("file:///")).toBe("Local file");
    expect(normalizeBrowserTabOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserTabOrigin("not a url")).toBeNull();
  });

  it("does not interrupt a worker before the end-of-day warning window", () => {
    const result = evaluateBrowserTabHygiene({
      now: new Date("2026-07-16T18:00:00Z"),
      workEnd: "23:00",
      policy,
      totalTabs: 20,
      actionableTabs: 18,
      capturedAt: new Date("2026-07-16T17:59:00Z"),
    });
    expect(result.status).toBe("during_day");
    expect(result.shouldWarn).toBe(false);
  });

  it("warns when fresh actionable tabs exceed the limit near EOD", () => {
    const result = evaluateBrowserTabHygiene({
      now: new Date("2026-07-16T19:40:00Z"),
      workEnd: "23:00",
      policy,
      totalTabs: 11,
      actionableTabs: 8,
      capturedAt: new Date("2026-07-16T19:38:00Z"),
    });
    expect(result).toMatchObject({ status: "over_limit", excessTabs: 3, shouldWarn: true, compliant: false });
  });

  it("treats an organized end-of-day browser as compliant", () => {
    const result = evaluateBrowserTabHygiene({
      now: new Date("2026-07-16T20:05:00Z"),
      workEnd: "23:00",
      policy,
      totalTabs: 6,
      actionableTabs: 5,
      capturedAt: new Date("2026-07-16T20:04:00Z"),
    });
    expect(result).toMatchObject({ status: "clear", shouldWarn: false, compliant: true });
  });

  it("does not claim compliance when the collector is stale", () => {
    const result = evaluateBrowserTabHygiene({
      now: new Date("2026-07-16T20:05:00Z"),
      workEnd: "23:00",
      policy,
      totalTabs: 3,
      actionableTabs: 2,
      capturedAt: new Date("2026-07-16T19:30:00Z"),
    });
    expect(result).toMatchObject({ status: "stale", connected: false, compliant: false });
  });

  it("keeps Sunday protected", () => {
    const result = evaluateBrowserTabHygiene({
      now: new Date("2026-07-19T20:05:00Z"),
      workEnd: "23:00",
      policy,
      totalTabs: 30,
      actionableTabs: 25,
      capturedAt: new Date("2026-07-19T20:04:00Z"),
    });
    expect(result).toMatchObject({ status: "protected_day", shouldWarn: false, compliant: true });
  });
});
