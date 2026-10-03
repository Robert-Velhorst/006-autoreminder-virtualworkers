import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: mocks.auth }));
vi.mock("wouter", () => ({ useLocation: () => ["/worker"] }));
import DashboardLayout from "../client/src/components/DashboardLayout";

beforeEach(() => mocks.auth.mockReset());
describe("session availability presentation", () => {
  it("shows recovery instead of asking a worker to enter credentials during an outage", () => {
    mocks.auth.mockReturnValue({ loading: false, user: null, verificationUnavailable: true, checking: false, refresh: vi.fn() });
    const html = renderToStaticMarkup(createElement(DashboardLayout, { children: "Worker task" }));
    expect(html).toContain("Dashboard temporarily unavailable");
    expect(html).toContain("Try again");
    expect(html).not.toMatch(/name="password"|id="password"|Worker task|SELECT|passwordHash/);
  });
  it("keeps the worker page mounted while a cached session is being rechecked", () => {
    mocks.auth.mockReturnValue({ loading: false, user: { role: "worker" }, verificationUnavailable: true, checking: false, refresh: vi.fn() });
    const html = renderToStaticMarkup(createElement(DashboardLayout, { children: "Worker task and unsent draft" }));
    expect(html).toContain("Worker task and unsent draft");
    expect(html).toContain("Connection interrupted");
    expect(html).not.toContain("id=\"password\"");
  });
  it("preserves normal login for a positively unauthenticated session", () => {
    mocks.auth.mockReturnValue({ loading: false, user: null, verificationUnavailable: false, checking: false, refresh: vi.fn() });
    const html = renderToStaticMarkup(createElement(DashboardLayout, { children: "Worker task" }));
    expect(html).toContain('id="password"');
    expect(html).not.toContain("temporarily unavailable");
  });
  it("retries only the session read, with a bounded polling interval", () => {
    const source = readFileSync(new URL("../client/src/_core/hooks/useAuth.ts", import.meta.url), "utf8");
    expect(source).toContain("refetchInterval: query => query.state.error ? 5_000 : query.state.data ? 60_000 : false");
    expect(source).toContain("retry: false");
  });
});
