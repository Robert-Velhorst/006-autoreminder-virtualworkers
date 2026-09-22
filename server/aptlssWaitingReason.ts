export const WAITING_REASON_INTERPRETER_VERSION = "1.1.0";

export const WAITING_REASON_CATEGORIES = [
  "approval",
  "decision",
  "information",
  "asset",
  "access",
  "payment",
  "dependency",
  "external_reply",
  "scheduling",
  "internal_action",
  "unclear",
] as const;

// `joyce` remains accepted for historical records. New assessments use `worker`.
export const WAITING_ON_TYPES = ["robert", "worker", "joyce", "external_party", "dependency", "unknown"] as const;
export const WAITING_URGENCIES = ["critical", "high", "normal", "low"] as const;
export const WAITING_NEXT_STEP_TYPES = [
  "request_approval",
  "request_decision",
  "request_information",
  "request_access",
  "verify_payment",
  "monitor_dependency",
  "schedule_follow_up",
  "follow_up",
  "complete_internal_action",
  "clarify_waiting_reason",
] as const;

export type WaitingReasonCategory = (typeof WAITING_REASON_CATEGORIES)[number];
export type WaitingOnType = (typeof WAITING_ON_TYPES)[number];
export type WaitingUrgency = (typeof WAITING_URGENCIES)[number];
export type WaitingNextStepType = (typeof WAITING_NEXT_STEP_TYPES)[number];

export type WaitingReasonContext = {
  cardId?: string;
  cardName?: string;
  boardName?: string;
  listName?: string;
  due?: string | null;
  nowMs?: number;
};

export type WaitingReasonInterpretation = {
  interpreterVersion: string;
  source: "deterministic" | "hybrid_ai";
  rawReason: string;
  normalizedReason: string;
  category: WaitingReasonCategory;
  waitingOn: WaitingOnType;
  waitingOnName: string | null;
  requestedItem: string | null;
  summary: string;
  nextAction: string;
  nextStepType: WaitingNextStepType;
  followUpAt: string | null;
  followUpSource: "explicit" | "derived_contact_age" | "default_policy" | "immediate";
  followUpReason: string;
  isActionableNow: boolean;
  requiresRobert: boolean;
  urgency: WaitingUrgency;
  confidenceScore: number;
  confidenceReason: string;
  missingInformation: string[];
  signals: string[];
};

export type AptlssWaitingSignal = WaitingReasonInterpretation & {
  reasonId: number;
  recordedAt: string;
};

const EAT_OFFSET_MS = 3 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const EXTERNAL_ROLES = [
  "client",
  "customer",
  "vendor",
  "supplier",
  "contractor",
  "freelancer",
  "designer",
  "developer",
  "accountant",
  "lawyer",
  "insurer",
  "bank",
  "landlord",
  "tenant",
  "council",
  "agency",
  "partner",
  "stakeholder",
  "team",
  "owner",
  "klant",
  "leverancier",
  "aannemer",
  "ontwerper",
  "ontwikkelaar",
  "advocaat",
  "verzekeraar",
  "verhuurder",
  "gemeente",
  "instantie",
] as const;
const PARTY_STOP_WORDS = new Set([
  "approval",
  "access",
  "answer",
  "confirmation",
  "decision",
  "details",
  "feedback",
  "files",
  "information",
  "invoice",
  "payment",
  "reply",
  "response",
  "the",
  "her",
  "him",
  "them",
  "haar",
  "hem",
  "hen",
]);
const CONTACT_ACTION_PATTERN = /\b(?:emailed|asked|contacted|messaged|sent|requested|followed\s+up|chased|called|gemaild|gevraagd|benaderd|nagevraagd|gebeld|bericht\s+gestuurd|contact\s+opgenomen)\b/i;

const CATEGORY_PATTERNS: Array<[WaitingReasonCategory, RegExp]> = [
  ["dependency", /\b(blocked\s+(?:by|until)|depends?\s+on|dependency|another\s+card|trello\s+card|deploy(?:ed|ment)?|release\s+must|until\s+.+\s+(?:is|has\s+been)\s+(?:done|complete|finished|deployed)|geblokkeerd\s+(?:door|totdat)|afhankelijk\s+van|andere\s+kaart|uitrol|totdat\s+.+\s+(?:klaar|afgerond|uitgerold)\s+is)\b/i],
  ["access", /\b(access|login|log-in|credentials?|password|permission\s+to\s+(?:a\s+)?(?:system|account|drive|site)|invite|invitation|2fa|otp|verification\s+code|toegang|inlog(?:gegevens)?|wachtwoord|uitnodiging|verificatiecode)\b/i],
  ["payment", /\b(payment|invoice|paid|refund|bank\s+transfer|purchase\s+order|po\s+number|deposit|remittance|betaling|factuur|betaald|terugbetaling|bankoverschrijving|betalingsregeling)\b/i],
  ["approval", /\b(approve|approval|sign[ -]?off|authori[sz]e|go[ -]?ahead|green\s+light|permission\s+to\s+(?:spend|publish|proceed|buy|pay)|goedkeur(?:en|ing)|akkoord|toestemming)\b/i],
  ["decision", /\b(decide|decision|choose|choice|direction|clarif(?:y|ication)|what\s+.+\s+wants?|which\s+(?:option|version)|confirm\s+which|besliss(?:en|ing)|besluit|keuze|richting|verduidelijk(?:en|ing)|wat\s+.+\s+wil)\b/i],
  ["scheduling", /\b(availability|schedule|reschedule|appointment|meeting\s+time|time\s+slot|calendar\s+invite|beschikbaarheid|inplannen|verzetten|afspraak|vergadertijd|tijdslot)\b/i],
  ["asset", /\b(files?|logo|photos?|images?|documents?|attachment|copy|content|brief|contract|signature|spreadsheet|recording|video|bestanden?|foto|afbeelding|documenten?|bijlage|tekst|inhoud|overeenkomst|handtekening|opname)\b/i],
  ["information", /\b(answer|details?|information|feedback|specification|requirements?|quote|confirmation|response|reply|measurements?|address|antwoord|informatie|specificatie|vereisten?|offerte|bevestiging|reactie|afmetingen?|adres)\b/i],
];

const MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
  januari: 0,
  februari: 1,
  maart: 2,
  mei: 4,
  juni: 5,
  juli: 6,
  augustus: 7,
  oktober: 9,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  zondag: 0,
  maandag: 1,
  dinsdag: 2,
  woensdag: 3,
  donderdag: 4,
  vrijdag: 5,
  zaterdag: 6,
};

const MONTH_PATTERN = Object.keys(MONTHS).sort((left, right) => right.length - left.length).join("|");
const WEEKDAY_PATTERN = Object.keys(WEEKDAYS).sort((left, right) => right.length - left.length).join("|");

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function stripHistoricalContactClauses(reason: string) {
  return normalizeWhitespace(reason
    .split(/[.;!?]\s*/)
    .filter((clause) => clause && !CONTACT_ACTION_PATTERN.test(clause))
    .join(" "));
}

function futureTimingScope(reason: string) {
  const operational = stripHistoricalContactClauses(reason);
  const marker = operational.match(/\b(?:waiting|pending|needs?|need|must|will|should|expected|expects?|promised|due|deadline|blocked|sends?|provides?|delivers?|wacht(?:en|end)?|moet(?:en)?|zal|zullen|verwacht(?:en)?|beloofd|stuurt?|levert?)\b/i);
  return marker?.index == null ? "" : operational.slice(marker.index);
}

function titleCase(value: string) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function asEatDate(year: number, month: number, day: number, hour = 9, minute = 0) {
  return new Date(Date.UTC(year, month, day, hour, minute) - EAT_OFFSET_MS);
}

