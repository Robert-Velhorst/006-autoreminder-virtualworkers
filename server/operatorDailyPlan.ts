import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { appSettings, aptlssPlans, aptlssSteps, dailyPlans, timeEntries, userWorkingHours, users, vaProfiles } from "../drizzle/schema.postgres";
import { dateKeyInTimeZone } from "../shared/workerTime";
import { getWorkLaneRank } from "../shared/workLanePriority";
import { getAllAptlssPlans } from "./aptlssDb";
import { getDb } from "./db";
import { getAllCardStates, getAllPriorityScores, getOpenStepsForCards } from "./aptlssStepsDb";
import { indexWorkQueueSteps } from "./operatorWorkQueueIndex";
import { resolveWorkerOperatorContextById, type WorkerOperatorContext } from "./workerOperatorContext";
import { managerPlanVersion } from "./aptlssManagerReviewService";

type ScheduleSettings = {
  startTime: string;
  endTime: string;
  breaks: Array<{ name: string; startTime: string; durationMinutes: number }>;
};

export type OperatorPlanBlock = {
  id: string;
  startTime: string;
  endTime: string;
  cardId: string | null;
  cardName: string;
  cardUrl: string | null;
  boardName: string;
  listName: string;
  action: string;
  stepIds: number[];
  priority: string;
  score: number;
  state: string;
  status: "planned" | "active" | "done" | "skipped";
  notes: string;
  flags: string[];
};

export type OperatorDailyPlanPayload = {
  planningImpact?: import("../shared/aptlssManagerPlanImpact").ManagerPlanImpact;
  version: 2;
  dateKey: string;
  generatedAt: string;
  blocks: OperatorPlanBlock[];
  robertItems: Array<{ stepId: number; cardId: string; cardName: string; decision: string }>;
  unscheduledCards: Array<{ cardId: string; cardName: string; reason: string }>;
  planHealth: {
    confidence: number;
    scheduledMinutes: number;
    availableMinutes: number;
    overlaps: number;
    gaps: number;
  };
  constraints: ScheduleSettings;
  auditTrail: Array<{ at: string; action: string; detail: string }>;
};

const DEFAULT_SCHEDULE: ScheduleSettings = {
  startTime: "09:00",
  endTime: "18:00",
  breaks: [],
};

export class OperatorDailyPlanScopeError extends Error {
  constructor() {
    super("Daily plan references work outside this worker's queue");
    this.name = "OperatorDailyPlanScopeError";
  }
}

export class OperatorDailyPlanConflictError extends Error {
  constructor(
    readonly expectedPlanVersion: string | null,
    readonly currentPlanVersion: string | null,
    message = "A newer version of this day plan was saved while you were working. The saved plan was kept; reload it before making further changes.",
  ) {
    super(message);
    this.name = "OperatorDailyPlanConflictError";
  }
}

export function assertOperatorDailyPlanReferencesInScope(
  payload: OperatorDailyPlanPayload,
  ownedCardIds: ReadonlySet<string>,
  ownedStepCards: ReadonlyMap<number, string>,
) {
  const cardIds = [
    ...payload.blocks.flatMap((block) => block.cardId !== null ? [block.cardId] : []),
    ...payload.robertItems.map((item) => item.cardId),
    ...payload.unscheduledCards.map((item) => item.cardId),
  ];
  if (cardIds.some((cardId) => !ownedCardIds.has(cardId))) throw new OperatorDailyPlanScopeError();

  for (const block of payload.blocks) {
    if ((!block.cardId && block.stepIds.length > 0)
      || block.stepIds.some((stepId) => ownedStepCards.get(stepId) !== block.cardId)) {
      throw new OperatorDailyPlanScopeError();
    }
  }
  for (const item of payload.robertItems) {
    if (ownedStepCards.get(item.stepId) !== item.cardId) throw new OperatorDailyPlanScopeError();
  }
}

function toMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function toTime(value: number) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function profileSchedule(worker?: WorkerOperatorContext): ScheduleSettings {
  return worker ? {
    startTime: worker.workStartTime,
    endTime: worker.workEndTime,
    breaks: worker.breaks,
  } : DEFAULT_SCHEDULE;
}

async function getScheduleSettings(vaId: number, worker?: WorkerOperatorContext): Promise<ScheduleSettings> {
  const fallback = profileSchedule(worker);
  const db = await getDb();
  if (!db) return fallback;
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.vaId, vaId), eq(appSettings.key, "daily_schedule")))
    .limit(1);
  return normalizeScheduleSettings(rows[0]?.value, fallback);
}

