import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  risks: vi.fn(), followUps: vi.fn(), ready: vi.fn(), weekly: vi.fn(),
  buttons: [] as Array<{ label: string; disabled?: boolean; onClick?: () => unknown }>,
}));
vi.mock("@/lib/trpc", () => ({ trpc: {
  aptlss: {
    getRisksAndExceptions: { useQuery: mocks.risks },
    getPendingFollowUps: { useQuery: mocks.followUps },
    getReadyForDone: { useQuery: mocks.ready },
    getLatestWeeklyAnalysis: { useQuery: mocks.weekly },
    markFollowUpSent: { useMutation: () => ({ mutate: vi.fn() }) },
    dismissFollowUp: { useMutation: () => ({ mutate: vi.fn() }) },
  },
  useUtils: () => ({ aptlss: { getPendingFollowUps: { invalidate: vi.fn() } } }),
} }));
vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href }, children),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
    const label = React.Children.toArray(children).filter(child => typeof child === "string").join("").trim();
    mocks.buttons.push({ label, disabled, onClick: onClick as () => unknown });
    return React.createElement("button", { onClick, disabled }, children);
  },
}));
import Dashboard from "../client/src/pages/manus/RobertDashboard";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());
const query = (overrides = {}) => ({
  data: undefined, error: null, isError: false, isLoading: false,
  isFetching: false, isStale: false, refetch: vi.fn().mockResolvedValue({}), ...overrides,
});
// Exact category/count shape returned by getRisksAndExceptions; no source-health fields exist.
const emptyRisks = () => ({
  totalIssues: 0, normalCount: 0, externalCount: 0,
  pendingDecisions: [], escalations: [], stalledCards: [], blockedCards: [],
  waitingCards: [], repairCards: [], deadlineRisks: [], readyForApproval: [],
});
const card = {
  cardId: "retained", cardName: "Retained card", cardUrl: "https://trello.com/c/retained",
  boardName: "Operations", tier: "HIGH", stateReason: "Recorded blocker",
};
const populated = () => ({
  ...emptyRisks(), totalIssues: 1, normalCount: 3, externalCount: 2,
  pendingDecisions: [{ ...card, stepTitle: "Approve recorded scope", recommendedDecision: "Review evidence" }],
});
const draft = { id: 1, cardName: "Draft card", reason: "Awaiting reply", urgencyType: "HIGH", draftMessage: "Retained follow-up draft" };
const weekly = {
  weekKey: "2026-W40", summary: "Retained weekly summary",
  noProgressCards: JSON.stringify([{ cardId: "weekly", cardName: "Weekly card", state: "STALLED" }]),
  recurringBlockers: "[]", processImprovements: JSON.stringify(["Review handover"]),
};
const render = () => {
  mocks.buttons.length = 0;
  return renderToStaticMarkup(React.createElement(Dashboard));
};
const click = async (label: string) => {
  const button = mocks.buttons.find(item => item.label === label);
  expect(button, `Missing button: ${label}`).toBeDefined();
  expect(button!.disabled).not.toBe(true);
  await button!.onClick!();
};
const assertNoOperationalClaims = (html: string) => {
  expect(html).not.toMatch(/All clear|working autonomously|proceed autonomously|all work can proceed|all active work is progressing|progressing normally|scheduled and not yet overdue|answered all questions|all cards are well-structured|No attention needed/);
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.risks.mockReturnValue(query({ data: emptyRisks() }));
  mocks.followUps.mockReturnValue(query({ data: [] }));
  mocks.ready.mockReturnValue(query({ data: [] }));
  mocks.weekly.mockReturnValue(query({ data: null }));
});

