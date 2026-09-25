import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  aptlssPlans,
  aptlssEvidenceConflicts,
  aptlssManagerUpdates,
  aptlssEvidenceRevisions,
  aptlssEvidenceSubjectLinks,
  aptlssVerificationFollowups,
  decisionOutcomes,
  emailTasks,
  workspaceEvidenceItems,
  workspaceEvidenceLinks,
} from "../drizzle/schema";
import { normalizeEvidenceDraft, resolveEvidenceConflict, type EvidenceDraft, type EvidenceTruth } from "./aptlssEvidenceGraph";
import { getDb } from "./db";
import { assertManagerPilotWorker } from "./aptlssManagerPilot";
import { enqueueManagerTask } from "./aptlssManagerQueue";
import { extractManagerFacts } from "./aptlssManagerFacts";
import { validManagerDate, type ManagerEvidenceMetadata, type ManagerFact } from "../shared/aptlssManagerEvidence";
import { projectWorkerCaseEvidence } from "./workerCaseEvidence";
import { gmailContentScope } from "../shared/gmailContentScope";

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
  database,
}: {
  vaId: number;
  cardId?: string | null;
  draft: EvidenceDraft;
  truthClass: EvidenceTruth;
  recordedBy?: string | null;
  matchReason?: string;
  linkMethod?: "automatic" | "manual" | "confirmed";
  database?: NonNullable<Awaited<ReturnType<typeof getDb>>>;
}) {
  assertManagerPilotWorker(vaId);
  const db = database ?? await getDb();
  if (!db) throw new AptlssEvidenceGraphError("Database unavailable");
  const evidence = normalizeEvidenceDraft(draft);

  return db.transaction(async (tx) => {
    const existing = await tx.select({ id: workspaceEvidenceItems.id })
      .from(workspaceEvidenceItems)
      .where(and(
        eq(workspaceEvidenceItems.vaId, vaId),
        eq(workspaceEvidenceItems.source, evidence.source),
        eq(workspaceEvidenceItems.sourceId, evidence.sourceId),
      ))
      .limit(1);

    let evidenceId = existing[0]?.id;
    if (!evidenceId) {
      const [created] = await tx.insert(workspaceEvidenceItems).values({
        vaId,
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

    await enqueueManagerTask(tx, { vaId, trigger: "source_ingested",
      eventKey: JSON.stringify(["evidence", evidenceId, evidence.contentHash, cardId ?? null, truthClass]) });
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
  database,
}: {
  vaId: number;
  cardId?: string | null;
  title: string;
  detail: string;
  recordedBy: string;
  observedAt?: Date;
  database?: NonNullable<Awaited<ReturnType<typeof getDb>>>;
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
    database,
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
  assertManagerPilotWorker(vaId);
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
    const scopedEvidence = await tx.select({
      evidenceId: aptlssEvidenceSubjectLinks.evidenceId,
      cardId: aptlssEvidenceSubjectLinks.subjectId,
    })
      .from(aptlssEvidenceSubjectLinks)
      .innerJoin(workspaceEvidenceItems, eq(workspaceEvidenceItems.id, aptlssEvidenceSubjectLinks.evidenceId))
      .where(and(
        eq(workspaceEvidenceItems.vaId, vaId),
        eq(aptlssEvidenceSubjectLinks.vaId, vaId),
        eq(aptlssEvidenceSubjectLinks.subjectType, "card"),
        inArray(aptlssEvidenceSubjectLinks.evidenceId, [sourceEvidenceId, assertedEvidenceId]),
      ));
    if (new Set(scopedEvidence.map((item) => item.evidenceId)).size !== 2) {
      throw new AptlssEvidenceGraphError("Evidence conflict is outside this worker scope");
    }
    const sourceCards = new Set(scopedEvidence.filter(item => item.evidenceId === sourceEvidenceId).map(item => item.cardId));
    const sharedCards = new Set(scopedEvidence.filter(item => item.evidenceId === assertedEvidenceId && sourceCards.has(item.cardId)).map(item => item.cardId));
    const conflictCardId = cardId ?? (sharedCards.size === 1 ? [...sharedCards][0] : null);
    if (!conflictCardId || !sharedCards.has(conflictCardId)) {
      throw new AptlssEvidenceGraphError("Conflict evidence must be linked to the same worker task");
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
    const ownedCard = await tx.select({ cardId: aptlssPlans.cardId })
      .from(aptlssPlans)
      .where(and(eq(aptlssPlans.vaId, vaId), eq(aptlssPlans.cardId, conflictCardId)))
      .limit(1);
    if (!ownedCard[0]) {
      throw new AptlssEvidenceGraphError("Evidence conflict is outside this worker scope");
    }
    // The unique source/assertion pair is the replay key. The upsert makes
    // concurrent retries converge on one row; locking it also serializes the
    // follow-up check below. Keep the existing resolution status unchanged.
    await tx.insert(aptlssEvidenceConflicts).values({
      vaId,
      sourceEvidenceId,
      assertedEvidenceId,
      status: conflict.status,
    }).onDuplicateKeyUpdate({
      set: { status: sql`${aptlssEvidenceConflicts.status}` },
    });
    const [storedConflict] = await tx.select({
      id: aptlssEvidenceConflicts.id,
      vaId: aptlssEvidenceConflicts.vaId,
      status: aptlssEvidenceConflicts.status,
    })
      .from(aptlssEvidenceConflicts)
      .where(and(
        eq(aptlssEvidenceConflicts.sourceEvidenceId, sourceEvidenceId),
        eq(aptlssEvidenceConflicts.assertedEvidenceId, assertedEvidenceId),
      ))
      .limit(1)
      .for("update");
    if (!storedConflict || storedConflict.vaId !== vaId) {
      throw new AptlssEvidenceGraphError("Evidence conflict is outside this worker scope");
    }

    const followups = await tx.select({
      id: aptlssVerificationFollowups.id,
      vaId: aptlssVerificationFollowups.vaId,
      cardId: aptlssVerificationFollowups.cardId,
      status: aptlssVerificationFollowups.status,
    })
      .from(aptlssVerificationFollowups)
      .where(eq(aptlssVerificationFollowups.conflictId, storedConflict.id))
      .orderBy(desc(aptlssVerificationFollowups.createdAt), desc(aptlssVerificationFollowups.id))
      .for("update");
    const openFollowup = followups.find(item => item.status === "open");
    const latestFollowup = openFollowup ?? followups[0];
    if (latestFollowup && (
      latestFollowup.vaId !== vaId || latestFollowup.cardId !== conflictCardId
    )) {
      throw new AptlssEvidenceGraphError("This evidence conflict is already linked to another worker task");
    }
    if (storedConflict.status === "needs_verification" && !openFollowup) {
      await tx.insert(aptlssVerificationFollowups).values({
        vaId,
        cardId: conflictCardId,
        conflictId: storedConflict.id,
        title: "Verify conflicting work evidence",
        question: question.trim(),
        status: "open",
        dueAt: new Date(),
      });
    }
    if (storedConflict.status === "needs_verification") {
      await enqueueManagerTask(tx, { vaId, trigger: "conflict", urgent: true, eventKey: `conflict:${storedConflict.id}` });
    }
    return { conflictId: storedConflict.id, status: storedConflict.status, createdBy };
  });
}

export async function getOpenVerificationFollowups(vaId: number, cardId?: string) {
  assertManagerPilotWorker(vaId);
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(aptlssVerificationFollowups.vaId, vaId), eq(aptlssVerificationFollowups.status, "open")];
  if (cardId) conditions.push(eq(aptlssVerificationFollowups.cardId, cardId));
  return db.select().from(aptlssVerificationFollowups)
    .where(and(...conditions))
    .orderBy(aptlssVerificationFollowups.dueAt, desc(aptlssVerificationFollowups.createdAt));
}

export async function getCardEvidence(vaId: number, cardId: string, limit = 30) {
  assertManagerPilotWorker(vaId);
  const db = await getDb();
  if (!db) return [];
  const recordLimit = Math.max(1, Math.min(100, limit));
  const evidenceSelection = {
    id: workspaceEvidenceItems.id,
    source: workspaceEvidenceItems.source,
    kind: workspaceEvidenceItems.kind,
    title: workspaceEvidenceItems.title,
    summary: workspaceEvidenceItems.summary,
    content: workspaceEvidenceItems.content,
    sourceUrl: workspaceEvidenceItems.sourceUrl,
    metadataJson: workspaceEvidenceItems.metadataJson,
    observedAt: workspaceEvidenceItems.observedAt,
    modifiedAt: workspaceEvidenceItems.modifiedAt,
  };
  const [graphRows, legacyRows] = await Promise.all([
    db.select(evidenceSelection).from(aptlssEvidenceSubjectLinks)
      .innerJoin(workspaceEvidenceItems, eq(workspaceEvidenceItems.id, aptlssEvidenceSubjectLinks.evidenceId))
      .where(and(
        eq(workspaceEvidenceItems.vaId, vaId), eq(aptlssEvidenceSubjectLinks.vaId, vaId),
        eq(aptlssEvidenceSubjectLinks.subjectType, "card"), eq(aptlssEvidenceSubjectLinks.subjectId, cardId),
        eq(workspaceEvidenceItems.active, true),
      ))
      .orderBy(desc(workspaceEvidenceItems.observedAt), desc(workspaceEvidenceItems.id)).limit(recordLimit),
    db.select(evidenceSelection).from(workspaceEvidenceLinks)
      .innerJoin(workspaceEvidenceItems, eq(workspaceEvidenceItems.id, workspaceEvidenceLinks.evidenceId))
      .where(and(
        eq(workspaceEvidenceItems.vaId, vaId), eq(workspaceEvidenceLinks.cardId, cardId),
        eq(workspaceEvidenceItems.active, true),
      ))
      .orderBy(desc(workspaceEvidenceItems.observedAt), desc(workspaceEvidenceItems.id)).limit(recordLimit),
  ]);
  const graphEvidenceIds = new Set(graphRows.map(row => row.id));
  const rowsById = new Map(legacyRows.map(row => [row.id, row]));
  for (const row of graphRows) rowsById.set(row.id, row);
  const rows = [...rowsById.values()]
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime() || b.id - a.id)
    .slice(0, recordLimit);

  const revisions = rows.length ? await db.select({
    id: aptlssEvidenceRevisions.id,
    evidenceId: aptlssEvidenceRevisions.evidenceId,
    truthClass: aptlssEvidenceRevisions.truthClass,
    metadataJson: aptlssEvidenceRevisions.metadataJson,
    observedAt: aptlssEvidenceRevisions.observedAt,
  }).from(aptlssEvidenceRevisions)
    .where(inArray(aptlssEvidenceRevisions.evidenceId, rows.map(row => row.id)))
    .orderBy(desc(aptlssEvidenceRevisions.observedAt), desc(aptlssEvidenceRevisions.id)) : [];
  const latestRevision = new Map<number, typeof revisions[number]>();
  for (const revision of revisions) {
    if (!latestRevision.has(revision.evidenceId)) latestRevision.set(revision.evidenceId, revision);
  }

  const graphEvidence = rows.flatMap(row => {
    const revision = latestRevision.get(row.id);
    const projected = projectWorkerCaseEvidence({ ...row,
      proofEvidenceId: graphEvidenceIds.has(row.id) ? row.id : null,
      metadataJson: revision?.metadataJson ?? row.metadataJson,
      truthClass: revision?.truthClass ?? null,
      roleOverride: !graphEvidenceIds.has(row.id) && row.kind !== "worker_assertion"
        && row.kind !== "system_inference" && row.kind !== "model_proposal"
        && row.kind !== "verified_conflict_resolution" && revision?.truthClass !== "worker_assertion"
        ? "linked_source" : undefined,
    });
    return projected ? [projected] : [];
  });

  const emailCard = /^email:(\d+)$/.exec(cardId);
  const emailId = emailCard ? Number(emailCard[1]) : null;
  const [mailRows, updates, decisions] = await Promise.all([
    db.select({
      id: emailTasks.id,
      gmailThreadId: emailTasks.gmailThreadId,
      subject: emailTasks.subject,
      fromAddress: emailTasks.fromAddress,
      snippet: emailTasks.snippet,
      receivedAt: emailTasks.receivedAt,
      status: emailTasks.status,
    }).from(emailTasks).where(and(
      eq(emailTasks.vaId, vaId),
      emailId !== null && Number.isSafeInteger(emailId) && emailId > 0
        ? eq(emailTasks.id, emailId)
        : eq(emailTasks.trelloCardId, cardId),
    )).orderBy(desc(emailTasks.receivedAt), desc(emailTasks.id)).limit(recordLimit),
    db.select({
      id: aptlssManagerUpdates.id,
      detail: aptlssManagerUpdates.detail,
      outcome: aptlssManagerUpdates.outcome,
      deadlineDate: aptlssManagerUpdates.deadlineDate,
      sourceDescription: aptlssManagerUpdates.sourceDescription,
      createdAt: aptlssManagerUpdates.createdAt,
    }).from(aptlssManagerUpdates).where(and(
      eq(aptlssManagerUpdates.vaId, vaId), eq(aptlssManagerUpdates.cardId, cardId),
    )).orderBy(desc(aptlssManagerUpdates.createdAt), desc(aptlssManagerUpdates.id)).limit(recordLimit),
    db.select({
      id: decisionOutcomes.id,
      disposition: decisionOutcomes.disposition,
      outcome: decisionOutcomes.outcome,
      resolvedAt: decisionOutcomes.resolvedAt,
    }).from(decisionOutcomes).where(and(
      eq(decisionOutcomes.vaId, vaId), eq(decisionOutcomes.cardId, cardId),
    )).orderBy(desc(decisionOutcomes.resolvedAt), desc(decisionOutcomes.id)).limit(recordLimit),
  ]);

  const graphWorkerUpdates = graphEvidence.filter(item => item.role === "worker_update");
  const graphEmailUrls = new Set(graphEvidence.filter(item => item.source === "gmail" && item.sourceUrl).map(item => item.sourceUrl));
  const emailEvidence = mailRows.flatMap(mail => {
    const sourceUrl = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(mail.gmailThreadId)}`;
    if (graphEmailUrls.has(sourceUrl)) return [];
    const scope = gmailContentScope(mail.subject, mail.snippet ?? "");
    return [projectWorkerCaseEvidence({
      id: mail.id,
      recordKey: `email:${mail.id}`,
      proofEvidenceId: null,
      source: "gmail",
      kind: "email_preview",
      title: mail.subject,
      content: [mail.fromAddress ? `From: ${mail.fromAddress}` : null, mail.snippet?.trim() || null].filter(Boolean).join("\n\n") || null,
      summary: null,
      sourceUrl,
      observedAt: mail.receivedAt,
      modifiedAt: null,
      roleOverride: "source_preview",
      contentNote: scope === "portal_notice"
        ? "Portal notice only; open the email to read the underlying correspondence."
        : "Email preview only; open the original for the full message.",
      statusLabel: mail.status === "pending" ? "Pending review" : mail.status === "processed" ? "Processed" : "Archived",
    })!];
  });
  const updateEvidence = updates.flatMap(update => {
    if (graphWorkerUpdates.some(item => item.content?.includes(update.detail))) return [];
    const content = [
      update.detail,
      update.outcome && update.outcome !== "Update" ? `Reported result: ${update.outcome}` : null,
      update.deadlineDate ? `Deadline stated: ${update.deadlineDate}` : null,
      update.sourceDescription ? `Source checked: ${update.sourceDescription}` : null,
    ].filter((part): part is string => !!part).join("\n\n");
    return [projectWorkerCaseEvidence({
      id: update.id,
      recordKey: `update:${update.id}`,
      proofEvidenceId: null,
      source: "worker_update",
      kind: "worker_update",
      title: "Worker update",
      content,
      summary: null,
      sourceUrl: null,
      observedAt: update.createdAt,
      modifiedAt: null,
      roleOverride: "worker_update",
      statusLabel: update.outcome && update.outcome !== "Update" ? update.outcome : null,
    })!];
  });
  const decisionEvidence = decisions.map(decision => projectWorkerCaseEvidence({
    id: decision.id,
    recordKey: `decision:${decision.id}`,
    proofEvidenceId: null,
    source: "decision_outcome",
    kind: "human_decision",
    title: "Decision outcome",
    content: decision.outcome,
    summary: null,
    sourceUrl: null,
    observedAt: decision.resolvedAt,
    modifiedAt: null,
    roleOverride: "reviewed_resolution",
    statusLabel: decision.disposition === "approved" ? "Approved" : decision.disposition === "rejected" ? "Not approved" : "Recorded",
  })!);

  return [...graphEvidence, ...emailEvidence, ...updateEvidence, ...decisionEvidence]
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
    .slice(0, recordLimit);
}

type ConflictRevision = Pick<typeof aptlssEvidenceRevisions.$inferSelect,
  "id" | "evidenceId" | "truthClass" | "contentHash" | "content" | "summary" | "metadataJson" | "observedAt" | "createdAt">;

export type ConflictResolutionEvidence = Pick<typeof workspaceEvidenceItems.$inferSelect,
  "source" | "sourceId" | "sourceUrl" | "kind" | "active" | "modifiedAt"> & {
  evidenceId: number;
  links: Array<{ vaId: number; cardId: string }>;
  revisions: ConflictRevision[];
};

function revisionMetadata(revision: ConflictRevision): ManagerEvidenceMetadata {
  if (!revision.metadataJson) return {};
  try {
    const metadata: unknown = JSON.parse(revision.metadataJson);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error();
    return metadata as ManagerEvidenceMetadata;
  } catch {
    throw new AptlssEvidenceGraphError("Source revision metadata must be verified");
  }
}

function revisionFacts(record: ConflictResolutionEvidence, revision: ConflictRevision, cardId: string, text?: string) {
  return extractManagerFacts({ id: `evidence:${record.evidenceId}:${cardId}`, cardId,
    source: record.source, kind: revision.truthClass === "worker_assertion" ? "worker" : "source",
    text: text ?? revision.content ?? revision.summary ?? "", observedAt: revision.observedAt.toISOString(),
    metadata: { ...revisionMetadata(revision), truthClass: revision.truthClass === "worker_assertion" ? "worker_report"
      : revision.truthClass === "source_record" ? "source_record" : "model_proposal" } });
}

const factKey = (fact: ManagerFact) => JSON.stringify([fact.subject, fact.topic]);
const explicitFact = (fact: ManagerFact) => fact.support === "explicit" && !["unknown", "context"].includes(fact.topic);

/** Validate retained records, not caller-supplied claims of authority or fact values. */
export function validateConflictResolutionProof(args: {
  vaId: number; cardId: string; sourceEvidenceId: number; sourceQuote: string; now: Date;
  conflict: Pick<typeof aptlssEvidenceConflicts.$inferSelect, "id" | "vaId" | "sourceEvidenceId" | "assertedEvidenceId" | "createdAt">;
  evidence: ConflictResolutionEvidence[];
}) {
  const { vaId, cardId, conflict, sourceEvidenceId, sourceQuote, now, evidence } = args;
  const fail = (reason: string): never => { throw new AptlssEvidenceGraphError(reason); };
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp) || conflict.vaId !== vaId || !cardId || !Number.isSafeInteger(sourceEvidenceId) || sourceEvidenceId <= 0) {
    fail("Conflict resolution is outside this worker/card scope");
  }
  if (!sourceQuote.trim() || sourceQuote.length > 8000) fail("An exact source quote of at most 8000 characters is required");
  const scoped = (id: number) => {
    const records = evidence.filter(e => e.evidenceId === id);
    if (records.length !== 1 || !records[0].links.some(l => l.vaId === vaId && l.cardId === cardId)) {
      fail("Conflict evidence must be linked to the same worker and card");
    }
    return records[0];
  };
  const sortedRevisions = (record: ConflictResolutionEvidence) => {
    if (record.revisions.some(r => r.evidenceId !== record.evidenceId ||
      !Number.isFinite(r.observedAt.getTime()) || !Number.isFinite(r.createdAt.getTime()) ||
      r.observedAt.getTime() > timestamp || r.createdAt.getTime() > timestamp || !r.contentHash.trim())) {
      fail("Invalid, future, or mismatched source revision provenance");
    }
    return [...record.revisions].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime() || b.id - a.id);
  };
  const original = scoped(conflict.sourceEvidenceId), assertion = scoped(conflict.assertedEvidenceId), selected = scoped(sourceEvidenceId);
  if (!selected.active || !selected.sourceId.trim() || !selected.source ||
      /worker_assertion|system_inference|verified_conflict_resolution/.test(selected.kind) ||
      /^(?:worker-assertion|verified-conflict-resolution):/.test(selected.sourceId)) fail("Proof must be an active retained external source record");
  const revision = sortedRevisions(selected)[0];
  if (!revision || revision.truthClass !== "source_record") fail("The current proof revision must be a source_record");
  const atConflict = (record: ConflictResolutionEvidence, truth: ConflictRevision["truthClass"]) => {
    const found = sortedRevisions(record).find(r => r.observedAt <= conflict.createdAt && r.createdAt <= conflict.createdAt);
    if (!found || found.truthClass !== truth) return fail("Original conflicting source/assertion revisions could not be verified");
    return found;
  };
  const originalRevision = atConflict(original, "source_record"), assertedRevision = atConflict(assertion, "worker_assertion");
  const sourceFacts = revisionFacts(original, originalRevision, cardId).filter(explicitFact);
  const assertedFacts = revisionFacts(assertion, assertedRevision, cardId).filter(explicitFact);
  const disputed = new Map(sourceFacts.filter(f => assertedFacts.some(a => factKey(a) === factKey(f) && a.value !== f.value)).map(f => [factKey(f), f]));
  if (!disputed.size) fail("The original conflicting subject and topic need explicit source facts");

  const fullText = revision.content ?? revision.summary ?? "";
  if (!fullText.includes(sourceQuote)) fail("The source quote must match the current retained revision exactly");
  const fullFacts = revisionFacts(selected, revision, cardId);
  const quotedFacts = revisionFacts(selected, revision, cardId, sourceQuote);
  if (!quotedFacts.length || quotedFacts.some(f => !explicitFact(f) || !disputed.has(factKey(f)) ||
    !fullFacts.some(originalFact => explicitFact(originalFact) && originalFact.quote === f.quote && factKey(originalFact) === factKey(f) && originalFact.value === f.value))) {
    fail("Quote complete, explicit source statements about the original conflicting subject/topic");
  }
  for (const key of disputed.keys()) {
    const values = new Set(quotedFacts.filter(f => factKey(f) === key).map(f => f.value));
    if (values.size !== 1) fail("Proof must resolve every conflicting topic without contradictory values");
  }

  const metadata = revisionMetadata(revision);
  const validateDates = (facts: ManagerFact[], meta: ManagerEvidenceMetadata) => {
    for (const date of [meta.sourceDate, meta.effectiveFrom, meta.effectiveTo]) {
      if (date !== undefined && date !== null && (typeof date !== "string" || !validManagerDate(date))) fail("Invalid source/effective date in proof");
    }
    if ((meta.sourceDate && Date.parse(meta.sourceDate) > timestamp) ||
      facts.some(f => f.effectiveFrom && (!validManagerDate(f.effectiveFrom) || Date.parse(f.effectiveFrom) > timestamp)) ||
      (meta.effectiveTo && Date.parse(meta.effectiveTo) <= timestamp)) fail("Source proof is future-effective or expired");
  };
  validateDates(quotedFacts, metadata);
  const sourceDate = metadata.sourceDate ?? selected.modifiedAt?.toISOString() ?? revision.observedAt.toISOString();
  if (!validManagerDate(sourceDate) || Date.parse(sourceDate) > timestamp) fail("The source date must be verified");
  const originalMetadata = revisionMetadata(originalRevision);
  const originalDate = originalMetadata.sourceDate ?? originalRevision.observedAt.toISOString();
  const sourceChanged = quotedFacts.some(f => disputed.get(factKey(f))?.value !== f.value);
  if (sourceChanged) {
    const sameRecordRevision = selected.evidenceId === original.evidenceId && revision.contentHash !== originalRevision.contentHash;
    const supersedes = Array.isArray(metadata.supersedesEvidenceIds) && metadata.supersedesEvidenceIds.includes(`evidence:${original.evidenceId}:${cardId}`);
    if ((!sameRecordRevision && !supersedes) || !validManagerDate(originalDate) ||
      Date.parse(sourceDate) <= Date.parse(originalDate) || revision.observedAt <= conflict.createdAt || revision.createdAt <= conflict.createdAt ||
      (!sameRecordRevision && (!metadata.effectiveFrom || Date.parse(metadata.effectiveFrom) > timestamp))) {
      fail("Changing the original source fact requires a newer dated source revision or explicit effective supersession");
    }
  }

  // Check every current linked source, never vote by the number of corroborating records.
  for (const record of evidence.filter(e => e.active && e.links.some(l => l.vaId === vaId && l.cardId === cardId))) {
    const current = sortedRevisions(record)[0];
    if (!current || current.truthClass !== "source_record" || record.kind === "verified_conflict_resolution") continue;
    const contrary = revisionFacts(record, current, cardId).filter(explicitFact).some(f => quotedFacts.some(q => factKey(q) === factKey(f) && q.value !== f.value));
    if (contrary && !(sourceChanged && record.evidenceId === original.evidenceId && record.evidenceId !== selected.evidenceId)) {
      fail("Current source records still disagree with the proposed proof");
    }
  }
  return { version: 1 as const, conflictId: conflict.id, cardId, sourceEvidenceId,
    sourceRevisionId: revision.id, sourceRevisionHash: revision.contentHash, sourceQuote,
    source: selected.source, sourceId: selected.sourceId, sourceUrl: selected.sourceUrl,
    sourceObservedAt: revision.observedAt.toISOString(), sourceDate, sourceMetadata: metadata,
    originalSourceEvidenceId: original.evidenceId, originalSourceRevisionId: originalRevision.id,
    originalSourceRevisionHash: originalRevision.contentHash, assertedEvidenceId: assertion.evidenceId,
    assertedRevisionId: assertedRevision.id, assertedRevisionHash: assertedRevision.contentHash,
    sourceChanged, facts: quotedFacts, validatedAt: now.toISOString() };
}

export async function resolveVerificationFollowup({
  vaId,
  followupId,
  resolution,
  resolvedBy,
  sourceEvidenceId,
  sourceQuote,
}: {
  vaId: number;
  followupId: number;
  resolution: string;
  resolvedBy: string;
  sourceEvidenceId?: number;
  sourceQuote?: string;
}) {
  assertManagerPilotWorker(vaId);
  const db = await getDb();
  if (!db) throw new AptlssEvidenceGraphError("Database unavailable");
  const detail = resolution.trim();
  if (!detail || !resolvedBy.trim()) throw new AptlssEvidenceGraphError("A verification explanation and resolver are required");
  if ((sourceEvidenceId === undefined) !== (sourceQuote === undefined)) {
    throw new AptlssEvidenceGraphError("Provide both sourceEvidenceId and the exact sourceQuote");
  }
  const resolvedAt = new Date();
  return db.transaction(async tx => {
    const [followup] = await tx.select().from(aptlssVerificationFollowups).where(and(
      eq(aptlssVerificationFollowups.id, followupId), eq(aptlssVerificationFollowups.vaId, vaId),
      eq(aptlssVerificationFollowups.status, "open"),
    )).limit(1).for("update");
    if (!followup) throw new AptlssEvidenceGraphError("Verification follow-up is no longer open");
    const explanation = [followup.resolution, `${resolvedAt.toISOString()} ${resolvedBy}: ${detail}`].filter(Boolean).join("\n\n");
    if (followup.conflictId && sourceEvidenceId === undefined) {
      await tx.update(aptlssVerificationFollowups).set({ resolution: explanation }).where(and(
        eq(aptlssVerificationFollowups.id, followupId), eq(aptlssVerificationFollowups.vaId, vaId), eq(aptlssVerificationFollowups.status, "open"),
      ));
      await enqueueManagerTask(tx, { vaId, trigger: "conflict", urgent: true, eventKey: `followup-note:${followupId}:${sha256(explanation)}` });
      return { followupId, resolvedAt: null, requiresEvidence: true as const };
    }

    let storedResolution = explanation;
    let decisionEvidenceId: number | undefined;
    if (followup.conflictId) {
      const [conflict] = await tx.select().from(aptlssEvidenceConflicts).where(and(
        eq(aptlssEvidenceConflicts.id, followup.conflictId), eq(aptlssEvidenceConflicts.vaId, vaId),
        eq(aptlssEvidenceConflicts.status, "needs_verification"),
      )).limit(1).for("update");
      if (!conflict || !followup.cardId) throw new AptlssEvidenceGraphError("An unresolved worker/card conflict is required");
      const cardId = followup.cardId;
      const [ownedCard] = await tx.select({ cardId: aptlssPlans.cardId }).from(aptlssPlans)
        .where(and(eq(aptlssPlans.vaId, vaId), eq(aptlssPlans.cardId, cardId))).limit(1).for("update");
      if (!ownedCard) throw new AptlssEvidenceGraphError("Conflict resolution is outside this worker/card scope");
      const links = await tx.select().from(aptlssEvidenceSubjectLinks).where(and(
        eq(aptlssEvidenceSubjectLinks.vaId, vaId), eq(aptlssEvidenceSubjectLinks.subjectType, "card"),
        eq(aptlssEvidenceSubjectLinks.subjectId, cardId),
      )).for("update");
      const ids = [...new Set(links.map(l => l.evidenceId))];
      if (!ids.length) throw new AptlssEvidenceGraphError("Conflict has no linked source evidence");
      const items = await tx.select().from(workspaceEvidenceItems).where(and(eq(workspaceEvidenceItems.vaId, vaId), inArray(workspaceEvidenceItems.id, ids))).for("update");
      const revisions = await tx.select().from(aptlssEvidenceRevisions).where(inArray(aptlssEvidenceRevisions.evidenceId, ids)).for("update");
      const proof = validateConflictResolutionProof({ vaId, cardId, conflict, sourceEvidenceId: sourceEvidenceId!, sourceQuote: sourceQuote!, now: resolvedAt,
        evidence: items.map(item => ({ ...item, evidenceId: item.id,
          links: links.filter(l => l.evidenceId === item.id).map(l => ({ vaId: l.vaId, cardId: l.subjectId })),
          revisions: revisions.filter(r => r.evidenceId === item.id) })) });
      const nowISO = resolvedAt.toISOString();
      const proofHash = sha256(JSON.stringify(proof));
      const decision = await recordAptlssEvidence({ vaId, cardId, recordedBy: resolvedBy,
        truthClass: "source_record", linkMethod: "confirmed", matchReason: "Verified conflict resolution backed by retained source quote",
        database: tx as unknown as NonNullable<Awaited<ReturnType<typeof getDb>>>,
        draft: { source: "communication", sourceId: `verified-conflict-resolution:${vaId}:${conflict.id}:${proofHash}`,
          kind: "verified_conflict_resolution", title: "Verified source fact for conflicting work evidence",
          content: proof.sourceQuote, summary: proof.sourceQuote, sourceUrl: proof.sourceUrl,
          observedAt: nowISO, modifiedAt: nowISO, contentHash: proofHash,
          metadataJson: JSON.stringify({ origin: "verified_conflict_resolution", truthClass: "human_decision",
            authority: "authoritative", sender: resolvedBy, sourceDate: nowISO, effectiveFrom: nowISO,
            supersedesEvidenceIds: [`evidence:${conflict.sourceEvidenceId}:${cardId}`, `evidence:${conflict.assertedEvidenceId}:${cardId}`], proof }) } });
      decisionEvidenceId = decision.evidenceId;
      storedResolution = JSON.stringify({ version: 1, explanation, proof, decisionEvidenceId });
      const [updated] = await tx.update(aptlssEvidenceConflicts).set({ status: "resolved", resolution: storedResolution, resolvedBy, resolvedAt })
        .where(and(eq(aptlssEvidenceConflicts.id, conflict.id), eq(aptlssEvidenceConflicts.vaId, vaId), eq(aptlssEvidenceConflicts.status, "needs_verification")));
      if (updated.affectedRows !== 1) throw new AptlssEvidenceGraphError("Canonical conflict changed during resolution");
    }
    const [updated] = await tx.update(aptlssVerificationFollowups).set({ status: "resolved", resolution: storedResolution, resolvedBy, resolvedAt })
      .where(and(eq(aptlssVerificationFollowups.id, followupId), eq(aptlssVerificationFollowups.vaId, vaId), eq(aptlssVerificationFollowups.status, "open")));
    if (updated.affectedRows !== 1) throw new AptlssEvidenceGraphError("Verification follow-up is no longer open");
    await enqueueManagerTask(tx, { vaId, trigger: "conflict_resolved", urgent: true, eventKey: `followup-resolved:${followupId}` });
    return { followupId, resolvedAt, requiresEvidence: false as const, ...(decisionEvidenceId ? { decisionEvidenceId } : {}) };
  });
}
