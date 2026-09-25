import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import ManagerCoach from "../client/src/components/ManagerCoach";
import ManagerShadowSettings from "../client/src/components/ManagerShadowSettings";
import AptlssManagerReview from "../client/src/components/AptlssManagerReview";

type StatusQuery = { state: { error: Error | null } };
type StatusOptions = { enabled?: (query: StatusQuery) => boolean; refetchInterval?: (query: StatusQuery) => number | false };
const fixture = vi.hoisted(() => ({ mode: "shadow" as string | undefined, enabled: true, error: null as null | Error, fetching: false, role: "admin", queries: [] as unknown[], statusOptions: [] as StatusOptions[], socketOptions: [] as Array<{ onManagerUpdated?: () => void }>, invalidations: [] as string[] }));
vi.mock("../client/src/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { role: fixture.role } }) }));
vi.mock("../client/src/hooks/useWebSocket", () => ({ useWebSocket: (options: { onManagerUpdated?: () => void }) => { fixture.socketOptions.push(options); return { status: { connected: false } }; } }));
vi.mock("../client/src/lib/trpc", () => {
  const mutation = { useMutation: () => ({ isPending: false, mutate: vi.fn() }) };
  return { trpc: {
    useUtils: () => ({ operator: Object.fromEntries(["getManagerStatus", "getDailyPlan", "getWorkQueueContext"].map(name => [name, { invalidate: () => fixture.invalidations.push(name) }])) }),
    operator: {
      getManagerStatus: { useQuery: (_: unknown, options: StatusOptions) => { fixture.statusOptions.push(options); return { data: { policy: { mode: fixture.mode, enabled: fixture.enabled, intervalMinutes: 5 } }, error: fixture.error, isFetching: fixture.fetching }; } },
      getWorkQueueContext: { useQuery: () => ({ data: { cards: [] } }) },
      getManagerReviewInbox: { useQuery: (_: unknown, options: unknown) => { fixture.queries.push(options); return { data: { workers: [] }, isFetching: false }; } },
      runManager: mutation, submitManagerUpdate: mutation, updateManagerPolicy: mutation,
      runManagerForReview: mutation, closeManagerTrial: mutation, restartManagerTrial: mutation, revokeManagerCorrection: mutation,
    },
  } };
});
vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => Object.assign(fixture, { mode: "shadow", enabled: true, error: null, fetching: false, role: "admin", queries: [], statusOptions: [], socketOptions: [], invalidations: [] }));

const pilotDenial = "Manager pilot requires an explicitly allowlisted worker, valid APTLSS_MANAGER_PILOT_WORKER_IDS, and APTLSS_MANAGER_SHADOW_ONLY=true.";
const queryError = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });

const render = (component: React.ComponentType) => renderToStaticMarkup(createElement(component));
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>[^]*?${label}</button>`, "g"))?.at(-1)?.split("<button").at(-1)?.split(">")[0] ?? "missing";

describe("shadow pilot controls", () => {
  it("enables assessment only for a loaded shadow policy", () => {
    const html = render(ManagerCoach);
    expect(button(html, "Reassess now")).not.toContain('disabled=""');
    expect(html).not.toContain("System status");
    expect(html).not.toContain("Fallback polling");
  });
  it.each(["active", undefined])("blocks assessment and settings for %s mode", mode => {
    fixture.mode = mode;
    expect(button(render(ManagerCoach), "Reassess now")).toContain('disabled=""');
    expect(render(ManagerShadowSettings)).toContain('<fieldset disabled=""');
  });
  it("blocks assessment after a query error or during refresh", () => {
    fixture.error = new Error("Status unavailable");
    expect(button(render(ManagerCoach), "Reassess now")).toContain('disabled=""');
    fixture.error = null;
    fixture.fetching = true;
    expect(button(render(ManagerCoach), "Reassess now")).toContain('disabled=""');
  });
  it("keeps disabled manager execution paused", () => {
    fixture.enabled = false;
    expect(button(render(ManagerCoach), "Reassess now")).toContain('disabled=""');
  });
  it("does not expose or even bind a mode mutation", () => {
    expect(render(AptlssManagerReview)).not.toContain("Enable active mode");
  });
  it("does not fetch the admin review inbox for workers", () => {
    fixture.role = "worker";
    expect(render(AptlssManagerReview)).toBe("");
    expect(fixture.queries).toEqual([expect.objectContaining({ enabled: false })]);
  });

  it("shows neutral unavailability and no controls for an explicit pilot denial, even with cached policy data", () => {
    fixture.error = queryError("FORBIDDEN", pilotDenial);
    for (const component of [ManagerCoach, ManagerShadowSettings]) {
      const html = render(component);
      expect(html).toContain("APTLSS manager is unavailable for this worker.");
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain("<button");
      expect(html).not.toContain("Fallback polling");
    }
  });

  it("stops automatic requests and socket-triggered invalidations after pilot denial", () => {
    fixture.error = queryError("FORBIDDEN", pilotDenial);
    render(ManagerCoach);
    render(ManagerShadowSettings);
    const query = { state: { error: fixture.error } };
    expect(fixture.statusOptions[0].refetchInterval?.(query)).toBe(false);
    for (const options of fixture.statusOptions) expect(options.enabled?.(query)).toBe(false);
    fixture.socketOptions[0].onManagerUpdated?.();
    expect(fixture.invalidations).toEqual([]);
  });

  it.each([
    ["UNAUTHORIZED", pilotDenial],
    ["FORBIDDEN", "Operator access requires an admin or worker account"],
    ["INTERNAL_SERVER_ERROR", "Manager status storage is unavailable"],
  ])("does not hide %s errors outside the explicit pilot boundary", (code, message) => {
    fixture.error = queryError(code, message);
    const coach = render(ManagerCoach);
    expect(coach).toContain("Work guidance could not be refreshed");
    expect(coach).not.toContain(message);
    const settings = render(ManagerShadowSettings);
    expect(settings).toContain('role="alert"');
    expect(settings).not.toContain(message);
    const query = { state: { error: fixture.error } };
    expect(fixture.statusOptions[0].refetchInterval?.(query)).toBe(60_000);
    for (const options of fixture.statusOptions) expect(options.enabled?.(query)).toBe(true);
  });
});
