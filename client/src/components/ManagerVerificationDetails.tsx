import type { ManagerIntervention } from "@shared/aptlssManager";

function SourceDate({ value }: { value: string | null }) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? <time dateTime={date.toISOString()}>{date.toLocaleString()}</time> : <>Not recorded</>;
}

export function ManagerVerificationDetails({ intervention }: { intervention: ManagerIntervention }) {
  const verification = intervention.verification;
  if (!verification) return null;
  const sources = verification.passages;
  const remaining = verification.issues.filter(issue => issue.id !== intervention.id);
  const renderSources = (items: typeof sources) => <div className="grid min-w-0 gap-3 sm:grid-cols-2">{items.map((passage, index) => <div key={`${passage.evidenceId}-${index}`} className="min-w-0 border-l-2 border-border pl-3 text-xs">
    <div className="flex flex-wrap gap-x-2 gap-y-1 font-medium"><span>{passage.source}</span><span className="text-muted-foreground">{passage.kind === "worker" ? "Worker statement" : passage.kind === "decision" ? "Recorded decision" : "Retained source"}</span></div>
    <blockquote className="my-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">{passage.quote}</blockquote>
    <p className="text-muted-foreground">{passage.sender ?? "Sender not recorded"}</p>
    <p className="text-muted-foreground">Source date: <SourceDate value={passage.sourceDate} /></p>
    <p className="text-muted-foreground">Observed: <SourceDate value={passage.observedAt ?? null} /></p>
    <p className="text-muted-foreground">Effective from: <SourceDate value={passage.effectiveFrom} /></p>
  </div>)}</div>;
  return <div className="min-w-0 space-y-3" aria-label="Verification evidence comparison">
    {renderSources(sources.slice(0, 2))}
    {sources.length > 2 && <details><summary className="cursor-pointer text-xs font-medium">Additional source passages ({sources.length - 2})</summary><div className="mt-3">{renderSources(sources.slice(2))}</div></details>}
    {remaining.length > 0 && <details><summary className="cursor-pointer text-xs font-medium">Other open questions ({remaining.length})</summary><ul className="mt-2 space-y-3">{remaining.map(issue => <li key={issue.id} className="border-l-2 border-border pl-3 text-xs"><p className="font-medium">{issue.question}</p><p className="mt-1 text-muted-foreground">{issue.explanation}</p>{issue.severity === "urgent" && <p className="mt-1 text-destructive">Urgent prerequisite</p>}</li>)}</ul></details>}
  </div>;
}
