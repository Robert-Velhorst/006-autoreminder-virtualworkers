import { createHash, randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  inArray,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { z } from "zod";
import {
  aptlssManagerControl,
  aptlssManagerCorrections,
  aptlssManagerTrialEvents,
  aptlssManagerReviews,
  aptlssManagerRuns,
  aptlssManagerState,
  dailyPlans,
  timeEntries,
  users,
} from "../drizzle/schema";
import type {
  ManagerAction,
  ManagerCard,
  ManagerEvidence,
  ManagerSnapshot,
} from "../shared/aptlssManager";
import type { ManagerPlanBuffer } from "../shared/aptlssManagerPlanImpact";
import { validManagerDate, validManagerTimestamp } from "../shared/aptlssManagerEvidence";
import { gmailContentScope } from "../shared/gmailContentScope";
import { safeManagerReviewedStep } from "./aptlssManagerLearning";
import { getDb } from "./db";
import { assertManagerPilotWorker, assertManagerPlanMutationAllowed, managerPilotWorkerIds } from "./aptlssManagerPilot";
import { evaluateManagerGate } from "./aptlssManagerGate";
import {
  managerSafetyDigest,
  managerSafetyVerified,
} from "./aptlssManagerSafety";
import { resolveWorkerOperatorContextById } from "./workerOperatorContext";
import {
  dateKeyInTimeZone,
  dayOfWeekInTimeZone,
  zonedDateTimeToUtc,
} from "../shared/workerTime";
import type { OperatorDailyPlanPayload } from "./operatorDailyPlan";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export class ManagerExecutionPausedError extends Error {}

/** Caller holds the worker row lock when this guards a write. Closure is founder-owned. */
export async function assertManagerExecutionAllowed(db: Db, vaId: number, allowDisabled = false) {
  assertManagerPilotWorker(vaId);
  const [events, states] = await Promise.all([
    db.select().from(aptlssManagerTrialEvents).where(eq(aptlssManagerTrialEvents.vaId, vaId)).orderBy(desc(aptlssManagerTrialEvents.id)).limit(1),
    db.select().from(aptlssManagerState).where(eq(aptlssManagerState.vaId, vaId)).limit(1),
  ]);
  if (events[0]?.event === "closed") throw new ManagerExecutionPausedError("Manager trial is closed; a founder must restart it before assessment or re-enablement.");
  if (!allowDisabled && states[0]?.enabled === false) throw new ManagerExecutionPausedError("Manager is disabled; re-enable it before a manual or scheduled assessment.");
}
export const managerPlanVersion = (value: string | null | undefined) =>
  createHash("sha256")
    .update(value ?? "no-plan")
    .digest("hex");
const parseSnapshot = (value: string): ManagerSnapshot => JSON.parse(value);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digestValue = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

/** Poll timestamps and shifted slots are not new review samples. Changed advice or evidence is. */
export function managerReviewProposalIdentity(snapshot: ManagerSnapshot) {
  const impact = snapshot.proposal?.planningImpact;
  const bufferState = (buffer: ManagerPlanBuffer | null) =>
    buffer && {
      deficit:
        buffer.minimumKnownDeficitMinutes === null
          ? null
          : buffer.minimumKnownDeficitMinutes > 0,
      highEstimateDeficit:
        buffer.afterHighEstimatesMinutes === null
          ? null
          : buffer.afterHighEstimatesMinutes < 0,
      unknownEstimateBlockIds: [...buffer.unknownEstimateBlockIds].sort(),
    };
  return digestValue({
    version: 3,
    actions: snapshot.actions.map(({ minutes, ...action }) => ({
      ...action,
      minutes: { low: minutes.low, likely: minutes.likely, high: minutes.high },
    })),
    assessments: snapshot.assessments.map(
      ({ cardId, state, reliability, facts }) => ({
        cardId,
        state,
        reliability,
        facts: (facts ?? [])
          .map(({ observedAt: _observedAt, ...fact }) => fact)
          .sort((a, b) => canonical(a).localeCompare(canonical(b))),
      })
    ),
    evidence: snapshot.evidence
      .map(({ observedAt: _observedAt, ...e }) => e)
      .sort((a, b) => a.id.localeCompare(b.id)),
    interventions: snapshot.interventions.map(({ verification, ...item }) => ({
      ...item,
      ...(verification
        ? {
            verification: {
              ...verification,
              passages: verification.passages.map(
                ({ observedAt: _observedAt, ...passage }) => passage
              ),
            },
          }
        : {}),
    })),
    sourceGaps: snapshot.sourceGaps,
    work: snapshot.proposal?.blocks.map(
      ({ startTime: _start, endTime: _end, ...block }) => block
    ),
    unscheduled: snapshot.proposal?.unscheduledCards,
    decisions: snapshot.proposal?.robertItems,
    impact: impact && {
      requiresReview: impact.requiresReview,
      risks: impact.risks
        .map(({ code, subjectId, requiresReview }) => ({
          code,
          subjectId,
          requiresReview,
        }))
        .sort((a, b) => canonical(a).localeCompare(canonical(b))),
      deadlines: impact.deadlines.map(
        ({ cardId, before, after, movement }) => ({
          cardId,
          before: before.status,
          after: after.status,
          movement,
        })
      ),
      dependencies: impact.dependencies.map(
        ({ actionId, dependency, completionRecorded, before, after }) => ({
          actionId,
          dependency,
          completionRecorded,
          before: { scheduled: before.scheduled, ordering: before.ordering },
          after: { scheduled: after.scheduled, ordering: after.ordering },
        })
      ),
      buffer: {
        before: bufferState(impact.buffer.before),
        after: bufferState(impact.buffer.after),
      },
      protectedBlocks: impact.protectedBlocks.map(
        ({ blockId, reasons, preservedExactly }) => ({
          blockId,
          reasons,
          preservedExactly,
        })
      ),
    },
  });
}

export function summarizeManagerAcceptance(input: {
  sample: Array<{ verdict: "correct" | "incorrect" | "insufficient" }>;
  workingDays: number;
  critical: number;
  unreviewedUrgent: number;
  safetyVerified: boolean;
}) {
  const reviewed = Math.min(100, input.sample.length),
    correct = input.sample
      .slice(0, 100)
      .filter(r => r.verdict === "correct").length;
  const reasons: string[] = [];
  if (!input.safetyVerified)
    reasons.push(
      "The safety suite has not passed for this exact implementation."
    );
  if (input.workingDays < 5)
    reasons.push(`${input.workingDays}/5 working days reviewed.`);
  if (reviewed < 100)
    reasons.push(`${reviewed}/100 distinct proposals reviewed.`);
  if (reviewed === 100 && correct < 98)
    reasons.push(
      `${correct}/100 proposals were correct and sufficiently supported; at least 98 are required.`
    );
  if (input.critical)
    reasons.push(
      `${input.critical} critical errors require a new shadow trial after correction.`
    );
  if (input.unreviewedUrgent)
    reasons.push(
      `${input.unreviewedUrgent} urgent proposals still need founder review.`
    );
  return {
    eligible: !reasons.length,
    reasons,
    reviewed,
    correct,
    workingDays: input.workingDays,
    critical: input.critical,
    unreviewedUrgent: input.unreviewedUrgent,
    safetyVerified: input.safetyVerified,
  };
}

const managerCorrectionConditionsSchema = z
  .object({
    boardName: z.string().trim().min(1).max(256).optional(),
    listName: z.string().trim().min(1).max(256).optional(),
    state: z.string().trim().min(1).max(128).optional(),
    actionKind: z.enum(["work", "verify", "draft", "decision", "follow_up"]).optional(),
  })
  .strict();
const managerReviewedStepSchema = z.object({
  actionId: z.string().trim().min(1).max(128),
  title: z.string().trim().min(3).max(300),
  completionCriteria: z.string().trim().min(3).max(1000),
}).strict();
const storedCorrectionPolicySchema = z.object({
  version: z.literal(2),
  conditions: managerCorrectionConditionsSchema,
  nextStep: managerReviewedStepSchema,
}).strict();

export const managerCorrectionInputSchema = z
  .object({
    scope: z.enum(["card", "worker"]),
    cardId: z.string().trim().min(1).max(64).optional(),
    topic: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    evidenceIds: z.array(z.string().min(1).max(256)).min(1).max(20),
    conditions: managerCorrectionConditionsSchema,
    nextStep: managerReviewedStepSchema.optional(),
    validUntil: z
      .string()
      .refine(
        validManagerTimestamp,
        "A timezone-qualified expiry timestamp is required"
      ),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scope === "card" && !v.cardId)
      ctx.addIssue({
        code: "custom",
        message: "Card scope requires a card",
        path: ["cardId"],
      });
    if (v.scope === "worker" && (v.cardId || !Object.keys(v.conditions).length))
      ctx.addIssue({
        code: "custom",
        message:
          "Worker scope requires explicit conditions and no single-card override",
        path: ["conditions"],
      });
    if (Object.values(v.conditions).some(value => value === "*"))
      ctx.addIssue({
        code: "custom",
        message: "Wildcard correction conditions are not allowed",
        path: ["conditions"],
      });
    if (v.nextStep && (v.scope !== "card" || !["work", "verify", "follow_up"].includes(v.conditions.actionKind ?? "")))
      ctx.addIssue({ code: "custom", message: "A corrected next step requires a card and a matching non-external action kind", path: ["nextStep"] });
  });
