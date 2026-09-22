import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error Browser package intentionally ships dependency-free JavaScript.
import { dashboardOrigin, inventory } from "../browser-extension/collector-core.js";

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
  it("has no automatic pairing or automatic tab closing in the background", () => {
    const service = readFileSync(new URL("../browser-extension/service-worker.js", import.meta.url), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../browser-extension/manifest.json", import.meta.url), "utf8"));
    expect(service).not.toContain("tabs.remove");
    expect(service).not.toContain("getCollectorSetup");
    expect(service).toContain('credentials: "omit"');
    expect(service).toContain('redirect: "error"');
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.permissions).not.toContain("history");
  });
});
