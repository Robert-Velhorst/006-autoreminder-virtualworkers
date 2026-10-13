import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  states: [] as any[], refs: [] as any[], stateIndex: 0, refIndex: 0,
  effects: [] as Array<() => unknown>,
  buttons: [] as Array<{ label: string; disabled?: boolean; onClick?: () => unknown }>,
  selects: [] as Array<{ label: string; disabled?: boolean; onValueChange?: (value: string) => unknown }>,
  graph: null as any, search: null as any,
  fetch: vi.fn(), toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

// Follow the existing Node-only dashboard test pattern: execute real read/action
// callbacks and render branches, isolating unrelated children and provider hooks.
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: any) => {
      const index = mocks.stateIndex++;
      if (!Object.hasOwn(mocks.states, index)) mocks.states[index] = typeof initial === "function" ? initial() : initial;
      return [mocks.states[index], (next: any) => {
        mocks.states[index] = typeof next === "function" ? next(mocks.states[index]) : next;
      }];
    },
    useRef: (initial: any) => mocks.refs[mocks.refIndex++] ??= { current: initial },
    useEffect: (effect: () => unknown) => mocks.effects.push(effect),
    useMemo: (calculate: () => unknown) => calculate(),
  };
});
vi.mock("@/lib/trpc", () => ({ trpc: { operator: {
  getFounderDecisionInbox: { useQuery: () => ({ data: { items: [] }, error: null }) },
} } }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("wouter", () => ({ Link: ({ href, children }: any) => React.createElement("a", { href }, children) }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, onClick, disabled }: any) => {
  const label = renderToStaticMarkup(React.createElement(React.Fragment, null, children)).replace(/<[^>]*>/g, "").trim();
  mocks.buttons.push({ label, onClick, disabled });
  return React.createElement("button", { disabled }, children);
} }));
vi.mock("@/components/ui/select", () => {
  const content = ({ children }: any) => React.createElement("div", null, children);
  return {
    Select: ({ children, onValueChange, disabled }: any) => {
      const label = renderToStaticMarkup(React.createElement(React.Fragment, null, children));
      mocks.selects.push({ label, onValueChange, disabled });
      return React.createElement("div", null, children);
    },
    SelectContent: content, SelectItem: content, SelectTrigger: content,
    SelectValue: ({ placeholder }: any) => React.createElement("span", null, placeholder),
  };
});
vi.mock("@/components/ui/dropdown-menu", () => {
  const content = ({ children }: any) => React.createElement("div", null, children);
  return {
    DropdownMenu: content, DropdownMenuContent: content, DropdownMenuLabel: content,
    DropdownMenuSeparator: () => null, DropdownMenuTrigger: content,
    DropdownMenuItem: ({ children, onClick, disabled }: any) => {
      const label = renderToStaticMarkup(React.createElement(React.Fragment, null, children)).replace(/<[^>]*>/g, "").trim();
      mocks.buttons.push({ label, onClick, disabled });
      return React.createElement("button", { disabled }, children);
    },
  };
});
vi.mock("@/components/ui/tabs", () => {
  const content = ({ children }: any) => React.createElement("div", null, children);
  return { Tabs: content, TabsList: content, TabsTrigger: content, TabsContent: content };
});
vi.mock("@/components/ui/dialog", () => {
  const content = ({ children }: any) => React.createElement("div", null, children);
  return { Dialog: content, DialogTrigger: content, DialogContent: () => null,
    DialogHeader: content, DialogTitle: content, DialogFooter: content };
});
vi.mock("@/components/ui/switch", () => ({ Switch: () => null }));
vi.mock("@/components/ui/input", () => ({ Input: () => null }));
vi.mock("@/components/ui/textarea", () => ({ Textarea: () => null }));
vi.mock("@/components/TimezoneDisplay", () => ({ TimezoneDisplay: () => null }));
vi.mock("@/components/DependencyGraph", () => ({ default: (props: any) => {
  mocks.graph = props;
  return React.createElement("div", null, props.tasks.length ? "Dependency editor" : "No tasks with dependencies to display");
} }));
vi.mock("@/components/LabelAutocompleteSearch", () => ({ LabelAutocompleteSearch: (props: any) => {
  mocks.search = props;
  return null;
} }));
vi.mock("@/components/ReanalysisProgressModal", () => ({ ReanalysisProgressModal: () => null }));
vi.mock("@/components/AptlssManagerReview", () => ({ default: () => null }));
vi.mock("@/components/FounderDecisionInbox", () => ({ default: () => null }));
vi.mock("../client/src/pages/manus/WeeklyPayCalculator", () => ({ default: () => null }));