export type ManagerCorrectionInput = z.infer<
  typeof managerCorrectionInputSchema
>;
export const managerReviewInputSchema = z.object({
  vaId: z.number().int().positive(),
  runId: z.number().int().positive(),
  verdict: z.enum(["correct", "incorrect", "insufficient"]),
  critical: z.boolean(),
  correction: z.string().max(8000),
  source: z.string().trim().min(3).max(8000),
  correctionKnowledge: managerCorrectionInputSchema.optional(),
});
export const managerTrialInputSchema = z.object({
  vaId: z.number().int().positive(),
  reason: z.string().trim().min(10).max(4000),
});
export const managerCorrectionRevokeInputSchema = z.object({
  vaId: z.number().int().positive(),
  correctionId: z.number().int().positive(),
  reason: z.string().trim().min(3).max(4000),
});
export const managerReviewInboxInputSchema = z.object({
  vaId: z.number().int().positive().optional(),
  page: z.number().int().min(0).max(100000).default(0),
});

const evidenceFingerprint = (e: ManagerEvidence) => digestValue(e);
function correctionSourceSupported(
  e: ManagerEvidence | undefined,
  now: number
): e is ManagerEvidence {
  const metadata = e?.metadata,
    source = e?.source.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (
    !!e &&
    !/^(?:virtual_)?worker(?:_|$)/.test(source ?? "") &&
    ["source", "decision"].includes(e.kind) &&
    !!e.text.trim() &&
    (e.kind === "decision"
      ? metadata?.truthClass === "human_decision" && metadata.authority === "authoritative"
      : metadata?.truthClass === "source_record" &&
        (metadata.authority === undefined || metadata.authority === "authoritative")) &&
    !(source === "gmail" && (metadata?.contentScope === "portal_notice" || gmailContentScope("", e.text) === "portal_notice")) &&
    validManagerTimestamp(e.observedAt) &&
    Number.isFinite(now) &&
    Date.parse(e.observedAt) <= now &&
    (metadata?.sourceDate == null || (validManagerDate(metadata.sourceDate) && Date.parse(metadata.sourceDate) <= now)) &&
    (metadata?.effectiveFrom == null || (validManagerDate(metadata.effectiveFrom) && Date.parse(metadata.effectiveFrom) <= now)) &&
    (metadata?.effectiveTo == null || (validManagerDate(metadata.effectiveTo) && Date.parse(metadata.effectiveTo) > now))
  );
}
function isAuthoritativeSourceRevisionOf(
  pinned: ManagerEvidence | undefined,
  candidate: ManagerEvidence,
  now: number
) {
  const previous = pinned?.metadata,
    current = candidate.metadata,
    supersedes = current?.supersedesEvidenceIds;
  if (
    !pinned ||
    candidate.id === pinned.id ||
    candidate.kind !== "source" ||
    !correctionSourceSupported(candidate, now) ||
    current?.authority !== "authoritative" ||
    !Array.isArray(supersedes) ||
    !supersedes.includes(pinned.id) ||
    !previous?.sourceRecordId ||
    current.sourceRecordId !== previous.sourceRecordId ||
    !previous.sender ||
    !current.sender ||
    previous.sender.trim().toLowerCase() !== current.sender.trim().toLowerCase() ||
    !previous.sourceRevision ||
    !current.sourceRevision ||
    previous.sourceRevision === current.sourceRevision ||
    pinned.source.trim().toLowerCase() !== candidate.source.trim().toLowerCase() ||
    typeof previous.sourceDate !== "string" ||
    !validManagerDate(previous.sourceDate) ||
    typeof current.sourceDate !== "string" ||
    !validManagerDate(current.sourceDate) ||
    typeof previous.effectiveFrom !== "string" ||
    !validManagerDate(previous.effectiveFrom) ||
    typeof current.effectiveFrom !== "string" ||
    !validManagerDate(current.effectiveFrom) ||
    Date.parse(current.sourceDate) <= Date.parse(previous.sourceDate) ||
    Date.parse(current.effectiveFrom) < Date.parse(previous.effectiveFrom)
  )
    return false;
  return true;
}
export function prepareManagerCorrection(args: {
  knowledge: ManagerCorrectionInput;
  correction: string;
  snapshot: ManagerSnapshot;
  now: Date;
}) {
  const rule = managerCorrectionInputSchema.parse(args.knowledge),
    correction = args.correction.trim();
  const expiry = new Date(rule.validUntil),
    now = args.now.getTime();
  if (
    correction.length < 3 ||
    correction.length > 8000 ||
    expiry.getTime() <= now ||
    expiry.getTime() - now > 90 * 86400000
  )
    throw new Error(
      "Corrections need an explanation and a future expiry within 90 days."
    );
  if (
    rule.scope === "card" &&
    !args.snapshot.cards.some(c => c.id === rule.cardId)
  )
    throw new Error("Correction card is outside the reviewed proposal.");
  if (rule.nextStep) {
    const actions = args.snapshot.actions.filter(a => a.id === rule.nextStep!.actionId);
    if (actions.length !== 1 || actions[0].cardId !== rule.cardId || actions[0].kind !== rule.conditions.actionKind)
      throw new Error("Corrected next step must match one reviewed action in the selected card.");
    if (!safeManagerReviewedStep(rule.nextStep))
      throw new Error("Corrected next step cannot authorize an external or unsafe action.");
  }
  const evidence = [...new Set(rule.evidenceIds)].map(id => {
    const records = args.snapshot.evidence.filter(e => e.id === id);
    const e = records[0];
    if (
      records.length !== 1 ||
      !correctionSourceSupported(e, now) ||
      (rule.scope === "card" && e.cardId !== rule.cardId)
    )
      throw new Error(
        "Correction evidence must be a unique retained source in the reviewed scope."
      );
    return {
      id,
      cardId: e.cardId,
      sourceRevision: e.metadata?.sourceRevision ?? null,
      fingerprint: evidenceFingerprint(e),
    };
  });
  return {
    scope: rule.scope,
    cardId: rule.scope === "card" ? rule.cardId! : null,
    topic: rule.topic,
    correction,
    conditionsJson: JSON.stringify(rule.nextStep
      ? { version: 2, conditions: rule.conditions, nextStep: rule.nextStep }
      : rule.conditions),
    evidenceJson: JSON.stringify(evidence),
    validFrom: new Date(args.now),
    validUntil: expiry,
  };
}

