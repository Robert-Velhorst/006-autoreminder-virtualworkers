import { and, desc, eq } from "drizzle-orm";
import { appSettings, dailyPlans } from "../drizzle/schema";
import { dateKeyInTimeZone } from "../shared/workerTime";
import { getWorkLaneRank } from "../shared/workLanePriority";
import { getAllAptlssPlans } from "./aptlssDb";
import { getDb } from "./db";
import { getAllCardStates, getAllPriorityScores, getOpenStepsForCard } from "./aptlssStepsDb";
import type { WorkerOperatorContext } from "./workerOperatorContext";

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
  try {
    const parsed = JSON.parse(rows[0]?.value ?? "{}") as Partial<ScheduleSettings>;
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

export async function generateOperatorDailyPlan(
  vaId: number,
  dateKey: string | undefined,
  force = false,
  worker?: WorkerOperatorContext,
) {
  const effectiveDateKey = dateKey ?? dateKeyInTimeZone(Date.now(), worker?.timezone);
  const existing = await getOperatorDailyPlan(vaId, effectiveDateKey, worker);
  if (existing && !force) return existing;

  const [plans, states, scores, schedule] = await Promise.all([
    getAllAptlssPlans(vaId),
    getAllCardStates(vaId),
    getAllPriorityScores(vaId),
    getScheduleSettings(vaId, worker),
  ]);
  const generatedAt = new Date();
  const { windows, breaks, availableMinutes } = buildAvailableWindows(schedule);
  const stateMap = new Map(states.map((item) => [item.cardId, item]));
  const scoreMap = new Map(scores.map((item) => [item.cardId, item]));

  const localDay = new Date(`${effectiveDateKey}T12:00:00Z`).getUTCDay();
  if (worker && !worker.workingDays.includes(localDay)) {
    const dayName = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" })
      .format(new Date(`${effectiveDateKey}T12:00:00Z`));
    const payload: OperatorDailyPlanPayload = {
      version: 2,
      dateKey: effectiveDateKey,
      generatedAt: generatedAt.toISOString(),
      blocks: [],
      robertItems: [],
      unscheduledCards: plans.map((plan) => ({
        cardId: plan.cardId,
        cardName: plan.cardName,
        reason: `${dayName} is protected time for this worker.`,
      })),
      planHealth: { confidence: 100, scheduledMinutes: 0, availableMinutes: 0, overlaps: 0, gaps: 0 },
      constraints: schedule,
      auditTrail: [{ at: generatedAt.toISOString(), action: "generated", detail: `Protected ${dayName} plan created.` }],
    };
    return persistOperatorPlan(vaId, payload);
  }

  const candidates = await Promise.all(plans.map(async (plan) => {
    const steps = await getOpenStepsForCard(vaId, plan.cardId);
    const state = stateMap.get(plan.cardId);
    const score = scoreMap.get(plan.cardId);
    const parsed = parsePlan(plan.planJson);
    const estimatedMinutes = Math.max(
      30,
      Math.min(120, score?.estimatedRemainingMinutes || steps.reduce((total, step) => total + step.estimatedMinutes, 0) || 30),
    );
    return { plan, parsed, state, score, steps, estimatedMinutes };
  }));

  candidates.sort((left, right) => {
    const lane = getWorkLaneRank(left.plan.listName) - getWorkLaneRank(right.plan.listName);
    if (lane !== 0) return lane;
    return (right.score?.score ?? 0) - (left.score?.score ?? 0);
  });

  const blocks: OperatorPlanBlock[] = [];
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
  return persistOperatorPlan(vaId, payload);
}

async function persistOperatorPlan(vaId: number, payload: OperatorDailyPlanPayload) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const values = {
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
  await db.insert(dailyPlans).values(values).onDuplicateKeyUpdate({ set: values });
  return getOperatorDailyPlan(vaId, payload.dateKey);
}

export async function updateOperatorDailyPlan(vaId: number, payload: OperatorDailyPlanPayload) {
  if (payload.version !== 2) throw new Error("Unsupported plan version");
  validateOperatorPlanBlocks({ blocks: payload.blocks, schedule: payload.constraints });
  return persistOperatorPlan(vaId, payload);
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
  return persistOperatorPlan(vaId, payload);
}