function eatParts(nowMs: number) {
  const date = new Date(nowMs + EAT_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

function parseClock(reason: string, defaultHour = 9, defaultMinute = 0) {
  if (/\b(?:eod|end\s+of\s+day|einde\s+van\s+de\s+dag)\b/i.test(reason)) return { hour: 17, minute: 0 };
  if (/\b(?:noon|middag)\b/i.test(reason)) return { hour: 12, minute: 0 };
  const half = reason.match(/\bom\s+half\s+(\d{1,2})\b/i);
  if (half) return { hour: (Number(half[1]) + 23) % 24, minute: 30 };
  const quarter = reason.match(/\bom\s+kwart\s+(over|voor)\s+(\d{1,2})\b/i);
  if (quarter) return quarter[1].toLowerCase() === "over"
    ? { hour: Number(quarter[2]) % 24, minute: 15 }
    : { hour: (Number(quarter[2]) + 23) % 24, minute: 45 };
  const match = reason.match(/(?:\bat\b|\bom\b|@)\s*(\d{1,2})(?:(?::|\.|u)(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return { hour: defaultHour, minute: defaultMinute };
  let hour = Number(match[1]);
  const minute = Math.min(59, Number(match[2] ?? 0));
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23) return { hour: defaultHour, minute: defaultMinute };
  return { hour, minute };
}

function parseExplicitFollowUp(reason: string, nowMs: number) {
  const clock = parseClock(reason);
  const current = eatParts(nowMs);
  const relative = reason.match(/\b(?:in|after|over|na)\s+(\d{1,3})\s+((?:business|werk)\s+)?(hours?|days?|uur|uren|dagen?|werkdagen?)\b/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[3].toLowerCase();
    if (unit.startsWith("hour") || unit.startsWith("uur")) return new Date(nowMs + amount * 60 * 60 * 1_000);
    if (relative[2] || unit.startsWith("werkdag")) {
      let target = new Date(nowMs);
      let remaining = amount;
      while (remaining > 0) {
        target = new Date(target.getTime() + DAY_MS);
        const weekday = eatParts(target.getTime()).weekday;
        if (weekday !== 0 && weekday !== 6) remaining--;
      }
      const parts = eatParts(target.getTime());
      return asEatDate(parts.year, parts.month, parts.day, clock.hour, clock.minute);
    }
    return new Date(nowMs + amount * DAY_MS);
  }

  const directivePrefix = "(?:by|before|until|follow(?:[ -]?up)?(?:\\s+(?:on|at))?|check(?:\\s+again)?(?:\\s+on|\\s+at)?|remind(?:\\s+me)?(?:\\s+on|\\s+at)?|chase(?:\\s+on|\\s+at)?|voor|uiterlijk|tegen|opvolg(?:en|ing)?(?:\\s+op)?|controleer(?:\\s+opnieuw)?(?:\\s+op)?|herinner(?:\\s+mij)?(?:\\s+op)?)";
  const directiveWeekday = reason.match(new RegExp(`\\b${directivePrefix}\\s+((?:next|volgende)\\s+(?:week\\s+)?)?(${WEEKDAY_PATTERN})\\b`, "i"));
  if (directiveWeekday) {
    const targetWeekday = WEEKDAYS[directiveWeekday[2].toLowerCase()];
    let delta = (targetWeekday - current.weekday + 7) % 7;
    const directiveClock = parseClock(reason.slice(directiveWeekday.index ?? 0));
    if (directiveWeekday[1] || (delta === 0 && (directiveClock.hour < current.hour || (directiveClock.hour === current.hour && directiveClock.minute <= current.minute)))) {
      delta = delta === 0 ? 7 : delta;
    }
    return asEatDate(current.year, current.month, current.day + delta, directiveClock.hour, directiveClock.minute);
  }
  const directiveRelativeDay = reason.match(new RegExp(`\\b${directivePrefix}\\s+(today|tonight|tomorrow|day\\s+after\\s+tomorrow|vandaag|vanavond|morgen|overmorgen)\\b`, "i"));
  if (directiveRelativeDay) {
    const relativeDay = directiveRelativeDay[1];
    const directiveClock = parseClock(reason.slice(directiveRelativeDay.index ?? 0), /^(?:tonight|vanavond)$/i.test(relativeDay) ? 18 : 9);
    const offset = /^(?:day\s+after\s+tomorrow|overmorgen)$/i.test(relativeDay) ? 2
      : /^(tomorrow|morgen)$/i.test(relativeDay) ? 1
        : 0;
    const target = asEatDate(current.year, current.month, current.day + offset, directiveClock.hour, directiveClock.minute);
    return target.getTime() < nowMs ? new Date(nowMs) : target;
  }
  const directiveIso = reason.match(new RegExp(`\\b${directivePrefix}\\s+(20\\d{2})-(\\d{1,2})-(\\d{1,2})\\b`, "i"));
  if (directiveIso) {
    const directiveClock = parseClock(reason.slice(directiveIso.index ?? 0));
    return asEatDate(Number(directiveIso[1]), Number(directiveIso[2]) - 1, Number(directiveIso[3]), directiveClock.hour, directiveClock.minute);
  }
  const directiveNumeric = reason.match(new RegExp(`\\b${directivePrefix}\\s+(\\d{1,2})[\\/-](\\d{1,2})(?:[\\/-](20\\d{2}))\\b`, "i"));
  if (directiveNumeric) {
    const directiveClock = parseClock(reason.slice(directiveNumeric.index ?? 0));
    return asEatDate(Number(directiveNumeric[3]), Number(directiveNumeric[2]) - 1, Number(directiveNumeric[1]), directiveClock.hour, directiveClock.minute);
  }
  const directiveDayMonth = reason.match(new RegExp(`\\b${directivePrefix}\\s+(\\d{1,2})\\s+(${MONTH_PATTERN})(?:\\s+(20\\d{2}))?\\b`, "i"));
  if (directiveDayMonth) {
    const directiveClock = parseClock(reason.slice(directiveDayMonth.index ?? 0));
    const month = MONTHS[directiveDayMonth[2].toLowerCase()];
    let year = Number(directiveDayMonth[3] ?? current.year);
    let date = asEatDate(year, month, Number(directiveDayMonth[1]), directiveClock.hour, directiveClock.minute);
    if (!directiveDayMonth[3] && date.getTime() < nowMs - DAY_MS) date = asEatDate(++year, month, Number(directiveDayMonth[1]), directiveClock.hour, directiveClock.minute);
    return date;
  }
  const directiveMonthDay = reason.match(new RegExp(`\\b${directivePrefix}\\s+(${MONTH_PATTERN})\\s+(\\d{1,2})(?:,?\\s+(20\\d{2}))?\\b`, "i"));
  if (directiveMonthDay) {
    const directiveClock = parseClock(reason.slice(directiveMonthDay.index ?? 0));
    const month = MONTHS[directiveMonthDay[1].toLowerCase()];
    let year = Number(directiveMonthDay[3] ?? current.year);
    let date = asEatDate(year, month, Number(directiveMonthDay[2]), directiveClock.hour, directiveClock.minute);
    if (!directiveMonthDay[3] && date.getTime() < nowMs - DAY_MS) date = asEatDate(++year, month, Number(directiveMonthDay[2]), directiveClock.hour, directiveClock.minute);
    return date;
  }

  const timingScope = futureTimingScope(reason);
  if (!timingScope) return null;
  const timingClock = parseClock(timingScope, /\b(?:tonight|vanavond)\b/i.test(timingScope) ? 18 : 9);
  const iso = timingScope.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return asEatDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), timingClock.hour, timingClock.minute);

  const numeric = timingScope.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](20\d{2}))\b/);
  if (numeric) return asEatDate(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1]), timingClock.hour, timingClock.minute);

  const dayMonth = timingScope.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_PATTERN})(?:\\s+(20\\d{2}))?\\b`, "i"));
  if (dayMonth) {
    const month = MONTHS[dayMonth[2].toLowerCase()];
    let year = Number(dayMonth[3] ?? current.year);
    let date = asEatDate(year, month, Number(dayMonth[1]), timingClock.hour, timingClock.minute);
    if (!dayMonth[3] && date.getTime() < nowMs - DAY_MS) date = asEatDate(++year, month, Number(dayMonth[1]), timingClock.hour, timingClock.minute);
    return date;
  }

  const monthDay = timingScope.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:,?\\s+(20\\d{2}))?\\b`, "i"));
  if (monthDay) {
    const month = MONTHS[monthDay[1].toLowerCase()];
    let year = Number(monthDay[3] ?? current.year);
    let date = asEatDate(year, month, Number(monthDay[2]), timingClock.hour, timingClock.minute);
    if (!monthDay[3] && date.getTime() < nowMs - DAY_MS) date = asEatDate(++year, month, Number(monthDay[2]), timingClock.hour, timingClock.minute);
    return date;
  }

  if (/\b(day\s+after\s+tomorrow|overmorgen)\b/i.test(timingScope)) {
    return asEatDate(current.year, current.month, current.day + 2, timingClock.hour, timingClock.minute);
  }
  if (/\b(tomorrow|morgen)\b/i.test(timingScope)) {
    return asEatDate(current.year, current.month, current.day + 1, timingClock.hour, timingClock.minute);
  }
  if (/\b(today|tonight|vandaag|vanavond)\b/i.test(timingScope)) {
    const target = asEatDate(current.year, current.month, current.day, timingClock.hour, timingClock.minute);
    return target.getTime() < nowMs ? new Date(nowMs) : target;
  }

  const weekdayMatch = timingScope.match(new RegExp(`\\b((?:next|volgende)\\s+(?:week\\s+)?)?(${WEEKDAY_PATTERN})\\b`, "i"));
  if (weekdayMatch) {
    const targetWeekday = WEEKDAYS[weekdayMatch[2].toLowerCase()];
    let delta = (targetWeekday - current.weekday + 7) % 7;
    if (weekdayMatch[1] || (delta === 0 && (timingClock.hour < current.hour || (timingClock.hour === current.hour && timingClock.minute <= current.minute)))) {
      delta = delta === 0 ? 7 : delta;
    }
    return asEatDate(current.year, current.month, current.day + delta, timingClock.hour, timingClock.minute);
  }
  return null;
}