export type ManagerCorrectionRow = typeof aptlssManagerCorrections.$inferSelect;
type CorrectionRow = ManagerCorrectionRow;
export type ManagerCorrectionContext = {
  vaId: number;
  card: Pick<ManagerCard, "id" | "board" | "list" | "state">;
  evidence: ManagerEvidence[];
  now: Date;
  topic?: string;
  actionKind?: ManagerAction["kind"];
};
function applicableCorrection(
  row: CorrectionRow,
  ctx: ManagerCorrectionContext
) {
  if (
    ![row.validFrom, row.validUntil, ctx.now].every(
      d => d instanceof Date && Number.isFinite(d.getTime())
    ) ||
    row.vaId !== ctx.vaId ||
    row.revokedAt ||
    row.validFrom.getTime() > ctx.now.getTime() ||
    row.validUntil.getTime() <= ctx.now.getTime() ||
    (row.scope === "card" && row.cardId !== ctx.card.id) ||
    (ctx.topic && row.topic !== ctx.topic)
  )
    return null;
  try {
    const stored: unknown = JSON.parse(row.conditionsJson);
    const policy = stored && typeof stored === "object" && "version" in stored
      ? storedCorrectionPolicySchema.parse(stored)
      : null;
    const conditions = policy?.conditions ?? managerCorrectionConditionsSchema.parse(stored);
    const nextStep = policy?.nextStep;
    if (nextStep && (row.scope !== "card" || !["work", "verify", "follow_up"].includes(conditions.actionKind ?? "") || !safeManagerReviewedStep(nextStep))) return null;
    const pins = z
      .array(
        z.object({
          id: z.string(),
          cardId: z.string(),
          fingerprint: z.string().length(64),
          sourceRevision: z.string().nullable(),
        })
      )
      .min(1)
      .parse(JSON.parse(row.evidenceJson));
    managerCorrectionInputSchema.parse({
      scope: row.scope,
      ...(row.cardId ? { cardId: row.cardId } : {}),
      topic: row.topic,
      evidenceIds: pins.map(e => e.id),
      conditions,
      ...(nextStep ? { nextStep } : {}),
      validUntil: row.validUntil.toISOString(),
    });
    if (
      (conditions.boardName && conditions.boardName !== ctx.card.board) ||
      (conditions.listName && conditions.listName !== ctx.card.list) ||
      (conditions.state && conditions.state !== ctx.card.state) ||
      (conditions.actionKind && conditions.actionKind !== ctx.actionKind)
    )
      return null;
    if (
      pins.some(pin => {
        const records = ctx.evidence.filter(
          e => e.id === pin.id && e.cardId === pin.cardId
        );
        return (
          records.length !== 1 ||
          !correctionSourceSupported(records[0], ctx.now.getTime()) ||
          (row.scope === "card" && records[0].cardId !== ctx.card.id) ||
          ctx.evidence.some(candidate =>
            isAuthoritativeSourceRevisionOf(
              records.length === 1 ? records[0] : undefined,
              candidate,
              ctx.now.getTime()
            )
          ) ||
          (records[0].metadata?.sourceRevision ?? null) !==
            pin.sourceRevision ||
          evidenceFingerprint(records[0]) !== pin.fingerprint
        );
      })
    )
      return null;
    return {
      id: row.id,
      reviewId: row.reviewId,
      vaId: row.vaId,
      scope: row.scope,
      cardId: ctx.card.id,
      topic: row.topic,
      correction: row.correction,
      conditions,
      ...(nextStep ? { nextStep } : {}),
      evidence: pins,
      validUntil: row.validUntil.toISOString(),
      knowledgeClass: "scoped_guidance" as const,
      doesNotResolveConflicts: true as const,
    };
  } catch {
    return null;
  }
}
export type ScopedManagerCorrection = NonNullable<
  ReturnType<typeof applicableCorrection>