import FounderDashboard from "../client/src/pages/FounderDashboard";

const previousReact = (globalThis as any).React;
beforeAll(() => Object.assign(globalThis, { React }));
afterAll(() => {
  if (previousReact === undefined) delete (globalThis as any).React;
  else Object.assign(globalThis, { React: previousReact });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const unavailable = () => json({
  error: "Trello assignments are unavailable. Retry after checking the Trello connection.",
  code: "TRELLO_ASSIGNMENTS_UNAVAILABLE",
}, 503);
// Match the direct route's unassigned-card response (string id, null schedules,
// absent blocks), not just the old narrower frontend interface.
const task = {
  id: "card-1", taskId: "card-1", taskTitle: "Recorded task", cardName: "Recorded card", cardId: "short-link",
  workerId: null, workerName: null, priority: "normal", isPriorityOverride: false, status: "unassigned",
  estimatedMinutes: 60, blockedBy: [], labels: ["Operations"], scheduledStart: null, scheduledEnd: null,
  checklist: [{ step: "Review evidence", timeMinutes: 15, aptlssType: "T" }],
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
};
const render = () => {
  mocks.stateIndex = 0; mocks.refIndex = 0; mocks.effects = [];
  mocks.buttons = []; mocks.selects = []; mocks.graph = null; mocks.search = null;
  return renderToStaticMarkup(React.createElement(FounderDashboard));
};
const mount = () => {
  const html = render();
  for (const effect of [...mocks.effects]) effect();
  return html;
};
const button = (label: string) => {
  const found = mocks.buttons.find(item => item.label === label);
  expect(found, `Missing button: ${label}`).toBeDefined();
  return found!;
};
const click = async (label: string) => {
  const action = button(label);
  expect(action.disabled).not.toBe(true);
  await action.onClick!();
};
const reads = () => mocks.fetch.mock.calls.filter(([url, options]) => url === "/api/va/assignments" && !options.method);
const writes = () => mocks.fetch.mock.calls.filter(([, options]) => options?.method);
const assertUnavailable = () => {
  const html = render();
  expect(html.match(/Assignments unavailable/g)).toHaveLength(2);
  expect(html).toContain('role="alert"');
  expect(html).toContain("Retry after checking the Trello connection");
  expect(html).not.toMatch(/No tasks found|No tasks with dependencies|Recorded task|Recorded card|private-diagnostics/);
  expect(mocks.graph).toBeNull();
  expect(mocks.selects.some(item => item.label.includes("Unassigned"))).toBe(false);
  expect(mocks.buttons.some(item => item.label === "Priority" || item.label === "Trello")).toBe(false);
  expect(mocks.search.allLabels).toEqual([]);
  return html;
};

let result: () => Response | Promise<Response>;
beforeEach(() => {
  vi.clearAllMocks(); mocks.states = []; mocks.refs = [];
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("window", { location: { search: "?tab=assignments" }, open: vi.fn() });
  result = () => json([task]);
  mocks.fetch.mockImplementation((url: string, options: any) => {
    if (options?.method) return Promise.resolve(json({}));
    if (url === "/api/va/assignments") return Promise.resolve(result());
    if (url === "/api/va/briefing-settings") return Promise.resolve(json({}));
    if (["/api/va/workload-overview", "/api/va/communications", "/api/va/timezone-overlaps"].includes(url)) return Promise.resolve(json([]));
    throw new Error(`Unexpected endpoint: ${url}`);
  });
});

describe("Founder assignment availability", () => {
  it('consumes an unavailable response without exposing its private body', async () => {
    const response = json({ error: 'private-diagnostics' }, 503);
    result = () => response;
    mount(); await settle();
    expect(response.bodyUsed).toBe(true);
    assertUnavailable();
  });
  it.each([
    ["unassigned", "Unassigned"], ["assigned", "Assigned"],
    ["in_progress", "In Progress"], ["completed", "Completed"], ["blocked", "Blocked"],
  ])("labels the %s task status accurately", async (status, label) => {
    result = () => json([{ ...task, status }]);
    mount(); await settle();
    const badges = [...render().matchAll(/<span[^>]*data-slot="badge"[^>]*>([\s\S]*?)<\/span>/g)]
      .map(match => match[1].replace(/<[^>]*>/g, ""));
    expect(badges).toContain(label);
    if (status === "unassigned") expect(badges).not.toContain("Assigned");
  });
  it('accepts the retained drop_everything priority without rejecting healthy assignments', async () => {
    result = () => json([{ ...task, priority: 'drop_everything', isPriorityOverride: true }]);
    mount(); await settle();
    const html = render();
    expect(html).toContain('DROP EVERYTHING');
    expect(html).not.toContain('Assignments unavailable');
    expect(mocks.graph.tasks).toHaveLength(1);
  });
  it("treats the provider 503 as unavailable in assignments and dependencies, without exposing diagnostics", async () => {
    result = unavailable;
    expect(mount()).not.toContain("No tasks found");
    await settle(); assertUnavailable(); assertUnavailable();
    expect(writes()).toEqual([]);
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP failure", () => json({ error: "private-diagnostics" }, 500)],
    ["unauthorized", () => json({ error: "private-diagnostics" }, 401)],
    ["transport failure", () => Promise.reject(new Error("private-diagnostics"))],
    ["malformed JSON", () => new Response("private-diagnostics")],
    ["missing body", () => new Response("")],
    ["null payload", () => json(null)],
    ["missing assignments", () => json({})],
    ["non-array envelope", () => json({ assignments: {} })],
    ["null row", () => json([null])],
    ["incomplete row", () => json([{ taskId: "card-1" }])],
    ["malformed labels", () => json([{ ...task, labels: [null] }])],
    ["malformed checklist", () => json([{ ...task, checklist: {} }])],
    ["partial malformed result", () => json([task, { ...task, priority: null }])],
  ])("fails closed for %s", async (_label, response) => {
    result = response;
    mount(); await settle(); assertUnavailable();
  });

  it.each([
    { name: "array", data: [] }, { name: "envelope", data: { assignments: [] } },
  ])("preserves genuinely empty $name success", async ({ data }) => {
    result = () => json(data);
    mount(); await settle();
    const html = render();
    expect(html).toContain("No tasks found matching your filters.");
    expect(html).toContain("No tasks with dependencies to display");
    expect(html).not.toContain("Assignments unavailable");
    expect(mocks.graph.tasks).toEqual([]);
  });

  it.each([
    { name: "array", data: [task] }, { name: "envelope", data: { assignments: [task] } },
  ])("preserves populated $name shape, labels and a genuine filter-empty state", async ({ data }) => {
    result = () => json(data);
    mount(); await settle();
    expect(render()).toContain("Recorded task");
    expect(mocks.graph.tasks[0]).toMatchObject({ id: "card-1", blockedBy: [], blocks: [] });
    expect(mocks.search.allLabels).toEqual(["Operations"]);
    expect(button("Priority").disabled).toBe(false);
    mocks.search.onChange("not-present");
    const html = render();
    expect(html).toContain("No tasks found matching your filters.");
    expect(html).not.toContain("Assignments unavailable");
    expect(mocks.graph.tasks).toHaveLength(1);
  });

  it.each([
    { name: "empty", recovered: [] }, { name: "populated", recovered: [task] },
  ])("keeps failure visible during retry and recovers only after validated $name success", async ({ recovered }) => {
    result = unavailable;
    mount(); await settle(); assertUnavailable();
    const retry = button("Retry assignments").onClick!;
    const pending = deferred<Response>();
    result = () => pending.promise;
    retry(); retry();
    const html = assertUnavailable();
    expect(html).toContain("Retrying...");
    expect(button("Retrying...").disabled).toBe(true);
    expect(button("Refresh").disabled).toBe(true);
    expect(reads()).toHaveLength(2);
    expect(reads()[1][1]).toEqual({ credentials: "include" });
    pending.resolve(json(recovered)); await settle();
    const success = render();
    expect(success).not.toContain("Assignments unavailable");
    expect(success).not.toContain("Retrying...");
    expect(success).toContain(recovered.length ? "Recorded task" : "No tasks found matching your filters.");
    expect(mocks.graph.tasks).toHaveLength(recovered.length);
    expect(writes()).toEqual([]);
  });

  it("clears stale assignments and labels, unmounts the dependency editor and blocks retained action callbacks", async () => {
    mount(); await settle(); render();
    const assign = mocks.selects.find(item => item.label.includes("Unassigned"))!.onValueChange!;
    const priority = button("Urgent").onClick!;
    const refresh = mocks.graph.onRefresh;
    const pending = deferred<Response>();
    result = () => pending.promise;
    refresh();
    render();
    expect(mocks.graph).toBeNull();
    await assign("7"); await priority();
    expect(writes()).toEqual([]);
    pending.resolve(unavailable()); await settle(); assertUnavailable();
    await assign("7"); await priority();
    expect(writes()).toEqual([]);
  });

  it("does not treat a malformed retry as recovery, and then accepts a valid retry", async () => {
    result = unavailable;
    mount(); await settle(); assertUnavailable();
    result = () => json({ assignments: "private-diagnostics" });
    await click("Retry assignments"); await settle(); assertUnavailable();
    result = () => json([task]);
    await click("Retry assignments"); await settle();
    expect(render()).toContain("Recorded task");
    expect(mocks.graph.tasks).toHaveLength(1);
    expect(reads()).toHaveLength(3);
  });

  it.each(["assignment", "priority"])("does not let a late %s mutation restore stale tasks or success feedback", async action => {
    mount(); await settle(); render();
    const refresh = mocks.graph.onRefresh;
    const pending = deferred<Response>();
    mocks.fetch.mockImplementationOnce(() => pending.promise);
    const mutation = action === "assignment"
      ? mocks.selects.find(item => item.label.includes("Unassigned"))!.onValueChange!("7")
      : button("Urgent").onClick!();
    result = unavailable;
    await refresh(); assertUnavailable();
    pending.resolve(json({})); await mutation;
    assertUnavailable();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });

  it("discards an old mutation even if the assignment read has already recovered", async () => {
    mount(); await settle(); render();
    const refresh = mocks.graph.onRefresh;
    const pending = deferred<Response>();
    mocks.fetch.mockImplementationOnce(() => pending.promise);
    const mutation = button("Urgent").onClick!();
    result = unavailable;
    await refresh(); assertUnavailable();
    result = () => json([task]);
    await click("Retry assignments"); await settle();
    expect(render()).toContain("NORMAL");
    pending.resolve(json({})); await mutation;
    const html = render();
    expect(html).toContain("NORMAL");
    expect(html).not.toContain(">URGENT</");
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(reads()).toHaveLength(4);
  });

  it.each(['assignment', 'priority'])('reconciles a late %s success after a refresh read returned the old snapshot', async action => {
    mount(); await settle(); render();
    const refresh = mocks.graph.onRefresh;
    const pending = deferred<Response>(); mocks.fetch.mockImplementationOnce(() => pending.promise);
    const mutation = action === 'assignment'
      ? mocks.selects.find(item => item.label.includes('Unassigned'))!.onValueChange!('7')
      : button('Urgent').onClick!();
    await refresh(); render();
    result = () => json([{ ...task, workerId: action === 'assignment' ? 7 : null, priority: action === 'priority' ? 'urgent' : 'normal' }]);
    pending.resolve(json({})); await mutation; await settle();
    const html = render();
    expect(reads()).toHaveLength(3);
    expect(html).not.toContain('Assignments unavailable');
    if (action === 'assignment') expect(mocks.states.some(value => Array.isArray(value) && value[0]?.workerId === 7)).toBe(true);
    else expect(html).toContain('URGENT');
    expect(mocks.toast.info).toHaveBeenCalled();
  });

  it('queues one verified read after a still-pending refresh when a successful write settles', async () => {
    mount(); await settle(); render();
    const refresh = mocks.graph.onRefresh;
    const write = deferred<Response>(); mocks.fetch.mockImplementationOnce(() => write.promise);
    const mutation = button('Urgent').onClick!();
    const read = deferred<Response>(); result = () => read.promise;
    const refreshPromise = refresh();
    write.resolve(json({})); await mutation;
    expect(reads()).toHaveLength(2);
    result = () => json([{ ...task, priority: 'urgent' }]);
    read.resolve(json([task])); await refreshPromise; await settle();
    expect(reads()).toHaveLength(3);
    expect(render()).toContain('URGENT');
  });

  it("keeps healthy assignment and priority actions connected to their existing API paths", async () => {
    mount(); await settle(); render();
    await mocks.selects.find(item => item.label.includes("Unassigned"))!.onValueChange!("7");
    render(); await button("Urgent").onClick!();
    expect(writes().map(([url, options]) => [url, options.method, JSON.parse(options.body)])).toEqual([
      ["/api/va/assignments", "POST", { taskId: "card-1", vaId: 7 }],
      ["/api/va/priority-override", "POST", { taskId: "card-1", priority: "urgent" }],
    ]);
    render();
    expect(mocks.graph.tasks[0].status).toBe("assigned");
    expect(mocks.toast.success).toHaveBeenCalledWith("Priority set to URGENT");
  });
});
