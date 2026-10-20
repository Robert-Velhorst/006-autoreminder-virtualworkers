import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ManagerSnapshot } from "../shared/aptlssManager";
vi.mock("../client/src/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: null }),
}));
vi.mock("../client/src/lib/trpc", () => ({ trpc: {} }));
import { ManagerSnapshotDetails } from "../client/src/components/AptlssManagerReview";
// This server test configuration uses the classic JSX transform.
vi.stubGlobal("React", React);

function snapshot(): ManagerSnapshot {
  const action = {
    id: "a",
    cardId: "c",
    title: "Check invoice",
    where: "Accounts",
    kind: "verify" as const,
    stepIds: [],
    dependsOn: [],
    minutes: {
      low: 5,
      likely: 10,
      high: 15,
      samples: 0,
      basis: "Initial estimate",
    },
    reason: "Verify",
    completionCriteria: "Evidence recorded",
    evidenceIds: [],
    notBefore: null,
    blocked: false,
    priority: 1,
    draft: null,
    reviewedGuidance: [
      {
        id: 1,
        reviewId: 2,
        cardId: "c",
        topic: "payment",
        correction: "Confirm payment date in the ledger.",
        evidenceIds: ["s"],
        validUntil: "2026-10-01T00:00:00Z",
        actionKind: "verify" as const,
      },
    ],
  };
  return {
    version: 1,
    trigger: "test",
    assessedAt: "2026-09-05T00:00:00Z",
    cards: [],
    actions: [action],
    assessments: [
      {
        cardId: "c",
        state: "READY",
        confidence: 0,
        explanation: "Check records",
        uncertainties: [],
        evidenceIds: [],
        facts: [],
        actions: [action],
      },
    ],
    evidence: [
      {
        id: "s",
        cardId: "c",
        source: "Ledger",
        kind: "source",
        observedAt: "2026-09-05T00:00:00Z",
        text: "Payment received on Friday.",
      },
    ],
    sourceGaps: [],
    changes: [],
    policy: { enabled: true, intervalMinutes: 5, mode: "shadow" },
    nextCheckAt: null,
    interventions: [
      {
        id: "i",
        cardId: "c",
        title: "Check payment",
        severity: "urgent",
        explanation: "Sources disagree",
        question: "Which date is correct?",
        safeAction: "Keep paused",
        evidenceIds: ["s"],
        verification: {
          issues: [],
          passages: [
            {
              evidenceId: "s",
              source: "Ledger",
              kind: "source",
              quote: "Payment received on Friday.",
              sender: "Accounts",
              sourceDate: "2026-09-05T00:00:00Z",
              effectiveFrom: null,
            },
          ],
        },
      },
    ],
  };
}
describe("founder review snapshot details", () => {
  it("renders the shared verification comparison", () => {
    const html = renderToStaticMarkup(
      createElement(ManagerSnapshotDetails, { snapshot: snapshot() })
    );
    expect(html).toContain("Verification evidence comparison");
    expect(html).toContain("Accounts");
  });
  it("shows reviewed guidance separately with its sources", () => {
    const html = renderToStaticMarkup(
      createElement(ManagerSnapshotDetails, { snapshot: snapshot() })
    );
    expect(html).toContain("Reviewed guidance");
    expect(html).toContain("Confirm payment date in the ledger.");
    expect(html).toContain("Ledger");
  });
  it("does not leak another card's questions or guidance", () => {
    const html = renderToStaticMarkup(
      createElement(ManagerSnapshotDetails, {
        snapshot: snapshot(),
        cardId: "other",
      })
    );
    expect(html).not.toContain("Which date is correct?");
    expect(html).not.toContain("Confirm payment date");
  });
  it("renders without optional guidance or verification", () => {
    const value = snapshot();
    delete value.actions[0].reviewedGuidance;
    delete value.interventions[0].verification;
    expect(
      renderToStaticMarkup(
        createElement(ManagerSnapshotDetails, { snapshot: value })
      )
    ).not.toContain("Reviewed guidance");
  });
});