function normalizeScheduleSettings(value: string | undefined, fallback: ScheduleSettings): ScheduleSettings {
  try {
    const parsed = JSON.parse(value ?? "{}") as Partial<ScheduleSettings>;
    return {
      startTime: parsed.startTime && /^\d{2}:\d{2}$/.test(parsed.startTime) ? parsed.startTime : fallback.startTime,
      endTime: parsed.endTime && /^\d{2}:\d{2}$/.test(parsed.endTime) ? parsed.endTime : fallback.endTime,
      breaks: Array.isArray(parsed.breaks)
        ? parsed.breaks
            .filter((item) => /^\d{2}:\d{2}$/.test(item.startTime) && item.durationMinutes >= 5)
            .map((item) => ({
              name: item.name || "Break",
              startTime: item.startTime,
              durationMinutes: Math.min(240, Math.round(item.durationMinutes)),
            }))
        : fallback.breaks,
    };
  } catch {
    return fallback;
  }
}

function buildAvailableWindows(schedule: ScheduleSettings) {
  const start = toMinutes(schedule.startTime);
  const end = toMinutes(schedule.endTime);
  const breaks = schedule.breaks
    .map((item) => ({
      ...item,
      start: Math.max(start, toMinutes(item.startTime)),
      end: Math.min(end, toMinutes(item.startTime) + item.durationMinutes),
    }))
    .filter((item) => item.start < item.end)
    .sort((left, right) => left.start - right.start);

  const windows: Array<{ start: number; end: number }> = [];
  let cursor = start;
  for (const item of breaks) {
    if (item.start > cursor) windows.push({ start: cursor, end: item.start });
    cursor = Math.max(cursor, item.end);
  }
  if (cursor < end) windows.push({ start: cursor, end });
  return { windows, breaks, availableMinutes: windows.reduce((total, item) => total + item.end - item.start, 0) };
}

function scheduleIdentity(schedule: ScheduleSettings) {
  return JSON.stringify({
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    breaks: [...schedule.breaks]
      .map(({ name, startTime, durationMinutes }) => ({ name, startTime, durationMinutes }))
      .sort((left, right) => left.startTime.localeCompare(right.startTime) || left.name.localeCompare(right.name)),
  });
}

function protectedBlocks(schedule: OperatorDailyPlanPayload | null, expectedPlanVersion: string | null) {
  const blocks = schedule?.blocks.filter(block => block.status === "active" || block.status === "done") ?? [];
  const sorted = [...blocks].sort((left, right) => toMinutes(left.startTime) - toMinutes(right.startTime));
  for (let index = 0; index < sorted.length; index += 1) {
    const block = sorted[index];
    const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!validTime(block.startTime) || !validTime(block.endTime)
      || toMinutes(block.endTime) <= toMinutes(block.startTime)
      || (index > 0 && toMinutes(block.startTime) < toMinutes(sorted[index - 1].endTime))) {
      throw new OperatorDailyPlanConflictError(
        expectedPlanVersion,
        expectedPlanVersion,
        "The saved active or completed blocks cannot be compared safely. The saved plan was kept; reload it before regenerating.",
      );
    }
  }
  return blocks;
}

function subtractProtectedBlocks(
  windows: Array<{ start: number; end: number }>,
  blocks: OperatorPlanBlock[],
) {
  const reserved = blocks.map(block => ({ start: toMinutes(block.startTime), end: toMinutes(block.endTime) }));
  return windows.flatMap(window => {
    let remaining = [window];
    for (const block of reserved) {
      remaining = remaining.flatMap(segment => {
        if (block.end <= segment.start || block.start >= segment.end) return [segment];
        return [
          ...(block.start > segment.start ? [{ start: segment.start, end: block.start }] : []),
          ...(block.end < segment.end ? [{ start: block.end, end: segment.end }] : []),
        ];
      });
    }
    return remaining;
  });
}

function savedPlanPayload(scheduleJson: string | undefined): OperatorDailyPlanPayload | null {
  if (!scheduleJson) return null;
  try {
    const parsed = JSON.parse(scheduleJson) as OperatorDailyPlanPayload;
    return parsed.version === 2 && Array.isArray(parsed.blocks) ? parsed : null;
  } catch {
    return null;
  }
}

function samePlanBlock(left: OperatorPlanBlock, right: OperatorPlanBlock) {
  const identity = (block: OperatorPlanBlock) => JSON.stringify([
    block.id, block.startTime, block.endTime, block.cardId, block.cardName, block.cardUrl,
    block.boardName, block.listName, block.action, block.stepIds, block.priority, block.score,
    block.state, block.status, block.notes, block.flags,
  ]);
  return identity(left) === identity(right);
}

function assertProtectedBlocksPreserved(
  existing: OperatorDailyPlanPayload | null,
  payload: OperatorDailyPlanPayload,
  expectedPlanVersion: string | null,
  currentPlanVersion: string | null,
) {
  const protectedItems = existing?.blocks.filter(block => block.status === "active" || block.status === "done") ?? [];
  for (const block of protectedItems) {
    const replacement = payload.blocks.find(candidate => candidate.id === block.id);
    if (!replacement || !samePlanBlock(block, replacement)) {
      throw new OperatorDailyPlanConflictError(
        expectedPlanVersion,
        currentPlanVersion,
        "Completed or active blocks must remain unchanged when saving this day plan. The saved plan was kept; reload it before making further changes.",
      );
    }
  }
}