function detectCategory(reason: string): WaitingReasonCategory {
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(reason)) return category;
  }
  if (/\b(waiting|pending|still\s+waiting|no\s+reply|hasn'?t\s+replied|heard\s+back|chasing|wacht(?:en|end)?|nog\s+geen\s+reactie|niets\s+gehoord|navragen)\b/i.test(reason)) return "external_reply";
  if (/\b(i|we|worker|virtual\s+worker|va|joyce|ik|wij)\s+(?:still\s+|nog\s+)?(?:need|must|have|moet(?:en)?|heb(?:ben)?\s+nodig)\s+(?:to|te)\b/i.test(reason)) return "internal_action";
  return "unclear";
}

function extractDependencyName(reason: string) {
  const trelloUrl = reason.match(/trello\.com\/c\/([A-Za-z0-9_-]+)/i);
  if (trelloUrl) return `Trello card ${trelloUrl[1]}`;
  const cardRef = reason.match(/\bcard\s+([A-Za-z0-9][A-Za-z0-9_-]{2,})\b/i);
  if (cardRef) return `card ${cardRef[1]}`;
  const blocker = reason.match(/\bblocked\s+by\s+(.+?)(?=\s+(?:before|until|because|since|and\s+then)\b|[.;,]|$)/i);
  if (blocker) return normalizeWhitespace(blocker[1]).slice(0, 120);
  const until = reason.match(/\buntil\s+(.+?)\s+(?:is|has\s+been)\s+(?:done|complete|finished|deployed)\b/i);
  if (until) return normalizeWhitespace(until[1]).slice(0, 120);
  return null;
}

function extractNamedParty(reason: string) {
  const contactedParty = reason.match(new RegExp(`\\b(?:emailed|asked|contacted|messaged|called|chased)\\s+(.+?)(?=\\s+(?:(?:on|about|for)\\s+)?(?:today|tomorrow|yesterday|last\\s+week|next\\s+week|${WEEKDAY_PATTERN})\\b|[.;,]|$)`, "i"));
  const contactedCandidate = normalizeWhitespace(contactedParty?.[1] ?? "");
  if (contactedCandidate
    && contactedCandidate.length <= 80
    && !PARTY_STOP_WORDS.has(contactedCandidate.toLowerCase())
    && !/^(?:the\s+)?(?:client|customer|vendor|supplier|team)$/i.test(contactedCandidate)) {
    return contactedCandidate.slice(0, 256);
  }
  const patterns = [
    /\b[Ww]aiting\s+(?:for|on)\s+(?:the\s+)?([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2})(?=\s+(?:to|for|about|on)\b|[.;,]|$)/,
    /\b[Ww]acht(?:en)?\s+op\s+(?:de\s+|het\s+)?([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2})(?=\s+(?:om|voor|over)\b|[.;,]|$)/,
    /\b[Ff]rom\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2})(?=\s+(?:to|for|about|on|before|by)\b|[.;,]|$)/,
    /\b[Vv]an\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2})(?=\s+(?:om|voor|over|tegen|uiterlijk)\b|[.;,]|$)/,
    /^([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2})\s+(?:still\s+)?needs?\s+to\b/,
    /^([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2})\s+(?:will|should|is\s+expected\s+to|promised\s+to)\b/,
    /^(?:Klant\s+)?([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2})\s+(?:moet|moeten)\b/,
    /\b(?:emailed|asked|contacted|messaged|called|chased)\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2})(?=\s+(?:on|about|for|last|next|today|tomorrow|yesterday|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|[.;,]|$)/,
    /\b(?:ik\s+heb\s+|wij\s+hebben\s+)?([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2})\s+(?:gemaild|gevraagd|benaderd|gebeld)(?=\s+(?:op|over|voor|vandaag|gisteren|zondag|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag)\b|[.;,]|$)/,
  ];
  for (const pattern of patterns) {
    const match = reason.match(pattern);
    const candidate = normalizeWhitespace(match?.[1] ?? "");
    if (!candidate || PARTY_STOP_WORDS.has(candidate.toLowerCase())) continue;
    return candidate.slice(0, 256);
  }
  return null;
}

function isInternalWorkerReason(reason: string) {
  return /\b(?:worker|virtual\s+worker|va|joyce)\b/i.test(reason)
    || /\b(i|we|ik|wij)\s+(?:still\s+|nog\s+)?(?:need|must|have|moet(?:en)?|heb(?:ben)?\s+nodig)\s+(?:to|te)\b/i.test(reason);
}

function detectWaitingOn(reason: string, category: WaitingReasonCategory) {
  if (category === "dependency") {
    const dependency = extractDependencyName(reason);
    return { waitingOn: "dependency" as const, waitingOnName: dependency };
  }
  if (/\brobert\b/i.test(reason)) return { waitingOn: "robert" as const, waitingOnName: "Robert" };

  const namedParty = extractNamedParty(reason);
  if (namedParty && !/\b(?:joyce|worker|va)\b/i.test(namedParty)) {
    return { waitingOn: "external_party" as const, waitingOnName: namedParty };
  }
  const role = EXTERNAL_ROLES.find((value) => new RegExp(`\\b${value}\\b`, "i").test(reason));
  if (role) return { waitingOn: "external_party" as const, waitingOnName: titleCase(role) };
  if (isInternalWorkerReason(reason)) return { waitingOn: "worker" as const, waitingOnName: "Worker" };

  return { waitingOn: "unknown" as const, waitingOnName: null };
}

function cleanRequestedItem(value: string) {
  const cleaned = normalizeWhitespace(value)
    .replace(/\s+(?:by|before|until|after|since|voor|uiterlijk|tegen|totdat|na|sinds)\s+(?:next\s+|volgende\s+)?(?:today|tomorrow|tonight|vandaag|morgen|vanavond|sunday|monday|tuesday|wednesday|thursday|friday|saturday|zondag|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?|\d{1,2}\s+[A-Za-z]+).*$/i, "")
    .replace(/\s*[.;,]\s*(?:i|we|joyce|ik|wij)\s+(?:already\s+|al\s+)?(?:emailed|asked|contacted|messaged|sent|requested|followed\s+up|gemaild|gevraagd|benaderd|bericht\s+gestuurd|contact\s+opgenomen|nagevraagd).*$/i, "")
    .replace(/[.;,]+$/, "")
    .trim()
    .slice(0, 300);
  const dutchSuffix = cleaned.match(/^(.+?)\s+(goed\s+te\s+keuren|te\s+sturen|te\s+leveren|te\s+bevestigen|te\s+beoordelen|te\s+beslissen)$/i);
  if (!dutchSuffix) return cleaned;
  const verbs: Record<string, string> = {
    "goed te keuren": "approve",
    "te sturen": "send",
    "te leveren": "provide",
    "te bevestigen": "confirm",
    "te beoordelen": "review",
    "te beslissen": "decide",
  };
  return `${verbs[dutchSuffix[2].toLowerCase()]} ${dutchSuffix[1]}`;
}

