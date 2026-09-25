import type { ManagerCard, ManagerEvidence } from "../shared/aptlssManager";
import { gmailContentScope } from "../shared/gmailContentScope";
import {
  MANAGER_DAY,
  validManagerDate,
  validManagerTimestamp,
  type ManagerEvidenceMetadata,
  type ManagerFact,
  type ManagerGraphConflict,
  type ManagerReliability,
} from "../shared/aptlssManagerEvidence";

type Evidence = ManagerEvidence & { metadata?: ManagerEvidenceMetadata };
export const unsafeManagerText =
  /ignore\s+(?:all\s+|previous\s+|prior\s+)?instructions|system\s*:|developer\s*:|\b(?:exfiltrate|bypass|override safeguards)\b|<\s*script|javascript\s*:|[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/i;
const uncertain =
  /\?|\b(?:if|unless|perhaps|maybe|might|could|would|will|whether|unknown|unclear|unsure|probably|apparently|reportedly|allegedly|supposedly|said|says|don't know|do not know|not sure|als|indien|misschien|wellicht|onbekend|onduidelijk|zal|zou|zegt|zei)\b|\b(?:not|niet)\s+(?:only|alleen)\b/i;

export function managerFact(
  e: Evidence,
  quote: string,
  topic: string,
  value: string,
  support: ManagerFact["support"] = "explicit"
): ManagerFact {
  const m = e.metadata;
  const entity = quote.match(
    /\b(invoice|factuur|project|order|ticket|revision|revisie)\s+(?:#\s*)?([a-z0-9][a-z0-9_-]*)\b/i
  );
  const generic =
    /^(?:is|has|was|not|unpaid|paid|betaald|niet|nog|the|an|it|het|de)$/i;
  const subject =
    entity && !generic.test(entity[2])
      ? `${entity[1].toLowerCase().replace("factuur", "invoice").replace("revisie", "revision")}:${entity[2].toLowerCase()}`
      : e.cardId;
  return {
    subject,
    topic,
    value,
    quote,
    evidenceId: e.id,
    cardId: e.cardId,
    sender: m?.sender ?? null,
    source: e.source,
    observedAt: e.observedAt,
    sourceDate: m?.sourceDate ?? null,
    effectiveFrom:
      m?.effectiveFrom ??
      quote.match(
        /\b(?:as of|on|per|vanaf|op)\s+(\d{4}-\d{2}-\d{2})\b/i
      )?.[1] ??
      null,
    effectiveTo: m?.effectiveTo ?? null,
    sourceRevision: m?.sourceRevision ?? null,
    truthClass:
      support === "unknown"
        ? "unknown"
        : (m?.truthClass ??
          (e.kind === "worker"
            ? "worker_report"
            : e.kind === "decision"
              ? "human_decision"
              : "source_record")),
    support,
  };
}

function structuredTaskFacts(e: Evidence): ManagerFact[] | null {
  if (!e.text.trim().startsWith("{")) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(e.text);
  } catch {
    return null;
  }
  if (
    !raw ||
    Array.isArray(raw) ||
    typeof raw !== "object" ||
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    (typeof raw.id === "string" && raw.id !== e.cardId)
  )
    return null;
  const facts: ManagerFact[] = [];
  const add = (field: string, topic: string, value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    facts.push({
      ...managerFact(e, value, topic, value),
      subject: e.cardId,
      sourceField: `$.${field}`,
    });
  };
  // Structured context asserts what the task fields contain, not that prose in
  // the description is true or that any action has been authorized/completed.
  add("name", "context", raw.name);
  add("desc", "context", raw.desc);
  add("description", "context", raw.description);
  if (typeof raw.due === "string") {
    facts.push({
      ...managerFact(
        e,
        raw.due,
        "deadline",
        raw.due.slice(0, 10),
        validManagerDate(raw.due) ? "explicit" : "unknown"
      ),
      subject: e.cardId,
      sourceField: "$.due",
    });
  }
  const list =
    typeof raw.list === "string"
      ? raw.list
      : raw.list && typeof raw.list === "object"
        ? (raw.list as Record<string, unknown>).name
        : raw.listName;
  const listField =
    typeof raw.list === "string"
      ? "list"
      : raw.list && typeof raw.list === "object"
        ? "list.name"
        : "listName";
  add(listField, "context", list);
  add("state", "context", raw.state);
  for (const [field, value] of [
    [listField, list],
    ["state", raw.state],
  ] as const) {
    if (typeof value !== "string") continue;
    const state = value.toLowerCase().replace(/[\s_-]/g, "");
    if (["onhold", "doing", "todo"].includes(state))
      facts.push({
        ...managerFact(e, value, "status", state),
        subject: e.cardId,
        sourceField: `$.${field}`,
      });
  }
  for (const field of ["desc", "description"]) {
    if (typeof raw[field] !== "string") continue;
    facts.push(
      ...extractManagerFacts({ ...e, text: raw[field] })
        .filter(f => f.topic !== "context")
        .map(f => ({ ...f, sourceField: `$.${field}` }))
    );
  }
  if (Array.isArray(raw.comments))
    raw.comments.slice(0, 100).forEach((comment, index) => {
      if (
        !comment ||
        typeof comment !== "object" ||
        typeof comment.text !== "string"
      )
        return;
      const source = {
        ...e,
        text: comment.text,
        metadata: {
          ...e.metadata,
          sender:
            typeof comment.memberName === "string" ? comment.memberName : null,
          sourceDate: typeof comment.date === "string" ? comment.date : null,
        },
      };
      facts.push(
        ...extractManagerFacts(source).map(f => ({
          ...f,
          sourceField: `$.comments[${index}].text`,
          truthClass:
            f.support === "unknown"
              ? ("unknown" as const)
              : ("worker_report" as const),
        }))
      );
    });
  return facts;
}

export function extractManagerFacts(e: Evidence): ManagerFact[] {
  if (e.source === "gmail" && e.kind === "source" &&
      (e.metadata?.contentScope === "portal_notice" || gmailContentScope("", e.text) === "portal_notice"))
    return [managerFact(e, e.text, "unknown", "underlying document unread", "unknown")];
  if (unsafeManagerText.test(e.text))
    return [managerFact(e, e.text, "unknown", "unsafe text", "unknown")];
  const structured = structuredTaskFacts(e);
  if (structured) return structured;
  const facts: ManagerFact[] = [];
  for (const quote of e.text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean)) {
    const ambiguousPolarity =
      /\b(?:no evidence|not confirmed|not verified|false that|niet bevestigd|geen bewijs|no longer|niet langer)\b|\b(?:not|niet)\s+(?:unpaid|incomplete|unapproved|onbetaald)\b|\bpaid\s+(?:leave|holiday|vacation)\b/i.test(
        quote
      );
    const multipleSubjects =
      (quote.match(
        /\b(?:invoice|factuur|project|order|ticket|revision|revisie)\b/gi
      )?.length ?? 0) > 1;
    if (
      uncertain.test(quote) ||
      ambiguousPolarity ||
      multipleSubjects ||
      /["\u201c\u201d]/.test(quote) ||
      /\b(?:but|however|although|and|en|maar|behalve|except)\b|^\s*(?:please\s+)?(?:mark|pay|send|submit|declare|assume|betaal|markeer|verstuur)\b/i.test(
        quote
      )
    ) {
      facts.push(
        managerFact(e, quote, "unknown", "unverified statement", "unknown")
      );
      continue;
    }
    const before = facts.length;
    const add = (topic: string, yes: RegExp, no: RegExp) => {
      const normalized = quote
        .toLowerCase()
        .replace(
          /\b(isn|wasn|hasn|haven|hadn|weren|aren|didn|doesn|don)['\u2019]t\b/g,
          "$1 not"
        );
      if (no.test(normalized)) facts.push(managerFact(e, quote, topic, "no"));
      else if (yes.test(normalized))
        facts.push(managerFact(e, quote, topic, "yes"));
    };
    add(
      "paid",
      /\b(paid|betaald)\b/,
      /\b(?:not|never|niet|nooit)\b[^.!?;]{0,35}\b(?:paid|betaald)\b|\bunpaid\b/
    );
    add(
      "approved",
      /\b(approved|approval received|akkoord gegeven|goedgekeurd)\b/,
      /\b(?:not|never|niet|nooit)\b[^.!?;]{0,35}\b(?:approved|goedgekeurd)\b|\b(?:no|geen)\s+(?:approval|akkoord)\b|\bapproval\s+(?:is\s+)?pending\b|\bpending approval\b|\b(?:rejected|afgekeurd)\b/
    );
    add(
      "completed",
      /\b(completed|finished|afgerond|klaar)\b/,
      /\b(?:not|never|niet|nooit)\b[^.!?;]{0,35}\b(?:completed|finished|afgerond|klaar)\b|\bincomplete\b/
    );
    const state = quote.match(
      /\bstatus\s*:\s*(on[- ]?hold|doing|to[- ]?do)\b/i
    )?.[1];
    if (state)
      facts.push(
        managerFact(
          e,
          quote,
          "status",
          state.toLowerCase().replace(/[- ]/g, "")
        )
      );
    const deadline = quote.match(
      /\b(?:deadline|uiterste datum)(?:\s+is(?:\s+now)?|\s*:)?\s*(\d{4}-\d{2}-\d{2})\b/i
    )?.[1];
    if (deadline)
      facts.push(
        managerFact(
          e,
          quote,
          "deadline",
          deadline,
          validManagerDate(deadline) ? "explicit" : "unknown"
        )
      );
    // These statements support context only, never completion, payment or approval.
    if (
      facts.length === before &&
      /\b(?:report|rapport|brief)\b.*\b(?:ready|prepare|review|check)\b|^\s*(?:prepare|review|check|controleer|bekijk)\b/i.test(
        quote
      )
    )
      facts.push(managerFact(e, quote, "context", quote));
    if (facts.length === before)
      facts.push(
        managerFact(e, quote, "unknown", "unrecognized statement", "unknown")
      );
  }
  return facts;
}

function validMetadata(e: Evidence, now: number) {
  const m = e.metadata;
  if (!validManagerTimestamp(e.observedAt) || Date.parse(e.observedAt) > now)
    return false;
  if (
    m &&
    Object.prototype.hasOwnProperty.call(m, "sourceDate") &&
    !validManagerDate(m.sourceDate)
  )
    return false;
  if (m?.sourceDate && Date.parse(m.sourceDate) > now) return false;
  for (const date of [m?.effectiveFrom, m?.effectiveTo])
    if (date && !validManagerDate(date)) return false;
  return !(
    m?.effectiveFrom &&
    m.effectiveTo &&
    Date.parse(m.effectiveFrom) >= Date.parse(m.effectiveTo)
  );
}
function supersedes(newer: Evidence, older: Evidence, now: number) {
  const n = newer.metadata,
    o = older.metadata;
  if (!n?.supersedesEvidenceIds?.includes(older.id)) return false;
  const humanResolution =
    newer.kind === "decision" &&
    n?.truthClass === "human_decision" &&
    n.authority === "authoritative" &&
    !!n.sender?.trim();
  const sameSourceRecordRevision =
    newer.source === older.source &&
    !!n.sourceRecordId?.trim() &&
    n.sourceRecordId === o?.sourceRecordId &&
    (n.sender?.trim() || "") === (o?.sender?.trim() || "") &&
    !!n.sourceRevision?.trim() &&
    !!o?.sourceRevision?.trim() &&
    n.sourceRevision !== o.sourceRevision &&
    n.authority !== "reported" &&
    n.authority !== "unverified";
  const olderClaims = extractManagerFacts(older).filter(
    f => f.support === "explicit" && f.topic !== "context"
  );
  const replacementClaims = extractManagerFacts(newer).filter(
    f => f.support === "explicit" && f.topic !== "context"
  );
  const coversClaims = olderClaims.every(old =>
    replacementClaims.some(
      next => next.subject === old.subject && next.topic === old.topic
    )
  );
  return (
    newer.id !== older.id &&
    newer.cardId === older.cardId &&
    (sameSourceRecordRevision || humanResolution) &&
    newer.kind !== "worker" &&
    n?.truthClass !== "model_proposal" &&
    n?.supersedesEvidenceIds?.includes(older.id) &&
    validMetadata(newer, now) &&
    !!n.sourceDate &&
    replacementClaims.length > 0 &&
    coversClaims &&
    (humanResolution ||
      (validMetadata(older, now) &&
        !!o?.sourceDate &&
        Date.parse(n.sourceDate) > Date.parse(o.sourceDate) &&
        (!o.effectiveFrom || Date.parse(n.effectiveFrom ?? "") >= Date.parse(o.effectiveFrom)))) &&
    !!n.effectiveFrom &&
    Date.parse(n.effectiveFrom) <= now &&
    (!n.effectiveTo || Date.parse(n.effectiveTo) > now)
  );
}

export function assessManagerEvidence(
  card: ManagerCard,
  input: Evidence[],
  graphConflicts: ManagerGraphConflict[],
  now: number,
  truncated = false
) {
  const records = input.filter(e => e.cardId === card.id);
  const duplicateIds = new Set(
    records
      .filter((e, i) =>
        records.some(
          (other, j) =>
            j < i &&
            other.id === e.id &&
            JSON.stringify(other) !== JSON.stringify(e)
        )
      )
      .map(e => e.id)
  );
  const seen = new Set<string>();
  const evidence = records.filter(e => {
    const stableSource = e.metadata?.sourceRecordId && e.metadata?.sourceRevision;
    const key = stableSource ? JSON.stringify([
      e.cardId, e.source, e.kind, e.metadata?.sourceRecordId, e.metadata?.sourceRevision,
      e.text.trim(), e.metadata?.sender ?? null, e.metadata?.sourceDate ?? null,
      e.metadata?.effectiveFrom ?? null, e.metadata?.effectiveTo ?? null,
      e.metadata?.truthClass ?? null, e.metadata?.authority ?? null,
    ]) : JSON.stringify([e.cardId, e.source, e.kind, e.text.trim(), e.metadata ?? null, e.observedAt]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const active = evidence.filter(
    e => !evidence.some(newer => supersedes(newer, e, now))
  );
  const facts = evidence.flatMap(extractManagerFacts);
  const activeIds = new Set(active.map(e => e.id));
  const currentFacts = facts.filter(
    f =>
      activeIds.has(f.evidenceId) &&
      f.support === "explicit" &&
      f.truthClass !== "model_proposal" &&
      f.truthClass !== "unknown"
  );
  const conflicts = new Set(duplicateIds);
  for (const f of currentFacts) {
    if (
      currentFacts.some(
        other =>
          f.subject === other.subject &&
          f.topic === other.topic &&
          f.value !== other.value &&
          f.topic !== "context" &&
          !(
            f.effectiveTo &&
            other.effectiveFrom &&
            validManagerDate(f.effectiveTo) &&
            validManagerDate(other.effectiveFrom) &&
            Date.parse(f.effectiveTo) <= Date.parse(other.effectiveFrom)
          ) &&
          !(
            other.effectiveTo &&
            f.effectiveFrom &&
            validManagerDate(other.effectiveTo) &&
            validManagerDate(f.effectiveFrom) &&
            Date.parse(other.effectiveTo) <= Date.parse(f.effectiveFrom)
          )
      )
    )
      conflicts.add(f.evidenceId);
    if (
      f.subject === card.id &&
      ((f.topic === "deadline" &&
        card.dueAt &&
        card.dueAt.slice(0, 10) !== f.value) ||
        (f.topic === "completed" &&
          f.value === "yes" &&
          card.state.toUpperCase() !== "DONE"))
    )
      conflicts.add(f.evidenceId);
  }
  const graph = graphConflicts.filter(
    g =>
      g.cardId === card.id &&
      !["resolved", "dismissed", "superseded"].includes(
        (g.status ?? "open").toLowerCase()
      )
  );
  for (const g of graph) for (const id of g.evidenceIds) conflicts.add(id);
  const work = card.steps
    .filter(s => !s.complete)
    .map(s => s.title)
    .join(" ");
  const requiredTopics = [
    ...(/\b(?:pay|payment|invoice|betaal|betaling|factuur)\b/i.test(work)
      ? ["paid"]
      : []),
    ...(/\b(?:approval|approved|approve|akkoord|goedkeuring)\b/i.test(work)
      ? ["approved"]
      : []),
  ];
  const missingTopics = requiredTopics.filter(
    topic =>
      !currentFacts.some(
        f =>
          f.topic === topic &&
          f.subject === card.id &&
          (f.truthClass === "source_record" ||
            f.truthClass === "human_decision")
      )
  );
  const essential = active.filter(e => e.metadata?.essential === true);
  // Supporting history is not essential solely because it is attached. Scope
  // freshness to designated task context and facts needed by its remaining work.
  const relevant = active.filter(
    e =>
      e.metadata?.essential !== false &&
      (e.metadata?.essential === true ||
        currentFacts.some(
          f =>
            f.evidenceId === e.id &&
            (requiredTopics.includes(f.topic) ||
              (!essential.length && f.topic === "context"))
        ))
  );
  if (!relevant.length)
    relevant.push(...active.filter(e => e.metadata?.essential !== false));
  const invalid =
    relevant.some(
      e =>
        !validMetadata(e, now) ||
        extractManagerFacts(e).some(
          f => f.sourceField === "$.due" && f.support === "unknown"
        )
    ) ||
    (!!card.dueAt && !validManagerDate(card.dueAt));
  const stale = relevant.some(
    e =>
      validMetadata(e, now) &&
      (now -
        Date.parse(
          e.metadata?.sourceDate ??
            extractManagerFacts(e).find(f => f.effectiveFrom)?.effectiveFrom ??
            e.observedAt
        ) >
        30 * MANAGER_DAY ||
        (!!e.metadata?.effectiveTo &&
          Date.parse(e.metadata.effectiveTo) <= now))
  );
  const future = relevant.some(e =>
    extractManagerFacts(e).some(
      f =>
        !!f.effectiveFrom &&
        (!validManagerDate(f.effectiveFrom) ||
          Date.parse(f.effectiveFrom) > now)
    )
  );
  const unknown =
    relevant.some(
      e =>
        !currentFacts.some(f => f.evidenceId === e.id) ||
        (!structuredTaskFacts(e) &&
          extractManagerFacts(e).some(f => f.support === "unknown"))
    ) || missingTopics.length > 0;
  const portalNotice = relevant.some(e => e.source === "gmail" && e.kind === "source" &&
    (e.metadata?.contentScope === "portal_notice" || gmailContentScope("", e.text) === "portal_notice"));
  const unresolved = conflicts.size > 0 || graph.length > 0;
  const reasons = [
    ...(!evidence.length ? ["No source evidence is linked"] : []),
    ...(invalid
      ? ["Invalid, missing, future or timezone-ambiguous source date"]
      : []),
    ...(stale ? ["Essential source evidence is stale or expired"] : []),
    ...(future ? ["Essential evidence is not yet effective"] : []),
    ...(portalNotice ? ["Only a portal notice is available; the underlying correspondence has not been checked"] : []),
    ...(unknown
      ? [
          "Essential claims lack explicit support; verify unknown or unsafe statements",
        ]
      : []),
    ...missingTopics.map(
      topic => `Missing source-supported fact required for this task: ${topic}`
    ),
    ...(unresolved ? ["Conflicting evidence requires verification"] : []),
    ...(truncated ? ["This task's evidence was truncated"] : []),
  ];
  const reliability: ManagerReliability = {
    coverage: !evidence.length
      ? "missing"
      : truncated || unknown
        ? "partial"
        : "sufficient",
    freshness:
      invalid || future || !evidence.length
        ? "unknown"
        : stale
          ? "stale"
          : "current",
    conflicts: unresolved ? "unresolved" : "none_detected",
    support:
      unknown || !currentFacts.length
        ? facts.some(f => f.truthClass === "model_proposal")
          ? "proposed"
          : "unknown"
        : currentFacts.some(
              f =>
                f.truthClass === "source_record" ||
                f.truthClass === "human_decision"
            )
          ? "direct"
          : "reported",
    calibrated: false,
    reasons,
  };
  return {
    evidence,
    facts,
    conflictIds: [...conflicts].sort(),
    unresolved,
    reliability,
    blocked: reasons.length > 0,
  };
}