describe("Robert dashboard snapshot availability", () => {
  it("renders a successful empty snapshot without turning zero categories into operational clearance", () => {
    const html = render();
    expect(html).toContain("No risks or exceptions returned");
    expect(html).toContain("Source coverage and live work status are not confirmed");
    expect(html).toContain("No pending decisions in this snapshot.");
    expect(html).not.toContain('role="alert"');
    assertNoOperationalClaims(html);
  });

  it.each([
    ["absent", query(), "Risks and exceptions unavailable"],
    ["null", query({ data: null }), "Risks and exceptions unavailable"],
    ["error", query({ error: { message: "private-provider-details" }, isError: true }), "Risks and exceptions unavailable"],
    ["loading", query({ isLoading: true, isFetching: true }), "Loading risks and exceptions"],
  ])("does not render success categories for an %s source", (_label, result, heading) => {
    mocks.risks.mockReturnValue(result);
    const html = render();
    expect(html).toContain(heading);
    expect(html).not.toMatch(/No risks or exceptions returned|No pending decisions in this snapshot|private-provider-details/);
    assertNoOperationalClaims(html);
  });

  it.each([
    ["failed refresh", { error: { message: "private-provider-details" }, isError: true }, "Risks and exceptions refresh failed"],
    ["stale cache", { isStale: true }, "Risks and exceptions snapshot may be out of date"],
    ["refreshing", { isFetching: true }, "Refreshing risks and exceptions"],
  ])("retains populated categories with an explicit %s warning", (_label, state, heading) => {
    mocks.risks.mockReturnValue(query({ data: populated(), ...state }));
    const html = render();
    expect(html).toContain(heading);
    expect(html).toContain("last loaded snapshot");
    expect(html).toContain("Retained card");
    expect(html).toContain("Approve recorded scope");
    expect(html).toContain('href="https://trello.com/c/retained"');
    expect(html).not.toContain("private-provider-details");
    assertNoOperationalClaims(html);
  });

  it.each([{ isStale: true }, { isError: true, error: new Error("private") }])("qualifies cached zero categories instead of rendering an all-clear (%j)", state => {
    mocks.risks.mockReturnValue(query({ data: emptyRisks(), ...state }));
    const html = render();
    expect(html).toContain("last loaded snapshot");
    expect(html).toContain("Source coverage and live work status are not confirmed");
    assertNoOperationalClaims(html);
  });

  it("describes normal/external counts according to the stored-state contract, not inferred progress or scheduling", () => {
    mocks.risks.mockReturnValue(query({ data: { ...emptyRisks(), normalCount: 3, externalCount: 2 } }));
    const html = render();
    expect(html).toContain("3 stored card states in the backend normal category");
    expect(html).toContain("2 stored card states waiting for external parties");
    assertNoOperationalClaims(html);
  });

  it("shows repair-only attention even though the backend totalIssues excludes repairCards", () => {
    mocks.risks.mockReturnValue(query({ data: { ...emptyRisks(), repairCards: [card] } }));
    const html = render();
    expect(html).toContain("Admin Attention Required");
    expect(html).toContain("Recorded blocker");
    expect(html).not.toContain("No risks or exceptions returned");
    assertNoOperationalClaims(html);
  });

  it("keeps all populated category details, links, and approval sections", () => {
    mocks.risks.mockReturnValue(query({ data: {
      ...populated(), stalledCards: [card], blockedCards: [card], waitingCards: [card],
      repairCards: [card], deadlineRisks: [{ ...card, isOverdue: true }], readyForApproval: [card],
      escalations: [{ ...card, escalationCategory: "scope_change", confidenceScore: 80, founderDecision: "Approve scope" }],
    } }));
    const html = render();
    for (const label of ["Pending Decisions", "Escalations", "Stalled Cards", "Blocked Cards", "Waiting for Worker", "Cards Needing Repair", "Deadline Risks", "Cards Ready for Final Approval", "OVERDUE", "Approve scope"])
      expect(html).toContain(label);
    expect(html.match(/href="https:\/\/trello.com\/c\/retained"/g)).toHaveLength(8);
    expect(html).toContain("Blocked or stalled cards");
    expect(html).not.toContain("Cards blocked 3+ days");
    assertNoOperationalClaims(html);
  });
});