>;
export type ManagerCorrectionReadResult = {
  corrections: ScopedManagerCorrection[];
  learningStateHash: string;
  withheldTopics: string[];
  withheldTargets: Array<{ topic: string; actionId?: string }>;
};
export function selectApplicableManagerCorrections(
  rows: CorrectionRow[],
  context: ManagerCorrectionContext
): ManagerCorrectionReadResult {
  const matches = rows.flatMap(row => {
    const value = applicableCorrection(row, context);
    return value ? [value] : [];
  });
  const groups = new Map<string, typeof matches>();
  for (const item of matches) {
    const key = JSON.stringify([item.topic, item.nextStep?.actionId ?? null]);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const withheldKeys = [...groups]
    .filter(
      ([, items]) => new Set(items.map(i => digestValue({ correction: i.correction.trim(), nextStep: i.nextStep ?? null }))).size > 1
    )
    .map(([key]) => key)
    .sort();
  const withheldTargets = withheldKeys.map(key => {
    const [topic, actionId] = JSON.parse(key) as [string, string | null];
    return { topic, ...(actionId ? { actionId } : {}) };
  });
  const withheldTopics = [...new Set(withheldTargets.map(item => item.topic))].sort();
  const corrections = [...groups]
    .filter(([key]) => !withheldKeys.includes(key))
    .map(([, items]) => items.sort((a, b) => b.id - a.id)[0])
    .sort((a, b) => a.id - b.id);
  const dateValue = (value: Date | null) =>
    value === null
      ? null
      : value instanceof Date && Number.isFinite(value.getTime())
        ? value.toISOString()
        : "invalid-date";
  const learningStateHash = digestValue(
    rows
      .map(row => ({
        ...row,
        createdAt: dateValue(row.createdAt),
        validFrom: dateValue(row.validFrom),
        validUntil: dateValue(row.validUntil),
        revokedAt: dateValue(row.revokedAt),
        applicable: matches.some(m => m.id === row.id),
      }))
      .sort((a, b) => a.id - b.id)
  );
  return { corrections, learningStateHash, withheldTopics, withheldTargets };
}
export const filterApplicableManagerCorrections = (
  rows: CorrectionRow[],
  context: ManagerCorrectionContext
) => selectApplicableManagerCorrections(rows, context).corrections;
export async function getApplicableManagerCorrections(
  context: ManagerCorrectionContext,
  suppliedDb?: Db
): Promise<ManagerCorrectionReadResult> {
  assertManagerPilotWorker(context.vaId);
  const db = suppliedDb ?? (await database());
  const rows = await db
    .select()
    .from(aptlssManagerCorrections)
    .where(
      and(
        eq(aptlssManagerCorrections.vaId, context.vaId),
        or(
          eq(aptlssManagerCorrections.scope, "worker"),
          eq(aptlssManagerCorrections.cardId, context.card.id)
        )
      )
    );
  return selectApplicableManagerCorrections(rows, context);
}

async function database() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}
async function checkManagerReviewer(actorId: number, db: Db, lock: boolean) {
  const query = db
    .select()
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  const [actor] = lock ? await query.for("update") : await query;
  // The canonical platform represents the founder through the admin role.
  if (actor?.role !== "admin")
    throw new Error(
      "Founder/admin access is required for manager reviews and activation."
    );
}
async function assertManagerReviewer(actorId: number, db: Db) {
  return checkManagerReviewer(actorId, db, false);
}
/** Must be called inside the transaction that performs the reviewer-authorized write. */
export async function requireManagerReviewer(actorId: number, db: Db) {
  return checkManagerReviewer(actorId, db, true);
}

