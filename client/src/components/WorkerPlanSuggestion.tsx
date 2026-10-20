import React from "react";
import type { WorkerManagerPlanImpact } from "@shared/workerManagerView";

type Props = {
  impact?: WorkerManagerPlanImpact | null;
  expectedPlanVersion?: string | null;
  currentPlanVersion?: string | null;
  currentDateKey: string;
  hasSavedPlan: boolean;
  applied?: boolean;
};

export function workerPlanSuggestionIsCurrent({ impact, expectedPlanVersion, currentPlanVersion, currentDateKey, hasSavedPlan, applied }: Props) {
  if (!impact || impact.dateKey !== currentDateKey || !impact.scheduleChanged || applied) return false;
  return hasSavedPlan
    ? impact.baseline === "same_day_plan" && !!expectedPlanVersion && expectedPlanVersion === currentPlanVersion
    : impact.baseline === "no_plan";
}

const changeLabel: Record<NonNullable<WorkerManagerPlanImpact["planChanges"]>[number]["kind"], string> = {
  added: "New time block",
  moved: "Different time",
  updated: "Changed work block",
  removed: "Not in the suggestion",
};

function timeSlot(slot: { startTime: string; endTime: string } | null) {
  return slot ? `${slot.startTime}-${slot.endTime}` : "Not scheduled";
}

export default function WorkerPlanSuggestion({ impact, expectedPlanVersion, currentPlanVersion, currentDateKey, hasSavedPlan, applied }: Props) {
  if (!impact || impact.dateKey !== currentDateKey || !impact.scheduleChanged) return null;

  const stale = !workerPlanSuggestionIsCurrent({ impact, expectedPlanVersion, currentPlanVersion, currentDateKey, hasSavedPlan, applied });
  const changes = impact.planChanges;
  const preserved = impact.protectedBlocks.filter(block => block.preservedExactly).length;
  const changedProtected = impact.protectedBlocks.some(block => !block.preservedExactly);

  return (
    <section aria-label="Suggested changes to your day" className="min-w-0 space-y-3 border-y py-4 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Suggested changes to your day</h2>
        <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">{applied ? "Check saved plan" : "Not applied"}</span>
      </div>
      {stale ? (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
          {applied
            ? "The saved agenda may already have changed. Refresh the plan before relying on this earlier suggestion."
            : hasSavedPlan
              ? "The saved agenda no longer matches the version APTLSS checked. Follow the saved agenda until a new assessment is available."
              : "This suggestion was not checked against today's saved agenda. Ask for a new assessment before using it."}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {hasSavedPlan
              ? "Your agenda below is still the plan to follow. These changes are suggestions only."
              : "No agenda is saved for today. These suggested time blocks are not ready to follow."}
          </p>
          {impact.requiresReview && <p className="text-sm text-amber-700 dark:text-amber-300">A review is needed before these changes can be used.</p>}
          {changedProtected && <p className="text-sm text-red-700 dark:text-red-300">Protected work may have changed. Keep following the saved agenda and ask for a review.</p>}
          {preserved > 0 && !changedProtected && <p className="text-xs text-muted-foreground">{preserved} protected {preserved === 1 ? "block stays" : "blocks stay"} unchanged.</p>}
          {impact.availabilityChanged && <p className="text-sm">The suggested working hours or breaks differ from the saved agenda.</p>}
          {!changes ? <p className="text-sm text-muted-foreground">A block-by-block comparison was not recorded for this suggestion.</p> : changes.length ? (
            <>
              <p className="text-xs text-muted-foreground">{changes.length} suggested {changes.length === 1 ? "change" : "changes"}</p>
              <ol className="divide-y border-y">
                {changes.slice(0, 3).map((change, index) => (
                  <li key={`${change.blockId}-${index}`} className="grid min-w-0 gap-1 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4">
                    <div className="min-w-0"><p className="font-medium">{change.cardName}</p><p className="text-xs text-muted-foreground">{changeLabel[change.kind]}</p><p className="mt-1 text-muted-foreground">{change.reason}</p></div>
                    <p className="text-xs sm:text-right">{timeSlot(change.before)} &rarr; {timeSlot(change.after)}</p>
                  </li>
                ))}
              </ol>
              {changes.length > 3 && <details className="text-sm"><summary className="cursor-pointer font-medium">Show {changes.length - 3} more suggested changes</summary><ol className="mt-2 divide-y border-y">{changes.slice(3).map((change, index) => <li key={`${change.blockId}-${index + 3}`} className="py-3"><p className="font-medium">{change.cardName}</p><p className="text-xs text-muted-foreground">{changeLabel[change.kind]}: {timeSlot(change.before)} &rarr; {timeSlot(change.after)}</p><p className="mt-1 text-muted-foreground">{change.reason}</p></li>)}</ol></details>}
            </>
          ) : <p className="text-sm text-muted-foreground">No individual work block is proposed to change.</p>}
        </>
      )}
    </section>
  );
}