type OperatorPlanDatabase = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type OperatorPlanTransaction = Parameters<Parameters<OperatorPlanDatabase["transaction"]>[0]>[0];

function workerScheduleIdentity(worker: WorkerOperatorContext) {
  return JSON.stringify({
    schedule: scheduleIdentity(profileSchedule(worker)),
    workingDays: [...worker.workingDays].sort((left, right) => left - right),
    timezone: worker.timezone,
  });
}

async function readCurrentWorkerContext(tx: OperatorPlanTransaction, vaId: number) {
  const profiles = await tx.select({
    founderId: vaProfiles.founderId,
    status: vaProfiles.status,
  }).from(vaProfiles)
    .where(eq(vaProfiles.userId, vaId))
    .orderBy(vaProfiles.id)
    .for("update");
  const activeProfiles = profiles.filter(profile => profile.status === "active");
  const userIds = [...new Set([
    vaId,
    ...(activeProfiles.length === 1 ? [activeProfiles[0].founderId] : []),
  ])];
  await tx.select({ id: userWorkingHours.id }).from(userWorkingHours)
    .where(inArray(userWorkingHours.userId, userIds))
    .for("update");
  return resolveWorkerOperatorContextById(vaId, tx as unknown as OperatorPlanDatabase);
}

async function assertCurrentSchedule(
  tx: OperatorPlanTransaction,
  vaId: number,
  expectedSchedule: ScheduleSettings,
  fallback: ScheduleSettings,
  expectedPlanVersion: string | null,
  currentPlanVersion: string | null,
) {
  const [currentSetting] = await tx.select({ value: appSettings.value }).from(appSettings)
    .where(and(eq(appSettings.vaId, vaId), eq(appSettings.key, "daily_schedule")))
    .limit(1).for("update");
  const currentSchedule = normalizeScheduleSettings(currentSetting?.value, fallback);
  if (scheduleIdentity(currentSchedule) !== scheduleIdentity(expectedSchedule)) {
    throw new OperatorDailyPlanConflictError(
      expectedPlanVersion,
      currentPlanVersion,
      "The working schedule changed while this day plan was being prepared. No plan was saved; reload the schedule and try again.",
    );
  }
}

async function assertNoActiveTimer(
  tx: OperatorPlanTransaction,
  vaId: number,
  expectedPlanVersion: string | null,
  currentPlanVersion: string | null,
) {
  const [activeTimer] = await tx.select({ id: timeEntries.id }).from(timeEntries)
    .where(and(
      eq(timeEntries.vaId, vaId),
      eq(timeEntries.isVoided, false),
      isNull(timeEntries.endTime),
    ))
    .limit(1).for("update");
  if (activeTimer) {
    throw new OperatorDailyPlanConflictError(
      expectedPlanVersion,
      currentPlanVersion,
      "Stop the active timer before changing this day plan. The saved plan was kept; try again when the timer is stopped.",
    );
  }
}

function parsePlan(planJson: string) {
  try {
    return JSON.parse(planJson) as {
      summary?: string;
      nextBestAction?: string;
      steps?: Array<{ title?: string; requiresRobert?: boolean; recommendedDecision?: string }>;
      confidenceScore?: number;
    };
  } catch {
    return {};
  }
}

export async function getOperatorDailyPlan(
  vaId: number,
  dateKey?: string,
  worker?: WorkerOperatorContext,
) {
  const effectiveDateKey = dateKey ?? dateKeyInTimeZone(Date.now(), worker?.timezone);
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(dailyPlans)
    .where(and(eq(dailyPlans.vaId, vaId), eq(dailyPlans.dateKey, effectiveDateKey)))
    .orderBy(desc(dailyPlans.generatedAt))
    .limit(1);
  if (!rows[0]) return null;
  try {
    const schedule = JSON.parse(rows[0].scheduleJson) as Partial<OperatorDailyPlanPayload>;
    if (schedule.version !== 2) return null;
    return { ...rows[0], schedule: schedule as OperatorDailyPlanPayload };
  } catch {
    return null;
  }
}

type StoredOperatorDailyPlan = NonNullable<Awaited<ReturnType<typeof getOperatorDailyPlan>>>;

