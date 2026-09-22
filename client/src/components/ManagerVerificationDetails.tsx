import { workerFacingManagerQuestion, type ManagerIntervention } from "@shared/aptlssManager";

function SourceDate({ value }: { value: string | null }) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? <time dateTime={date.toISOString()}>{date.toLocaleString()}</time> : null;
}

export function ManagerVerificationDetails({ intervention }: { intervention: ManagerIntervention }) {
  const verification = intervention.verification;
  if (!verification) return null;
  type Passage = typeof verification.passages[number];
  // Preserve distinct source versions while joining excerpts from the same record.
  const sources = new Map<string, { passage: Passage; quotes: string[] }>();
  for (const passage of verification.passages) {
    if (/^(from|sender|status):[^\r\n]*$/i.test(passage.quote.trim())) continue;
    const key = JSON.stringify([passage.evidenceId, passage.kind, passage.sourceDate, passage.effectiveFrom]);
    const group = sources.get(key) ?? { passage, quotes: [] };
    const quote = passage.quote.trim();
    if (quote && !group.quotes.includes(quote)) group.quotes.push(quote);
    sources.set(key, group);
  }
  const remaining = verification.issues.filter(issue => issue.id !== intervention.id);
  return <div className="min-w-0 space-y-4" aria-label="Verification evidence comparison">
    {sources.size ? [...sources].map(([key, { passage, quotes }]) => <article key={key} className="min-w-0 border-l-2 border-border pl-3 text-sm" aria-label="Source preview">
      <p className="font-medium">{passage.kind === "worker" ? "Worker statement" : passage.kind === "decision" ? "Recorded decision" : passage.sender ?? "Original message"}</p>
      <p className="mt-1 text-xs text-muted-foreground"><SourceDate value={passage.sourceDate} /></p>
      <blockquote className="my-3 whitespace-pre-wrap break-words leading-relaxed">{quotes.join("\n\n")}</blockquote>
      {passage.effectiveFrom && <p className="text-xs text-muted-foreground">Applies from <SourceDate value={passage.effectiveFrom} /></p>}
    </article>) : <p className="text-sm text-muted-foreground">No message preview is available. Open the original source to read it.</p>}
    {remaining.length > 0 && <details><summary className="cursor-pointer text-sm font-medium">Other questions to resolve ({remaining.length})</summary><ul className="mt-2 space-y-3">{remaining.map(issue => <li key={issue.id} className="border-l-2 border-border pl-3 text-sm"><p className="font-medium">{workerFacingManagerQuestion(issue.question)}</p></li>)}</ul></details>}
  </div>;
}