describe("independent dashboard queries and retries", () => {
  const sections = [
    { hook: mocks.followUps, title: "Follow-up drafts", retry: "Retry follow-up drafts", data: [draft], content: "Retained follow-up draft" },
    { hook: mocks.ready, title: "Ready-to-done cards", retry: "Retry ready-to-done cards", data: [card], content: "Cards Ready to Move to Done" },
    { hook: mocks.weekly, title: "Weekly analysis", retry: "Retry weekly analysis", data: weekly, content: "Retained weekly summary" },
  ];

  it.each(sections)("renders and retries $title errors independently while preserving the other sections", async section => {
    const retry = vi.fn().mockResolvedValue({});
    mocks.risks.mockReturnValue(query({ data: populated() }));
    for (const item of sections) item.hook.mockReturnValue(query({ data: item.data }));
    section.hook.mockReturnValue(query({ data: section.data, isError: true, error: new Error("private-diagnostics"), refetch: retry }));
    const html = render();
    expect(html).toContain(`${section.title} refresh failed`);
    expect(html).toContain('role="alert"');
    expect(html).toContain("last loaded snapshot");
    for (const item of sections) expect(html).toContain(item.content);
    expect(html).toContain("Retained card");
    expect(html).not.toContain("private-diagnostics");
    await click(section.retry);
    expect(retry).toHaveBeenCalledOnce();
    expect(mocks.risks.mock.results[0].value.refetch).not.toHaveBeenCalled();
    section.hook.mockReturnValue(query({ data: section.data }));
    expect(render()).not.toContain(`${section.title} refresh failed`);
  });

  it.each(sections)("reports initial $title failure without hiding healthy main data", async section => {
    const retry = vi.fn().mockResolvedValue({});
    mocks.risks.mockReturnValue(query({ data: populated() }));
    section.hook.mockReturnValue(query({ isError: true, error: new Error("private"), refetch: retry }));
    const html = render();
    expect(html).toContain(`${section.title} unavailable`);
    expect(html).toContain("Retained card");
    await click(section.retry);
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each([query(), query({ isError: true, error: new Error("private") }), query({ isLoading: true, isFetching: true })])("keeps independent successful sections visible when main data is unavailable (%j)", main => {
    mocks.risks.mockReturnValue(main);
    for (const section of sections) section.hook.mockReturnValue(query({ data: section.data }));
    const html = render();
    for (const section of sections) expect(html).toContain(section.content);
    for (const action of ["Copy", "Mark Sent", "Dismiss"]) expect(html).toContain(action);
    assertNoOperationalClaims(html);
  });

  it("main refresh retries all four reads, including failed auxiliary queries", async () => {
    const results = [mocks.risks, mocks.followUps, mocks.ready, mocks.weekly].map(hook => {
      const result = query({ isError: true, error: new Error("private") });
      hook.mockReturnValue(result);
      return result;
    });
    render();
    await click("Refresh");
    for (const result of results) expect(result.refetch).toHaveBeenCalledOnce();
  });

  it("retries the main query independently and recovers to a populated, qualified snapshot", async () => {
    const retry = vi.fn().mockResolvedValue({});
    mocks.risks.mockReturnValue(query({ error: new Error("private"), refetch: retry }));
    expect(render()).toContain("Risks and exceptions unavailable");
    await click("Retry risks and exceptions");
    expect(retry).toHaveBeenCalledOnce();
    for (const hook of [mocks.followUps, mocks.ready, mocks.weekly])
      expect(hook.mock.results[0].value.refetch).not.toHaveBeenCalled();
    mocks.risks.mockReturnValue(query({ data: populated() }));
    const html = render();
    expect(html).toContain("Retained card");
    expect(html).toContain("Admin Attention Required");
    expect(html).not.toContain("Risks and exceptions unavailable");
    assertNoOperationalClaims(html);
  });

  it.each(sections)("keeps stale $title snapshots labelled and individually refreshable", async section => {
    const retry = vi.fn().mockResolvedValue({});
    section.hook.mockReturnValue(query({ data: section.data, isStale: true, refetch: retry }));
    const html = render();
    expect(html).toContain(`${section.title} snapshot may be out of date`);
    expect(html).toContain(section.content);
    expect(html).toContain("last loaded snapshot");
    await click(section.retry);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("accepts successful empty auxiliary results, including the weekly null contract, without inventing work or errors", () => {
    const html = render();
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/Cards Ready to Move to Done|Auto-Generated Follow-Up Drafts|Weekly Analysis/);
    assertNoOperationalClaims(html);
  });

  it("retains the main failure and cached work during retry, clearing the warning only after recovery", () => {
    const failure = { data: populated(), isError: true, error: new Error("private") };
    mocks.risks.mockReturnValue(query(failure));
    expect(render()).toContain("Risks and exceptions refresh failed");
    mocks.risks.mockReturnValue(query({ ...failure, isFetching: true }));
    const retrying = render();
    expect(retrying).toContain("Risks and exceptions refresh failed");
    expect(retrying).toContain("Retained card");
    expect(mocks.buttons.find(button => button.label === "Retry risks and exceptions")?.disabled).toBe(true);
    mocks.risks.mockReturnValue(query({ data: populated() }));
    const recovered = render();
    expect(recovered).not.toContain("Risks and exceptions refresh failed");
    expect(recovered).toContain("Retained card");
    assertNoOperationalClaims(recovered);
  });

  it.each(sections)("disables duplicate main and section retries while $title is retrying", section => {
    section.hook.mockReturnValue(query({ isError: true, error: new Error("private"), isFetching: true }));
    const html = render();
    expect(html).toContain(`${section.title} unavailable`);
    expect(mocks.buttons.find(button => button.label === section.retry)?.disabled).toBe(true);
    expect(mocks.buttons.find(button => button.label === "Refresh")?.disabled).toBe(true);
  });
});