export function toWorkerOperatorDailyPlan(plan: StoredOperatorDailyPlan | null) {
  if (!plan) return null;

  const { schedule } = plan;
  return {
    vaId: plan.vaId,
    dateKey: plan.dateKey,
    generatedAt: plan.generatedAt,
    totalScheduledMinutes: plan.totalScheduledMinutes,
    planVersion: managerPlanVersion(plan.scheduleJson),
    schedule: {
      version: schedule.version,
      dateKey: schedule.dateKey,
      generatedAt: schedule.generatedAt,
      blocks: schedule.blocks.map((block) => ({
        id: block.id,
        startTime: block.startTime,
        endTime: block.endTime,
        cardId: block.cardId,
        cardName: block.cardName,
        cardUrl: block.cardUrl,
        boardName: block.boardName,
        listName: block.listName,
        stepIds: [...(block.stepIds ?? [])],
        action: block.stepIds?.length
          ? block.action
          : "Open the task and record the next concrete action.",
        priority: block.priority,
        status: block.status,
      })),
      unscheduledCards: schedule.unscheduledCards.map((item) => ({
        cardId: item.cardId,
        cardName: item.cardName,
        reason: "No time block is scheduled for this item today.",
      })),
      planHealth: {
        ...(schedule.planHealth.confidence === 0 ? { confidence: 0 } : {}),
        scheduledMinutes: schedule.planHealth.scheduledMinutes,
        availableMinutes: schedule.planHealth.availableMinutes,
        ...(schedule.planHealth.overlaps === 0 ? { overlaps: 0 } : {}),
        gaps: schedule.planHealth.gaps,
      },
      constraints: schedule.constraints,
      ...(schedule.robertItems.length === 0 ? { robertItems: [] } : {}),
      ...(schedule.auditTrail.length === 0 ? { auditTrail: [] } : {}),
    },
  };
}