type TrialScope = {
  trialKey: string;
  status: "open" | "closed";
  startedAt: Date;
  closedAt: Date | null;
  afterRunId: number;
  throughRunId: number | null;
  implementationDigest: string | null;
};
async function trialScope(
  vaId: number,
  db: Db,
  state?: typeof aptlssManagerState.$inferSelect
): Promise<TrialScope> {
  const [latest] = await db
    .select()
    .from(aptlssManagerTrialEvents)
    .where(eq(aptlssManagerTrialEvents.vaId, vaId))
    .orderBy(desc(aptlssManagerTrialEvents.id))
    .limit(1);
  const [started] =
    !latest || latest.event === "started"
      ? [latest]
      : await db
          .select()
          .from(aptlssManagerTrialEvents)
          .where(
            and(
              eq(aptlssManagerTrialEvents.vaId, vaId),
              eq(aptlssManagerTrialEvents.trialKey, latest.trialKey),
              eq(aptlssManagerTrialEvents.event, "started")
            )
          )
          .limit(1);
  const startedAt = started?.createdAt ?? state?.shadowStartedAt ?? new Date();
  return {
    trialKey: latest?.trialKey ?? `legacy:${vaId}:${startedAt.toISOString()}`,
    status: latest?.event === "closed" ? "closed" : "open",
    startedAt,
    closedAt: latest?.event === "closed" ? latest.createdAt : null,
    afterRunId: started?.afterRunId ?? 0,
    throughRunId: latest?.event === "closed" ? latest.afterRunId : null,
    implementationDigest: started?.implementationDigest ?? null,
  };
}
const runDigest = aptlssManagerRuns.reviewDigest;
function trialConditions(vaId: number, trial: TrialScope, digest: string) {
  return and(
    eq(aptlssManagerRuns.vaId, vaId),
    isNotNull(aptlssManagerRuns.proposalHash),
    eq(runDigest, digest),
    gte(aptlssManagerRuns.createdAt, trial.startedAt),
    gt(aptlssManagerRuns.id, trial.afterRunId),
    trial.throughRunId === null
      ? undefined
      : lte(aptlssManagerRuns.id, trial.throughRunId)
  );
}
function proposalGroups(
  db: Db,
  vaId: number,
  trial: TrialScope,
  digest: string,
  gateOnly = false
) {
  return db
    .select({
      proposalHash: aptlssManagerRuns.proposalHash,
      latestRunId: sql<number>`MAX(${aptlssManagerRuns.id})`.as("latestRunId"),
      firstSeenAt: sql<Date>`MIN(${aptlssManagerRuns.createdAt})`.as(
        "firstSeenAt"
      ),
      occurrences: sql<number>`COUNT(*)`.as("occurrences"),
      urgent:
        sql<number>`MAX(${aptlssManagerRuns.reviewUrgent})`.as(
          "urgent"
        ),
      critical:
        sql<number>`SUM(CASE WHEN ${aptlssManagerReviews.critical} THEN 1 ELSE 0 END)`.as(
          "critical"
        ),
      reviewId: sql<
        number | null
      >`COALESCE(MAX(CASE WHEN ${aptlssManagerReviews.critical} THEN ${aptlssManagerReviews.id} END), MAX(${aptlssManagerReviews.id}))`.as(
        "reviewId"
      ),
    })
    .from(aptlssManagerRuns)
    .leftJoin(
      aptlssManagerReviews,
      and(
        eq(aptlssManagerReviews.runId, aptlssManagerRuns.id),
        eq(aptlssManagerReviews.vaId, vaId)
      )
    )
    .where(
      and(
        trialConditions(vaId, trial, digest),
        gateOnly
          ? or(
              eq(aptlssManagerRuns.mode, "shadow"),
              eq(aptlssManagerReviews.critical, true)
            )
          : undefined
      )
    )
    .groupBy(aptlssManagerRuns.proposalHash)
    .as("proposal_groups");
}

export async function getManagerGate(vaId: number, db: Db) {
  assertManagerPilotWorker(vaId);
  const worker = await resolveWorkerOperatorContextById(vaId, db);
  const [state] = await db
    .select()
    .from(aptlssManagerState)
    .where(eq(aptlssManagerState.vaId, vaId))
    .limit(1);
  const trial = await trialScope(vaId, db, state),
    digest = managerSafetyDigest();
  const groups = proposalGroups(db, vaId, trial, digest, true);
  const [counts] = await db
    .select({
      critical: sql<number>`COALESCE(SUM(${groups.critical}),0)`,
      unreviewedUrgent: sql<number>`COALESCE(SUM(CASE WHEN ${groups.urgent} AND ${groups.reviewId} IS NULL THEN 1 ELSE 0 END),0)`,
    })
    .from(groups);
  const reviewedRun = alias(aptlssManagerRuns, "reviewed_run");
  const sample = await db
    .select({ verdict: aptlssManagerReviews.verdict })
    .from(groups)
    .innerJoin(
      aptlssManagerReviews,
      eq(aptlssManagerReviews.id, groups.reviewId)
    )
    .innerJoin(reviewedRun, eq(reviewedRun.id, aptlssManagerReviews.runId))
    .orderBy(desc(reviewedRun.createdAt), desc(reviewedRun.id))
    .limit(100);
  // Seek across local day boundaries, not across thousands of repeated polls.
  const days = new Set<string>();
  let before: Date | undefined;
  while (days.size < 5) {
    const [row] = await db
      .select({ createdAt: reviewedRun.createdAt })
      .from(groups)
      .innerJoin(
        aptlssManagerReviews,
        eq(aptlssManagerReviews.id, groups.reviewId)
      )
      .innerJoin(reviewedRun, eq(reviewedRun.id, aptlssManagerReviews.runId))
      .where(before ? lt(reviewedRun.createdAt, before) : undefined)
      .orderBy(desc(reviewedRun.createdAt), desc(reviewedRun.id))
      .limit(1);
    if (!row) break;
    const dateKey = dateKeyInTimeZone(row.createdAt, worker.timezone);
    if (
      worker.workingDays.includes(
        dayOfWeekInTimeZone(row.createdAt, worker.timezone)
      )
    )
      days.add(dateKey);
    const boundary = zonedDateTimeToUtc(dateKey, "00:00", worker.timezone);
    if (before && boundary >= before)
      throw new Error("Trial day boundary did not advance safely");
    before = boundary;
  }
  const gate = summarizeManagerAcceptance({
    sample,
    critical: Number(counts?.critical ?? 0),
    unreviewedUrgent: Number(counts?.unreviewedUrgent ?? 0),
    workingDays: days.size,
    safetyVerified: managerSafetyVerified(),
  });
  if (trial.status === "closed") {
    gate.eligible = false;
    gate.reasons.push(
      "This trial is closed. Start a new shadow trial before activation."
    );
  }
  if (trial.implementationDigest && trial.implementationDigest !== digest) {
    gate.eligible = false;
    gate.reasons.push(
      "The implementation changed. Start a new shadow trial for this implementation."
    );
  }
  gate.eligible = false;
  gate.reasons.push("Deployment policy restricts this manager to a shadow-only pilot; activation is prohibited.");
  return gate;
}