function extractRequestedItem(reason: string, category: WaitingReasonCategory, waitingOnName: string | null) {
  const patterns = [
    /\b(?:waiting|pending)\s+(?:for|on)\s+.+?\s+to\s+(.+?)(?=\s+(?:by|before|until|after|since)\b|[.;]|$)/i,
    /\b(?:still\s+)?needs?\s+to\s+(.+?)(?=\s+(?:by|before|until|after|since)\b|[.;]|$)/i,
    /\b(?:i|we|joyce)\s+(?:still\s+)?need\s+(.+?)\s+from\s+.+?(?=\s+(?:by|before|until|after|since)\b|[.;]|$)/i,
    /\b(?:approval|sign[ -]?off|confirmation)\s+(?:for|on|of)\s+(.+?)(?=\s+(?:by|before|until|after|since)\b|[.;]|$)/i,
    /\b(?:will|should|is\s+expected\s+to|promised\s+to)\s+(.+?)(?=\s+(?:by|before|until|after|since|today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|[.;]|$)/i,
    /\bwacht(?:en)?\s+op\s+.+?\s+om\s+(.+?)(?=\s+(?:voor|uiterlijk|tegen|totdat|na|sinds)\b|[.;]|$)/i,
    /\b(?:moet|moeten)\s+(.+?)(?=\s+(?:voor|uiterlijk|tegen|totdat|na|sinds)\b|[.;]|$)/i,
    /\b(?:goedkeuring|akkoord|bevestiging)\s+(?:voor|van|op)\s+(.+?)(?=\s+(?:voor|uiterlijk|tegen|totdat|na|sinds)\b|[.;]|$)/i,
    /\b(?:zal|zullen|zou|zouden)\s+(.+?)(?=\s+(?:voor|uiterlijk|tegen|totdat|na|sinds|vandaag|morgen|zondag|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag)\b|[.;]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = reason.match(pattern);
    const item = cleanRequestedItem(match?.[1] ?? "");
    if (item) return category === "access" && /^access\s+to\b/i.test(item) ? `grant ${item}` : item;
  }

  if (category === "access") {
    const match = reason.match(/\b(?:access|toegang)\s+(?:to|tot)\s+(.+?)(?=\s+(?:from|van)\s+|\s+(?:by|before|until|after|voor|uiterlijk|tegen)\b|[.;]|$)/i);
    if (match) return `grant access to ${cleanRequestedItem(match[1])}`;
  }
  if (category === "decision" && waitingOnName === "Robert") {
    const match = reason.match(/\b(?:what\s+robert\s+wants?|direction)\s+(?:for|on|about)\s+(.+?)(?=[.;]|$)/i);
    if (match) return `clarify Robert's direction for ${cleanRequestedItem(match[1])}`;
  }
  if (category === "dependency") {
    const dependency = extractDependencyName(reason);
    if (dependency) return `completion evidence for ${dependency}`;
  }
  const topic = reason.match(/\b(?:about|regarding|concerning|over)\s+(.+?)(?=\s+(?:by|before|until|after|since|voor|uiterlijk|tegen|totdat|na|sinds)\b|[.;]|$)/i);
  if (topic) return cleanRequestedItem(topic[1]);
  return null;
}

function determineUrgency(reason: string, due: string | null | undefined, nowMs: number): WaitingUrgency {
  if (/\b(no\s+rush|low\s+priority|when\s+convenient|geen\s+haast|lage\s+prioriteit|wanneer\s+het\s+uitkomt)\b/i.test(reason)) return "low";
  const timingScope = futureTimingScope(reason);
  if (/\b(urgent|asap|immediately|critical|legal\s+deadline|security\s+incident|dringend|meteen|onmiddellijk|kritiek|juridische\s+deadline|beveiligingsincident)\b/i.test(reason)
    || /\b(today|eod|end\s+of\s+day|vandaag|einde\s+van\s+de\s+dag)\b/i.test(timingScope)) return "critical";
  const dueMs = due ? new Date(due).getTime() : Number.NaN;
  if (Number.isFinite(dueMs) && dueMs <= nowMs) return "critical";
  if (Number.isFinite(dueMs) && dueMs - nowMs <= DAY_MS) return "high";
  if (/\b(client|payment|invoice|contract|deadline|robert|klant|betaling|factuur)\b/i.test(reason) || /\b(tomorrow|morgen)\b/i.test(timingScope)) return "high";
  return "normal";
}

function hasPriorContact(reason: string) {
  return CONTACT_ACTION_PATTERN.test(reason);
}

function priorContactText(reason: string) {
  return normalizeWhitespace(reason
    .split(/[.;!?]\s*/)
    .filter((clause) => clause && CONTACT_ACTION_PATTERN.test(clause))
    .join(" "));
}

function parsePriorContactAt(reason: string, nowMs: number) {
  const contactText = priorContactText(reason);
  if (!contactText) return null;
  const current = eatParts(nowMs);
  const clock = parseClock(contactText, current.hour, current.minute);
  const relative = contactText.match(/\b(\d{1,3})\s+(hours?|days?|uur|uren|dagen?)\s+(?:ago|geleden)\b/i);
  if (relative) {
    const amount = Number(relative[1]);
    const isHours = /^(?:hour|uur)/i.test(relative[2]);
    return new Date(nowMs - amount * (isHours ? 60 * 60_000 : DAY_MS));
  }
  if (/\b(yesterday|gisteren)\b/i.test(contactText)) return new Date(nowMs - DAY_MS);
  if (/\b(last\s+week|vorige\s+week|afgelopen\s+week)\b/i.test(contactText)) return new Date(nowMs - 7 * DAY_MS);
  if (/\b(today|vandaag)\b/i.test(contactText)) {
    const value = asEatDate(current.year, current.month, current.day, clock.hour, clock.minute);
    return value.getTime() > nowMs ? new Date(nowMs) : value;
  }

  const iso = contactText.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const value = asEatDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), clock.hour, clock.minute);
    return value.getTime() <= nowMs ? value : null;
  }
  const numeric = contactText.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2})\b/);
  if (numeric) {
    const value = asEatDate(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1]), clock.hour, clock.minute);
    return value.getTime() <= nowMs ? value : null;
  }
  const dayMonth = contactText.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_PATTERN})(?:\\s+(20\\d{2}))?\\b`, "i"));
  if (dayMonth) {
    const month = MONTHS[dayMonth[2].toLowerCase()];
    let year = Number(dayMonth[3] ?? current.year);
    let value = asEatDate(year, month, Number(dayMonth[1]), clock.hour, clock.minute);
    if (!dayMonth[3] && value.getTime() > nowMs) value = asEatDate(--year, month, Number(dayMonth[1]), clock.hour, clock.minute);
    return value.getTime() <= nowMs ? value : null;
  }
  const monthDay = contactText.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:,?\\s+(20\\d{2}))?\\b`, "i"));
  if (monthDay) {
    const month = MONTHS[monthDay[1].toLowerCase()];
    let year = Number(monthDay[3] ?? current.year);
    let value = asEatDate(year, month, Number(monthDay[2]), clock.hour, clock.minute);
    if (!monthDay[3] && value.getTime() > nowMs) value = asEatDate(--year, month, Number(monthDay[2]), clock.hour, clock.minute);
    return value.getTime() <= nowMs ? value : null;
  }
  const weekday = contactText.match(new RegExp(`\\b(last\\s+|previous\\s+|vorige\\s+|afgelopen\\s+)?(${WEEKDAY_PATTERN})\\b`, "i"));
  if (weekday) {
    const targetWeekday = WEEKDAYS[weekday[2].toLowerCase()];
    let delta = (current.weekday - targetWeekday + 7) % 7;
    if (weekday[1] && delta === 0) delta = 7;
    let value = asEatDate(current.year, current.month, current.day - delta, clock.hour, clock.minute);
    if (value.getTime() > nowMs) value = new Date(value.getTime() - 7 * DAY_MS);
    return value;
  }
  return null;
}

