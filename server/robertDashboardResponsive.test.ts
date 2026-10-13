import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import RobertDashboard from "../client/src/pages/manus/RobertDashboard";

const queries = vi.hoisted(() => ({
  risks: vi.fn(),
  followUps: vi.fn(),
  readyForDone: vi.fn(),
  weeklyAnalysis: vi.fn(),
}));

vi.mock("../client/src/lib/trpc", () => ({
  trpc: {
    aptlss: {
      getRisksAndExceptions: { useQuery: queries.risks },
      getPendingFollowUps: { useQuery: queries.followUps },
      getReadyForDone: { useQuery: queries.readyForDone },
      getLatestWeeklyAnalysis: { useQuery: queries.weeklyAnalysis },
      markFollowUpSent: { useMutation: () => ({ mutate: vi.fn() }) },
      dismissFollowUp: { useMutation: () => ({ mutate: vi.fn() }) },
    },
    useUtils: () => ({
      aptlss: { getPendingFollowUps: { invalidate: vi.fn() } },
    }),
  },
}));

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());

function emptyRisks() {
  return {
    totalIssues: 0,
    pendingDecisions: [],
    escalations: [],
    stalledCards: [],
    blockedCards: [],
    waitingCards: [],
    repairCards: [],
    deadlineRisks: [],
    readyForApproval: [],
  };
}

function markup() {
  return renderToStaticMarkup(
    createElement(Router, { ssrPath: "/robert" }, createElement(RobertDashboard))
  );
}

beforeEach(() => {
  queries.risks.mockReturnValue({ data: emptyRisks(), isLoading: false, isFetching: false, refetch: vi.fn() });
  queries.followUps.mockReturnValue({ data: [] });
  queries.readyForDone.mockReturnValue({ data: [] });
  queries.weeklyAnalysis.mockReturnValue({ data: null });
});

// Structural guards only: the parent route matrix measures compiled CSS at 390px.
describe("Robert dashboard responsive layout", () => {
  it.each([false, true])("keeps every header control in a responsive layout (loading: %s)", isLoading => {
    queries.risks.mockReturnValue({ data: isLoading ? undefined : emptyRisks(), isLoading, isFetching: false, refetch: vi.fn() });
    const html = markup();
    const header = html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1];

    expect(header).toContain("flex flex-col items-start gap-3 lg:flex-row lg:flex-wrap lg:items-center");
    expect(header).toContain("flex max-w-full flex-wrap items-center gap-2");
    expect(header).toContain('href="/"');
    expect(header).toContain('href="/command-center"');
    expect(header).toContain('href="/admin"');
    expect(header).toContain("Admin Oversight Dashboard");
    expect(header).toContain("Refresh");
    expect(header).not.toContain('class="flex-1"');
  });

  it("allows long board names to wrap without losing the card link or section count", () => {
    const boardName = "Board".repeat(80);
    queries.risks.mockReturnValue({
      data: {
        ...emptyRisks(),
        totalIssues: 1,
        pendingDecisions: [{
          cardUrl: "https://trello.com/c/responsive-test",
          cardName: "Card".repeat(80),
          boardName,
          tier: "HIGH",
          stepTitle: "Review the recorded decision.",
        }],
      },
      isLoading: false,
      refetch: vi.fn(),
    });
    const html = markup();

    expect(html).toContain('href="https://trello.com/c/responsive-test"');
    expect(html).toContain("flex min-w-0 flex-wrap items-center gap-1");
    expect(html).toContain(`class="min-w-0 max-w-full text-muted-foreground text-[10px]"`);
    expect(html).toContain(boardName);
    expect(html).toMatch(/<h2 class="min-w-0 [^"]*flex-1">Pending Decisions<\/h2>/);
    expect(html).toMatch(/<span class="shrink-0 [^"]*">1<\/span>/);
  });

  it("wraps unbroken draft content and keeps all follow-up actions", () => {
    const longText = "reference".repeat(100);
    queries.followUps.mockReturnValue({ data: [{
      id: 1,
      cardName: longText,
      reason: longText,
      urgencyType: "HIGH",
      draftMessage: `Please review\n${longText}`,
    }] });
    const html = markup();

    expect(html).toMatch(/<main class="[^"]*min-w-0[^"]*\[overflow-wrap:anywhere\][^"]*">/);
    expect(html).toContain('class="min-w-0 flex-1"');
    expect(html).toMatch(/<pre class="[^"]*whitespace-pre-wrap[^"]*">Please review\n/);
    expect(html).toContain(longText);
    expect(html).toContain('class="flex flex-wrap items-center gap-2"');
    expect(html).toContain("Copy");
    expect(html).toContain("Mark Sent");
    expect(html).toContain("Dismiss");
    expect(html).not.toContain("overflow-x-hidden");
  });
});
