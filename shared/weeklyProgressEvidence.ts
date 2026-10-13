export type WeeklyTimeEvidence = {
  label: string;
  detail: string;
  tone: "neutral" | "attention";
};

function formatHours(value: number) {
  return `${Math.round(value * 10) / 10}h`;
}

export function describeWeeklyTimeEvidence(
  trackedHours: number,
  scheduledHours: number | null,
): WeeklyTimeEvidence {
  const tracked = Math.max(0, Number.isFinite(trackedHours) ? trackedHours : 0);
  if (scheduledHours == null || !Number.isFinite(scheduledHours) || scheduledHours <= 0) {
    return {
      label: `${formatHours(tracked)} tracked`,
      detail: "No scheduled-hours comparison is available for this week.",
      tone: "neutral",
    };
  }

  const scheduled = Math.max(0, scheduledHours);
  const label = `${formatHours(tracked)} tracked of ${formatHours(scheduled)} scheduled`;
  if (tracked > scheduled) {
    return {
      label,
      detail: `Tracked time is ${formatHours(tracked - scheduled)} above the available schedule.`,
      tone: "attention",
    };
  }

  return {
    label,
    detail: `${Math.round((tracked / scheduled) * 100)}% of scheduled time has tracked evidence.`,
    tone: "neutral",
  };
}