function deriveFollowUp({
  reason,
  waitingOn,
  nowMs,
}: {
  reason: string;
  waitingOn: WaitingOnType;
  nowMs: number;
}) {
  const explicit = parseExplicitFollowUp(reason, nowMs);
  if (explicit) {
    return {
      followUpAt: explicit,
      source: "explicit" as const,
      reason: "The VA supplied a follow-up date or relative time in the waiting reason.",
    };
  }
  const contacted = hasPriorContact(reason);
  const priorContactAt = parsePriorContactAt(reason, nowMs);
  if (priorContactAt) {
    const checkpoint = new Date(priorContactAt.getTime() + DAY_MS);
    const due = checkpoint.getTime() <= nowMs;
    return {
      followUpAt: due ? new Date(nowMs) : checkpoint,
      source: "derived_contact_age" as const,
      reason: due
        ? "The recorded contact is at least one day old, so the follow-up is due now."
        : "APTLSS scheduled the checkpoint 24 hours after the recorded contact.",
    };
  }
  if (waitingOn === "robert" || waitingOn === "worker" || waitingOn === "joyce" || waitingOn === "unknown") {
    return {
      followUpAt: new Date(nowMs),
      source: "immediate" as const,
      reason: waitingOn === "robert"
        ? "A Robert decision can be prepared and presented immediately."
        : "The assigned worker can clarify or resolve this internal blocker immediately.",
    };
  }
  const delayMs = waitingOn === "dependency" ? 4 * 60 * 60 * 1_000 : DAY_MS;
  return {
    followUpAt: new Date(nowMs + delayMs),
    source: "default_policy" as const,
    reason: waitingOn === "dependency"
      ? "No checkpoint was supplied; APTLSS applied a four-hour dependency check."
      : contacted
        ? "No contact time was supplied; APTLSS applied a 24-hour reply checkpoint."
        : "No follow-up time was supplied; APTLSS applied a 24-hour external-response checkpoint.",
  };
}

function formatEatDate(value: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value).replace(",", "") + " EAT";
}

function actorLabel(waitingOn: WaitingOnType, waitingOnName: string | null) {
  if (waitingOnName) return waitingOnName;
  if (waitingOn === "external_party") return "the external party";
  if (waitingOn === "dependency") return "the dependency";
  if (waitingOn === "worker" || waitingOn === "joyce") return "the assigned worker";
  if (waitingOn === "robert") return "Robert";
  return "an unidentified blocker";
}

function buildSummary(category: WaitingReasonCategory, waitingOn: WaitingOnType, waitingOnName: string | null, requestedItem: string | null) {
  const categoryLabel = category.replace(/_/g, " ");
  const item = requestedItem ?? categoryLabel;
  const relation = /^(approve|authori[sz]e|choose|clarify|confirm|decide|deliver|grant|provide|review|send|sign|supply|verify)\b/i.test(item) ? "to" : "for";
  return `Waiting on ${actorLabel(waitingOn, waitingOnName)} ${relation} ${item}.`;
}