export async function getManagerReviewInbox(
  actorId: number,
  vaId?: number,
  page = 0
) {
  const pilotWorkerIds = managerPilotWorkerIds();
  assertManagerPilotWorker(vaId ?? pilotWorkerIds[0]);
  const db = await database();
  await assertManagerReviewer(actorId, db);
  const workers = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.role, "worker"), inArray(users.id, pilotWorkerIds)))
    .orderBy(users.id);
  const workerId = vaId ?? null;
  if (workerId !== null && !workers.some(w => w.id === workerId))
    throw new Error("Worker not found");
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000)
    throw new Error("Invalid review page");
  const [state] =
    workerId === null
      ? []
      : await db
          .select()
          .from(aptlssManagerState)
          .where(eq(aptlssManagerState.vaId, workerId))
          .limit(1);
  const trial =
    workerId === null ? null : await trialScope(workerId, db, state);
  const groups =
    trial && workerId !== null
      ? proposalGroups(db, workerId, trial, managerSafetyDigest())
      : null;
  const rows = groups
    ? await db
        .select({
          run: aptlssManagerRuns,
          review: aptlssManagerReviews,
          occurrences: groups.occurrences,
          firstSeenAt: groups.firstSeenAt,
          urgent: groups.urgent,
        })
        .from(groups)
        .innerJoin(
          aptlssManagerRuns,
          eq(aptlssManagerRuns.id, groups.latestRunId)
        )
        .leftJoin(
          aptlssManagerReviews,
          eq(aptlssManagerReviews.id, groups.reviewId)
        )
        .orderBy(
          desc(groups.urgent),
          sql`${groups.reviewId} IS NULL DESC`,
          desc(groups.latestRunId)
        )
        .limit(26)
        .offset(page * 25)
    : [];
  const trialHistory =
    workerId === null
      ? []
      : await db
          .select()
          .from(aptlssManagerTrialEvents)
          .where(eq(aptlssManagerTrialEvents.vaId, workerId))
          .orderBy(desc(aptlssManagerTrialEvents.id))
          .limit(20);
  const corrections =
    workerId === null
      ? []
      : await db
          .select()
          .from(aptlssManagerCorrections)
          .where(eq(aptlssManagerCorrections.vaId, workerId))
          .orderBy(desc(aptlssManagerCorrections.id))
          .limit(100);
  return {
    workers,
    workerId,
    mode: "shadow" as const,
    trial,
    trialHistory,
    corrections,
    page,
    hasMore: rows.length > 25,
    entries: rows
      .slice(0, 25)
      .map(({ run, review, occurrences, firstSeenAt, urgent }) => ({
        runId: run.id,
        vaId: run.vaId,
        createdAt: run.createdAt,
        proposalHash: run.proposalHash!,
        occurrences: Number(occurrences),
        firstSeenAt,
        urgent: Boolean(Number(urgent)),
        snapshot: parseSnapshot(run.snapshotJson),
        review,
      })),
    gate:
      workerId === null
        ? evaluateManagerGate({
            observations: [],
            timezone: "UTC",
            workingDays: [1, 2, 3, 4, 5],
            safetyVerified: managerSafetyVerified(),
          })
        : await getManagerGate(workerId, db),
  };
}

export async function recordManagerReview(
  actorId: number,
  input: z.infer<typeof managerReviewInputSchema>
) {
  input = managerReviewInputSchema.parse(input);
  assertManagerPilotWorker(input.vaId);
  const db = await database();
  const correction = input.correction.trim(),
    source = input.source.trim();
  if (
    source.length < 3 ||
    source.length > 8000 ||
    correction.length > 8000 ||
    (input.verdict !== "correct" && correction.length < 3)
  )
    throw new Error(
      "Record the source and explain an incorrect or insufficient proposal."
    );
  if (input.critical && input.verdict === "correct")
    throw new Error("A correct proposal cannot also be a critical error.");
  return db.transaction(async tx => {
    await tx
      .insert(aptlssManagerControl)
      .values({ id: 1 })
      .onDuplicateKeyUpdate({ set: { id: 1 } });
    await tx
      .select()
      .from(aptlssManagerControl)
      .where(eq(aptlssManagerControl.id, 1))
      .for("update");
    await requireManagerReviewer(actorId, tx as unknown as Db);
    await tx.select().from(users).where(eq(users.id, input.vaId)).for("update");
    const [run] = await tx
      .select()
      .from(aptlssManagerRuns)
      .where(
        and(
          eq(aptlssManagerRuns.id, input.runId),
          eq(aptlssManagerRuns.vaId, input.vaId)
        )
      )
      .limit(1);
    if (!run?.proposalHash)
      throw new Error("A current, worker-scoped proposal is required.");
    const [state] = await tx
      .select()
      .from(aptlssManagerState)
      .where(eq(aptlssManagerState.vaId, input.vaId))
      .limit(1);
    const trial = await trialScope(input.vaId, tx as unknown as Db, state);
    if (
      trial.status === "closed" ||
      run.id <= trial.afterRunId ||
      run.createdAt < trial.startedAt ||
      parseSnapshot(run.snapshotJson).implementationDigest !==
        managerSafetyDigest()
    )
      throw new Error(
        "Review a proposal in the current implementation's open trial."
      );
    const [existing] = await tx
      .select({ id: aptlssManagerReviews.id })
      .from(aptlssManagerReviews)
      .innerJoin(
        aptlssManagerRuns,
        eq(aptlssManagerRuns.id, aptlssManagerReviews.runId)
      )
      .where(
        and(
          eq(aptlssManagerReviews.vaId, input.vaId),
          eq(aptlssManagerReviews.proposalHash, run.proposalHash),
          trialConditions(input.vaId, trial, managerSafetyDigest())
        )
      )
      .limit(1);
    if (existing)
      throw new Error(
        "This proposal has already been reviewed. The recorded review is immutable."
      );
    const knowledge = input.correctionKnowledge
      ? prepareManagerCorrection({
          knowledge: input.correctionKnowledge,
          correction,
          snapshot: parseSnapshot(run.snapshotJson),
          now: new Date(),
        })
      : null;
    const { correctionKnowledge: _knowledge, ...reviewInput } = input;
    const [review] = await tx
      .insert(aptlssManagerReviews)
      .values({
        ...reviewInput,
        correction,
        source,
        reviewerId: actorId,
        proposalHash: run.proposalHash,
      })
      .$returningId();
    let correctionId: number | null = null;
    if (knowledge) {
      const [stored] = await tx
        .insert(aptlssManagerCorrections)
        .values({
          ...knowledge,
          vaId: input.vaId,
          reviewId: review.id,
          createdBy: actorId,
        })
        .$returningId();
      correctionId = stored.id;
      await tx
        .update(aptlssManagerState)
        .set({
          inputHash: null,
          policyRevision: sql`${aptlssManagerState.policyRevision} + 1`,
        })
        .where(eq(aptlssManagerState.vaId, input.vaId));
    }
    if (input.critical) {
      await tx
        .update(aptlssManagerState)
        .set({
          mode: "shadow",
          policyRevision: sql`${aptlssManagerState.policyRevision} + 1`,
          inputHash: null,
        })
        .where(eq(aptlssManagerState.vaId, input.vaId));
      await tx
        .update(aptlssManagerControl)
        .set({ activeVaId: null })
        .where(eq(aptlssManagerControl.activeVaId, input.vaId));
    }
    return { recorded: true, revertedToShadow: input.critical, correctionId };
  });
}

