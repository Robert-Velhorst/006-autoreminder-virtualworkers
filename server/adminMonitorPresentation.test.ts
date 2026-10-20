import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), monitor: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: mocks.auth }));
vi.mock("@/lib/trpc", () => ({ trpc: { aptlss: {
  getAdminMonitor: { useQuery: mocks.monitor },
  getRecentAuditLog: { useQuery: mocks.audit },
} } }));
vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href }, children),
}));
import AdminMonitor from "../client/src/pages/manus/AdminMonitor";

const previousReact = (globalThis as any).React;
beforeAll(() => Object.assign(globalThis, { React }));
afterAll(() => {
  if (previousReact === undefined) delete (globalThis as any).React;
  else Object.assign(globalThis, { React: previousReact });
});
const snapshot = (webhookStatus: unknown = { state: "active", active: true, count: 1 }) => ({
  syncStats: { totalRuns: 9, successRuns: 9, failedRuns: 0, totalCardsProcessed: 12 },
  lastSync: null, recentSyncs: [], pendingApprovals: [], cardsSkipped: [], failedRecs: [],
  webhookStatus,
});
const query = (overrides = {}) => ({
  data: undefined, error: null, isLoading: false, isFetching: false, refetch: vi.fn(), ...overrides,
});
const render = () => renderToStaticMarkup(React.createElement(AdminMonitor));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockReturnValue({ user: { id: 7, role: "admin" }, loading: false });
  mocks.monitor.mockReturnValue(query({ data: snapshot() }));
  mocks.audit.mockReturnValue(query({ data: [] }));
});

describe("AdminMonitor truthful error presentation", () => {
  it.each(["INTERNAL_SERVER_ERROR", "TIMEOUT", undefined])("does not label %s as access denied or render fabricated zero counts", code => {
    mocks.monitor.mockReturnValue(query({ error: { data: { code }, message: "secret-provider-diagnostics" } }));
    const html = render();
    expect(html).toContain("Admin monitor temporarily unavailable");
    expect(html).toContain("Try again");
    expect(html).not.toMatch(/Access Restricted|Total Syncs|No drafts awaiting|secret-provider-diagnostics/);
  });
  it("preserves access denial for a real FORBIDDEN response even with cached data", () => {
    mocks.monitor.mockReturnValue(query({ data: snapshot(), error: { data: { code: "FORBIDDEN" } } }));
    const html = render();
    expect(html).toContain("Access Restricted");
    expect(html).not.toContain("Total Syncs");
  });
  it("marks cached monitoring data as stale after a failed refresh", () => {
    mocks.monitor.mockReturnValue(query({ data: snapshot(), error: { data: { code: "INTERNAL_SERVER_ERROR" } } }));
    const html = render();
    expect(html).toContain("Refresh failed. Showing the last successful monitor result; it may be out of date.");
    expect(html).toContain("Total Syncs");
    expect(html).not.toContain("Access Restricted");
  });
  it("does not render empty success when no monitor result exists", () => {
    mocks.monitor.mockReturnValue(query());
    expect(render()).toContain("Admin monitor temporarily unavailable");
    expect(render()).not.toContain("Total Syncs");
  });
  it.each(["unavailable", "unconfigured"])("renders %s webhook health without asserting inactive or a registered count", state => {
    mocks.monitor.mockReturnValue(query({ data: snapshot({ state, active: null, count: null }) }));
    const html = render();
    expect(html).toContain(state === "unavailable" ? "Webhook status unavailable" : "Trello credentials not configured");
    expect(html).not.toMatch(/Inactive|0 webhooks registered/);
  });
  it.each(["active", "inactive"])("renders verified %s webhook health", state => {
    mocks.monitor.mockReturnValue(query({ data: snapshot({ state, active: state === "active", count: 2 }) }));
    const html = render();
    expect(html).toContain(state === "active" ? "Active" : "Inactive");
    expect(html).toContain("2 webhooks registered");
  });
  it("does not describe a failed audit read as an empty automation log", () => {
    mocks.audit.mockReturnValue(query({ error: { message: "secret-audit-diagnostics" } }));
    const html = render();
    expect(html).toContain("Automation log temporarily unavailable");
    expect(html).not.toMatch(/No automation actions recorded yet|secret-audit-diagnostics/);
  });
});
