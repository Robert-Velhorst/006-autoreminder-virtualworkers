import { isDeepStrictEqual } from "node:util";
import type {
  ManagerAction,
  ManagerCard,
  ManagerResult,
} from "../shared/aptlssManager";
import {
  dateKeyInTimeZone,
  dayOfWeekInTimeZone,
  timeKeyInTimeZone,
  zonedDateTimeToUtc,
} from "../shared/workerTime";
import type {
  OperatorDailyPlanPayload,
  OperatorPlanBlock,
} from "./operatorDailyPlan";
import type { WorkerOperatorContext } from "./workerOperatorContext";
import type {
  ManagerPlanImpact,
  ManagerDeadlinePosition,
  ManagerDependencyPosition,
  ManagerPlanBuffer,
} from "../shared/aptlssManagerPlanImpact";

const minutes = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};
const time = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const overlap = (
  a: { start: number; end: number },
  b: { start: number; end: number }
) => a.end > a.start && b.end > b.start && a.start < b.end && b.start < a.end;

function freeWindows(
  worker: WorkerOperatorContext,
  nowMinute: number,
  occupied: Array<{ start: number; end: number }>
) {
  const start = Math.max(minutes(worker.workStartTime), nowMinute);
  const end = minutes(worker.workEndTime);
  const breaks = worker.breaks
    .map(b => ({
      start: Math.max(minutes(worker.workStartTime), minutes(b.startTime)),
      end: Math.min(end, minutes(b.startTime) + b.durationMinutes),
    }))
    .filter(b => b.end > b.start);
  const unavailable = [...breaks, ...occupied]
    .filter(b => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const merged: typeof unavailable = [];
  for (const item of unavailable) {
    const last = merged.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else merged.push({ ...item });
  }
  const windows: Array<{ start: number; end: number }> = [];
  let cursor = start;
  for (const item of merged) {
    if (item.end <= cursor) continue;
    if (item.start > cursor)
      windows.push({ start: cursor, end: Math.min(item.start, end) });
    cursor = Math.max(cursor, item.end);
  }
  if (cursor < end) windows.push({ start: cursor, end });
  const mergedBreaks: typeof breaks = [];
  for (const item of [...breaks].sort((a, b) => a.start - b.start)) {
    const last = mergedBreaks.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else mergedBreaks.push({ ...item });
  }
  return {
    windows: windows.filter(w => w.end > w.start),
    breaks,
    availableMinutes: Math.max(
      0,
      end -
        minutes(worker.workStartTime) -
        mergedBreaks.reduce((n, b) => n + b.end - b.start, 0)
    ),
  };
}

function notBeforeInstant(value: string) {
  // Date-only and offset-free values depend on the host timezone. Fail closed.
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      value
    );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  const instant = Date.parse(value);
  if (
    !Number.isFinite(instant) ||
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}` ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second ?? 0) > 59
  )
    return null;
  return instant;
}

export function reconcileManagerPlan(args: {
  result: ManagerResult;
  cards: ManagerCard[];
  existing: OperatorDailyPlanPayload | null;
  worker: WorkerOperatorContext;
  now: Date;
  activeTimer: { cardId: string | null; planBlockId: string | null } | null;
}) {
  const { result, cards, existing, worker, now, activeTimer } = args;
  const dateKey = dateKeyInTimeZone(now, worker.timezone),
    nowTime = timeKeyInTimeZone(now, worker.timezone);
  const currentMinute =
    minutes(nowTime) +
    (now.getUTCSeconds() * 1000 + now.getUTCMilliseconds()) / 60000;
  const nowMinute = Math.ceil(currentMinute);
  const workingDay = worker.workingDays.includes(
    dayOfWeekInTimeZone(now, worker.timezone)
  );
  const sameDayBaseline = existing?.dateKey === dateKey ? existing : null;
  const todayBlocks = sameDayBaseline?.blocks ?? [];
  const storedTimezone = sameDayBaseline?.planningImpact?.timezone;
  const baselineTimezone =
    typeof storedTimezone === "string" && storedTimezone.length > 0
      ? storedTimezone
      : null;
  const timezoneChanged =
    !!sameDayBaseline &&
    baselineTimezone !== null &&
    baselineTimezone !== worker.timezone;
  const baselineTimezoneUnknown =
    !!sameDayBaseline &&
    sameDayBaseline.blocks.length > 0 &&
    baselineTimezone === null;
  const timerCandidates =
    !activeTimer?.planBlockId && activeTimer?.cardId
      ? todayBlocks.filter(
          b =>
            b.cardId === activeTimer.cardId &&
            b.status !== "done" &&
            b.status !== "skipped"
        )
      : [];
  const timerBlock = activeTimer?.planBlockId
    ? todayBlocks.find(b => b.id === activeTimer.planBlockId)
    : (timerCandidates.find(b => b.status === "active") ??
      timerCandidates.find(
        b =>
          minutes(b.startTime) <= currentMinute &&
          minutes(b.endTime) > currentMinute
      ) ??
      [...timerCandidates]
        .filter(b => minutes(b.startTime) <= currentMinute)
        .sort((a, b) => minutes(b.startTime) - minutes(a.startTime))[0] ??
      [...timerCandidates].sort(
        (a, b) => minutes(a.startTime) - minutes(b.startTime)
      )[0]);
  const timerStart = timerBlock ? minutes(timerBlock.startTime) : Number.NaN;
  const timerEnd = timerBlock ? minutes(timerBlock.endTime) : Number.NaN;
  const timerMappingUnresolved =
    activeTimer !== null &&
    (!timerBlock ||
      (activeTimer.cardId !== null && timerBlock.cardId !== activeTimer.cardId) ||
      timerBlock.status === "skipped" ||
      !Number.isFinite(timerStart) ||
      !Number.isFinite(timerEnd) ||
      timerEnd <= timerStart ||
      timerStart > currentMinute);
  const preserved = todayBlocks
    .filter(
      b =>
        b.status !== "planned" ||
        minutes(b.startTime) < currentMinute ||
        b === timerBlock
    )
    .map(b => structuredClone(b));
  const matches = (
    a: Pick<ManagerAction, "id" | "cardId" | "stepIds">,
    b: OperatorPlanBlock
  ) => {
    if (a.cardId === b.cardId && a.stepIds.length && b.stepIds.length)
      return a.stepIds.some(id => b.stepIds.includes(id));
    return a.id === b.id;
  };
  const occupied = preserved.map(b => ({
    start: minutes(b.startTime),
    end: minutes(b.endTime),
  }));
  const reservations: ManagerPlanImpact["buffer"]["reservations"] = [];
  for (const activeBlock of preserved.filter(
    b =>
      b.status === "active" ||
      (b.id === timerBlock?.id && b.status !== "done" && b.status !== "skipped")
  )) {
    if (minutes(activeBlock.endTime) > currentMinute) continue;
    const action =
      result.actions.find(a => a.id === activeBlock.id) ??
      result.actions.find(a => matches(a, activeBlock));
    const estimate = action?.minutes.likely;
    const hasValidEstimate =
      estimate !== undefined && Number.isFinite(estimate) && estimate > 0;
    const reservation = {
      start: nowMinute,
      end: Math.min(
        minutes(worker.workEndTime),
        nowMinute +
          (hasValidEstimate
            ? Math.max(5, Math.ceil(estimate))
            : 30)
      ),
    };
    occupied.push(reservation);
    reservations.push({
      blockId: activeBlock.id,
      startTime: time(reservation.start),
      endTime: time(reservation.end),
      basis: hasValidEstimate
        ? "action_likely_estimate"
        : "planner_fallback_30_minutes",
    });
  }
  const { windows, breaks, availableMinutes } = freeWindows(
    worker,
    nowMinute,
    occupied
  );
  const cardMap = new Map(cards.map(c => [c.id, c]));
  const actionsById = new Map(result.actions.map(a => [a.id, a]));
  const completedBlocks = (existing?.blocks ?? []).filter(
    b => b.status === "done"
  );
  const stepComplete = (cardId: string, stepId: number) =>
    cardMap.get(cardId)?.steps.some(s => s.id === stepId && s.complete) ===
      true ||
    completedBlocks.some(
      b => b.cardId === cardId && b.stepIds.includes(stepId)
    );
  const actionComplete = (a: ManagerAction) =>
    completedBlocks.some(
      b =>
        b.id === a.id &&
        (!a.stepIds.length ||
          a.stepIds.every(id => b.stepIds.includes(id)))
    ) ||
    (a.stepIds.length > 0 && a.stepIds.every(id => stepComplete(a.cardId, id)));
  const dependencyComplete = (ref: string, cardId: string) => {
    const target = actionsById.get(ref);
    if (target) return actionComplete(target);
    const colon = ref.lastIndexOf(":");
    const stepRef = colon < 0 ? ref : ref.slice(colon + 1);
    if (/^-?\d+$/.test(stepRef))
      return stepComplete(
        colon < 0 ? cardId : ref.slice(0, colon),
        Number(stepRef)
      );
    return completedBlocks.some(b => b.id === ref);
  };
  const candidates = result.actions.flatMap(a => {
    if (actionComplete(a)) return [];
    if (!a.stepIds.length)
      return preserved.some(b => matches(a, b)) ? [] : [a];

    const remainingStepIds = a.stepIds.filter(
      id =>
        !stepComplete(a.cardId, id) &&
        !preserved.some(
          b => b.cardId === a.cardId && b.stepIds.includes(id)
        )
    );
    if (!remainingStepIds.length) return [];
    if (remainingStepIds.length === a.stepIds.length) return [a];

    return [
      {
        ...a,
        id: `${a.id}::remaining::${remainingStepIds.join(",")}`,
        stepIds: remainingStepIds,
      },
    ];
  });
  const blocks: OperatorPlanBlock[] = [...preserved];
  const unscheduled: OperatorDailyPlanPayload["unscheduledCards"] = [];
  const reject = (a: ManagerAction, reason: string) =>
    unscheduled.push({
      cardId: a.cardId,
      cardName: cardMap.get(a.cardId)?.name ?? a.title,
      reason,
    });
  const instantCache = new Map<string, number | null>();
  const dayOffsetCache = new Map<string, number[]>();
  const offsetsForDate = (timezone: string) => {
    const key = `${timezone}:${dateKey}`;
    const cached = dayOffsetCache.get(key);
    if (cached) return cached;
    const utcMidnight = Date.parse(`${dateKey}T00:00:00.000Z`);
    const offsets = new Set<number>();
    for (let hour = -36; hour <= 36; hour += 6) {
      const sample = utcMidnight + hour * 60 * 60 * 1000;
      const localDate = dateKeyInTimeZone(sample, timezone);
      const localTime = timeKeyInTimeZone(sample, timezone);
      const localAsUtc = Date.parse(`${localDate}T${localTime}:00.000Z`);
      offsets.add(Math.round((localAsUtc - sample) / 60000));
    }
    const result = [...offsets];
    dayOffsetCache.set(key, result);
    return result;
  };
  const instantAt = (minute: number, timezone = worker.timezone) => {
    const key = `${timezone}:${minute}`;
    if (instantCache.has(key)) return instantCache.get(key)!;
    if (minute < 0 || minute >= 1440 || !Number.isInteger(minute)) return null;
    const value = zonedDateTimeToUtc(dateKey, time(minute), timezone);
    const localTimeIsValid =
      dateKeyInTimeZone(value, timezone) === dateKey &&
      timeKeyInTimeZone(value, timezone) === time(minute);
    const wallClockUtc = Date.parse(`${dateKey}T${time(minute)}:00.000Z`);
    const ambiguous =
      localTimeIsValid &&
      offsetsForDate(timezone).some(offset => {
        const alternate = wallClockUtc - offset * 60000;
        return (
          alternate !== value.getTime() &&
          dateKeyInTimeZone(alternate, timezone) === dateKey &&
          timeKeyInTimeZone(alternate, timezone) === time(minute)
        );
      });
    const instant = localTimeIsValid && !ambiguous ? value.getTime() : null;
    instantCache.set(key, instant);
    return instant;
  };
  let orderCursor = nowMinute;
  if (!workingDay) {
    const affectedCards = new Set<string>();
    for (const a of candidates) {
      if (affectedCards.has(a.cardId)) continue;
      affectedCards.add(a.cardId);
      unscheduled.push({
        cardId: a.cardId,
        cardName: cardMap.get(a.cardId)?.name ?? a.title,
        reason: "This is a protected non-working day.",
      });
    }
  } else {
    // The manager already supplied the order. Neither priority sorting nor gap
    // filling may turn that order into a different execution sequence.
    for (const a of candidates) {
      if (blocks.some(b => matches(a, b))) continue;
      if (timerMappingUnresolved) {
        reject(
          a,
          "The active timer is not linked to a current or already-started plan block. Verify its task before scheduling additional work."
        );
        continue;
      }
      const card = cardMap.get(a.cardId);
      const blockedCard =
        !!card &&
        /WAIT|HOLD|BLOCK/.test(`${card.state} ${card.list}`.toUpperCase());
      const dependencies = [
        ...a.dependsOn,
        ...(card?.steps
          .filter(s => a.stepIds.includes(s.id))
          .flatMap(s => s.dependsOn) ?? []),
      ];
      const failedDep = dependencies.find(
        dep => !dependencyComplete(dep, a.cardId)
      );
      if (failedDep) {
        reject(
          a,
          `Dependency ${failedDep} must be completed before execution.`
        );
        continue;
      }
      if (
        (a.blocked || blockedCard || !!card?.waiting) &&
        a.kind !== "verify" &&
        a.kind !== "follow_up"
      ) {
        reject(
          a,
          card?.stateReason || "Blocked dependency must be resolved first."
        );
        continue;
      }
      let earliestInstant = now.getTime();
      if (a.notBefore != null) {
        const notBefore = notBeforeInstant(a.notBefore);
        if (notBefore === null) {
          reject(
            a,
            "Invalid or timezone-ambiguous follow-up date must be verified."
          );
          continue;
        }
        if (dateKeyInTimeZone(notBefore, worker.timezone) > dateKey) {
          reject(
            a,
            "Follow-up date is after today; do not execute before that date."
          );
          continue;
        }
        earliestInstant = Math.max(earliestInstant, notBefore);
      }
      if (!Number.isFinite(a.minutes.likely) || a.minutes.likely <= 0) {
        reject(a, "Invalid duration estimate; the value must be positive before scheduling.");
        continue;
      }
      const duration = Math.max(5, Math.ceil(a.minutes.likely));
      const fits = (start: number) => {
        const end = start + duration;
        if (
          start < orderCursor ||
          !windows.some(w => start >= w.start && end <= w.end)
        )
          return false;
        const startInstant = instantAt(start, worker.timezone),
          endInstant = instantAt(end, worker.timezone);
        // HH:mm blocks cannot describe missing clock times or a duration that
        // straddles a DST transition. Move to a whole-duration slot instead.
        return (
          startInstant !== null &&
          endInstant !== null &&
          startInstant >= earliestInstant &&
          endInstant - startInstant === duration * 60000
        );
      };
      const old = todayBlocks.find(
        b => b.id === a.id && b.status === "planned"
      );
      let start =
        old &&
        minutes(old.endTime) - minutes(old.startTime) === duration &&
        fits(minutes(old.startTime))
          ? minutes(old.startTime)
          : undefined;
      if (start === undefined) {
        for (const window of windows) {
          for (
            let candidate = Math.max(window.start, orderCursor);
            candidate + duration <= window.end;
            candidate++
          ) {
            if (fits(candidate)) {
              start = candidate;
              break;
            }
          }
          if (start !== undefined) break;
        }
      }
      if (start === undefined) {
        reject(a, `No full ${duration}-minute working window remains today.`);
        continue;
      }
      const end = start + duration;
      const interval = { start, end };
      if ([...occupied, ...breaks].some(b => overlap(interval, b)))
        throw new Error("Manager plan produced an overlapping block");
      occupied.push(interval);
      orderCursor = end;
      blocks.push({
        id: a.id,
        cardId: a.cardId,
        cardName: card?.name ?? a.title,
        cardUrl: card?.url ?? null,
        boardName: card?.board ?? "Work",
        listName: card?.list ?? "",
        startTime: time(start),
        endTime: time(end),
        action: a.title,
        stepIds: [...a.stepIds],
        priority:
          a.priority >= 80 ? "HIGH" : a.priority >= 40 ? "MEDIUM" : "LOW",
        score: a.priority,
        state: card?.state ?? "READY",
        status: "planned",
        notes: `${a.reason} Evidence: ${a.evidenceIds.join(", ") || "none"}`,
        flags: [a.kind, ...(a.blocked ? ["blocked"] : [])],
      });
    }
  }
  blocks.sort((a, b) => minutes(a.startTime) - minutes(b.startTime));
  let overlaps = 0;
  for (let i = 0; i < blocks.length; i++) {
    const a = {
      start: minutes(blocks[i].startTime),
      end: minutes(blocks[i].endTime),
    };
    for (
      let j = i + 1;
      j < blocks.length && minutes(blocks[j].startTime) < a.end;
      j++
    ) {
      if (
        overlap(a, {
          start: minutes(blocks[j].startTime),
          end: minutes(blocks[j].endTime),
        })
      )
        overlaps++;
    }
  }
  const scheduledMinutes = blocks.reduce(
    (n, b) => n + minutes(b.endTime) - minutes(b.startTime),
    0
  );
  const constraints = {
    startTime: worker.workStartTime,
    endTime: worker.workEndTime,
    breaks: structuredClone(worker.breaks),
  };
  const plan: OperatorDailyPlanPayload = {
    version: 2,
    dateKey,
    generatedAt: now.toISOString(),
    blocks,
    robertItems: result.actions
      .filter(a => a.kind === "decision")
      .map(a => ({
        stepId: a.stepIds[0] ?? 0,
        cardId: a.cardId,
        cardName: cardMap.get(a.cardId)?.name ?? a.title,
        decision: a.title,
      })),
    unscheduledCards: unscheduled,
    planHealth: {
      confidence: 0,
      scheduledMinutes,
      availableMinutes: workingDay ? availableMinutes : 0,
      overlaps,
      gaps: Math.max(0, (workingDay ? availableMinutes : 0) - scheduledMinutes),
    },
    constraints,
    auditTrail: [
      ...(existing?.auditTrail ?? []),
      {
        at: now.toISOString(),
        action: "APTLSS manager reconciliation",
        detail: `${blocks.length} blocks scheduled; ${unscheduled.length} actions unscheduled.`,
      },
    ].slice(-100),
  };
  const comparable = (p: OperatorDailyPlanPayload) => ({
    ...p,
    generatedAt: "",
    auditTrail: [],
    planningImpact: undefined,
  });
  const baseline = sameDayBaseline;
  const previousDeadlineByCard = new Map(
    (baseline?.planningImpact?.deadlines ?? []).map(deadline => [
      deadline.cardId,
      deadline.dueAt,
    ])
  );
  const deadlineChanges = new Map<
    string,
    { before: string | null; after: string | null }
  >();
  for (const [cardId, before] of previousDeadlineByCard) {
    const card = cardMap.get(cardId);
    if (!card) continue;
    const after = card.dueAt;
    const beforeInstant = before ? notBeforeInstant(before) : null;
    const afterInstant = after ? notBeforeInstant(after) : null;
    const sameDeadline =
      before === after ||
      (beforeInstant !== null && beforeInstant === afterInstant);
    if (!sameDeadline) deadlineChanges.set(cardId, { before, after });
  }
  const unchanged =
    !!existing &&
    existing.dateKey === dateKey &&
    !timezoneChanged &&
    !baselineTimezoneUnknown &&
    deadlineChanges.size === 0 &&
    isDeepStrictEqual(comparable(existing), comparable(plan));

  // Compare the candidate before returning it to any caller that can persist it.
  // Neither a slot nor a linked action citation proves real-world completion.
  const scheduleChanged =
    !baseline ||
    timezoneChanged ||
    baselineTimezoneUnknown ||
    !isDeepStrictEqual(baseline.blocks, blocks) ||
    !isDeepStrictEqual(baseline.constraints, constraints);
  const previousById = new Map((baseline?.blocks ?? []).map(block => [block.id, block]));
  const proposedById = new Map(blocks.map(block => [block.id, block]));
  const slot = (block: OperatorPlanBlock) => ({ startTime: block.startTime, endTime: block.endTime });
  const planChanges: NonNullable<ManagerPlanImpact["planChanges"]> = [];
  for (const block of blocks) {
    const before = previousById.get(block.id);
    const timezoneContextChanged =
      (timezoneChanged || baselineTimezoneUnknown) &&
      !preserved.some(item => item.id === block.id);
    const kind = !before
      ? "added"
      : before.startTime !== block.startTime || before.endTime !== block.endTime
        ? "moved"
        : !isDeepStrictEqual(before, block) || timezoneContextChanged
          ? "updated"
          : null;
    if (!kind) continue;
    const action = result.actions.find(item => item.id === block.id);
    const timezoneReason = timezoneChanged
      ? `Worker timezone changed from ${baselineTimezone} to ${worker.timezone}; the same clock time now represents a different instant.`
      : baselineTimezoneUnknown
        ? "The retained plan has no recorded timezone, so its clock time cannot be compared safely with the current schedule."
        : null;
    planChanges.push({
      kind,
      blockId: block.id,
      cardName: block.cardName,
      before: before ? slot(before) : null,
      after: slot(block),
      reason: timezoneContextChanged
        ? timezoneReason!
        : action?.reason ||
          "No specific reason was recorded for this proposed change.",
      assumptionIds: [
        "baseline",
        "worker",
        ...(action ? [`action:${action.id}`] : []),
      ],
    });
  }
  for (const block of baseline?.blocks ?? []) {
    if (proposedById.has(block.id)) continue;
    const notScheduled = unscheduled.find(item => item.cardId === block.cardId);
    planChanges.push({ kind: "removed", blockId: block.id, cardName: block.cardName,
      before: slot(block), after: null,
      reason: notScheduled?.reason || "The proposal does not retain this block; the specific cause needs review.",
      assumptionIds: ["baseline", "worker", ...(result.actions.some(item => item.id === block.id) ? [`action:${block.id}`] : [])] });
  }
  const assumptions: ManagerPlanImpact["assumptions"] = [
    {
      id: "clock",
      inputPath: "now",
      value: now.toISOString(),
      limitation: "Assessment clock, not a source event timestamp.",
    },
    {
      id: "worker",
      inputPath: "worker",
      value: {
        timezone: worker.timezone,
        workingDays: worker.workingDays,
        workStartTime: worker.workStartTime,
        workEndTime: worker.workEndTime,
        breaks: worker.breaks,
      },
      limitation:
        "Configured availability; external calendars and a minimum buffer requirement are not supplied.",
    },
    {
      id: "baseline",
      inputPath: "existing",
      value: existing
        ? {
            dateKey: existing.dateKey,
            generatedAt: existing.generatedAt,
            timezone: existing.planningImpact?.timezone ?? null,
            constraints: existing.constraints,
            blocks: existing.blocks.map(
              ({ id, cardId, startTime, endTime, status, stepIds }) => ({
                id,
                cardId,
                startTime,
                endTime,
                status,
                stepIds,
              })
            ),
          }
        : null,
      limitation:
        "Retained schedule and recorded statuses, not independently verified completion. The prior timezone is required to compare real instants; other-day blocks are not today's alternative.",
    },
    {
      id: "timer",
      inputPath: "activeTimer",
      value: activeTimer,
      limitation: "Timer identity does not establish remaining duration.",
    },
    ...cards.map((card, index) => ({
      id: `card:${card.id}`,
      inputPath: `cards[${index}]`,
      value: {
        id: card.id,
        dueAt: card.dueAt,
        updatedAt: card.updatedAt,
        steps: card.steps.map(({ id, complete, dependsOn }) => ({
          id,
          complete,
          dependsOn,
        })),
      },
      limitation:
        "Current card deadline and recorded dependencies; historical deadlines and underlying source quotes are not supplied.",
    })),
    ...result.actions.map((action, index) => ({
      id: `action:${action.id}`,
      inputPath: `result.actions[${index}]`,
      value: {
        id: action.id,
        cardId: action.cardId,
        stepIds: action.stepIds,
        dependsOn: action.dependsOn,
        minutes: action.minutes,
        evidenceIds: action.evidenceIds,
        blocked: action.blocked,
        notBefore: action.notBefore,
      },
      limitation:
        "Manager proposal and cited IDs, not calibrated duration or independent verification of citations.",
    })),
  ];
  const risks: ManagerPlanImpact["risks"] = [];
  const risk = (
    code: string,
    subjectId: string,
    detail: string,
    assumptionIds: string[],
    requiresReview = false
  ) => risks.push({ code, subjectId, detail, assumptionIds, requiresReview });
  if (timezoneChanged && baseline?.blocks.length)
    risk(
      "timezone_changed",
      "worker-timezone",
      `The worker timezone changed from ${baselineTimezone} to ${worker.timezone}; retained clock times now represent different instants.`,
      ["baseline", "worker", "clock"],
      true
    );
  if (baselineTimezoneUnknown)
    risk(
      "baseline_timezone_unknown",
      "worker-timezone",
      "The retained same-day plan has no recorded timezone, so its clock times cannot be compared safely with the current schedule.",
      ["baseline", "worker", "clock"],
      true
    );
  if (timerMappingUnresolved)
    risk(
      "active_timer_unmapped",
      activeTimer?.planBlockId ?? activeTimer?.cardId ?? "active-timer",
      "The active timer has no valid same-day plan block starting by now; its task and occupied time cannot be established.",
      ["baseline", "timer"],
      true
    );
  const validClock = (value: string) =>
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  const blockInstant = (
    block: OperatorPlanBlock,
    key: "startTime" | "endTime",
    timezone: string | null = worker.timezone
  ) =>
    timezone && validClock(block[key])
      ? instantAt(minutes(block[key]), timezone)
      : null;
  for (const block of blocks) {
    const start = blockInstant(block, "startTime"),
      end = blockInstant(block, "endTime");
    if (
      start === null ||
      end === null ||
      end < start ||
      end - start !==
        (minutes(block.endTime) - minutes(block.startTime)) * 60_000
    )
      risk(
        "invalid_slot",
        block.id,
        "A proposed slot has invalid or timezone-ambiguous boundaries.",
        ["baseline", "worker", "clock"],
        scheduleChanged
      );
  }
  const deadlinePosition = (
    list: OperatorPlanBlock[],
    cardId: string,
    timezone: string | null
  ): ManagerDeadlinePosition => {
    const matching = list.filter(
      b => b.cardId === cardId && b.status !== "skipped"
    );
    const ends = matching.map(b => blockInstant(b, "endTime", timezone));
    const end =
      ends.length && ends.every(value => value !== null)
        ? Math.max(...(ends as number[]))
        : null;
    const card = cardMap.get(cardId);
    const due = card?.dueAt ? notBeforeInstant(card.dueAt) : null;
    const unscheduledActionIds = result.actions
      .filter(
        a =>
          a.cardId === cardId &&
          !actionComplete(a) &&
          !matching.some(b => matches(a, b))
      )
      .map(a => a.id);
    return {
      blockIds: matching.map(b => b.id),
      unscheduledActionIds,
      latestScheduledEndAt: end === null ? null : new Date(end).toISOString(),
      slackMinutes: end !== null && due !== null ? (due - end) / 60_000 : null,
      status: !card
        ? "unknown"
        : !card.dueAt
          ? "deadline_not_provided"
          : due === null
            ? "unknown"
            : !matching.length || unscheduledActionIds.length > 0
              ? "unscheduled"
              : end === null
                ? "unknown"
                : end <= due
                  ? "within_deadline"
                  : "after_deadline",
    };
  };
  const deadlines: ManagerPlanImpact["deadlines"] = [
    ...new Set([
      ...cards.map(c => c.id),
      ...result.actions.map(a => a.cardId),
      ...todayBlocks.flatMap(b => (b.cardId ? [b.cardId] : [])),
    ]),
  ].map(cardId => {
    const before = deadlinePosition(todayBlocks, cardId, baselineTimezone),
      after = deadlinePosition(blocks, cardId, worker.timezone);
    const refs = [
      "baseline",
      "clock",
      "worker",
      ...(cardMap.has(cardId) ? [`card:${cardId}`] : []),
    ];
    const oldEnd = before.latestScheduledEndAt,
      newEnd = after.latestScheduledEndAt;
    const due = cardMap.get(cardId)?.dueAt;
    const dueInstant = due ? notBeforeInstant(due) : null;
    // The timestamp's written date can differ from its date for this worker.
    const dueTodayOrEarlier =
      dueInstant !== null &&
      dateKeyInTimeZone(dueInstant, worker.timezone) <= dateKey;
    const deadlineChanged = deadlineChanges.has(cardId);
    const unfinished =
      result.actions.some(a => a.cardId === cardId && !actionComplete(a)) ||
      cardMap.get(cardId)?.steps.some(step => !step.complete) === true;
    const movement =
      !oldEnd && !newEnd
        ? "unknown"
        : !oldEnd
          ? "added"
          : !newEnd
            ? "removed"
            : oldEnd === newEnd
              ? "unchanged"
              : newEnd > oldEnd
                ? "later"
                : "earlier";
    if (after.status === "unknown")
      risk(
        "deadline_unknown",
        cardId,
        "No unambiguous deadline/slot comparison is supported by the supplied inputs.",
        refs,
        !!due && movement !== "unchanged" && after.blockIds.length > 0
      );
    if (after.status === "after_deadline")
      risk(
        "deadline_overrun",
        cardId,
        "A proposed slot ends after the supplied deadline; this is not a completion forecast.",
        refs,
        before.status !== "after_deadline" ||
          (before.slackMinutes !== null &&
            after.slackMinutes !== null &&
            after.slackMinutes < before.slackMinutes) ||
          (deadlineChanged && dueTodayOrEarlier && unfinished)
      );
    if (deadlineChanged)
      risk(
        "deadline_changed",
        cardId,
        "The task deadline changed since the previous assessment; review its timing and priority.",
        refs,
        after.status === "after_deadline" ||
          (after.status === "unscheduled" && dueTodayOrEarlier && unfinished)
      );
    if (after.status === "unscheduled")
      risk(
        "deadline_unscheduled",
        cardId,
        "A deadline exists but some work has no proposed slot today; a future deadline is not automatically a current-day capacity constraint.",
        refs,
        dueTodayOrEarlier && unfinished
      );
    if (
      baseline &&
      ((before.status === "within_deadline" &&
        ["after_deadline", "unscheduled"].includes(after.status)) ||
        (before.slackMinutes !== null &&
          after.slackMinutes !== null &&
          after.slackMinutes < before.slackMinutes &&
          after.slackMinutes < 0))
    )
      risk(
        "deadline_regression",
        cardId,
        "The candidate worsens the retained schedule's position against the current deadline.",
        refs,
        after.status !== "unscheduled" || dueTodayOrEarlier
      );
    return {
      cardId,
      dueAt: cardMap.get(cardId)?.dueAt ?? null,
      before,
      after,
      movement,
      assumptionIds: refs,
    };
  });
  const predecessorBlocks = (
    ref: string,
    cardId: string,
    list: OperatorPlanBlock[]
  ) => {
    const target = actionsById.get(ref);
    if (target)
      return list.filter(b => matches(target, b) && b.status !== "skipped");
    const direct = list.filter(b => b.id === ref && b.status !== "skipped");
    if (direct.length) return direct;
    const colon = ref.lastIndexOf(":"),
      stepRef = colon < 0 ? ref : ref.slice(colon + 1);
    return /^-?\d+$/.test(stepRef)
      ? list.filter(
          b =>
            b.cardId === (colon < 0 ? cardId : ref.slice(0, colon)) &&
            b.stepIds.includes(Number(stepRef)) &&
            b.status !== "skipped"
        )
      : [];
  };
  const dependencies: ManagerPlanImpact["dependencies"] = [];
  const dependencySubjects: Pick<
    ManagerAction,
    "id" | "cardId" | "stepIds" | "dependsOn"
  >[] = [
    ...result.actions,
    ...todayBlocks
      .filter(b => b.cardId && !result.actions.some(a => matches(a, b)))
      .map(b => ({
        id: b.id,
        cardId: b.cardId!,
        stepIds: b.stepIds,
        dependsOn: [],
      })),
  ];
  for (const a of dependencySubjects) {
    const card = cardMap.get(a.cardId);
    for (const ref of new Set([
      ...a.dependsOn,
      ...(card?.steps
        .filter(s => a.stepIds.includes(s.id))
        .flatMap(s => s.dependsOn) ?? []),
    ])) {
      const complete = dependencyComplete(ref, a.cardId);
      const position = (
        list: OperatorPlanBlock[],
        timezone: string | null
      ): ManagerDependencyPosition => {
        const own = list.filter(b => matches(a, b) && b.status !== "skipped");
        const starts = own.map(b => blockInstant(b, "startTime", timezone));
        const ends = predecessorBlocks(ref, a.cardId, list).map(b =>
          blockInstant(b, "endTime", timezone)
        );
        const start =
          starts.length && starts.every(n => n !== null)
            ? Math.min(...(starts as number[]))
            : null;
        const end =
          ends.length && ends.every(n => n !== null)
            ? Math.max(...(ends as number[]))
            : null;
        return {
          scheduled: own.length > 0,
          startAt: start === null ? null : new Date(start).toISOString(),
          predecessorEndAt: end === null ? null : new Date(end).toISOString(),
          ordering: !own.length
            ? "unscheduled"
            : complete
              ? "recorded_complete"
              : start === null || end === null
                ? "unknown"
                : end <= start
                  ? "before_start"
                  : "violated",
        };
      };
      const colon = ref.lastIndexOf(":");
      const dependencyCardId =
        actionsById.get(ref)?.cardId ??
        (colon < 0 ? a.cardId : ref.slice(0, colon));
      const refs = [
        "baseline",
        ...(actionsById.has(a.id) ? [`action:${a.id}`] : []),
        ...[...new Set([a.cardId, dependencyCardId])]
          .filter(id => cardMap.has(id))
          .map(id => `card:${id}`),
        ...(actionsById.has(ref) ? [`action:${ref}`] : []),
      ];
      const before = position(todayBlocks, baselineTimezone),
        after = position(blocks, worker.timezone);
      dependencies.push({
        actionId: a.id,
        dependency: ref,
        completionRecorded: complete,
        before,
        after,
        assumptionIds: [...new Set(refs)],
      });
      if (after.scheduled && !complete)
        risk(
          "dependency_not_complete",
          a.id,
          `Dependency ${ref} has no recorded completion; slot ordering alone is insufficient.`,
          refs,
          true
        );
    }
  }
  const capacity = (list: OperatorPlanBlock[]): ManagerPlanBuffer => {
    const invalid = list.some(
      b =>
        !validClock(b.startTime) ||
        !validClock(b.endTime) ||
        minutes(b.endTime) < minutes(b.startTime)
    );
    const reserved = reservations.map(r => ({
      start: minutes(r.startTime),
      end: minutes(r.endTime),
    }));
    const open =
      !workingDay || invalid
        ? []
        : freeWindows(worker, nowMinute, [
            ...list.map(b => ({
              start: minutes(b.startTime),
              end: minutes(b.endTime),
            })),
            ...reserved,
          ]).windows;
    const unallocated = invalid
      ? null
      : open.reduce((n, w) => n + w.end - w.start, 0);
    let additional = 0;
    const unknown: string[] = [];
    for (const b of list) {
      if (b.status === "done" || b.status === "skipped") continue;
      const reservation = reservations.find(r => r.blockId === b.id);
      if (minutes(b.endTime) <= currentMinute && !reservation) continue;
      const a =
        result.actions.find(a => a.id === b.id) ??
        result.actions.find(a => matches(a, b));
      if (
        !a ||
        !Number.isFinite(a.minutes.high) ||
        !Number.isFinite(a.minutes.likely) ||
        !Number.isFinite(a.minutes.low) ||
        a.minutes.likely <= 0 ||
        a.minutes.low < 0 ||
        a.minutes.low > a.minutes.likely ||
        a.minutes.high < a.minutes.likely
      ) {
        unknown.push(b.id);
        continue;
      }
      const allocated = reservation
        ? minutes(reservation.endTime) - minutes(reservation.startTime)
        : minutes(b.endTime) - minutes(b.startTime);
      additional += Math.max(0, a.minutes.high - allocated);
    }
    return {
      unallocatedMinutes: unallocated,
      largestWindowMinutes: invalid
        ? null
        : Math.max(0, ...open.map(w => w.end - w.start)),
      additionalHighEstimateMinutes: unknown.length ? null : additional,
      afterHighEstimatesMinutes:
        unknown.length || unallocated === null
          ? null
          : unallocated - additional,
      minimumKnownDeficitMinutes:
        unallocated === null ? null : Math.max(0, additional - unallocated),
      unknownEstimateBlockIds: [...new Set(unknown)],
    };
  };
  const beforeBuffer = baseline ? capacity(todayBlocks) : null,
    afterBuffer = capacity(blocks);
  const bufferRefs = [
    "baseline",
    "worker",
    "clock",
    "timer",
    ...result.actions.map(a => `action:${a.id}`),
  ];
  if (
    afterBuffer.minimumKnownDeficitMinutes !== null &&
    afterBuffer.minimumKnownDeficitMinutes > 0
  )
    risk(
      "high_estimate_buffer_deficit",
      "schedule",
      "Known high duration estimates already exceed the remaining configured capacity; unsupported estimates may increase the deficit.",
      bufferRefs,
      true
    );
  if (
    afterBuffer.unknownEstimateBlockIds.length ||
    afterBuffer.unallocatedMinutes === null
  )
    risk(
      "buffer_unknown",
      "schedule",
      "Some retained slots lack valid timing or high-estimate support.",
      bufferRefs
    );
  const protectedBlocks: ManagerPlanImpact["protectedBlocks"] = preserved.map(
    original => ({
      blockId: original.id,
      reasons: [
        ...(original.status !== "planned"
          ? ["non_planned_status" as const]
          : []),
        ...(minutes(original.startTime) < currentMinute
          ? ["already_started" as const]
          : []),
        ...(original.id === timerBlock?.id ? ["active_timer" as const] : []),
      ],
      preservedExactly:
        blocks.filter(b => b.id === original.id).length === 1 &&
        isDeepStrictEqual(
          original,
          blocks.find(b => b.id === original.id)
        ),
      assumptionIds: ["baseline", "timer", "clock"],
    })
  );
  if (protectedBlocks.some(b => !b.preservedExactly))
    throw new Error(
      "Manager planning preflight rejected a modified protected block"
    );
  const planningImpact: ManagerPlanImpact = {
    version: 1,
    assessedAt: now.toISOString(),
    dateKey,
    timezone: worker.timezone,
    baseline: baseline
      ? "same_day_plan"
      : existing
        ? "different_day_plan"
        : "no_plan",
    scheduleChanged,
    requiresReview: risks.some(risk => risk.requiresReview),
    planChanges,
    availabilityChanged:
      !!baseline &&
      (timezoneChanged ||
        baselineTimezoneUnknown ||
        !isDeepStrictEqual(baseline.constraints, constraints)),
    assumptions: structuredClone(assumptions),
    deadlines,
    dependencies,
    buffer: {
      before: beforeBuffer,
      after: afterBuffer,
      unallocatedDeltaMinutes:
        beforeBuffer?.unallocatedMinutes != null &&
        afterBuffer.unallocatedMinutes !== null
          ? afterBuffer.unallocatedMinutes - beforeBuffer.unallocatedMinutes
          : null,
      reservations,
      assumptionIds: bufferRefs,
    },
    protectedBlocks,
    alternative: {
      kind: "keep_current_plan",
      available: !!baseline,
      blockIds: todayBlocks.map(b => b.id),
      deadlineRiskCardIds: deadlines
        .filter(d =>
          ["after_deadline", "unscheduled", "unknown"].includes(d.before.status)
        )
        .map(d => d.cardId),
      dependencyRiskActionIds: [
        ...new Set(
          dependencies
            .filter(d => d.before.scheduled && !d.completionRecorded)
            .map(d => d.actionId)
        ),
      ],
      buffer: beforeBuffer,
      limitation:
        "Retains only the supplied same-day plan, evaluated against current deadlines and worker settings. It is not a newly optimized or verified-safe alternative.",
    },
    risks,
    limitations: [
      "Scheduled end times are slot boundaries, not promises that a card or project will be completed.",
      "No historical deadline values, external calendar commitments, or minimum buffer policy were supplied.",
      "Capacity uses configured wall-clock windows; high-estimate stress totals do not prove the extra minutes fit before each individual deadline or break.",
      "Recorded step and block completion is accepted as supplied, not independently verified; absence of a dependency declaration does not prove independence.",
      ...(baselineTimezoneUnknown
        ? [
            "The same-day baseline has no recorded timezone; its prior clock labels have no verified real-instant interpretation.",
          ]
        : []),
      ...result.sourceGaps,
    ],
  };
  const changes: string[] = [];
  if (unchanged)
    return { plan: { ...structuredClone(existing!), planningImpact }, changes };
  for (const change of planChanges) {
    if (change.kind === "added") changes.push(`Scheduled ${change.cardName} at ${change.after!.startTime}.`);
    else if (change.kind === "moved") changes.push(`Moved ${change.cardName} from ${change.before!.startTime} to ${change.after!.startTime}.`);
    else if (change.kind === "updated" && timezoneChanged)
      changes.push(
        `Updated the timing context for ${change.cardName}: timezone changed from ${baselineTimezone} to ${worker.timezone}; the same clock time now represents a different instant.`
      );
    else if (change.kind === "updated" && baselineTimezoneUnknown)
      changes.push(
        `Updated the timing context for ${change.cardName}: the saved plan has no recorded timezone, so the clock time cannot be compared safely.`
      );
    else if (change.kind === "updated") changes.push(`Updated the proposed work for ${change.cardName} at ${change.after!.startTime}.`);
    else changes.push(`No longer scheduled: ${change.cardName} at ${change.before!.startTime}. This does not mark the work complete. ${change.reason}`);
  }
  if (planningImpact.availabilityChanged)
    changes.push(
      timezoneChanged || baselineTimezoneUnknown
        ? "Worker timezone context changed or is unknown; review the proposed working slots."
        : "Worker availability changed; review the proposed working slots."
    );
  for (const [cardId, deadline] of deadlineChanges) {
    const cardName = cardMap.get(cardId)?.name ?? cardId;
    changes.push(
      `Deadline changed for ${cardName}: ${deadline.before ?? "none"} to ${deadline.after ?? "none"}. Review its timing and priority.`
    );
  }
  for (const u of unscheduled) {
    const action = result.actions.find(a => a.cardId === u.cardId);
    changes.push(
      `${u.cardName}: ${u.reason}${action?.reason ? ` ${action.reason}.` : ""}${action?.evidenceIds.length ? ` Sources ${action.evidenceIds.join(", ")}.` : ""}`
    );
  }
  if (!changes.length) changes.push("Plan content changed without a block movement; review the proposal details.");
  return { plan: { ...plan, planningImpact }, changes: [...new Set(changes)] };
}