async function transitionManagerTrial(
  actorId: number,
  input: z.infer<typeof managerTrialInputSchema>,
  restart: boolean
) {
  input = managerTrialInputSchema.parse(input);
  assertManagerPilotWorker(input.vaId);
  const db = await database();
  return db.transaction(async tx => {
    await tx
      .insert(aptlssManagerControl)
      .values({ id: 1 })
      .onDuplicateKeyUpdate({ set: { id: 1 } });
    await tx
      .select()
      .from(aptlssManagerControl)
      .where(eq(aptlssManagerControl.id, 1))
      .for("update");
    await requireManagerReviewer(actorId, tx as unknown as Db);
    await tx.select().from(users).where(eq(users.id, input.vaId)).for("update");
    await resolveWorkerOperatorContextById(input.vaId, tx as unknown as Db);
    const [state] = await tx
      .select()
      .from(aptlssManagerState)
      .where(eq(aptlssManagerState.vaId, input.vaId))
      .limit(1);
    const trial = await trialScope(input.vaId, tx as unknown as Db, state);
    if (!restart && trial.status === "closed")
      throw new Error("This trial is already closed.");
    const [lastRun] = await tx
      .select({ id: aptlssManagerRuns.id })
      .from(aptlssManagerRuns)
      .where(eq(aptlssManagerRuns.vaId, input.vaId))
      .orderBy(desc(aptlssManagerRuns.id))
      .limit(1);
    const afterRunId = lastRun?.id ?? 0,
      now = new Date(),
      digest = managerSafetyDigest();
    if (trial.status === "open")
      await tx.insert(aptlssManagerTrialEvents).values({
        vaId: input.vaId,
        trialKey: trial.trialKey,
        event: "closed",
        afterRunId,
        implementationDigest: trial.implementationDigest ?? digest,
        actorId,
        reason: input.reason,
        createdAt: now,
      });
    const trialKey = restart ? randomUUID() : trial.trialKey;
    if (restart)
      await tx.insert(aptlssManagerTrialEvents).values({
        vaId: input.vaId,
        trialKey,
        event: "started",
        afterRunId,
        implementationDigest: digest,
        actorId,
        reason: input.reason,
        createdAt: now,
      });
    const values = {
      mode: "shadow" as const,
      enabled: restart,
      inputHash: null,
      ...(restart ? { shadowStartedAt: now } : {}),
    };
    await tx
      .insert(aptlssManagerState)
      .values({ vaId: input.vaId, ...values })
      .onDuplicateKeyUpdate({
        set: {
          ...values,
          policyRevision: sql`${aptlssManagerState.policyRevision} + 1`,
        },
      });
    await tx
      .update(aptlssManagerControl)
      .set({ activeVaId: null })
      .where(eq(aptlssManagerControl.activeVaId, input.vaId));
    return {
      trialKey,
      status: restart ? ("open" as const) : ("closed" as const),
      mode: "shadow" as const,
      enabled: restart,
      afterRunId,
    };
  });
}
export const closeManagerTrial = (
  actorId: number,
  input: z.infer<typeof managerTrialInputSchema>
) => transitionManagerTrial(actorId, input, false);
export const restartManagerTrial = (
  actorId: number,
  input: z.infer<typeof managerTrialInputSchema>
) => transitionManagerTrial(actorId, input, true);

export async function revokeManagerCorrection(
  actorId: number,
  input: z.infer<typeof managerCorrectionRevokeInputSchema>
) {
  input = managerCorrectionRevokeInputSchema.parse(input);
  assertManagerPilotWorker(input.vaId);
  const db = await database();
  return db.transaction(async tx => {
    await requireManagerReviewer(actorId, tx as unknown as Db);
    await tx.select().from(users).where(eq(users.id, input.vaId)).for("update");
    const [row] = await tx
      .select()
      .from(aptlssManagerCorrections)
      .where(
        and(
          eq(aptlssManagerCorrections.id, input.correctionId),
          eq(aptlssManagerCorrections.vaId, input.vaId)
        )
      )
      .limit(1)
      .for("update");
    if (!row || row.revokedAt)
      throw new Error("An unrevoked worker-scoped correction is required.");
    await tx
      .update(aptlssManagerCorrections)
      .set({
        revokedAt: new Date(),
        revokedBy: actorId,
        revocationReason: input.reason,
      })
      .where(eq(aptlssManagerCorrections.id, row.id));
    await tx
      .update(aptlssManagerState)
      .set({
        inputHash: null,
        policyRevision: sql`${aptlssManagerState.policyRevision} + 1`,
      })
      .where(eq(aptlssManagerState.vaId, input.vaId));
    return { revoked: true, correctionId: row.id };
  });
}

