import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  states: [] as any[], refs: [] as any[], stateIndex: 0, refIndex: 0,
  effects: [] as Array<() => unknown>,
  buttons: [] as Array<{ label: string; disabled?: boolean; onClick?: () => unknown }>,
  timeline: null as any, calendar: null as any,
  fetch: vi.fn(), toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  cache: { get: vi.fn(), set: vi.fn(), invalidate: vi.fn() },
}));

// Exercise the canonical fetch callbacks and render branches without mounting a
// browser or importing the unrelated dashboard child/provider trees.
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: any) => {
      const index = mocks.stateIndex++;
      if (!Object.hasOwn(mocks.states, index)) {
        mocks.states[index] = typeof initial === "function" ? initial() : initial;
      }
      return [mocks.states[index], (next: any) => {
        mocks.states[index] = typeof next === "function" ? next(mocks.states[index]) : next;
      }];
    },
    useRef: (initial: any) => {
      const index = mocks.refIndex++;
      return mocks.refs[index] ??= { current: initial };
    },
    useEffect: (effect: () => unknown) => mocks.effects.push(effect),
    useMemo: (calculate: () => unknown) => calculate(),
    useCallback: (callback: unknown) => callback,
  };
});
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({
  user: { id: 7, name: "Robert", role: "admin" }, isAuthenticated: true, logout: vi.fn(),
}) }));
vi.mock("@/hooks/useWebSocket", () => ({ useWebSocket: () => ({ status: "connected" }) }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/taskCache", () => ({ taskCache: mocks.cache, CACHE_KEYS: { TIMELINE_TASKS: "timeline-tasks" } }));
vi.mock("wouter", () => ({ Link: ({ href, children }: any) => React.createElement("a", { href }, children) }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, onClick, disabled }: any) => {
  mocks.buttons.push({ label: renderToStaticMarkup(React.createElement(React.Fragment, null, children)).replace(/<[^>]*>/g, "").trim(), onClick, disabled });
  return React.createElement("button", { disabled }, children);
} }));
vi.mock("@/components/ui/input", () => ({ Input: () => null }));
vi.mock("@/components/ui/avatar", () => ({ Avatar: () => null, AvatarFallback: () => null, AvatarImage: () => null }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: () => null, DropdownMenuContent: () => null, DropdownMenuItem: () => null,
  DropdownMenuLabel: () => null, DropdownMenuSeparator: () => null, DropdownMenuTrigger: () => null,
}));
vi.mock("@/components/Timeline", () => ({ Timeline: (props: any) => {
  mocks.timeline = props;
  return React.createElement("div", null, props.isLoading ? "Loading work queue..." : props.tasks.length
    ? props.tasks.map((task: any) => task.cardName).join(", ") : "No tasks scheduled");
} }));
vi.mock("@/components/CalendarView", () => ({ CalendarView: (props: any) => {
  mocks.calendar = props;
  return React.createElement("div", { "data-testid": "calendar-view" }, props.tasks.length
    ? props.tasks.map((task: any) => task.cardName).join(", ") : "Empty calendar");
} }));
vi.mock("@/components/StatsPanel", () => ({ StatsPanel: ({ stats }: any) => React.createElement("div", null, `Queue metrics: ${JSON.stringify(stats)}`) }));
vi.mock("@/components/WeeklyProgressDashboard", () => ({ WeeklyProgressDashboard: () => React.createElement("div", null, "Weekly completion metrics") }));
vi.mock("@/components/OverflowTasks", () => ({ OverflowTasks: ({ tasks }: any) => React.createElement("div", null, `Overflow: ${JSON.stringify(tasks)}`) }));
vi.mock("@/components/TaskFilters", () => ({ TaskFilters: () => null }));
vi.mock("@/components/WorkloadHeatmap", () => ({ WorkloadHeatmap: () => null }));
vi.mock("@/components/MobileNav", () => ({ MobileNav: () => null }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/LoadingQueueIndicator", () => ({ LoadingQueueIndicator: () => null }));
vi.mock("@/components/ConversationDialog", () => ({ ConversationDialog: () => null }));
vi.mock("@/components/BulkTaskActions", () => ({ BulkTaskActions: () => null }));
vi.mock("@/components/GoalInterviewDialog", () => ({ GoalInterviewDialog: () => null }));

import Home from "../client/src/pages/Home";
import Calendar from "../client/src/pages/Calendar";

const previousReact = (globalThis as any).React;
beforeAll(() => Object.assign(globalThis, { React }));
afterAll(() => {
  if (previousReact === undefined) delete (globalThis as any).React;
  else Object.assign(globalThis, { React: previousReact });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.states = []; mocks.refs = [];
  mocks.cache.get.mockReturnValue(null);
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
};
const render = (Page: typeof Home | typeof Calendar) => {
  mocks.stateIndex = 0; mocks.refIndex = 0;
  mocks.effects = []; mocks.buttons = []; mocks.timeline = null; mocks.calendar = null;
  return renderToStaticMarkup(React.createElement(Page));
};
const mount = (Page: typeof Home | typeof Calendar) => {
  const html = render(Page);
  for (const effect of [...mocks.effects]) effect();
  return html;
};
const click = (label: string) => {
  const button = mocks.buttons.find(item => item.label === label);
  expect(button, `Missing button: ${label}`).toBeDefined();
  expect(button!.disabled).not.toBe(true);
  button!.onClick!();
};
const card = { id: "card-1", name: "Retained work", cardName: "Retained work", dueDate: "2026-10-01", estimatedMinutes: 60 };
const pages = [
  { name: "Home", Page: Home, endpoint: "/api/atis/timeline-tasks?filter=all", heading: "Work queue unavailable", empty: "No tasks scheduled",
    populated: { scheduled: [card], overflow: [{ name: "Retained overflow" }], metrics: { totalScheduled: 1, totalScheduledMinutes: 60 } }, emptyData: { scheduled: [], overflow: [] } },
  { name: "Calendar", Page: Calendar, endpoint: "/api/trello/tasks", heading: "Calendar unavailable", empty: "Empty calendar",
    populated: { tasks: [card] }, emptyData: [] },
] as const;

for (const page of pages) describe(`${page.name} task availability`, () => {
  let result: () => Response | Promise<Response>;
  const taskCalls = () => mocks.fetch.mock.calls.filter(([url]) => url === page.endpoint);
  beforeEach(() => {
    result = () => json(page.populated);
    mocks.fetch.mockImplementation((url: string) => {
      if (url === page.endpoint) return Promise.resolve(result());
      if (url === "/api/working-hours/settings") return Promise.resolve(json({ workingDays: [2, 4] }));
      if (url === "/api/holidays") return Promise.resolve(json(["2026-12-25"]));
      if (url === "/api/atis/task-types") return Promise.resolve(json([]));
      throw new Error(`Unexpected endpoint: ${url}`);
    });
  });

  it("persists an actionable initial HTTP failure without claiming empty work or zero completion metrics", async () => {
    result = () => json({ error: "secret-provider-diagnostics" }, 500);
    expect(mount(page.Page)).not.toContain(page.heading);
    await settle();
    for (let i = 0; i < 2; i++) {
      const html = render(page.Page);
      expect(html).toContain('role="alert"');
      expect(html).toContain(page.heading);
      expect(html).toContain("Try again");
      expect(html).not.toMatch(/No tasks scheduled|Empty calendar|Queue metrics|Weekly completion metrics|0 tasks|secret-provider-diagnostics/);
      expect(mocks.timeline).toBeNull();
      expect(mocks.calendar).toBeNull();
    }
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.error.mock.calls.flat().join(" ")).not.toContain("secret-provider-diagnostics");
  });

  it("retries the existing read endpoint and clears the error only after true empty recovery", async () => {
    result = () => json({ error: "private" }, 500);
    mount(page.Page); await settle(); render(page.Page);
    const pending = deferred<Response>();
    result = () => pending.promise;
    click("Try again");
    const retrying = render(page.Page);
    expect(retrying).toContain(page.heading);
    expect(retrying).toContain("Retrying...");
    expect(mocks.buttons.find(button => button.label === "Retrying...")?.disabled).toBe(true);
    expect(taskCalls()).toHaveLength(2);
    expect(taskCalls()[1][1].credentials).toBe("include");
    expect(taskCalls()[1][1].method).toBeUndefined();
    pending.resolve(json(page.emptyData)); await settle();
    const recovered = render(page.Page);
    expect(recovered).not.toContain(page.heading);
    expect(recovered).not.toContain('role="alert"');
    expect(recovered).toContain(page.empty);
    expect(recovered).not.toContain("Retrying...");
    if (page.Page === Home) {
      expect(recovered).toContain("Queue metrics");
      expect(mocks.cache.invalidate).toHaveBeenCalledWith("timeline-tasks");
    } else expect(mocks.toast.success).toHaveBeenCalledWith("Calendar tasks refreshed");
  });

  it("renders a genuinely successful empty result without an error", async () => {
    result = () => json(page.emptyData);
    mount(page.Page); await settle();
    const html = render(page.Page);
    expect(html).toContain(page.empty);
    expect(html).not.toContain(page.heading);
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("keeps populated tasks and metrics visible during refresh, on failure, and until recovery", async () => {
    mount(page.Page); await settle();
    const initial = render(page.Page);
    expect(initial).toContain("Retained work");
    const retainedTasks = (mocks.timeline ?? mocks.calendar).tasks;
    const retainedState = [...mocks.states];
    const pending = deferred<Response>();
    result = () => pending.promise;
    if (page.Page === Home) mocks.timeline.onRefresh(); else click("Refresh");
    const refreshing = render(page.Page);
    expect(refreshing).toContain("Retained work");
    expect(refreshing).toContain('role="status"');
    if (page.Page === Home) expect(mocks.timeline).toBeNull();
    else expect(mocks.calendar.tasks).toEqual(retainedTasks);
    pending.resolve(json({ error: "private-details" }, 500)); await settle();
    const stale = render(page.Page);
    expect(stale).toContain(page.heading);
    expect(stale).toContain('role="alert"');
    expect(stale).toContain("last successfully loaded");
    expect(stale).toContain("may be out of date");
    expect(stale).toContain("Retained work");
    if (page.Page === Home) {
      expect(mocks.timeline).toBeNull();
      expect(stale).toContain('Last loaded work (read-only)');
    } else expect(mocks.calendar.tasks).toEqual(retainedTasks);
    expect(stale).not.toMatch(/No tasks scheduled|Empty calendar|private-details/);
    expect(mocks.toast.success).not.toHaveBeenCalled();
    if (page.Page === Home) {
      expect(stale).toContain("Queue metrics");
      expect(stale).toContain("Retained overflow");
      // No task, client, overflow, stats, selection or filter state is cleared.
      expect(mocks.states.filter(value => typeof value !== "boolean")).toEqual(retainedState.filter(value => typeof value !== "boolean"));
    }
    result = () => json(page.populated);
    click("Try again"); await settle();
    const recovered = render(page.Page);
    expect(recovered).toContain("Retained work");
    expect(recovered).not.toContain(page.heading);
    expect(recovered).not.toContain("may be out of date");
  });

  if (page.Page === Home) it('blocks retained task, reschedule, sync and interview callbacks during refresh and after source failure', async () => {
    mount(Home); await settle(); render(Home);
    const retained = mocks.timeline;
    const reschedule = mocks.buttons.find(button => button.label === 'Reschedule')!;
    expect(reschedule.disabled).toBe(false);
    const pending = deferred<Response>(); result = () => pending.promise;
    retained.onRefresh(); render(Home);
    expect(mocks.timeline).toBeNull();
    expect(mocks.buttons.find(button => button.label === 'Reschedule')?.disabled).toBe(true);
    await reschedule.onClick!(); await retained.onSync();
    await retained.onToggleTask('atis-card-1'); retained.onStartInterview(card);
    expect(mocks.fetch.mock.calls.filter(([, options]) => options?.method)).toEqual([]);
    pending.resolve(json({ code: 'TRELLO_BOARD_ACCESS_UNAVAILABLE' }, 503)); await settle();
    expect(render(Home)).toContain('Last loaded work (read-only)');
    expect(mocks.buttons.find(button => button.label === 'Reschedule')?.disabled).toBe(true);
    expect(mocks.cache.invalidate).toHaveBeenCalledWith('timeline-tasks');
    await reschedule.onClick!(); await retained.onSync();
    await retained.onToggleTask('atis-card-1'); retained.onStartInterview(card);
    expect(mocks.fetch.mock.calls.filter(([, options]) => options?.method)).toEqual([]);
    result = () => json(page.populated); click('Try again'); await settle(); render(Home);
    expect(mocks.timeline.tasks).toHaveLength(1);
    expect(mocks.buttons.find(button => button.label === 'Reschedule')?.disabled).toBe(false);
  });

  if (page.Page === Home) it('consumes an unavailable response without exposing its private body', async () => {
    const response = json({ error: 'private-details' }, 503);
    result = () => response;
    mount(Home); await settle();
    expect(response.bodyUsed).toBe(true);
    const html = render(Home);
    expect(html).toContain(page.heading);
    expect(html).not.toContain('private-details');
  });

  it.each([
    ["unauthorized", () => json({ error: "private" }, 401)],
    ["invalid shape", () => json({ error: "private" })],
    ["null body", () => json(null)],
    ["missing body", () => new Response("")],
    ["invalid JSON", () => new Response("private non-JSON diagnostics")],
  ])("treats %s as unavailable, not successful empty", async (_label, response) => {
    result = response as () => Response;
    mount(page.Page); await settle();
    const html = render(page.Page);
    expect(html).toContain(page.heading);
    expect(html).not.toMatch(/No tasks scheduled|Empty calendar|Queue metrics|private/);
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
});

describe("focused source and auxiliary-state contracts", () => {
  it("keeps retry connected to canonical endpoints and preserves established cancellation/retry policy", () => {
    const home = readFileSync(new URL("../client/src/pages/Home.tsx", import.meta.url), "utf8");
    const calendar = readFileSync(new URL("../client/src/pages/Calendar.tsx", import.meta.url), "utf8");
    expect(home).toContain("/api/atis/timeline-tasks?filter=all");
    expect(home).toContain("onClick={() => void fetchTasks(true)}");
    expect(home).toContain("if (forceRefresh) taskCache.invalidate(CACHE_KEYS.TIMELINE_TASKS)");
    expect(calendar).toContain("retryFetch('/api/trello/tasks', 2, 1000, 30000)");
    expect(calendar).toContain("controller.abort()");
    expect(calendar).toContain("onClick={() => void loadCalendar(true)}");
    expect(calendar).not.toContain("setTasks([])");
    expect(home.slice(home.indexOf("const fetchTasks"), home.indexOf("const syncFromTrello"))).not.toContain("setTasks([])");
  });

  it("keeps loading active until the calendar's full existing read batch settles and suppresses duplicate refreshes", async () => {
    const settings = deferred<Response>();
    const holidays = deferred<Response>();
    mocks.fetch.mockImplementation((url: string) => url === "/api/trello/tasks" ? Promise.resolve(json([]))
      : url === "/api/holidays" ? holidays.promise : settings.promise);
    mount(Calendar); await settle(); render(Calendar);
    expect(mocks.buttons.find(button => button.label === "Refresh")?.disabled).toBe(true);
    mocks.buttons.find(button => button.label === "Refresh")!.onClick!();
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    settings.resolve(json({ workingDays: [2, 4] })); await settle(); render(Calendar);
    expect(mocks.buttons.find(button => button.label === "Refresh")?.disabled).toBe(true);
    holidays.resolve(json([])); await settle(); render(Calendar);
    expect(mocks.buttons.find(button => button.label === "Refresh")?.disabled).toBe(false);
  });

  it("retains previously loaded calendar holidays and working days when all refresh reads fail", async () => {
    let failed = false;
    mocks.fetch.mockImplementation((url: string) => Promise.resolve(failed ? json({ error: "private" }, 500)
      : json(url === "/api/trello/tasks" ? [card] : url === "/api/holidays" ? ["2026-12-25"] : { workingDays: [2, 4] })));
    mount(Calendar); await settle(); render(Calendar);
    const { tasks, holidays, workingDays } = mocks.calendar;
    failed = true; click("Refresh"); await settle();
    expect(render(Calendar)).toContain("Calendar unavailable");
    expect(mocks.calendar.tasks).toBe(tasks);
    expect(mocks.calendar.holidays).toBe(holidays);
    expect(mocks.calendar.workingDays).toBe(workingDays);
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
});