function buildNextAction({
  category,
  waitingOn,
  waitingOnName,
  requestedItem,
  followUpAt,
  nowMs,
}: {
  category: WaitingReasonCategory;
  waitingOn: WaitingOnType;
  waitingOnName: string | null;
  requestedItem: string | null;
  followUpAt: Date;
  nowMs: number;
}): { nextAction: string; nextStepType: WaitingNextStepType; isActionableNow: boolean } {
  const party = actorLabel(waitingOn, waitingOnName);
  const item = requestedItem ?? "the missing deliverable";
  const dueNow = followUpAt.getTime() <= nowMs + 5 * 60_000;
  const timing = dueNow ? "now" : `for ${formatEatDate(followUpAt)}`;

  if (waitingOn === "robert") {
    const nextStepType = category === "approval" || category === "payment" ? "request_approval" : "request_decision";
    return {
      nextStepType,
      isActionableNow: true,
      nextAction: `Prepare a bounded ${nextStepType === "request_approval" ? "approval" : "decision"} request for Robert now: ${item}. Include a recommended option, the deadline, and the cost of delay.`,
    };
  }
  if (waitingOn === "dependency") {
    return {
      nextStepType: "monitor_dependency",
      isActionableNow: dueNow,
      nextAction: `${dueNow ? "Check" : "Schedule a check of"} ${party} ${timing}; resume this card only after completion evidence is visible.`,
    };
  }
  if (waitingOn === "worker" || waitingOn === "joyce") {
    return {
      nextStepType: "complete_internal_action",
      isActionableNow: true,
      nextAction: `Resolve the assigned worker's internal blocker now: ${item}. Then reassess the card before starting unrelated work.`,
    };
  }
  if (waitingOn === "unknown") {
    return {
      nextStepType: "clarify_waiting_reason",
      isActionableNow: true,
      nextAction: "Clarify the waiting reason now by naming who or what is blocking the card, the exact missing deliverable, and when follow-up is due.",
    };
  }
  if (category === "access") {
    return {
      nextStepType: dueNow ? "request_access" : "schedule_follow_up",
      isActionableNow: dueNow,
      nextAction: dueNow
        ? `Ask ${party} now to ${item}; verify that the access works before resuming the card.`
        : `Schedule an access request to ${party} for ${formatEatDate(followUpAt)}: ${item}. Verify that the access works before resuming the card.`,
    };
  }
  if (category === "payment") {
    return {
      nextStepType: dueNow ? "verify_payment" : "schedule_follow_up",
      isActionableNow: dueNow,
      nextAction: dueNow
        ? `Verify with ${party} now whether ${item} is complete; if it remains unresolved, prepare a specific escalation with evidence.`
        : `Schedule a payment-status check with ${party} for ${formatEatDate(followUpAt)} about ${item}; if it remains unresolved, prepare a specific escalation with evidence.`,
    };
  }
  const itemRequest = /^(?:approve|authori[sz]e|choose|clarify|confirm|decide|deliver|grant|provide|review|send|sign|supply|verify)\b/i.test(item)
    ? `ask them to ${item}`
    : `request ${item}`;
  return {
    nextStepType: dueNow ? (category === "information" || category === "asset" ? "request_information" : "follow_up") : "schedule_follow_up",
    isActionableNow: dueNow,
    nextAction: dueNow
      ? `Follow up with ${party} now and ${itemRequest}; restate the exact deliverable and deadline.`
      : `Schedule a follow-up with ${party} for ${formatEatDate(followUpAt)} and ${itemRequest}; restate the exact deliverable and deadline.`,
  };
}

export function interpretWaitingReason(reason: string, context: WaitingReasonContext = {}): WaitingReasonInterpretation {
  const rawReason = reason.trim();
  const normalizedReason = normalizeWhitespace(rawReason);
  const nowMs = context.nowMs ?? Date.now();
  const category = detectCategory(normalizedReason);
  const actor = detectWaitingOn(normalizedReason, category);
  const requestedItem = extractRequestedItem(normalizedReason, category, actor.waitingOnName);
  const urgency = determineUrgency(normalizedReason, context.due, nowMs);
  const followUp = deriveFollowUp({ reason: normalizedReason, waitingOn: actor.waitingOn, nowMs });
  const next = buildNextAction({
    category,
    waitingOn: actor.waitingOn,
    waitingOnName: actor.waitingOnName,
    requestedItem,
    followUpAt: followUp.followUpAt,
    nowMs,
  });
  const missingInformation: string[] = [];
  if (actor.waitingOn === "unknown") missingInformation.push("Who or what is blocking the card is not explicit.");
  if (!requestedItem) missingInformation.push("The exact missing deliverable or decision is not explicit.");
  if ((actor.waitingOn === "external_party" || actor.waitingOn === "dependency") && followUp.source === "default_policy") {
    missingInformation.push("No explicit follow-up time was supplied; an APTLSS default was applied.");
  }
  if (/\b(he|him|his|she|her|hers|they|them|their|hij|hem|zijn|zij|haar|hen|hun)\b/i.test(normalizedReason) && !actor.waitingOnName) {
    missingInformation.push("A pronoun is ambiguous without a named person or role.");
  }

  const explicitActor = actor.waitingOn !== "unknown";
  const explicitTime = followUp.source === "explicit";
  let confidence = 28;
  if (explicitActor) confidence += 22;
  if (actor.waitingOnName) confidence += 5;
  if (category !== "unclear") confidence += 16;
  if (requestedItem) confidence += 18;
  if (explicitTime) confidence += 10;
  if (hasPriorContact(normalizedReason)) confidence += 4;
  confidence -= missingInformation.length * 4;
  if (category === "unclear") confidence = Math.min(confidence, 52);
  if (actor.waitingOn === "unknown") confidence = Math.min(confidence, 55);
  confidence = clamp(confidence, 20, 96);
  const requiresRobert = actor.waitingOn === "robert";
  const signals = [
    `category:${category}`,
    `waiting_on:${actor.waitingOn}`,
    explicitActor ? "actor:explicit" : "actor:missing",
    requestedItem ? "deliverable:explicit" : "deliverable:missing",
    explicitTime ? "timing:explicit" : `timing:${followUp.source}`,
    `urgency:${urgency}`,
    ...(hasPriorContact(normalizedReason) ? ["prior_contact:mentioned"] : []),
    ...(requiresRobert ? ["robert_required"] : []),
  ];

  return {
    interpreterVersion: WAITING_REASON_INTERPRETER_VERSION,
    source: "deterministic",
    rawReason,
    normalizedReason,
    category,
    waitingOn: actor.waitingOn,
    waitingOnName: actor.waitingOnName,
    requestedItem,
    summary: buildSummary(category, actor.waitingOn, actor.waitingOnName, requestedItem),
    nextAction: next.nextAction,
    nextStepType: next.nextStepType,
    followUpAt: followUp.followUpAt.toISOString(),
    followUpSource: followUp.source,
    followUpReason: followUp.reason,
    isActionableNow: next.isActionableNow,
    requiresRobert,
    urgency,
    confidenceScore: confidence,
    confidenceReason: `${explicitActor ? "Blocking party identified" : "Blocking party missing"}; ${category !== "unclear" ? `classified as ${category.replace(/_/g, " ")}` : "blocker type unclear"}; ${requestedItem ? "missing item identified" : "missing item unclear"}; ${explicitTime ? "explicit follow-up time found" : "follow-up timing inferred"}.`,
    missingInformation: Array.from(new Set(missingInformation)),
    signals: Array.from(new Set(signals)),
  };
}

