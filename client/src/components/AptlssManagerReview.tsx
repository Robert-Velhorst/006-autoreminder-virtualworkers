import React, { useState } from "react";
import {
  Check,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  Square,
  RotateCcw,
} from "lucide-react";
import type { ManagerSnapshot } from "@shared/aptlssManager";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ManagerVerificationDetails } from "./ManagerVerificationDetails";
import ManagerPlanImpact from "./ManagerPlanImpact";
import { toast } from "sonner";

const selectClass =
  "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function ManagerTimestamp({
  value,
}: {
  value: string | Date | null | undefined;
}) {
  if (!value) return <span>Not recorded</span>;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>Unknown timestamp</span>;
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()}>
      {date.toLocaleString()}
    </time>
  );
}

function sourceUrl(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function ManagerSnapshotDetails({
  snapshot,
  cardId,
  presentedInterventionId,
}: {
  snapshot: ManagerSnapshot;
  cardId?: string;
  presentedInterventionId?: string;
}) {
  const assessments = snapshot.assessments.filter(
    item => !cardId || item.cardId === cardId
  );
  const citedIds = new Set(
    assessments.flatMap(item => [
      ...item.evidenceIds,
      ...item.actions.flatMap(action => action.evidenceIds),
      ...item.actions.flatMap(
        action => action.reviewedGuidance?.flatMap(g => g.evidenceIds) ?? []
      ),
      ...snapshot.interventions
        .filter(intervention => intervention.cardId === item.cardId)
        .flatMap(intervention => intervention.evidenceIds),
    ])
  );
  const evidence = snapshot.evidence.filter(item => citedIds.has(item.id));
  const missingIds = [...citedIds].filter(
    id => !evidence.some(item => item.id === id)
  );
  const planBlocks = snapshot.proposal?.blocks.filter(block => !cardId || block.cardId === cardId) ?? [];
  const unscheduledByTask = new Map<string, { cardId: string; cardName: string; reasons: string[] }>();
  for (const item of snapshot.proposal?.unscheduledCards ?? []) {
    if (cardId && item.cardId !== cardId) continue;
    const task = unscheduledByTask.get(item.cardId) ?? { cardId: item.cardId, cardName: item.cardName, reasons: [] };
    if (!task.reasons.includes(item.reason)) task.reasons.push(item.reason);
    unscheduledByTask.set(item.cardId, task);
  }
  const unscheduled = [...unscheduledByTask.values()];
  const nonWorkingDay = unscheduled.length > 0 && unscheduled.every(item => item.reasons.length > 0 && item.reasons.every(reason => reason === "This is a protected non-working day."));
  const visibleUnscheduled = unscheduled.slice(0, 5);
  const remainingUnscheduled = unscheduled.slice(5);
  return (
    <div className="min-w-0 space-y-6 break-words [overflow-wrap:anywhere]">
      {snapshot.interventions
        .filter(item => (!cardId || item.cardId === cardId) && item.id !== presentedInterventionId)
        .map(item => (
          <section key={item.id} className="space-y-1 border-t pt-3 text-sm">
            <h3 className="font-medium">{item.title}</h3>
            <p>{item.explanation}</p>
            <p>{item.question}</p>
            <p className="text-muted-foreground">{item.safeAction}</p>
            <ManagerVerificationDetails intervention={item} />
          </section>
        ))}
      {!cardId && snapshot.proposal?.planningImpact && (
        <ManagerPlanImpact impact={snapshot.proposal.planningImpact} />
      )}
      {snapshot.sourceGaps.length > 0 && (
        <details className="border-b pb-3">
          <summary className="cursor-pointer text-sm font-semibold">Coverage limits ({new Set(snapshot.sourceGaps).size})</summary>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            {[...new Set(snapshot.sourceGaps)].map((gap, index) => (
              <li key={index}>{gap}</li>
            ))}
          </ul>
        </details>
      )}
      {assessments.map(assessment => {
        const unclear = snapshot.interventions.some(item => item.cardId === assessment.cardId && (/which unknown applies now/i.test(item.question) || item.question.startsWith("Open the linked source and confirm the current fact needed for this task:")));
        return (
        <section key={assessment.cardId} className="space-y-2 border-t pt-3">
          <h3 className="text-sm font-medium">
            {snapshot.cards.find(card => card.id === assessment.cardId)?.name ??
              assessment.cardId}
          </h3>
          {unclear ? <div className="space-y-2 border-l-2 border-amber-500 pl-3 text-sm"><p className="font-medium">The assessment does not identify a specific contradiction.</p><p>Read the original message to establish what is requested and whether a deadline applies. The notification alone is not enough to choose the follow-up.</p><p className="text-muted-foreground">This is a request to check the source, not evidence that the worker made a mistake. Dependent work remains on hold.</p></div> : <p className="text-sm">{assessment.explanation}</p>}
          <details open={!unclear} className="space-y-2"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">Recorded assessment details</summary>
          {unclear && <p className="text-sm">{assessment.explanation}</p>}
          <h4 className="pt-2 text-sm font-semibold">Reliability</h4>
          {assessment.reliability ? (
            <>
              <dl className="grid grid-cols-2 gap-4 border-y bg-muted/30 p-3 text-sm sm:grid-cols-4 [&_dd]:mt-1 [&_dd]:font-medium">
                <div>
                  <dt className="text-muted-foreground">Coverage</dt>
                  <dd>{assessment.reliability.coverage}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Freshness</dt>
                  <dd>{assessment.reliability.freshness}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Conflicts</dt>
                  <dd>
                    {assessment.reliability.conflicts.replaceAll("_", " ")}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Support</dt>
                  <dd>{assessment.reliability.support}</dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">
                Uncalibrated assessment
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Reliability details not recorded; uncalibrated assessment.
            </p>
          )}
          {!!(assessment.uncertainties.length || assessment.reliability?.reasons.length) && <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-300">
            {[...new Set([...(assessment.reliability?.reasons ?? []), ...assessment.uncertainties])].map(reason => <li key={reason}>{reason}</li>)}
          </ul>}
          {assessment.evidenceIds.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Cited evidence: {assessment.evidenceIds.join(", ")}
            </p>
          )}
          </details>
          <h4 className="pt-4 text-sm font-semibold">Proposed steps ({assessment.actions.length})</h4>
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {assessment.actions.map((action, index) => (
            <div key={action.id} className="min-w-0 space-y-3 rounded-md border p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium text-muted-foreground">Step {index + 1}</span><Badge variant="outline">{action.blocked ? "Blocked" : "Available"}</Badge></div>
              <p className="font-semibold">
                {unclear ? action.kind === "verify" ? "Read the original message and record what it asks" : "Choose the follow-up after the source is checked" : action.title}
                {action.blocked ? " (blocked)" : ""}
              </p>
              <p className="text-muted-foreground">{unclear ? action.kind === "verify" ? "Record the request, any stated deadline, and the source. Report an access problem if you cannot read it." : "The follow-up is not yet established. Do not send or submit anything based only on this notification." : action.reason}</p>
              {unclear && <details><summary className="cursor-pointer text-xs text-muted-foreground">Original generated step</summary><p>{action.title}</p><p>{action.reason}</p><p>{action.completionCriteria}</p>{action.draft && <p>{action.draft}</p>}</details>}
              {!!action.reviewedGuidance?.length && (
                <section
                  className="my-2 space-y-2 text-xs"
                  aria-label="Reviewed guidance"
                >
                  <h4 className="font-semibold">Reviewed guidance</h4>
                  {action.reviewedGuidance.map(guidance => (
                    <div key={guidance.id} className="space-y-1">
                      <p>
                        {guidance.topic}: {guidance.correction}
                      </p>
                      <p className="text-muted-foreground">
                        Review {guidance.reviewId}; valid until{" "}
                        <ManagerTimestamp value={guidance.validUntil} />
                      </p>
                      <p className="text-muted-foreground">
                        Sources: {guidance.evidenceIds.join(", ")}
                      </p>
                    </div>
                  ))}
                </section>
              )}
              <p className="border-t pt-3 text-xs text-muted-foreground">
                {action.minutes.low}-{action.minutes.high} min;{" "}
                {action.minutes.samples} timing samples. {action.minutes.basis}
              </p>
              <div><p className="text-xs font-semibold">Done when</p><p className="mt-1">{unclear ? action.kind === "verify" ? "You have recorded the message's request and deadline, or explained why you cannot access it." : "The source has been checked and the appropriate next action has been agreed." : action.completionCriteria}</p></div>
              {action.evidenceIds.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Cited evidence: {action.evidenceIds.join(", ")}
                </p>
              )}
              {action.draft && !unclear && (
                <p className="mt-1 whitespace-pre-wrap text-xs">
                  Draft (not sent): {action.draft}
                </p>
              )}
            </div>
          ))}
          </div>
        </section>
      );})}
      <section className="space-y-2 border-t pt-3" aria-label="Cited sources">
        <h3 className="text-sm font-medium">Cited sources</h3>
        {!evidence.length && (
          <p className="text-xs text-muted-foreground">
            No cited source records available.
          </p>
        )}
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        {evidence.map(item => (
          <div key={item.id} className="min-w-0 space-y-3 rounded-md border p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {item.source} [{item.id}]
              </span>
              <Badge variant="outline">{item.kind}</Badge>
              {sourceUrl(item.url) && (
                <a
                  href={sourceUrl(item.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline"
                >
                  Open source
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap leading-relaxed">{item.text}</p>
            <details><summary className="cursor-pointer text-xs font-medium">Source metadata</summary><div className="mt-2 space-y-1 text-xs">
            <p className="text-muted-foreground">
              Observed <ManagerTimestamp value={item.observedAt} />
            </p>
            {item.metadata?.sourceDate && (
              <p className="text-muted-foreground">
                Source date:{" "}
                <ManagerTimestamp value={item.metadata.sourceDate} />
              </p>
            )}
            {item.metadata?.effectiveFrom && (
              <p className="text-muted-foreground">
                Effective from:{" "}
                <ManagerTimestamp value={item.metadata.effectiveFrom} />
              </p>
            )}
            {item.metadata?.effectiveTo && (
              <p className="text-muted-foreground">
                Effective until:{" "}
                <ManagerTimestamp value={item.metadata.effectiveTo} />
              </p>
            )}
            {item.metadata?.sender && (
              <p className="text-muted-foreground">
                Sender: {item.metadata.sender}
              </p>
            )}
            {item.metadata?.sourceRevision && (
              <p className="text-muted-foreground">
                Revision: {item.metadata.sourceRevision}
              </p>
            )}
            </div></details>
          </div>
        ))}
        </div>
        {missingIds.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Cited records unavailable: {missingIds.join(", ")}
          </p>
        )}
      </section>
      <details className="border-t pt-3">
        <summary className="cursor-pointer text-sm font-medium">
          Proposed plan
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          {snapshot.applied
            ? "Applied to the active plan"
            : "Not applied to the active plan"}
          {cardId ? "; showing this task only" : "; all tasks"}
        </p>
        {snapshot.proposal ? (
          <>
            <p className="mt-3 text-sm font-semibold">{nonWorkingDay ? "No work scheduled: this is a non-working day." : "Schedule proposal"}</p>
            <p className="mt-2 text-sm">
              {snapshot.proposal.dateKey}{!nonWorkingDay && <>:{" "}
              {snapshot.proposal.constraints.startTime}-
              {snapshot.proposal.constraints.endTime}</>}
            </p>
            <ol className="mt-2 divide-y">
              {planBlocks.map(block => (
                <li
                  key={block.id}
                  className="grid gap-1 py-2 text-sm sm:grid-cols-[100px_minmax(0,1fr)]"
                >
                  <span className="text-xs text-muted-foreground">
                    {block.startTime}-{block.endTime}
                  </span>
                  <div>
                    <p className="font-medium">{block.cardName}</p>
                    <p>{block.action}</p>
                    <p className="text-xs text-muted-foreground">
                      {block.status}
                      {block.flags.length ? `; ${block.flags.join("; ")}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            {!planBlocks.length && !nonWorkingDay && (
              <p className="mt-2 text-xs">No proposed work blocks.</p>
            )}
            {nonWorkingDay && <p className="mt-2 text-sm text-muted-foreground">Today is a protected non-working day. {unscheduled.length} {unscheduled.length === 1 ? "task remains" : "tasks remain"} open; none were completed, removed, or moved to another day.</p>}
            {!!unscheduled.length && <details className="mt-3"><summary className="cursor-pointer text-sm font-medium">{nonWorkingDay ? "Show affected tasks" : "Tasks not scheduled"} ({unscheduled.length})</summary><ul className="mt-2 grid gap-3 sm:grid-cols-2">{visibleUnscheduled.map(item => <li key={item.cardId} className="min-w-0 border-l-2 pl-3 text-sm"><p className="font-medium">{item.cardName}</p>{!nonWorkingDay && item.reasons.map(reason => <p key={reason} className="text-muted-foreground">{reason}</p>)}</li>)}</ul>{remainingUnscheduled.length > 0 && <details className="mt-3"><summary className="cursor-pointer text-sm font-medium">Show {remainingUnscheduled.length} more {remainingUnscheduled.length === 1 ? "task" : "tasks"}</summary><ul className="mt-2 grid gap-3 sm:grid-cols-2">{remainingUnscheduled.map(item => <li key={item.cardId} className="min-w-0 border-l-2 pl-3 text-sm"><p className="font-medium">{item.cardName}</p>{!nonWorkingDay && item.reasons.map(reason => <p key={reason} className="text-muted-foreground">{reason}</p>)}</li>)}</ul></details>}</details>}
            {snapshot.proposal.robertItems.filter(item => !cardId || item.cardId === cardId).map(item => (
              <p key={item.stepId} className="mt-2 text-xs">
                Founder decision: {item.cardName}. {item.decision}
              </p>
            ))}
          </>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            No proposed plan recorded.
          </p>
        )}
        <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">Plan version</summary><p className="mt-2 break-all font-mono text-xs">{snapshot.planVersion ?? "Not recorded"}</p></details>
      </details>
      {snapshot.timing && (
        <section className="space-y-3 border-t pt-4" aria-label="Timing history">
          <h3 className="text-sm font-semibold">Timing history</h3>
          {snapshot.timing.samples === 0 && <p className="text-sm text-muted-foreground">No recorded samples yet. Estimates have not been validated against completed work.</p>}
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-5 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:mt-1 [&_dd]:font-medium">
            <div><dt>Samples</dt><dd>{snapshot.timing.samples}</dd></div>
            <div><dt>Within estimate</dt><dd>{snapshot.timing.withinRange}</dd></div>
            <div><dt>Mean absolute error</dt><dd>{snapshot.timing.meanAbsoluteErrorMinutes === null ? "Not available" : `${snapshot.timing.meanAbsoluteErrorMinutes} min`}</dd></div>
            <div><dt>Waiting</dt><dd>{snapshot.timing.waitingMinutes} min</dd></div>
            <div><dt>Interrupted</dt><dd>{snapshot.timing.interruptedMinutes} min</dd></div>
          </dl>
        </section>
      )}
    </div>
  );
}

type ReviewEntry = {
  vaId: number;
  runId: number;
  createdAt: string | Date;
  snapshot: ManagerSnapshot;
  occurrences?: number;
  urgent?: boolean;
  review: null | {
    verdict: string;
    critical: boolean;
    correction: string;
    source: string;
  };
};

function RunReview({
  entry,
  onSaved,
  closed = false,
}: {
  entry: ReviewEntry;
  onSaved: () => void;
  closed?: boolean;
}) {
  const [verdict, setVerdict] = useState<
    "correct" | "incorrect" | "insufficient"
  >(
    entry.review?.verdict === "correct" || entry.review?.verdict === "incorrect"
      ? entry.review.verdict
      : "insufficient"
  );
  const [critical, setCritical] = useState(entry.review?.critical ?? false);
  const [correction, setCorrection] = useState(entry.review?.correction ?? "");
  const [source, setSource] = useState(entry.review?.source ?? "");
  const [savedReview, setSavedReview] = useState<ReviewEntry["review"]>(null);
  const [reuse, setReuse] = useState(false);
  const [scope, setScope] = useState<"card" | "worker">("card");
  const [cardId, setCardId] = useState(entry.snapshot.cards[0]?.id ?? "");
  const [topic, setTopic] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [actionKind, setActionKind] = useState<
    "work" | "verify" | "draft" | "decision" | "follow_up"
  >("verify");
  const [boardName, setBoardName] = useState("");
  const [listName, setListName] = useState("");
  const [conditionState, setConditionState] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [replaceNextStep, setReplaceNextStep] = useState(false);
  const [nextActionId, setNextActionId] = useState("");
  const [nextTitle, setNextTitle] = useState("");
  const [nextCompletion, setNextCompletion] = useState("");
  const editableActions = entry.snapshot.actions.filter(a =>
    a.cardId === cardId && a.kind === actionKind && ["work", "verify", "follow_up"].includes(a.kind)
  );
  const selectedActionId = editableActions.some(a => a.id === nextActionId)
    ? nextActionId : editableActions[0]?.id ?? "";
  const sourceRecords = entry.snapshot.evidence.filter(
    e =>
      (e.kind === "source" || e.kind === "decision") &&
      (scope === "worker" || e.cardId === cardId)
  );
  const knowledgeValid =
    !reuse ||
    (correction.trim().length >= 3 &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(topic) &&
      evidenceIds.length > 0 &&
      (scope === "worker" || !!cardId) &&
      Number.isFinite(Date.parse(validUntil)) &&
      Date.parse(validUntil) > Date.now() &&
      (!replaceNextStep || (scope === "card" && !!selectedActionId && nextTitle.trim().length >= 3 && nextCompletion.trim().length >= 3)));
  const save = trpc.operator.recordManagerReview.useMutation({
    onSuccess: (result, submitted) => {
      if (!result.recorded) {
        toast.error("Review could not be confirmed.");
        return;
      }
      setSavedReview({
        verdict: submitted.verdict,
        critical: submitted.critical,
        correction: submitted.correction,
        source: submitted.source,
      });
      toast.success("Manager review saved");
      onSaved();
    },
    onError: error => toast.error(error.message),
  });
  const recordedReview = entry.review ?? savedReview;
  const prefix = `review-${entry.vaId}-${entry.runId}`;
  return (
    <details className="min-w-0 border-t py-3">
      <summary className="cursor-pointer text-sm font-medium">
        Review run {entry.runId}
        {(entry.occurrences ?? 1) > 1 && (
          <span className="ml-2 font-normal text-muted-foreground">
            {entry.occurrences} matching assessments
          </span>
        )}
      </summary>
      <div className="mt-3 space-y-4">
        <div className="flex flex-wrap gap-2 text-xs">
          <ManagerTimestamp value={entry.createdAt} />
          <Badge variant="outline">
            {recordedReview ? `Reviewed: ${recordedReview.verdict}` : "Unreviewed"}
          </Badge>
          {(entry.urgent ||
            entry.snapshot.interventions.some(
              item => item.severity === "urgent"
            )) && <Badge variant="destructive">Urgent</Badge>}
        </div>
        <ManagerSnapshotDetails snapshot={entry.snapshot} />
        <form
          className="min-w-0 border-t pt-3"
          onSubmit={event => {
            event.preventDefault();
            if (!recordedReview && !save.isPending && !closed && knowledgeValid)
              save.mutate({
                vaId: entry.vaId,
                runId: entry.runId,
                verdict,
                critical,
                correction: correction.trim(),
                source: source.trim(),
                ...(reuse
                  ? {
                      correctionKnowledge: {
                        scope,
                        ...(scope === "card" ? { cardId } : {}),
                        topic,
                        evidenceIds,
                        conditions: {
                          actionKind,
                          ...(boardName.trim()
                            ? { boardName: boardName.trim() }
                            : {}),
                          ...(listName.trim()
                            ? { listName: listName.trim() }
                            : {}),
                          ...(conditionState.trim()
                            ? { state: conditionState.trim() }
                            : {}),
                        },
                        ...(replaceNextStep ? { nextStep: {
                          actionId: selectedActionId,
                          title: nextTitle.trim(),
                          completionCriteria: nextCompletion.trim(),
                        } } : {}),
                        validUntil: new Date(validUntil).toISOString(),
                      },
                    }
                  : {}),
              });
          }}
        >
          {recordedReview && (
            <p className="mb-3 text-xs text-muted-foreground">
              Recorded review (read-only)
            </p>
          )}
          <fieldset
            disabled={!!recordedReview || save.isPending || closed}
            className="min-w-0 space-y-3"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`${prefix}-verdict`}>Verdict</Label>
                <select
                  id={`${prefix}-verdict`}
                  className={selectClass}
                  value={recordedReview?.verdict ?? verdict}
                  onChange={event => {
                    setVerdict(event.target.value as typeof verdict);
                    if (event.target.value === "correct") setCritical(false);
                  }}
                >
                  <option value="correct">Correct</option>
                  <option value="incorrect">Incorrect</option>
                  <option value="insufficient">Insufficient evidence</option>
                </select>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  id={`${prefix}-critical`}
                  checked={recordedReview?.critical ?? critical}
                  onCheckedChange={setCritical}
                  disabled={
                    !!recordedReview || save.isPending || verdict === "correct"
                  }
                />
                <Label htmlFor={`${prefix}-critical`}>Critical finding</Label>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${prefix}-correction`}>
                Correction or review notes
              </Label>
              <Textarea
                id={`${prefix}-correction`}
                value={recordedReview?.correction ?? correction}
                onChange={event => setCorrection(event.target.value)}
                required={verdict !== "correct" || reuse}
                minLength={verdict !== "correct" || reuse ? 3 : undefined}
                maxLength={8000}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${prefix}-source`}>Review source</Label>
              <Input
                id={`${prefix}-source`}
                value={recordedReview?.source ?? source}
                onChange={event => setSource(event.target.value)}
                required
                minLength={3}
                maxLength={2000}
                disabled={save.isPending}
              />
            </div>
            {!recordedReview && (
              <>
                <div className="flex items-center gap-3">
                  <Switch
                    id={`${prefix}-reuse`}
                    checked={reuse}
                    onCheckedChange={setReuse}
                  />
                  <Label htmlFor={`${prefix}-reuse`}>
                    Use as scoped reviewed guidance
                  </Label>
                </div>
                {reuse && (
                  <div className="space-y-3 border-l-2 pl-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor={`${prefix}-scope`}>
                          Guidance scope
                        </Label>
                        <select
                          id={`${prefix}-scope`}
                          className={selectClass}
                          value={scope}
                          onChange={e => {
                            setScope(e.target.value as typeof scope);
                            setEvidenceIds([]);
                            setReplaceNextStep(false);
                          }}
                        >
                          <option value="card">This card</option>
                          <option value="worker">
                            This worker, matching conditions
                          </option>
                        </select>
                      </div>
                      {scope === "card" && (
                        <div className="space-y-1">
                          <Label htmlFor={`${prefix}-card`}>
                            Guidance card
                          </Label>
                          <select
                            id={`${prefix}-card`}
                            className={selectClass}
                            value={cardId}
                            onChange={e => {
                              setCardId(e.target.value);
                              setEvidenceIds([]);
                              setReplaceNextStep(false);
                            }}
                          >
                            {entry.snapshot.cards.map(c => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div className="space-y-1">
                        <Label htmlFor={`${prefix}-topic`}>
                          Guidance topic
                        </Label>
                        <Input
                          id={`${prefix}-topic`}
                          value={topic}
                          onChange={e => setTopic(e.target.value)}
                          required
                          pattern="[a-z0-9](?:[a-z0-9_]|-)*"
                          maxLength={64}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`${prefix}-kind`}>
                          Action condition
                        </Label>
                        <select
                          id={`${prefix}-kind`}
                          className={selectClass}
                          value={actionKind}
                          onChange={e => {
                            setActionKind(e.target.value as typeof actionKind);
                            setReplaceNextStep(false);
                          }}
                        >
                          <option value="verify">Verify</option>
                          <option value="work">Work</option>
                          <option value="draft">Draft</option>
                          <option value="decision">Decision</option>
                          <option value="follow_up">Follow up</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`${prefix}-board`}>
                          Board condition (optional)
                        </Label>
                        <Input
                          id={`${prefix}-board`}
                          value={boardName}
                          onChange={e => setBoardName(e.target.value)}
                          maxLength={256}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`${prefix}-list`}>
                          List condition (optional)
                        </Label>
                        <Input
                          id={`${prefix}-list`}
                          value={listName}
                          onChange={e => setListName(e.target.value)}
                          maxLength={256}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`${prefix}-state`}>
                          State condition (optional)
                        </Label>
                        <Input
                          id={`${prefix}-state`}
                          value={conditionState}
                          onChange={e => setConditionState(e.target.value)}
                          maxLength={128}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`${prefix}-expiry`}>
                          Guidance expiry (local time)
                        </Label>
                        <Input
                          id={`${prefix}-expiry`}
                          type="datetime-local"
                          value={validUntil}
                          onChange={e => setValidUntil(e.target.value)}
                          required
                        />
                      </div>
                    </div>
                    <fieldset className="min-w-0 space-y-2">
                      <legend className="mb-2 text-sm font-medium">
                        Supporting source records
                      </legend>
                      {sourceRecords.map(e => (
                        <label
                          key={e.id}
                          className="flex min-w-0 items-start gap-2 text-xs"
                        >
                          <input
                            type="checkbox"
                            className="mt-1 shrink-0"
                            checked={evidenceIds.includes(e.id)}
                            onChange={event =>
                              setEvidenceIds(ids =>
                                event.target.checked
                                  ? [...ids, e.id]
                                  : ids.filter(id => id !== e.id)
                              )
                            }
                          />
                          <span className="min-w-0 break-words">
                            {e.source} [{e.id}]: {e.text}
                          </span>
                        </label>
                      ))}
                      {!sourceRecords.length && (
                        <p className="text-xs text-muted-foreground">
                          No supporting source records in this scope.
                        </p>
                      )}
                    </fieldset>
                    {scope === "card" && (
                      <div className="space-y-3 border-t pt-3">
                        <div className="flex items-center gap-3">
                          <Switch id={`${prefix}-replace-step`} checked={replaceNextStep} onCheckedChange={setReplaceNextStep} disabled={!editableActions.length} />
                          <Label htmlFor={`${prefix}-replace-step`}>Correct a future proposed step</Label>
                        </div>
                        {replaceNextStep && (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1 sm:col-span-2">
                              <Label htmlFor={`${prefix}-target-step`}>Step to correct</Label>
                              <select id={`${prefix}-target-step`} className={selectClass} value={selectedActionId} onChange={e => setNextActionId(e.target.value)}>
                                {editableActions.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                              </select>
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`${prefix}-next-title`}>Corrected next step</Label>
                              <Input id={`${prefix}-next-title`} value={nextTitle} onChange={e => setNextTitle(e.target.value)} minLength={3} maxLength={300} required />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`${prefix}-next-completion`}>Done when</Label>
                              <Input id={`${prefix}-next-completion`} value={nextCompletion} onChange={e => setNextCompletion(e.target.value)} minLength={3} maxLength={1000} required />
                            </div>
                            <p className="text-xs text-muted-foreground sm:col-span-2">This changes future proposals for this same step and source only. It does not change the saved plan, remove blockers, or send anything.</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            {!recordedReview && (
              <Button
                type="submit"
                size="sm"
                disabled={
                  save.isPending ||
                  closed ||
                  !knowledgeValid ||
                  source.trim().length < 3 ||
                  (verdict !== "correct" && correction.trim().length < 3)
                }
              >
                {save.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                Save review
              </Button>
            )}
          </fieldset>
        </form>
      </div>
    </details>
  );
}

export default function AptlssManagerReview() {
  const { user } = useAuth();
  const [workerId, setWorkerId] = useState<number | undefined>();
  const [page, setPage] = useState(0);
  const [trialReason, setTrialReason] = useState("");
  const [revokeReasons, setRevokeReasons] = useState<Record<number, string>>(
    {}
  );
  const utils = trpc.useUtils();
  const inbox = trpc.operator.getManagerReviewInbox.useQuery(
    workerId === undefined ? {} : { vaId: workerId, page },
    {
      enabled: user?.role === "admin",
      retry: false,
      staleTime: 0,
      refetchInterval: 60_000,
      placeholderData: previous => previous,
    }
  );
  const refresh = () => {
    void utils.operator.getManagerReviewInbox.invalidate();
    void utils.operator.getManagerStatus.invalidate();
  };
  const run = trpc.operator.runManagerForReview.useMutation({
    onSuccess: result => {
      refresh();
      if (result.applied) toast.error("Unexpected plan change: stop the shadow trial and review the assessment.");
      else if (result.policy.mode === "shadow")
        toast.success("Shadow proposal assessed");
      else toast.success("Proposal assessed; active plan unchanged");
    },
    onError: error => toast.error(error.message),
  });
  const closeTrial = trpc.operator.closeManagerTrial.useMutation({
    onSuccess: () => {
      setTrialReason("");
      refresh();
      toast.success("Trial closed; history retained");
    },
    onError: error => toast.error(error.message),
  });
  const restartTrial = trpc.operator.restartManagerTrial.useMutation({
    onSuccess: () => {
      setTrialReason("");
      setPage(0);
      refresh();
      toast.success("New shadow trial started; history retained");
    },
    onError: error => toast.error(error.message),
  });
  const revoke = trpc.operator.revokeManagerCorrection.useMutation({
    onSuccess: () => {
      setRevokeReasons({});
      refresh();
      toast.success("Guidance withdrawn; review retained");
    },
    onError: error => toast.error(error.message),
  });
  if (user?.role !== "admin") return null;
  const selected =
    workerId !== undefined &&
    inbox.data?.workerId === workerId &&
    (inbox.data?.page ?? 0) === page;
  const gate = selected ? inbox.data?.gate : undefined;
  // Keep runtime defenses even though the backend contract only permits shadow.
  const currentMode = selected && inbox.data?.mode != null ? String(inbox.data.mode) : undefined;
  const busy =
    run.isPending ||
    closeTrial.isPending ||
    restartTrial.isPending ||
    revoke.isPending;
  const trial = selected ? inbox.data?.trial : undefined;
  const canAssess = Boolean(
    selected &&
      currentMode === "shadow" &&
      trial?.status !== "closed" &&
      !inbox.isFetching &&
      !inbox.error &&
      !busy
  );
  return (
    <section className="min-w-0 space-y-4" aria-label="APTLSS manager review">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">APTLSS manager review</h2>
        <Button
          variant="ghost"
          size="icon"
          title="Refresh reviews"
          aria-label="Refresh reviews"
          disabled={inbox.isFetching}
          onClick={() => void inbox.refetch()}
        >
          <RefreshCw
            className={`size-4 ${inbox.isFetching ? "animate-spin" : ""}`}
          />
        </Button>
      </div>
      <div className="max-w-sm space-y-1">
        <Label htmlFor="manager-review-worker">Review worker</Label>
        <select
          id="manager-review-worker"
          className={selectClass}
          value={workerId ?? ""}
          disabled={busy}
          onChange={event => {
            setPage(0);
            setTrialReason("");
            setRevokeReasons({});
            setWorkerId(
              event.target.value ? Number(event.target.value) : undefined
            );
          }}
        >
          <option value="">Select a worker</option>
          {inbox.data?.workers.map(worker => (
            <option key={worker.id} value={worker.id}>
              {worker.name}
            </option>
          ))}
        </select>
      </div>
      {inbox.isLoading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading manager reviews...
        </p>
      )}
      {inbox.error && (
        <p role="alert" className="text-sm text-destructive">
          {inbox.error.message}
        </p>
      )}
      {workerId === undefined && !inbox.isLoading && !inbox.error && (
        <p className="text-sm text-muted-foreground">
          {inbox.data?.workers.length
            ? "No worker selected."
            : "No workers available for review."}
        </p>
      )}
      {gate && (
        <>
          <div className="space-y-3 border-y py-4">
            <Badge variant="outline">
              Current mode: {currentMode === "active" ? "Active" : currentMode === "shadow" ? "Shadow" : "Unavailable"}
            </Badge>
            <p className="text-xs text-muted-foreground">Shadow pilot only. Active mode and external messages are unavailable.</p>
            {currentMode !== "shadow" && <p role="alert" className="text-sm text-destructive">Assessment paused: a confirmed shadow policy is required.</p>}
            {trial && (
              <p className="text-xs">
                Trial: {trial.status === "closed" ? "Closed" : "Open"}; started{" "}
                <ManagerTimestamp value={trial.startedAt} />
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className="size-4" />
              <h3 className="text-sm font-medium">Activation gate</h3>
              <Badge variant={gate.eligible ? "outline" : "secondary"}>
                {gate.eligible ? "Eligible" : "Not eligible"}
              </Badge>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">Reviewed / correct</dt>
                <dd>
                  {gate.reviewed} / {gate.correct}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Working days</dt>
                <dd>{gate.workingDays}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  Unreviewed urgent / critical
                </dt>
                <dd>
                  {gate.unreviewedUrgent} / {gate.critical}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Safety verified</dt>
                <dd>{gate.safetyVerified ? "Yes" : "No"}</dd>
              </div>
            </dl>
            {gate.reasons.length > 0 && (
              <ul className="space-y-1 text-sm text-muted-foreground">
                {gate.reasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!canAssess}
                onClick={() => { if (canAssess) run.mutate({ vaId: workerId! }); }}
              >
                {run.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                Run shadow assessment
              </Button>
            </div>
          </div>
          <section
            className="space-y-3 border-b pb-4"
            aria-label="Trial lifecycle"
          >
            <h3 className="text-sm font-medium">Shadow trial</h3>
            <div className="space-y-1">
              <Label htmlFor="manager-trial-reason">Trial change reason</Label>
              <Textarea
                id="manager-trial-reason"
                value={trialReason}
                onChange={e => setTrialReason(e.target.value)}
                minLength={10}
                maxLength={4000}
                disabled={busy}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy ||
                  inbox.isFetching ||
                  !!inbox.error ||
                  trialReason.trim().length < 10 ||
                  trial?.status === "closed"
                }
                onClick={() => {
                  if (
                    window.confirm(
                      "Close this trial and disable manager execution? All assessment and review history will remain."
                    )
                  )
                    closeTrial.mutate({
                      vaId: workerId!,
                      reason: trialReason.trim(),
                    });
                }}
              >
                <Square className="size-4" />
                Close trial
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy ||
                  inbox.isFetching ||
                  !!inbox.error ||
                  trialReason.trim().length < 10
                }
                onClick={() => {
                  if (
                    window.confirm(
                      "Start a new shadow trial? Acceptance starts again. Existing plans, assessments, reviews and guidance remain."
                    )
                  )
                    restartTrial.mutate({
                      vaId: workerId!,
                      reason: trialReason.trim(),
                    });
                }}
              >
                <RotateCcw className="size-4" />
                Restart shadow trial
              </Button>
            </div>
            {!!inbox.data?.trialHistory?.length && (
              <details>
                <summary className="cursor-pointer text-sm">
                  Trial history
                </summary>
                <ol className="mt-2 space-y-2 text-xs">
                  {inbox.data.trialHistory.map(event => (
                    <li key={event.id}>
                      <ManagerTimestamp value={event.createdAt} />:{" "}
                      {event.event}; {event.reason}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </section>
          {!!inbox.data?.corrections?.length && (
            <section
              className="space-y-2 border-b pb-4"
              aria-label="Saved reviewed guidance"
            >
              <h3 className="text-sm font-medium">Saved reviewed guidance</h3>
              {inbox.data.corrections.map(item => (
                <details key={item.id} className="border-t pt-2 text-xs">
                  <summary className="cursor-pointer">
                    {item.topic}:{" "}
                    {item.revokedAt
                      ? "Withdrawn"
                      : new Date(item.validUntil).getTime() <= Date.now()
                        ? "Expired"
                        : "Current"}
                  </summary>
                  <div className="mt-2 space-y-2">
                    <p>{item.correction}</p>
                    <p>
                      Scope: {item.scope}
                      {item.cardId ? `; card ${item.cardId}` : ""}; review{" "}
                      {item.reviewId}
                    </p>
                    <p>
                      Valid until <ManagerTimestamp value={item.validUntil} />
                    </p>
                    <p className="break-all">
                      Conditions: {item.conditionsJson}
                    </p>
                    <p className="break-all">
                      Source provenance: {item.evidenceJson}
                    </p>
                    {item.revokedAt ? (
                      <p>
                        Withdrawn <ManagerTimestamp value={item.revokedAt} />:{" "}
                        {item.revocationReason}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        <Label htmlFor={`revoke-${item.id}`}>
                          Withdrawal reason
                        </Label>
                        <Input
                          id={`revoke-${item.id}`}
                          value={revokeReasons[item.id] ?? ""}
                          onChange={e =>
                            setRevokeReasons(values => ({
                              ...values,
                              [item.id]: e.target.value,
                            }))
                          }
                          maxLength={4000}
                          disabled={busy}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            busy ||
                            inbox.isFetching ||
                            !!inbox.error ||
                            (revokeReasons[item.id]?.trim().length ?? 0) < 3
                          }
                          onClick={() =>
                            revoke.mutate({
                              vaId: workerId!,
                              correctionId: item.id,
                              reason: revokeReasons[item.id].trim(),
                            })
                          }
                        >
                          <Square className="size-4" />
                          Withdraw guidance
                        </Button>
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </section>
          )}
          {!inbox.data?.entries.length && (
            <p className="text-sm text-muted-foreground">
              No assessment runs for this worker.
            </p>
          )}
          {inbox.data?.entries.map(entry => (
            <RunReview
              key={`${entry.vaId}-${entry.runId}`}
              entry={entry}
              onSaved={refresh}
              closed={trial?.status === "closed" || inbox.isFetching || !!inbox.error || busy || currentMode !== "shadow"}
            />
          ))}
          <nav
            className="flex items-center justify-between gap-3"
            aria-label="Review pages"
          >
            <Button
              variant="outline"
              size="icon"
              title="Previous review page"
              aria-label="Previous review page"
              disabled={page === 0 || busy || inbox.isFetching}
              onClick={() => setPage(value => value - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-xs">Page {page + 1}</span>
            <Button
              variant="outline"
              size="icon"
              title="Next review page"
              aria-label="Next review page"
              disabled={!inbox.data?.hasMore || busy || inbox.isFetching}
              onClick={() => setPage(value => value + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </nav>
        </>
      )}
    </section>
  );
}
