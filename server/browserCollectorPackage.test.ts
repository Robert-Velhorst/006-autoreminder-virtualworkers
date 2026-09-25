import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error Browser package intentionally ships dependency-free JavaScript.
import { dashboardOrigin, inventory, nextCaptureVersion, reconcileCaptureVersion } from "../browser-extension/collector-core.js";

describe("worker browser collector boundaries", () => {
  it("accepts HTTPS and loopback only, never URL credentials or paths", () => {
    expect(dashboardOrigin("https://dashboard.example")).toBe("https://dashboard.example");
    expect(dashboardOrigin("http://127.0.0.1:3025")).toBe("http://127.0.0.1:3025");
    for (const url of ["http://remote.example", "https://user:secret@example.com", "https://example.com/path", "https://example.com?token=x"]) expect(() => dashboardOrigin(url)).toThrow();
  });
  it("reports domains only and excludes incognito without understating oversized inventories", () => {
    const tab = { id: 1, title: "Private document", url: "https://user:secret@example.com/private?token=abc#password", pinned: true, active: true, windowId: 3 };
    expect(inventory([tab, { ...tab, incognito: true }])).toEqual([{ id: "1", title: "example.com", url: "https://example.com/", pinned: true, active: true, windowId: 3 }]);
    expect(() => inventory(Array.from({ length: 251 }, () => tab))).toThrow(/no partial inventory/);
  });
  it("increments report versions, initializes upgraded installs, and rotates invalid or exhausted identities", () => {
    const replacement = () => "replacement-id";
    expect(nextCaptureVersion("existing-id", 8, replacement)).toEqual({ collectorId: "existing-id", captureSequence: 9 });
    expect(nextCaptureVersion("existing-id", undefined, replacement)).toEqual({ collectorId: "existing-id", captureSequence: 1 });
    expect(nextCaptureVersion("existing-id", 4_294_967_295, replacement)).toEqual({ collectorId: "replacement-id", captureSequence: 1 });
    expect(nextCaptureVersion("existing-id", -1, replacement)).toEqual({ collectorId: "replacement-id", captureSequence: 1 });
    expect(nextCaptureVersion("", 5, replacement)).toEqual({ collectorId: "replacement-id", captureSequence: 1 });
  });
  it("resynchronizes delayed reports and rotates an exhausted collector sequence", () => {
    const replacement = () => "replacement-id";
    expect(reconcileCaptureVersion("existing-id", 3, 20, replacement)).toEqual({ collectorId: "existing-id", captureSequence: 20 });
    expect(reconcileCaptureVersion("existing-id", 20, 18, replacement)).toEqual({ collectorId: "existing-id", captureSequence: 20 });
    expect(reconcileCaptureVersion("existing-id", 3, 4_294_967_295, replacement)).toEqual({ collectorId: "replacement-id", captureSequence: 0 });
    expect(reconcileCaptureVersion("existing-id", 3, Number.NaN, replacement)).toBeNull();
  });
  it("has no automatic pairing or automatic tab closing in the background", () => {
    const service = readFileSync(new URL("../browser-extension/service-worker.js", import.meta.url), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../browser-extension/manifest.json", import.meta.url), "utf8"));
    expect(service).not.toContain("tabs.remove");
    expect(service).not.toContain("getCollectorSetup");
    expect(service).toContain('credentials: "omit"');
    expect(service).toContain('redirect: "error"');
    expect(service).toContain("protocolVersion: 2");
    expect(service).toContain("captureSequence");
    expect(service).toContain("reconcileCaptureVersion");
    expect(service).toContain("response.status === 409");
    expect(service).toContain("captureSequence: 0");
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.permissions).not.toContain("history");
  });
});