type AiWaitingCandidate = Partial<Pick<
  WaitingReasonInterpretation,
  "category" | "waitingOn" | "waitingOnName" | "requestedItem" | "nextAction" | "nextStepType" | "urgency" | "confidenceScore" | "confidenceReason" | "missingInformation"
>>;

function textSupportedByReason(candidate: string | null | undefined, reason: string) {
  if (!candidate) return false;
  const significant = candidate.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  if (!significant.length) return false;
  const normalized = reason.toLowerCase();
  return significant.filter((token) => normalized.includes(token)).length / significant.length >= 0.4;
}

/** Merge AI semantics only when literal text support exists; explicit actor and timing stay locked. */
export function mergeWaitingReasonInterpretation(base: WaitingReasonInterpretation, candidate: AiWaitingCandidate, nowMs = Date.now()): WaitingReasonInterpretation {
  const category = base.category === "unclear" && WAITING_REASON_CATEGORIES.includes(candidate.category as WaitingReasonCategory)
    ? candidate.category as WaitingReasonCategory
    : base.category;
  const actorLocked = base.signals.includes("actor:explicit");
  const requestedCandidateActor = WAITING_ON_TYPES.includes(candidate.waitingOn as WaitingOnType)
    ? candidate.waitingOn as WaitingOnType
    : null;
  const candidateActor = requestedCandidateActor === "joyce" ? "worker" : requestedCandidateActor;
  const candidateName = textSupportedByReason(candidate.waitingOnName, base.rawReason)
    ? normalizeWhitespace(candidate.waitingOnName!).slice(0, 256)
    : null;
  const candidateActorSupported = candidateActor === "external_party" ? Boolean(candidateName)
    : candidateActor === "robert" ? /\brobert\b/i.test(base.rawReason)
      : candidateActor === "worker" ? /\b(worker|virtual\s+worker|va|joyce|i|we|ik|wij)\b/i.test(base.rawReason)
        : candidateActor === "dependency" ? base.category === "dependency"
          : false;
  const waitingOn = !actorLocked && candidateActor && candidateActor !== "unknown" && candidateActorSupported
    ? candidateActor
    : base.waitingOn;
  const waitingOnName = waitingOn === base.waitingOn && base.waitingOnName
    ? base.waitingOnName
    : waitingOn === "robert" ? "Robert"
      : waitingOn === "worker" || waitingOn === "joyce" ? "Worker"
        : candidateName;
  const requestedItem = base.requestedItem
    ?? (textSupportedByReason(candidate.requestedItem, base.rawReason) ? normalizeWhitespace(candidate.requestedItem!).slice(0, 300) : null);
  const urgency = WAITING_URGENCIES.includes(candidate.urgency as WaitingUrgency)
    && base.urgency === "normal"
    ? candidate.urgency as WaitingUrgency
    : base.urgency;
  const followUpAt = base.followUpAt ? new Date(base.followUpAt) : new Date(nowMs);
  const policyNext = buildNextAction({ category, waitingOn, waitingOnName, requestedItem, followUpAt, nowMs });
  const proposedAction = normalizeWhitespace(candidate.nextAction ?? "");
  const nextAction = proposedAction.length >= 20 && proposedAction.length <= 600
    && textSupportedByReason(proposedAction, base.rawReason)
    && !/\b(already|has been|was)\s+(?:sent|posted|moved|completed)\b/i.test(proposedAction)
    ? proposedAction
    : policyNext.nextAction;
  const resolvedActor = waitingOn !== "unknown";
  const resolvedItem = Boolean(requestedItem);
  const candidateConfidence = typeof candidate.confidenceScore === "number" ? candidate.confidenceScore : base.confidenceScore;
  let confidenceScore = clamp(Math.max(base.confidenceScore, Math.min(candidateConfidence, base.confidenceScore + 10)), 20, 96);
  if (!resolvedActor || !resolvedItem) confidenceScore = Math.min(confidenceScore, 60);
  const missingInformation = Array.from(new Set([
    ...base.missingInformation.filter((item) => {
      if (resolvedActor && item.startsWith("Who or what")) return false;
      if (resolvedItem && item.startsWith("The exact missing")) return false;
      return true;
    }),
    ...(Array.isArray(candidate.missingInformation) ? candidate.missingInformation.map((item) => normalizeWhitespace(item).slice(0, 300)).filter(Boolean) : []),
  ])).slice(0, 10);
  const requiresRobert = waitingOn === "robert" || base.requiresRobert;
  const signals = [
    ...base.signals.filter((signal) => !/^(?:category:|waiting_on:|actor:|deliverable:|urgency:|robert_required$)/.test(signal)),
    `category:${category}`,
    `waiting_on:${waitingOn}`,
    resolvedActor ? "actor:explicit" : "actor:missing",
    resolvedItem ? "deliverable:explicit" : "deliverable:missing",
    `urgency:${urgency}`,
    ...(requiresRobert ? ["robert_required"] : []),
    "semantic_refinement:ai",
  ];

  return {
    ...base,
    source: "hybrid_ai",
    category,
    waitingOn,
    waitingOnName,
    requestedItem,
    summary: buildSummary(category, waitingOn, waitingOnName, requestedItem),
    nextAction,
    nextStepType: policyNext.nextStepType,
    isActionableNow: policyNext.isActionableNow,
    urgency,
    requiresRobert,
    confidenceScore,
    confidenceReason: normalizeWhitespace(candidate.confidenceReason ?? "").slice(0, 600) || `${base.confidenceReason} Structured AI refinement was constrained to text-supported fields.`,
    missingInformation,
    signals: Array.from(new Set(signals)),
  };
}