export async function setManagerMode(
  actorId: number,
  vaId: number,
  mode: "shadow" | "active"
) {
  assertManagerPilotWorker(vaId);
  if (mode !== "shadow") assertManagerPlanMutationAllowed(vaId);
  const db = await database();
  return db.transaction(async tx => {
    await tx
      .insert(aptlssManagerControl)
      .values({ id: 1 })
      .onDuplicateKeyUpdate({ set: { id: 1 } });
    const [pilot] = await tx
      .select()
      .from(aptlssManagerControl)
      .where(eq(aptlssManagerControl.id, 1))
      .for("update");
    await requireManagerReviewer(actorId, tx as unknown as Db);
    await tx.select().from(users).where(eq(users.id, vaId)).for("update");
    await resolveWorkerOperatorContextById(vaId, tx as unknown as Db);
    await tx
      .insert(aptlssManagerState)
      .values({ vaId, mode })
      .onDuplicateKeyUpdate({
        set: {
          mode,
          inputHash: null,
          policyRevision: sql`${aptlssManagerState.policyRevision} + 1`,
        },
      });
    if (pilot.activeVaId === vaId)
      await tx
        .update(aptlssManagerControl)
        .set({ activeVaId: null })
        .where(eq(aptlssManagerControl.id, 1));
    return { mode };
  });
}

export async function restoreManagerPlan(
  actorId: number,
  vaId: number,
  runId: number
) {
  assertManagerPlanMutationAllowed(vaId);
  const db = await database();
  return db.transaction(
    async tx => {
      await tx
        .insert(aptlssManagerControl)
        .values({ id: 1 })
        .onDuplicateKeyUpdate({ set: { id: 1 } });
      await tx
        .select()
        .from(aptlssManagerControl)
        .where(eq(aptlssManagerControl.id, 1))
        .for("update");
      await requireManagerReviewer(actorId, tx as unknown as Db);
      await tx.select().from(users).where(eq(users.id, vaId)).for("update");
      const [run] = await tx
        .select()
        .from(aptlssManagerRuns)
        .where(
          and(eq(aptlssManagerRuns.id, runId), eq(aptlssManagerRuns.vaId, vaId))
        )
        .limit(1);
      if (!run?.appliedPlanHash || !run.previousPlanJson)
        throw new Error("This run has no prior plan to restore.");
      const oldPlan = JSON.parse(
        run.previousPlanJson
      ) as OperatorDailyPlanPayload;
      const [current] = await tx
        .select()
        .from(dailyPlans)
        .where(
          and(
            eq(dailyPlans.vaId, vaId),
            eq(dailyPlans.dateKey, oldPlan.dateKey)
          )
        )
        .for("update");
      if (
        !current ||
        managerPlanVersion(current.scheduleJson) !== run.appliedPlanHash
      )
        throw new Error(
          "The plan has changed since this run. Automatic rollback would overwrite newer work."
        );
      const [timer] = await tx
        .select({ id: timeEntries.id })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.vaId, vaId),
            eq(timeEntries.isVoided, false),
            isNull(timeEntries.endTime)
          )
        )
        .for("update");
      if (timer)
        throw new Error(
          "Stop the active timer before restoring a previous plan."
        );
      const worker = await resolveWorkerOperatorContextById(
        vaId,
        tx as unknown as Db
      );
      const currentPlan = JSON.parse(
        current.scheduleJson
      ) as OperatorDailyPlanPayload;
      const now = new Date();
      const protectedBlocks = currentPlan.blocks.filter(
        block =>
          block.status === "done" ||
          block.status === "active" ||
          zonedDateTimeToUtc(
            currentPlan.dateKey,
            block.startTime,
            worker.timezone
          ) <= now
      );
      if (
        protectedBlocks.some(
          block =>
            JSON.stringify(
              oldPlan.blocks.find(previous => previous.id === block.id)
            ) !== JSON.stringify(block)
        )
      )
        throw new Error(
          "Restoring this plan would overwrite completed, active or elapsed work. Review the remaining day instead."
        );
      const restoredPlan: OperatorDailyPlanPayload = {
        ...oldPlan,
        auditTrail: [
          ...(Array.isArray(oldPlan.auditTrail) ? oldPlan.auditTrail : []),
          {
            at: now.toISOString(),
            action: "restored",
            detail: "Previous day schedule restored after owner review.",
          },
        ],
      };
      await tx
        .update(dailyPlans)
        .set({
          scheduleJson: JSON.stringify(restoredPlan),
          totalScheduledMinutes: oldPlan.planHealth.scheduledMinutes,
          generatedAt: new Date(oldPlan.generatedAt),
          dailySummary: "Restored previous plan after manager review",
          topPriority: oldPlan.blocks[0]?.cardName ?? null,
          robertItemsCount: oldPlan.robertItems.length,
        })
        .where(eq(dailyPlans.id, current.id));
      await tx
        .update(aptlssManagerState)
        .set({
          mode: "shadow",
          inputHash: null,
          policyRevision: sql`${aptlssManagerState.policyRevision} + 1`,
        })
        .where(eq(aptlssManagerState.vaId, vaId));
      await tx
        .update(aptlssManagerControl)
        .set({ activeVaId: null })
        .where(eq(aptlssManagerControl.activeVaId, vaId));
      return { restored: true };
    },
    { isolationLevel: "serializable" }
  );
}
