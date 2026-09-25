import { workerFacingManagerQuestion, type ManagerIntervention } from "@shared/aptlssManager";
import { groupManagerVerificationPassages } from "@shared/managerVerificationPresentation";
import { ExternalLink } from "lucide-react";

function SourceDate({ value }: { value: string | null }) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? <time dateTime={date.toISOString()}>{date.toLocaleString()}</time> : null;
}

export function ManagerVerificationDetails({ intervention }: { intervention: ManagerIntervention }) {
  const verification = intervention.verification;
  if (!verification) return null;
  const sources = groupManagerVerificationPassages(verification.passages);
  const comparisons = verification.comparisons ?? [];
  const remaining = verification.issues.filter(issue => issue.id !== intervention.id);
  const sourcePassages = sources.length ? sources.map(({ passage, quotes }, index) => <article key={`${passage.evidenceId}:${passage.sourceRevision ?? index}`} className="min-w-0 border-l-2 border-border pl-3 text-sm" aria-label="Source preview">
    <p className="font-medium">{passage.kind === "worker" ? "Worker statement" : passage.kind === "decision" ? "Recorded decision" : passage.sender ?? "Original message"}</p>
    <p className="mt-1 text-xs text-muted-foreground"><SourceDate value={passage.sourceDate} /></p>
    <blockquote className="my-3 whitespace-pre-wrap break-words leading-relaxed">{quotes.join("\n\n")}</blockquote>
    {passage.effectiveFrom && <p className="text-xs text-muted-foreground">Applies from <SourceDate value={passage.effectiveFrom} /></p>}
  </article>) : <p className="text-sm text-muted-foreground">No message preview is available. Open the original source to read it.</p>;
  return <div className="min-w-0 space-y-4" aria-label="Verification evidence comparison">
    {comparisons.length > 0 && <section className="min-w-0 space-y-3" aria-label="Conflicting statements">
      <h4 className="text-sm font-semibold">What differs</h4>
      {comparisons.map((comparison, index) => <div key={`${comparison.subject}:${comparison.topic}:${index}`} className="min-w-0 border-t pt-3">
        <p className="text-xs font-medium text-muted-foreground">{comparison.topic === "deadline" ? "Deadline" : comparison.topic === "paid" ? "Payment status" : comparison.topic === "approved" ? "Approval" : comparison.topic === "completed" ? "Completion" : comparison.topic}</p>
        <div className="mt-2 grid min-w-0 gap-3 md:grid-cols-2">{[comparison.left, comparison.right].map(side => <div key={side.evidenceId} className="min-w-0 border-l-2 border-border pl-3 text-sm">
          <p className="font-medium">{side.kind === "worker" ? "Worker report" : side.kind === "decision" ? "Recorded decision" : side.sender ?? side.source}</p>
          <p className="text-xs text-muted-foreground"><SourceDate value={side.sourceDate} /></p>
          <p className="mt-2 break-words font-semibold">{side.value}</p>
          <blockquote className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{side.quote}</blockquote>
          {side.url && <a className="mt-2 inline-flex items-center gap-1 text-primary underline" href={side.url} target="_blank" rel="noopener noreferrer">Open source <ExternalLink aria-hidden="true" className="size-3" /></a>}
        </div>)}</div>
      </div>)}
    </section>}
    {comparisons.length ? <details><summary className="cursor-pointer text-sm font-medium">Original passages ({sources.length})</summary><div className="mt-3 space-y-3">{sourcePassages}</div></details> : sourcePassages}
    {remaining.length > 0 && <details><summary className="cursor-pointer text-sm font-medium">Other questions to resolve ({remaining.length})</summary><ul className="mt-2 space-y-3">{remaining.map(issue => <li key={issue.id} className="border-l-2 border-border pl-3 text-sm"><p className="font-medium">{workerFacingManagerQuestion(issue.question)}</p></li>)}</ul></details>}
  </div>;
}