export async function generateOperatorDailyPlan(
  vaId: number,
  dateKey: string | undefined,
  force = false,
  worker?: WorkerOperatorContext,
) {
  const effectiveDateKey = dateKey ?? dateKeyInTimeZone(Date.now(), worker?.timezone);
  const existing = await getOperatorDailyPlan(vaId, effectiveDateKey, worker);
  if (existing && !force) return existing;
  const expectedPlanVersion = existing ? managerPlanVersion(existing.scheduleJson) : null;
  const fixedBlocks = protectedBlocks(existing?.schedule ?? null, expectedPlanVersion);
  const protectedStepIdsByCard = new Map<string, Set<number>>();
  const protectedCardLevelWork = new Set<string>();
  for (const block of fixedBlocks) {
    if (!block.cardId) continue;
    if (!block.stepIds.length) {
      protectedCardLevelWork.add(block.cardId);
      continue;
    }
    const stepIds = protectedStepIdsByCard.get(block.cardId) ?? new Set<number>();
    for (const stepId of block.stepIds) stepIds.add(stepId);
    protectedStepIdsByCard.set(block.cardId, stepIds);
  }

  const [plans, states, scores, schedule] = await Promise.all([
    getAllAptlssPlans(vaId),
    getAllCardStates(vaId),
    getAllPriorityScores(vaId),
    getScheduleSettings(vaId, worker),
  ]);
  const generatedAt = new Date();
  const { windows: scheduleWindows, breaks, availableMinutes } = buildAvailableWindows(schedule);
  const windows = subtractProtectedBlocks(scheduleWindows, fixedBlocks);
  const stateMap = new Map(states.map((item) => [item.cardId, item]));
  const scoreMap = new Map(scores.map((item) => [item.cardId, item]));
  const indexedSteps = indexWorkQueueSteps(await getOpenStepsForCards(vaId, plans.map((plan) => plan.cardId)));
  const remainingStepsByCardId = new Map([...indexedSteps].map(([cardId, steps]) => [
    cardId,
    steps.filter(step => step.status !== "complete" && step.status !== "obsolete"
      && !protectedStepIdsByCard.get(cardId)?.has(step.id)),
  ]));
  const hasRemainingWork = (cardId: string) => {
    if (protectedCardLevelWork.has(cardId)) return false;
    if (!protectedStepIdsByCard.has(cardId)) return true;
    return (remainingStepsByCardId.get(cardId)?.length ?? 0) > 0;
  };

  const localDay = new Date(`${effectiveDateKey}T12:00:00Z`).getUTCDay();
  if (worker && !worker.workingDays.includes(localDay)) {
    const dayName = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" })
      .format(new Date(`${effectiveDateKey}T12:00:00Z`));
    const scheduledMinutes = fixedBlocks.reduce((total, block) => total + toMinutes(block.endTime) - toMinutes(block.startTime), 0);
    const payload: OperatorDailyPlanPayload = {
      version: 2,
      dateKey: effectiveDateKey,
      generatedAt: generatedAt.toISOString(),
      blocks: fixedBlocks,
      robertItems: [],
      unscheduledCards: plans.filter(plan => hasRemainingWork(plan.cardId)).map((plan) => ({
        cardId: plan.cardId,
        cardName: plan.cardName,
        reason: `${dayName} is protected time for this worker.`,
      })),
      planHealth: { confidence: 100, scheduledMinutes, availableMinutes: 0, overlaps: 0, gaps: 0 },
      constraints: schedule,
      auditTrail: [{ at: generatedAt.toISOString(), action: "generated", detail: `Protected ${dayName} plan created.` }],
    };
    return persistOperatorPlan(vaId, payload, expectedPlanVersion, schedule, worker);
  }

  const candidates = plans.filter(plan => hasRemainingWork(plan.cardId)).map((plan) => {
    const steps = remainingStepsByCardId.get(plan.cardId) ?? [];
    const state = stateMap.get(plan.cardId);
    const score = scoreMap.get(plan.cardId);
    const parsed = parsePlan(plan.planJson);
    const stepEstimate = steps.reduce((total, step) => total + step.estimatedMinutes, 0);
    const estimatedSource = protectedStepIdsByCard.has(plan.cardId)
      ? stepEstimate || score?.estimatedRemainingMinutes
      : score?.estimatedRemainingMinutes || stepEstimate;
    const estimatedMinutes = Math.max(
      30,
      Math.min(120, estimatedSource || 30),
    );
    return { plan, parsed, state, score, steps, estimatedMinutes };
  });

  candidates.sort((left, right) => {
    const lane = getWorkLaneRank(left.plan.listName) - getWorkLaneRank(right.plan.listName);
    if (lane !== 0) return lane;
    return (right.score?.score ?? 0) - (left.score?.score ?? 0);
  });

  const blocks: OperatorPlanBlock[] = [...fixedBlocks];
  const unscheduledCards: OperatorDailyPlanPayload["unscheduledCards"] = [];
  const robertItems: OperatorDailyPlanPayload["robertItems"] = [];
  let windowIndex = 0;
  let cursor = windows[0]?.start ?? toMinutes(schedule.endTime);

  for (const candidate of candidates) {
    const robertSteps = candidate.steps.filter((step) => step.requiresRobert && step.status !== "complete");
    robertItems.push(...robertSteps.map((step) => ({
      stepId: step.id,
      cardId: candidate.plan.cardId,
      cardName: candidate.plan.cardName,
      decision: step.recommendedDecision || step.title,
    })));

    let duration = Math.ceil(candidate.estimatedMinutes / 15) * 15;
    while (windows[windowIndex] && cursor >= windows[windowIndex].end) {
      windowIndex += 1;
      cursor = windows[windowIndex]?.start ?? cursor;
    }
    const window = windows[windowIndex];
    if (!window) {
      unscheduledCards.push({
        cardId: candidate.plan.cardId,
        cardName: candidate.plan.cardName,
        reason: "No working time remains.",
      });
      continue;
    }
    duration = Math.min(duration, window.end - cursor);
    if (duration < 30) {
      windowIndex += 1;
      cursor = windows[windowIndex]?.start ?? cursor;
      const nextWindow = windows[windowIndex];
      if (!nextWindow) {
        unscheduledCards.push({
          cardId: candidate.plan.cardId,
          cardName: candidate.plan.cardName,
          reason: "No working block of at least 30 minutes remains.",
        });
        continue;
      }
      duration = Math.min(Math.ceil(candidate.estimatedMinutes / 15) * 15, nextWindow.end - cursor);
    }

    const end = cursor + duration;
    blocks.push({
      id: `${effectiveDateKey}:${candidate.plan.cardId}:${cursor}`,
      startTime: toTime(cursor),
      endTime: toTime(end),
      cardId: candidate.plan.cardId,
      cardName: candidate.plan.cardName,
      cardUrl: candidate.plan.cardUrl,
      boardName: candidate.plan.boardName,
      listName: candidate.plan.listName,
      action: candidate.steps[0]?.title || candidate.parsed.nextBestAction || candidate.parsed.summary || "Review and define the next concrete action.",
      stepIds: candidate.steps.slice(0, 3).map((step) => step.id),
      priority: candidate.score?.tier ?? "MEDIUM",
      score: candidate.score?.score ?? 0,
      state: candidate.state?.state ?? "NEW_UNTRIAGED",
      status: "planned",
      notes: candidate.state?.stateReason ?? "",
      flags: [
        ...(candidate.state?.isOverdue ? ["Overdue"] : []),
        ...(robertSteps.length ? ["Robert"] : []),
        ...(/BLOCKED|WAITING/.test(candidate.state?.state ?? "") ? ["Blocked"] : []),
      ],
    });
    cursor = end;
  }

  blocks.sort((left, right) => toMinutes(left.startTime) - toMinutes(right.startTime));
  const scheduledMinutes = blocks.reduce((total, block) => total + toMinutes(block.endTime) - toMinutes(block.startTime), 0);
  const confidenceValues = candidates.map((item) => item.parsed.confidenceScore).filter((value): value is number => typeof value === "number");
  const evidenceConfidence = confidenceValues.length
    ? Math.round(confidenceValues.reduce((total, value) => total + value, 0) / confidenceValues.length)
    : 60;
  const confidence = Math.max(20, Math.min(98, evidenceConfidence - unscheduledCards.length * 2));
  const payload: OperatorDailyPlanPayload = {
    version: 2,
    dateKey: effectiveDateKey,
    generatedAt: generatedAt.toISOString(),
    blocks,
    robertItems,
    unscheduledCards,
    planHealth: {
      confidence,
      scheduledMinutes,
      availableMinutes,
      overlaps: 0,
      gaps: Math.max(0, availableMinutes - scheduledMinutes),
    },
    constraints: { ...schedule, breaks },
    auditTrail: [{
      at: generatedAt.toISOString(),
      action: force ? "regenerated" : "generated",
      detail: `${blocks.length} blocks scheduled; ${unscheduledCards.length} cards unscheduled.`,
    }],
  };
  return persistOperatorPlan(vaId, payload, expectedPlanVersion, schedule, worker);
}

