import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  aptlssPlans,
  aptlssEvidenceConflicts,
  aptlssEvidenceRevisions,
  aptlssEvidenceSubjectLinks,
  aptlssVerificationFollowups,
  workspaceEvidenceItems,
  workspaceEvidenceLinks,
} from "../drizzle/schema";
import { normalizeEvidenceDraft, resolveEvidenceConflict, type EvidenceDraft, type EvidenceTruth } from "./aptlssEvidenceGraph";
import { getDb } from "./db";

export class AptlssEvidenceGraphError extends Error {}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function recordAptlssEvidence({
  vaId,
  cardId,
  draft,
  truthClass,
  recordedBy,
  matchReason,
  linkMethod = "automatic",
}: {
  vaId: number;
  cardId?: string | null;
  draft: EvidenceDraft;
  truthClass: EvidenceTruth;
  recordedBy?: string | null;
  matchReason?: string;
  linkMethod?: "automatic" | "manual" | "confirmed";
}) {
  const db = await getDb();
  if (!db) throw new AptlssEvidenceGraphError("Database unavailable");
  const evidence = normalizeEvidenceDraft(draft);

  return db.transaction(async (tx) => {
    const existing = await tx.select({ id: workspaceEvidenceItems.id })
      .from(workspaceEvidenceItems)
      .where(and(
        eq(workspaceEvidenceItems.source, evidence.source),
        eq(workspaceEvidenceItems.sourceId, evidence.sourceId),
      ))
      .limit(1);

    let evidenceId = existing[0]?.id;
    if (!evidenceId) {
      const [created] = await tx.insert(workspaceEvidenceItems).values({
        source: evidence.source,
        sourceId: evidence.sourceId,
        sourceContainerId: evidence.sourceContainerId,
        kind: evidence.kind,
        title: evidence.title,
        summary: evidence.summary,
        content: evidence.content,
        sourceUrl: evidence.sourceUrl,
        modifiedAt: evidence.modifiedAt ? new Date(evidence.modifiedAt) : null,
        observedAt: new Date(evidence.observedAt),
        contentHash: evidence.contentHash,
        metadataJson: evidence.metadataJson,
        reviewStatus: cardId ? "linked" : "unreviewed",
        reviewedAt: cardId ? new Date() : null,
        reviewedBy: cardId ? recordedBy ?? null : null,
        active: true,
      }).$returningId();
      evidenceId = created?.id;
    }
    if (!evidenceId) throw new AptlssEvidenceGraphError("Evidence could not be stored");

    const knownRevision = await tx.select({ id: aptlssEvidenceRevisions.id })
      .from(aptlssEvidenceRevisions)
      .where(and(
        eq(aptlssEvidenceRevisions.evidenceId, evidenceId),
        eq(aptlssEvidenceRevisions.contentHash, evidence.contentHash),
      ))
      .limit(1);
    if (!knownRevision[0]) {
      await tx.insert(aptlssEvidenceRevisions).values({
        evidenceId,
        contentHash: evidence.contentHash,
        truthClass,
        summary: evidence.summary,
        content: evidence.content,
        metadataJson: evidence.metadataJson,
        observedAt: new Date(evidence.observedAt),
        recordedBy: recordedBy ?? null,
      });
    }

    if (cardId) {
      const ownedCard = await tx.select({ cardId: aptlssPlans.cardId })
        .from(aptlssPlans)
        .where(and(eq(aptlssPlans.vaId, vaId), eq(aptlssPlans.cardId, cardId)))
        .limit(1);
      if (!ownedCard[0]) {
        throw new AptlssEvidenceGraphError("Evidence can only be linked to a card in this worker scope");
      }
      const existingSubject = await tx.select({ id: aptlssEvidenceSubjectLinks.id })
        .from(aptlssEvidenceSubjectLinks)
        .where(and(
          eq(aptlssEvidenceSubjectLinks.evidenceId, evidenceId),
          eq(aptlssEvidenceSubjectLinks.vaId, vaId),
          eq(aptlssEvidenceSubjectLinks.subjectType, "card"),
          eq(aptlssEvidenceSubjectLinks.subjectId, cardId),
        ))
        .limit(1);
      if (!existingSubject[0]) {
        await tx.insert(aptlssEvidenceSubjectLinks).values({
          evidenceId,
          vaId,
          subjectType: "card",
          subjectId: cardId,
          relevanceScore: 100,
          linkMethod,
          matchReason: (matchReason ?? "Explicit card link").slice(0, 512),
        });
      }
      const legacyLink = await tx.select({ id: workspaceEvidenceLinks.id })
        .from(workspaceEvidenceLinks)
        .where(and(eq(workspaceEvidenceLinks.evidenceId, evidenceId), eq(workspaceEvidenceLinks.cardId, cardId)))
        .limit(1);
      if (!legacyLink[0]) {
        await tx.insert(workspaceEvidenceLinks).values({
          evidenceId,
          cardId,
          relevanceScore: 100,
          matchReason: (matchReason ?? "Explicit card link").slice(0, 512),
          linkMethod: linkMethod === "confirmed" ? "manual" : linkMethod,
        });
      }
    }

    return { evidenceId, created: !existing[0], cardId: cardId ?? null };
  });
}

