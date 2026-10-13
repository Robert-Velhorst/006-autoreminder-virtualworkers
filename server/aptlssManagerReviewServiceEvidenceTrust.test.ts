import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ManagerCard,
  ManagerEvidence,
  ManagerSnapshot,
} from "../shared/aptlssManager";
import {
  prepareManagerCorrection,
  selectApplicableManagerCorrections,
} from "./aptlssManagerReviewService";
import type {
  ManagerCorrectionContext,
  ManagerCorrectionRow,
} from "./aptlssManagerReviewService";

const now = new Date("2026-09-05T10:00:00Z");
const card: ManagerCard = {
  id: "card-invoice",
  name: "Invoice A",
  url: null,
  board: "Accounts",
  list: "Doing",
  state: "READY",
  stateReason: "Ready",
  dueAt: null,
  overdue: false,
  priority: 50,
  updatedAt: now.toISOString(),
  steps: [],
  waiting: null,
};

function sourceRecord(): ManagerEvidence {
  return {
    id: "source:invoice-a",
    cardId: card.id,
    source: "trello",
    kind: "source",
    text: "Invoice A is unpaid.",
    observedAt: now.toISOString(),
    metadata: {
      truthClass: "source_record",
      sourceDate: "2026-09-01T09:00:00Z",
      effectiveFrom: "2026-09-01T00:00:00Z",
      sourceRecordId: "invoice-a",
      sourceRevision: "revision-1",
      sender: "Accounts",
    },
  };
}

function snapshot(evidence: ManagerEvidence[]): ManagerSnapshot {
  return {
    cards: [card],
    actions: [
      {
        id: "verify-invoice",
        cardId: card.id,
        kind: "verify",
      },
    ],
    evidence,
  } as unknown as ManagerSnapshot;
}

function knowledge(evidenceId = "source:invoice-a") {
  return {
    scope: "card" as const,
    cardId: card.id,
    topic: "invoice-status",
    evidenceIds: [evidenceId],
    conditions: { actionKind: "verify" as const },
    validUntil: "2026-09-20T10:00:00Z",
  };
}

function preparedRow(evidence = sourceRecord()): ManagerCorrectionRow {
  return {
    id: 1,
    vaId: 7,
    reviewId: 10,
    createdBy: 99,
    createdAt: now,
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    ...prepareManagerCorrection({
      knowledge: knowledge(),
      correction: "Check the reviewed invoice record before proceeding.",
      snapshot: snapshot([evidence]),
      now,
    }),
  };
}

function context(evidence: ManagerEvidence[]): ManagerCorrectionContext {
  return {
    vaId: 7,
    card,
    evidence,
    now,
    topic: "invoice-status",
    actionKind: "verify",
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function repin(row: ManagerCorrectionRow, evidence: ManagerEvidence) {
  const pins = JSON.parse(row.evidenceJson) as Array<{
    id: string;
    cardId: string;
    fingerprint: string;
    sourceRevision: string | null;
  }>;
  pins[0].fingerprint = createHash("sha256")
    .update(canonical(evidence))
    .digest("hex");
  pins[0].sourceRevision = evidence.metadata?.sourceRevision ?? null;
  row.evidenceJson = JSON.stringify(pins);
}

describe("manager correction evidence trust boundary", () => {
  it.each(["missing", "worker_report", "model_proposal", "unknown"] as const)(
    "requires an explicit source_record class instead of %s evidence",
    truthClass => {
      const unsupported = sourceRecord();
      if (truthClass === "missing") delete unsupported.metadata!.truthClass;
      else unsupported.metadata!.truthClass = truthClass;

      expect(() =>
        prepareManagerCorrection({
          knowledge: knowledge(),
          correction: "Treat the reported status as confirmed.",
          snapshot: snapshot([unsupported]),
          now,
        })
      ).toThrow(/evidence|source/i);

      const row = preparedRow();
      repin(row, unsupported);
      expect(
        selectApplicableManagerCorrections([row], context([unsupported]))
          .corrections
      ).toEqual([]);
    }
  );

  it.each(["reported", "unverified"] as const)(
    "does not accept %s source authority for correction proof",
    authority => {
      const unsupported = sourceRecord();
      unsupported.metadata!.authority = authority;
      expect(() =>
        prepareManagerCorrection({
          knowledge: knowledge(),
          correction: "Use this claimed invoice status.",
          snapshot: snapshot([unsupported]),
          now,
        })
      ).toThrow(/evidence|source/i);

      const row = preparedRow();
      repin(row, unsupported);
      expect(
        selectApplicableManagerCorrections([row], context([unsupported]))
          .corrections
      ).toEqual([]);
    }
  );

  it("keeps a VA response as a claim and does not let its supersedes claim erase the accepted source", () => {
    const accepted = sourceRecord();
    const vaClaim: ManagerEvidence = {
      id: "worker-report:invoice-a",
      cardId: card.id,
      source: "worker_update",
      kind: "worker",
      text: "Invoice A has been paid.",
      observedAt: now.toISOString(),
      metadata: {
        truthClass: "worker_report",
        authority: "authoritative",
        sourceRecordId: "invoice-a",
        sourceRevision: "revision-2",
        sourceDate: "2026-09-04T09:00:00Z",
        effectiveFrom: "2026-09-04T00:00:00Z",
        supersedesEvidenceIds: [accepted.id],
      },
    };
    const evidence = [accepted, vaClaim];
    const before = structuredClone(evidence);
    const selected = selectApplicableManagerCorrections(
      [preparedRow(accepted)],
      context(evidence)
    );

    expect(evidence).toEqual(before);
    expect(evidence[1]).toMatchObject({
      kind: "worker",
      metadata: { truthClass: "worker_report" },
    });
    expect(selected.corrections).toHaveLength(1);
    expect(selected.corrections[0]).toMatchObject({
      evidence: [{ id: accepted.id }],
      doesNotResolveConflicts: true,
    });
    expect(() =>
      prepareManagerCorrection({
        knowledge: knowledge(vaClaim.id),
        correction: "Treat the VA response as confirmed fact.",
        snapshot: snapshot(evidence),
        now,
      })
    ).toThrow(/evidence|source/i);
  });

  it("withholds pinned guidance when an accepted revision supersedes it without changing the effective date", () => {
    const accepted = sourceRecord();
    const superseding: ManagerEvidence = {
      ...structuredClone(accepted),
      id: "source:invoice-a:revision-2",
      text: "Invoice A is paid.",
      metadata: {
        ...accepted.metadata,
        authority: "authoritative",
        sourceDate: "2026-09-02T09:00:00Z",
        sourceRevision: "revision-2",
        supersedesEvidenceIds: [accepted.id],
      },
    };

    expect(
      selectApplicableManagerCorrections(
        [preparedRow(accepted)],
        context([accepted, superseding])
      ).corrections
    ).toEqual([]);
  });
});