async function persistOperatorPlan(
  vaId: number,
  payload: OperatorDailyPlanPayload,
  expectedPlanVersion: string | null,
  expectedSchedule: ScheduleSettings,
  workerContext?: WorkerOperatorContext,
) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const values = operatorPlanValues(vaId, payload);
  await db.transaction(async (tx) => {
    const [worker] = await tx.select({ id: users.id }).from(users)
      .where(eq(users.id, vaId)).limit(1).for("update");
    if (!worker) throw new Error("Worker account not found");

    const [current] = await tx.select({ scheduleJson: dailyPlans.scheduleJson }).from(dailyPlans)
      .where(and(eq(dailyPlans.vaId, vaId), eq(dailyPlans.dateKey, payload.dateKey)))
      .limit(1).for("update");
    const currentPlanVersion = current ? managerPlanVersion(current.scheduleJson) : null;
    if (currentPlanVersion !== expectedPlanVersion) {
      throw new OperatorDailyPlanConflictError(expectedPlanVersion, currentPlanVersion);
    }
    const currentPayload = savedPlanPayload(current?.scheduleJson);
    assertProtectedBlocksPreserved(currentPayload, payload, expectedPlanVersion, currentPlanVersion);
    await assertNoActiveTimer(tx, vaId, expectedPlanVersion, currentPlanVersion);
    const currentWorker = await readCurrentWorkerContext(tx, vaId);
    if (workerContext && workerScheduleIdentity(currentWorker) !== workerScheduleIdentity(workerContext)) {
      throw new OperatorDailyPlanConflictError(
        expectedPlanVersion,
        currentPlanVersion,
        "Worker hours, workdays, or timezone changed while this day plan was being prepared. No plan was saved; reload the schedule and try again.",
      );
    }
    await assertCurrentSchedule(tx, vaId, expectedSchedule, profileSchedule(currentWorker), expectedPlanVersion, currentPlanVersion);

    const cardIds = [...new Set([
      ...payload.blocks.flatMap((block) => block.cardId !== null ? [block.cardId] : []),
      ...payload.robertItems.map((item) => item.cardId),
      ...payload.unscheduledCards.map((item) => item.cardId),
    ])];
    const stepIds = [...new Set([
      ...payload.blocks.flatMap((block) => block.stepIds),
      ...payload.robertItems.map((item) => item.stepId),
    ])];
    const ownedCards = cardIds.length
      ? await tx.select({ cardId: aptlssPlans.cardId }).from(aptlssPlans)
        .where(and(eq(aptlssPlans.vaId, vaId), inArray(aptlssPlans.cardId, cardIds)))
        .for("update")
      : [];
    const ownedSteps = stepIds.length
      ? await tx.select({ id: aptlssSteps.id, cardId: aptlssSteps.cardId }).from(aptlssSteps)
        .where(and(eq(aptlssSteps.vaId, vaId), inArray(aptlssSteps.id, stepIds)))
        .for("update")
      : [];
    try {
      assertOperatorDailyPlanReferencesInScope(
        payload,
        new Set(ownedCards.map((card) => card.cardId)),
        new Map(ownedSteps.map((step) => [step.id, step.cardId])),
      );
    } catch (error) {
      if (!(error instanceof OperatorDailyPlanScopeError)) throw error;
      throw new OperatorDailyPlanConflictError(
        expectedPlanVersion,
        currentPlanVersion,
        "A task assignment changed while this day plan was being prepared. No plan was saved; reload the work queue and try again.",
      );
    }

    await tx.insert(dailyPlans).values(values).onConflictDoUpdate({ target: [dailyPlans.vaId, dailyPlans.dateKey], set: values });
  }, { isolationLevel: "serializable" });
  return getOperatorDailyPlan(vaId, payload.dateKey);
}

