import React, { useId, useState } from "react";
import { AlertTriangle, ClipboardCheck } from "lucide-react";
import type {
  ManagerPlanImpact as Impact,
  ManagerDeadlinePosition,
  ManagerPlanBuffer,
} from "@shared/aptlssManagerPlanImpact";

const minutes = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "Unknown"
    : `${Math.round(value * 10) / 10} min`;
const deadlineStatus: Record<ManagerDeadlinePosition["status"], string> = {
  within_deadline: "Slots end within deadline",
  after_deadline: "Slots end after deadline",
  unscheduled: "Work remains unscheduled",
  deadline_not_provided: "No deadline supplied",
  unknown: "Unknown",
};

function BufferPosition({ value }: { value: ManagerPlanBuffer | null }) {
  if (!value)
    return <p className="text-muted-foreground">No same-day baseline</p>;
  return (
    <dl className="space-y-1">
      <div>
        <dt className="text-muted-foreground">Unallocated working time</dt>
        <dd>{minutes(value.unallocatedMinutes)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Largest open window</dt>
        <dd>{minutes(value.largestWindowMinutes)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Extra time at high estimates</dt>
        <dd>{minutes(value.additionalHighEstimateMinutes)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">
          Remaining after high estimates
        </dt>
        <dd>{minutes(value.afterHighEstimatesMinutes)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Minimum known time deficit</dt>
        <dd>{minutes(value.minimumKnownDeficitMinutes)}</dd>
      </div>
      {value.unknownEstimateBlockIds.length > 0 && (
        <div>
          <dt className="text-muted-foreground">Unknown duration support</dt>
          <dd className="break-words">
            {value.unknownEstimateBlockIds.join(", ")}
          </dd>
        </div>
      )}
    </dl>
  );
}

export default function ManagerPlanImpact({
  impact,
}: {
  impact?: Impact | null;
}) {
  const instanceId = useId();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  if (!impact || impact.version !== 1)
    return (
      <p className="text-xs text-muted-foreground">
        Planning impact unavailable for this proposal.
      </p>
    );
  const sourceId = (ref: string) => `${instanceId}-${ref}`;
  const refs = (ids: string[]) => (
    <p className="mt-1 break-words text-xs text-muted-foreground">
      Inputs:{" "}
      {ids.map((ref, index) => (
        <React.Fragment key={`${ref}-${index}`}>
          {index > 0 && ", "}
          <a
            className="underline underline-offset-2"
            href={`#${encodeURIComponent(sourceId(ref))}`}
            onClick={() => setSourcesOpen(true)}
          >
            {ref}
          </a>
        </React.Fragment>
      ))}
    </p>
  );
  const instant = (value: string | null) => {
    if (!value) return "Not supplied";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    let label = value;
    try {
      label = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: impact.timezone,
      }).format(date);
    } catch {
      /* Retain the exact input when its timezone cannot be formatted. */
    }
    return (
      <time dateTime={value} title={`${value} (${impact.timezone})`}>
        {label}
      </time>
    );
  };
  const deadline = (position: ManagerDeadlinePosition) => (
    <div className="space-y-1">
      <p>{deadlineStatus[position.status]}</p>
      <p>Last slot end: {instant(position.latestScheduledEndAt)}</p>
      <p>Deadline margin: {minutes(position.slackMinutes)}</p>
      {position.unscheduledActionIds.length > 0 && (
        <p className="break-words">
          Unscheduled: {position.unscheduledActionIds.join(", ")}
        </p>
      )}
    </div>
  );
  return (
    <details className="min-w-0 border-y py-3" aria-label="Planning impact">
      <summary className="cursor-pointer text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        <span className="ml-1 inline-flex max-w-full flex-wrap items-center gap-2 align-middle">
          <ClipboardCheck aria-hidden="true" className="size-4 shrink-0" />
          Planning impact
          <span className="text-xs font-normal text-muted-foreground">
            {impact.scheduleChanged
              ? "Schedule changes proposed"
              : "Schedule unchanged"}
          </span>
        </span>
      </summary>
      <div className="min-w-0 space-y-4 pt-3 text-xs [overflow-wrap:anywhere]">
        <p className="text-muted-foreground">
          Assessed {instant(impact.assessedAt)} ({impact.timezone})
        </p>
        <p className="text-muted-foreground">
          {impact.baseline === "same_day_plan"
            ? "Compared with the retained same-day plan."
            : "No same-day plan was supplied for comparison."}
        </p>
        <p className="flex items-center gap-2">
          {impact.requiresReview && (
            <AlertTriangle
              aria-hidden="true"
              className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
            />
          )}
          {impact.requiresReview
            ? "Review required"
            : "No review-blocking risks listed"}
        </p>
        {impact.risks.length > 0 && (
          <ul className="space-y-2" aria-label="Planning risks">
            {impact.risks.map((risk, index) => (
              <li key={`${risk.code}-${risk.subjectId}-${index}`}>
                <p>
                  <strong>{risk.subjectId}:</strong> {risk.detail}{" "}
                  <span className="text-muted-foreground">
                    ({risk.requiresReview ? "Review required" : "Notice"})
                  </span>
                </p>
                {refs(risk.assumptionIds)}
              </li>
            ))}
          </ul>
        )}
        <section className="space-y-3" aria-label="Deadline impact">
          <h4 className="font-medium">Deadlines</h4>
          {impact.deadlines.length === 0 && (
            <p className="text-muted-foreground">No task deadlines supplied.</p>
          )}
          {impact.deadlines.map(item => (
            <div key={item.cardId} className="space-y-2 border-t pt-2">
              <p className="font-medium">{item.cardId}</p>
              <p>Supplied deadline: {instant(item.dueAt)}</p>
              <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1 font-medium">Current plan</p>
                  {deadline(item.before)}
                </div>
                <div>
                  <p className="mb-1 font-medium">Proposal</p>
                  {deadline(item.after)}
                </div>
              </div>
              <p>Slot movement: {item.movement}</p>
              {refs(item.assumptionIds)}
            </div>
          ))}
        </section>
        <section className="space-y-2" aria-label="Dependency impact">
          <h4 className="font-medium">Dependencies</h4>
          {impact.dependencies.length === 0 && (
            <p className="text-muted-foreground">
              No dependencies declared in the supplied inputs.
            </p>
          )}
          {impact.dependencies.map((item, index) => (
            <div
              key={`${item.actionId}-${item.dependency}-${index}`}
              className="space-y-1 border-t pt-2"
            >
              <p>
                <strong>{item.actionId}</strong> depends on {item.dependency}
              </p>
              <p>
                Completion recorded: {item.completionRecorded ? "Yes" : "No"}
              </p>
              <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                {(["before", "after"] as const).map(side => (
                  <div key={side}>
                    <p className="font-medium">
                      {side === "before" ? "Current plan" : "Proposal"}
                    </p>
                    <p>Order: {item[side].ordering.replaceAll("_", " ")}</p>
                    <p>Start: {instant(item[side].startAt)}</p>
                    <p>
                      Predecessor slot end:{" "}
                      {instant(item[side].predecessorEndAt)}
                    </p>
                  </div>
                ))}
              </div>
              {refs(item.assumptionIds)}
            </div>
          ))}
        </section>
        <section className="space-y-2" aria-label="Buffer impact">
          <h4 className="font-medium">Working-time buffer</h4>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 font-medium">Current plan</p>
              <BufferPosition value={impact.buffer.before} />
            </div>
            <div>
              <p className="mb-1 font-medium">Proposal</p>
              <BufferPosition value={impact.buffer.after} />
            </div>
          </div>
          <p>
            Unallocated time change:{" "}
            {minutes(impact.buffer.unallocatedDeltaMinutes)}
          </p>
          {impact.buffer.reservations.map((item, index) => (
            <p key={`${item.blockId}-${index}`}>
              Overrun reservation for {item.blockId}: {item.startTime}-
              {item.endTime},{" "}
              {item.basis === "planner_fallback_30_minutes"
                ? "30-minute planner fallback, not a measured duration"
                : "supplied likely estimate"}
              .
            </p>
          ))}
          {refs(impact.buffer.assumptionIds)}
        </section>
        <section className="space-y-2" aria-label="Protected blocks">
          <h4 className="font-medium">Protected blocks</h4>
          {impact.protectedBlocks.length === 0 ? (
            <p className="text-muted-foreground">
              No protected blocks in the supplied same-day plan.
            </p>
          ) : (
            impact.protectedBlocks.map((item, index) => (
              <div key={`${item.blockId}-${index}`}>
                <p>
                  {item.blockId}:{" "}
                  {item.preservedExactly ? "Preserved exactly" : "Changed"} (
                  {item.reasons
                    .map(reason => reason.replaceAll("_", " "))
                    .join(", ")}
                  )
                </p>
                {refs(item.assumptionIds)}
              </div>
            ))
          )}
        </section>
        <section className="space-y-2" aria-label="Plan alternative">
          <h4 className="font-medium">Alternative: keep current plan</h4>
          {!impact.alternative.available ? (
            <p>No same-day plan available to retain.</p>
          ) : (
            <>
              <p>
                Retained blocks:{" "}
                {impact.alternative.blockIds.join(", ") || "None"}
              </p>
              <p>
                Deadline risks:{" "}
                {impact.alternative.deadlineRiskCardIds.join(", ") ||
                  "None listed"}
              </p>
              <p>
                Unfinished dependencies:{" "}
                {impact.alternative.dependencyRiskActionIds.join(", ") ||
                  "None listed"}
              </p>
              <BufferPosition value={impact.alternative.buffer} />
            </>
          )}
          <p className="text-muted-foreground">
            {impact.alternative.limitation}
          </p>
        </section>
        <details
          className="border-t pt-2"
          open={sourcesOpen}
          onToggle={event => setSourcesOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer font-medium">
            Source assumptions
          </summary>
          <div className="space-y-3 pt-2">
            {impact.assumptions.map((assumption, index) => (
              <section
                id={sourceId(assumption.id)}
                key={`${assumption.id}-${index}`}
                className="scroll-mt-4 space-y-1"
              >
                <h5 className="font-medium">{assumption.id}</h5>
                <p>Input: {assumption.inputPath}</p>
                <pre className="max-w-full whitespace-pre-wrap break-words font-mono text-xs">
                  {JSON.stringify(assumption.value, null, 2)}
                </pre>
                <p className="text-muted-foreground">{assumption.limitation}</p>
              </section>
            ))}
          </div>
        </details>
        <ul
          className="space-y-1 text-muted-foreground"
          aria-label="Planning limitations"
        >
          {impact.limitations.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </div>
    </details>
  );
}
