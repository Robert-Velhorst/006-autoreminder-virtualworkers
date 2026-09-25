import type { ManagerIntervention } from "./aptlssManager";

type Passage = NonNullable<ManagerIntervention["verification"]>["passages"][number];

export function groupManagerVerificationPassages(passages: Passage[]) {
  const records = new Map<string, { passage: Passage; quotes: string[] }>();
  for (const passage of passages) {
    const quote = passage.quote.trim();
    if (!quote || /^(from|sender|status):[^\r\n]*$/i.test(quote)) continue;
    // A content revision is one source record, even when extraction produced several evidence rows.
    const identity = passage.sourceRecordId && passage.sourceRevision
      ? [passage.source, passage.sourceRecordId, passage.sourceRevision, passage.sender, passage.sourceDate, passage.kind]
      : [passage.evidenceId, passage.kind, passage.sourceDate, passage.effectiveFrom];
    const key = JSON.stringify(identity);
    const group = records.get(key) ?? { passage, quotes: [] };
    if (!group.quotes.includes(quote)) group.quotes.push(quote);
    records.set(key, group);
  }
  return [...records.values()];
}