export async function recordWorkerEvidenceAssertion({
  vaId,
  cardId,
  title,
  detail,
  recordedBy,
  observedAt = new Date(),
}: {
  vaId: number;
  cardId?: string | null;
  title: string;
  detail: string;
  recordedBy: string;
  observedAt?: Date;
}) {
  const normalizedTitle = title.trim();
  const normalizedDetail = detail.trim();
  if (!normalizedTitle || !normalizedDetail) {
    throw new AptlssEvidenceGraphError("An assertion needs both a title and detail");
  }
  const contentHash = sha256(`${normalizedTitle}\n${normalizedDetail}`);
  return recordAptlssEvidence({
    vaId,
    cardId,
    draft: {
      source: "communication",
      sourceId: `worker-assertion:${vaId}:${contentHash}`,
      kind: "worker_assertion",
      title: normalizedTitle,
      summary: normalizedDetail,
      content: normalizedDetail,
      observedAt: observedAt.toISOString(),
      contentHash,
      metadataJson: JSON.stringify({ origin: "worker_operator", actor: recordedBy }),
    },
    truthClass: "worker_assertion",
    recordedBy,
    matchReason: "Worker assertion explicitly linked to this card",
    linkMethod: "confirmed",
  });
}

export async function createEvidenceConflict({
  vaId,
  sourceEvidenceId,
  assertedEvidenceId,
  cardId,
  question,
  createdBy,
}: {
  vaId: number;
  sourceEvidenceId: number;
  assertedEvidenceId: number;
  cardId?: string | null;
  question: string;
  createdBy: string;
}) {
  const db = await getDb();
  if (!db) throw new AptlssEvidenceGraphError("Database unavailable");
  const conflict = resolveEvidenceConflict({
    sourceTruth: "source_record",
    sourceObservedAt: new Date().toISOString(),
    assertedTruth: "worker_assertion",
    assertedAt: new Date().toISOString(),
    contradictsSource: true,
  });

  return db.transaction(async (tx) => {
    const scopedEvidence = await tx.select({ evidenceId: aptlssEvidenceSubjectLinks.evidenceId })
      .from(aptlssEvidenceSubjectLinks)
      .where(and(
        eq(aptlssEvidenceSubjectLinks.vaId, vaId),
        inArray(aptlssEvidenceSubjectLinks.evidenceId, [sourceEvidenceId, assertedEvidenceId]),
      ));
    if (new Set(scopedEvidence.map((item) => item.evidenceId)).size !== 2) {
      throw new AptlssEvidenceGraphError("Evidence conflict is outside this worker scope");
    }
    const truthClasses = await tx.select({
      evidenceId: aptlssEvidenceRevisions.evidenceId,
      truthClass: aptlssEvidenceRevisions.truthClass,
    }).from(aptlssEvidenceRevisions)
      .where(inArray(aptlssEvidenceRevisions.evidenceId, [sourceEvidenceId, assertedEvidenceId]));
    const sourceIsRecord = truthClasses.some((item) => item.evidenceId === sourceEvidenceId && item.truthClass === "source_record");
    const assertedIsWorker = truthClasses.some((item) => item.evidenceId === assertedEvidenceId && item.truthClass === "worker_assertion");
    if (!sourceIsRecord || !assertedIsWorker) {
      throw new AptlssEvidenceGraphError("The conflict must compare a source record with a worker assertion");
    }
    if (cardId) {
      const ownedCard = await tx.select({ cardId: aptlssPlans.cardId })
        .from(aptlssPlans)
        .where(and(eq(aptlssPlans.vaId, vaId), eq(aptlssPlans.cardId, cardId)))
        .limit(1);
      if (!ownedCard[0]) {
        throw new AptlssEvidenceGraphError("Evidence conflict is outside this worker scope");
      }
    }
    const existing = await tx.select({ id: aptlssEvidenceConflicts.id })
      .from(aptlssEvidenceConflicts)
      .where(and(
        eq(aptlssEvidenceConflicts.sourceEvidenceId, sourceEvidenceId),
        eq(aptlssEvidenceConflicts.assertedEvidenceId, assertedEvidenceId),
      ))
      .limit(1);
    const conflictId = existing[0]?.id ?? (await tx.insert(aptlssEvidenceConflicts).values({
      vaId,
      sourceEvidenceId,
      assertedEvidenceId,
      status: conflict.status,
    }).$returningId())[0]?.id;
    if (!conflictId) throw new AptlssEvidenceGraphError("Conflict could not be stored");

    const existingFollowup = await tx.select({ id: aptlssVerificationFollowups.id })
      .from(aptlssVerificationFollowups)
      .where(and(
        eq(aptlssVerificationFollowups.conflictId, conflictId),
        eq(aptlssVerificationFollowups.status, "open"),
      ))
      .limit(1);
    if (!existingFollowup[0]) {
      await tx.insert(aptlssVerificationFollowups).values({
        vaId,
        cardId: cardId ?? null,
        conflictId,
        title: "Verify conflicting work evidence",
        question: question.trim(),
        status: "open",
        dueAt: new Date(),
      });
    }
    return { conflictId, status: conflict.status, createdBy };
  });
}