function operatorPlanValues(vaId: number, payload: OperatorDailyPlanPayload) {
  return {
    vaId,
    dateKey: payload.dateKey,
    scheduleJson: JSON.stringify(payload),
    dailySummary: payload.blocks.length
      ? `${payload.blocks.length} focused blocks scheduled from the current APTLSS state.`
      : "No work scheduled.",
    topPriority: payload.blocks[0]?.cardName ?? null,
    totalScheduledMinutes: payload.planHealth.scheduledMinutes,
    robertItemsCount: payload.robertItems.length,
    autoGenerated: true,
    generatedAt: new Date(payload.generatedAt),
  };
}

export async function updateOperatorDailyPlan(
  vaId: number,
  payload: OperatorDailyPlanPayload,
  expectedPlanVersion: string | null,
) {
  if (payload.version !== 2) throw new Error("Unsupported plan version");
  validateOperatorPlanBlocks({ blocks: payload.blocks, schedule: payload.constraints });
  const sorted = [...payload.blocks].sort((left, right) => toMinutes(left.startTime) - toMinutes(right.startTime));
  for (let index = 1; index < sorted.length; index += 1) {
    if (toMinutes(sorted[index].startTime) < toMinutes(sorted[index - 1].endTime)) {
      throw new Error("Daily plan blocks cannot overlap");
    }
  }

  const cardIds = [...new Set([
    ...payload.blocks.flatMap((block) => block.cardId !== null ? [block.cardId] : []),
    ...payload.robertItems.map((item) => item.cardId),
    ...payload.unscheduledCards.map((item) => item.cardId),
  ])];
  const stepIds = [...new Set([
    ...payload.blocks.flatMap((block) => block.stepIds),
    ...payload.robertItems.map((item) => item.stepId),
  ])];
  const values = operatorPlanValues(vaId, payload);
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  await db.transaction(async (tx) => {
    const [worker] = await tx.select({ id: users.id }).from(users)
      .where(eq(users.id, vaId)).limit(1).for("update");
    if (!worker) throw new Error("Worker account not found");

    const [current] = await tx.select({ scheduleJson: dailyPlans.scheduleJson }).from(dailyPlans)
      .where(and(eq(dailyPlans.vaId, vaId), eq(dailyPlans.dateKey, payload.dateKey)))
      .limit(1).for("update");
    const currentPlanVersion = current ? managerPlanVersion(current.scheduleJson) : null;
    if (currentPlanVersion !== expectedPlanVersion) {
      throw new OperatorDailyPlanConflictError(expectedPlanVersion, currentPlanVersion);
    }
    const currentPayload = savedPlanPayload(current?.scheduleJson);
    assertProtectedBlocksPreserved(currentPayload, payload, expectedPlanVersion, currentPlanVersion);
    await assertNoActiveTimer(tx, vaId, expectedPlanVersion, currentPlanVersion);
    const ownedCards = cardIds.length
      ? await tx.select({ cardId: aptlssPlans.cardId }).from(aptlssPlans)
        .where(and(eq(aptlssPlans.vaId, vaId), inArray(aptlssPlans.cardId, cardIds)))
        .for("update")
      : [];

    const ownedSteps = stepIds.length
      ? await tx.select({ id: aptlssSteps.id, cardId: aptlssSteps.cardId }).from(aptlssSteps)
        .where(and(eq(aptlssSteps.vaId, vaId), inArray(aptlssSteps.id, stepIds)))
        .for("update")
      : [];
    assertOperatorDailyPlanReferencesInScope(
      payload,
      new Set(ownedCards.map((card) => card.cardId)),
      new Map(ownedSteps.map((step) => [step.id, step.cardId])),
    );

    const currentWorker = await readCurrentWorkerContext(tx, vaId);
    const expectedSchedule = currentPayload?.constraints ?? payload.constraints;
    await assertCurrentSchedule(tx, vaId, expectedSchedule, profileSchedule(currentWorker), expectedPlanVersion, currentPlanVersion);

    await tx.insert(dailyPlans).values(values).onConflictDoUpdate({ target: [dailyPlans.vaId, dailyPlans.dateKey], set: values });
  }, { isolationLevel: "serializable" });

  return getOperatorDailyPlan(vaId, payload.dateKey);
}

export function validateOperatorPlanBlocks({
  blocks,
  schedule,
}: {
  blocks: OperatorPlanBlock[];
  schedule: ScheduleSettings;
}) {
  const sorted = [...blocks].sort((left, right) => toMinutes(left.startTime) - toMinutes(right.startTime));
  const { windows, availableMinutes } = buildAvailableWindows(schedule);
  let scheduledMinutes = 0;
  for (const block of sorted) {
    const start = toMinutes(block.startTime);
    const end = toMinutes(block.endTime);
    if (end <= start || !windows.some((window) => start >= window.start && end <= window.end)) {
      throw new Error("Daily plan blocks must fit within configured working windows");
    }
    scheduledMinutes += end - start;
  }
  for (let index = 1; index < sorted.length; index += 1) {
    if (toMinutes(sorted[index].startTime) < toMinutes(sorted[index - 1].endTime)) {
      throw new Error("Daily plan blocks cannot overlap");
    }
  }
  if (scheduledMinutes > availableMinutes) {
    throw new Error("Daily plan exceeds available working minutes");
  }
}

export function replanFutureBlocks({
  blocks,
  schedule,
  nowTime,
}: {
  blocks: OperatorPlanBlock[];
  schedule: ScheduleSettings;
  nowTime: string;
}) {
  const now = toMinutes(nowTime);
  const future = blocks
    .filter((block) => block.status === "planned" && toMinutes(block.startTime) >= now)
    .sort((left, right) => toMinutes(left.startTime) - toMinutes(right.startTime));
  const preserved = blocks.filter((block) => !future.includes(block));
  const { windows } = buildAvailableWindows(schedule);
  const protectedEnd = preserved.reduce((latest, block) => {
    const end = toMinutes(block.endTime);
    return end > now ? Math.max(latest, end) : latest;
  }, now);

  const replanned: OperatorPlanBlock[] = [];
  const unscheduled: OperatorPlanBlock[] = [];
  let cursor = protectedEnd;
  let windowIndex = 0;

  for (const original of future) {
    const duration = Math.max(15, toMinutes(original.endTime) - toMinutes(original.startTime));
    while (windows[windowIndex] && cursor >= windows[windowIndex].end) windowIndex += 1;
    if (windows[windowIndex] && cursor < windows[windowIndex].start) cursor = windows[windowIndex].start;
    while (windows[windowIndex] && cursor + duration > windows[windowIndex].end) {
      windowIndex += 1;
      if (windows[windowIndex]) cursor = Math.max(cursor, windows[windowIndex].start);
    }
    if (!windows[windowIndex] || cursor + duration > windows[windowIndex].end) {
      unscheduled.push(original);
      continue;
    }
    const next = { ...original, startTime: toTime(cursor), endTime: toTime(cursor + duration) };
    replanned.push(next);
    cursor += duration;
  }

  return {
    blocks: [...preserved, ...replanned].sort((left, right) => toMinutes(left.startTime) - toMinutes(right.startTime)),
    unscheduled,
  };
}


function timeInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

export async function replanOperatorRemainingDay({
  vaId,
  dateKey,
  completedBlockIds = [],
  activeBlockId,
  now = new Date(),
  worker,
}: {
  vaId: number;
  dateKey?: string;
  completedBlockIds?: string[];
  activeBlockId?: string;
  now?: Date;
  worker?: WorkerOperatorContext;
}) {
  const existing = await getOperatorDailyPlan(vaId, dateKey, worker);
  if (!existing) throw new Error("No saved plan to replan");
  const completed = new Set(completedBlockIds);
  const blocks = existing.schedule.blocks.map((block) => {
    if (completed.has(block.id)) return { ...block, status: "done" as const };
    if (activeBlockId === block.id) return { ...block, status: "active" as const };
    return block;
  });
  const nowTime = timeInTimeZone(now, worker?.timezone ?? "UTC");
  const result = replanFutureBlocks({ blocks, schedule: existing.schedule.constraints, nowTime });
  const unscheduledCards = [
    ...existing.schedule.unscheduledCards,
    ...result.unscheduled.map((block) => ({
      cardId: block.cardId ?? block.id,
      cardName: block.cardName,
      reason: "No remaining protected work window can fit this block.",
    })),
  ];
  const scheduledMinutes = result.blocks
    .filter((block) => block.status !== "skipped")
    .reduce((total, block) => total + toMinutes(block.endTime) - toMinutes(block.startTime), 0);
  const payload: OperatorDailyPlanPayload = {
    ...existing.schedule,
    generatedAt: now.toISOString(),
    blocks: result.blocks,
    unscheduledCards,
    planHealth: {
      ...existing.schedule.planHealth,
      scheduledMinutes,
      gaps: Math.max(0, existing.schedule.planHealth.availableMinutes - scheduledMinutes),
    },
    auditTrail: [
      ...existing.schedule.auditTrail,
      {
        at: now.toISOString(),
        action: "replanned_remaining_day",
        detail: `${result.blocks.filter((block) => block.status === "planned").length} future blocks retained; ${result.unscheduled.length} moved to unscheduled.`,
      },
    ],
  };
  return updateOperatorDailyPlan(vaId, payload, managerPlanVersion(existing.scheduleJson));
}