export async function getOpenVerificationFollowups(vaId: number, cardId?: string) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(aptlssVerificationFollowups.vaId, vaId), eq(aptlssVerificationFollowups.status, "open")];
  if (cardId) conditions.push(eq(aptlssVerificationFollowups.cardId, cardId));
  return db.select().from(aptlssVerificationFollowups)
    .where(and(...conditions))
    .orderBy(aptlssVerificationFollowups.dueAt, desc(aptlssVerificationFollowups.createdAt));
}

export async function getCardEvidence(vaId: number, cardId: string, limit = 30) {
  const db = await getDb();
  if (!db) return [];
  return db.select({
    id: workspaceEvidenceItems.id,
    source: workspaceEvidenceItems.source,
    kind: workspaceEvidenceItems.kind,
    title: workspaceEvidenceItems.title,
    summary: workspaceEvidenceItems.summary,
    content: workspaceEvidenceItems.content,
    sourceUrl: workspaceEvidenceItems.sourceUrl,
    observedAt: workspaceEvidenceItems.observedAt,
    modifiedAt: workspaceEvidenceItems.modifiedAt,
    contentHash: workspaceEvidenceItems.contentHash,
    metadataJson: workspaceEvidenceItems.metadataJson,
    relevanceScore: aptlssEvidenceSubjectLinks.relevanceScore,
    linkMethod: aptlssEvidenceSubjectLinks.linkMethod,
    matchReason: aptlssEvidenceSubjectLinks.matchReason,
  }).from(aptlssEvidenceSubjectLinks)
    .innerJoin(workspaceEvidenceItems, eq(workspaceEvidenceItems.id, aptlssEvidenceSubjectLinks.evidenceId))
    .where(and(
      eq(aptlssEvidenceSubjectLinks.vaId, vaId),
      eq(aptlssEvidenceSubjectLinks.subjectType, "card"),
      eq(aptlssEvidenceSubjectLinks.subjectId, cardId),
      eq(workspaceEvidenceItems.active, true),
    ))
    .orderBy(desc(workspaceEvidenceItems.observedAt), desc(workspaceEvidenceItems.id))
    .limit(Math.max(1, Math.min(100, limit)));
}

export async function resolveVerificationFollowup({
  vaId,
  followupId,
  resolution,
  resolvedBy,
}: {
  vaId: number;
  followupId: number;
  resolution: string;
  resolvedBy: string;
}) {
  const db = await getDb();
  if (!db) throw new AptlssEvidenceGraphError("Database unavailable");
  const detail = resolution.trim();
  if (!detail) throw new AptlssEvidenceGraphError("A verification resolution is required");
  const resolvedAt = new Date();
  const update = await db.update(aptlssVerificationFollowups).set({
    status: "resolved",
    resolution: detail,
    resolvedBy,
    resolvedAt,
  }).where(and(
    eq(aptlssVerificationFollowups.id, followupId),
    eq(aptlssVerificationFollowups.vaId, vaId),
    eq(aptlssVerificationFollowups.status, "open"),
  ));
  if (update[0].affectedRows !== 1) throw new AptlssEvidenceGraphError("Verification follow-up is no longer open");
  return { followupId, resolvedAt };
}
