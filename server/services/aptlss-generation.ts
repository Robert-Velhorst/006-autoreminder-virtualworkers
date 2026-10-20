import { encodeTrelloPathSegment } from "../utils/trello-path";
import { getLLMText, invokeLLM } from "../_core/llm";
import { assertAptlssJobOwnership, createChecklistSyncService } from "./trello-checklist-sync";
import { ScheduledJobLeaseLostError, type ScheduledJobContext } from "../scheduledJobRuntime";

export type AptlssGenerationSettings = {
  applyToTrello?: boolean;
  skipExisting?: boolean;
  replaceExisting?: boolean;
  validateBeforeGenerate?: boolean;
  minimumConfidence?: number;
  clarifiedGoal?: unknown;
};

export type AptlssGeneratedStep = {
  stepNumber: number;
  title: string;
  estimatedMinutes: number;
  category: string;
  requiresFounder: boolean;
  blockedBy: string | null;
  completionCriteria: string;
  riskIfSkipped: string;
  recommendedDecision: string | null;
};

export type AptlssGeneratedPlan = {
  summary: string;
  nextBestAction: string;
  stateReason: string;
  urgencyLabel: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  confidenceScore: number;
  needsReview: boolean;
  missingInformation: string[];
  steps: AptlssGeneratedStep[];
};

type TrelloChecklist = {
  id?: string;
  name?: string;
  checkItems?: Array<{ id?: string; name?: string; state?: string }>;
};

export type AptlssSourceCard = {
  id: string;
  name: string;
  desc?: string | null;
  due?: string | null;
  url?: string;
  shortUrl?: string;
  board?: { name?: string };
  list?: { name?: string };
  labels?: Array<{ name?: string; color?: string }>;
  members?: Array<{ username?: string; fullName?: string }>;
  checklists?: TrelloChecklist[];
  attachments?: Array<{ name?: string; url?: string; mimeType?: string }>;
  actions?: Array<{
    type?: string;
    date?: string;
    data?: { text?: string };
    memberCreator?: { fullName?: string; username?: string };
  }>;
};

export type AptlssGenerationResult = {
  success: true;
  cardId: string;
  aptlss: AptlssGeneratedPlan;
  checklistId: string | null;
  itemsCreated: number;
  appliedToTrello: boolean;
  reusedExistingChecklist: boolean;
  validation: {
    confidenceScore: number;
    minimumConfidence: number;
    passed: boolean;
    needsReview: boolean;
    issues: string[];
  };
};

const generationSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    nextBestAction: { type: "string" },
    stateReason: { type: "string" },
    urgencyLabel: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
    confidenceScore: { type: "number" },
    missingInformation: { type: "array", items: { type: "string" } },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          estimatedMinutes: { type: "number" },
          category: { type: "string" },
          requiresFounder: { type: "boolean" },
          blockedBy: { type: ["string", "null"] },
          completionCriteria: { type: "string" },
          riskIfSkipped: { type: "string" },
          recommendedDecision: { type: ["string", "null"] },
        },
        required: [
          "title",
          "estimatedMinutes",
          "category",
          "requiresFounder",
          "blockedBy",
          "completionCriteria",
          "riskIfSkipped",
          "recommendedDecision",
        ],
        additionalProperties: false,
      },
    },
  },
  required: [
    "summary",
    "nextBestAction",
    "stateReason",
    "urgencyLabel",
    "confidenceScore",
    "missingInformation",
    "steps",
  ],
  additionalProperties: false,
} as const;

function cleanText(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : fallback;
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(maximum, Math.max(minimum, Math.round(numeric)))
    : fallback;
}

function existingAptlssChecklist(card: AptlssSourceCard) {
  return (card.checklists ?? []).find((checklist) =>
    cleanText(checklist.name).toLowerCase().includes("aptlss")
  );
}

async function waitForGeneration<T>(operation: Promise<T>, context?: ScheduledJobContext): Promise<T> {
  if (!context) return operation;
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ScheduledJobLeaseLostError());
    if (context.signal.aborted) onAbort();
    else context.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // The LLM API has no caller signal; abandon its result without allowing writes.
    return await Promise.race([operation, cancelled]);
  } finally {
    context.signal.removeEventListener("abort", onAbort);
  }
}

export function normalizeGeneratedAptlssPlan(raw: unknown, card: AptlssSourceCard): AptlssGeneratedPlan {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  const seen = new Set<string>();
  const steps: AptlssGeneratedStep[] = [];

  for (const candidate of rawSteps.slice(0, 30)) {
    if (!candidate || typeof candidate !== "object") continue;
    const step = candidate as Record<string, unknown>;
    const title = cleanText(step.title);
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    steps.push({
      stepNumber: steps.length + 1,
      title: title.slice(0, 900),
      estimatedMinutes: clampInteger(step.estimatedMinutes, 5, 480, 30),
      category: cleanText(step.category, "internal_work").slice(0, 64),
      requiresFounder: step.requiresFounder === true,
      blockedBy: cleanText(step.blockedBy) || null,
      completionCriteria: cleanText(step.completionCriteria, `The result of "${title}" is verified.`).slice(0, 2_000),
      riskIfSkipped: cleanText(step.riskIfSkipped, "The task may remain incomplete or unverified.").slice(0, 2_000),
      recommendedDecision: cleanText(step.recommendedDecision) || null,
    });
  }

  if (steps.length === 0) {
    steps.push({
      stepNumber: 1,
      title: `Review requirements and define the next action for ${cleanText(card.name, "this card")}`.slice(0, 900),
      estimatedMinutes: 30,
      category: "clarification",
      requiresFounder: false,
      blockedBy: null,
      completionCriteria: "Requirements, owner, evidence, and the next executable action are documented.",
      riskIfSkipped: "Execution would continue without enough verified context.",
      recommendedDecision: null,
    });
  }

  const missingInformation = Array.isArray(value.missingInformation)
    ? Array.from(new Set(value.missingInformation.map((item) => cleanText(item)).filter(Boolean))).slice(0, 20)
    : [];
  const evidenceSignals = [
    cleanText(card.desc).length >= 80,
    (card.actions ?? []).some((action) => cleanText(action.data?.text).length > 0),
    (card.attachments ?? []).length > 0,
    (card.checklists ?? []).some((checklist) => (checklist.checkItems?.length ?? 0) > 0),
    Boolean(card.due),
  ].filter(Boolean).length;
  const evidenceCeiling = Math.min(99, 65 + evidenceSignals * 7);
  const reportedConfidence = clampInteger(value.confidenceScore, 0, 100, 50);
  const confidenceScore = Math.min(reportedConfidence, evidenceCeiling);

  return {
    summary: cleanText(value.summary, `Execution plan for ${cleanText(card.name, "the selected card")}`).slice(0, 2_000),
    nextBestAction: cleanText(value.nextBestAction, steps[0].title).slice(0, 1_000),
    stateReason: cleanText(value.stateReason, "Plan generated from the currently available Trello evidence.").slice(0, 2_000),
    urgencyLabel: ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(String(value.urgencyLabel))
      ? value.urgencyLabel as AptlssGeneratedPlan["urgencyLabel"]
      : "MEDIUM",
    confidenceScore,
    needsReview: confidenceScore < 98 || missingInformation.length > 0,
    missingInformation,
    steps,
  };
}

function compactCardContext(card: AptlssSourceCard, clarifiedGoal: unknown) {
  const comments = (card.actions ?? [])
    .filter((action) => action.type === "commentCard" && cleanText(action.data?.text))
    .slice(0, 20)
    .map((action) => ({
      at: action.date ?? null,
      author: action.memberCreator?.fullName ?? action.memberCreator?.username ?? "Unknown",
      text: cleanText(action.data?.text).slice(0, 2_000),
    }));
  return {
    id: card.id,
    name: cleanText(card.name),
    description: cleanText(card.desc).slice(0, 8_000),
    due: card.due ?? null,
    board: card.board?.name ?? "",
    list: card.list?.name ?? "",
    labels: (card.labels ?? []).map((label) => label.name).filter(Boolean),
    members: (card.members ?? []).map((member) => member.fullName ?? member.username).filter(Boolean),
    attachments: (card.attachments ?? []).slice(0, 20).map((attachment) => ({ name: attachment.name, url: attachment.url })),
    checklists: (card.checklists ?? []).slice(0, 10).map((checklist) => ({
      name: checklist.name,
      items: (checklist.checkItems ?? []).slice(0, 50).map((item) => ({ name: item.name, state: item.state })),
    })),
    comments,
    clarifiedGoal: clarifiedGoal ?? null,
  };
}

export async function fetchAptlssSourceCard(cardId: string, context?: ScheduledJobContext): Promise<AptlssSourceCard> {
  await assertAptlssJobOwnership(context);
  const apiKey = process.env.TRELLO_API_KEY?.trim();
  const token = process.env.TRELLO_TOKEN?.trim();
  if (!apiKey || !token) throw new Error("Trello credentials not configured");

  const encodedCardId = encodeTrelloPathSegment(cardId);
  if (!encodedCardId) throw new Error("Invalid Trello card ID");
  const query = new URLSearchParams({
    key: apiKey,
    token,
    fields: "name,desc,due,url,shortUrl,labels,idBoard,idList,idMembers,badges",
    board: "true",
    list: "true",
    members: "true",
    member_fields: "username,fullName",
    checklists: "all",
    attachments: "true",
    attachment_fields: "name,url,mimeType",
    actions: "commentCard",
    actions_limit: "20",
    action_fields: "data,date,type",
    action_memberCreator_fields: "username,fullName",
  });
  const response = await fetch(`https://api.trello.com/1/cards/${encodedCardId}?${query}`, {
    redirect: "error",
    signal: context ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`Failed to fetch Trello card ${cardId} (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return await response.json() as AptlssSourceCard;
}

export async function generateAptlssForCard(
  card: AptlssSourceCard,
  settings: AptlssGenerationSettings = {},
  context?: ScheduledJobContext,
): Promise<AptlssGenerationResult> {
  await assertAptlssJobOwnership(context);
  if (!card?.id || !cleanText(card.name)) throw new Error("A valid Trello card is required");
  const existing = existingAptlssChecklist(card);
  const applyToTrello = settings.applyToTrello !== false;

  if (settings.skipExisting !== false && existing) {
    const existingSteps = existing.checkItems ?? [];
    const syncStatus = await createChecklistSyncService(context).getSyncStatus(card.id);
    await assertAptlssJobOwnership(context);
    const previouslyVerified = Boolean(
      existing.id
      && existingSteps.length > 0
      && syncStatus.synced
      && syncStatus.checklistId === existing.id
      && syncStatus.itemCount === existingSteps.length,
    );

    // Existence alone is not proof: failed writes can leave a partial checklist.
    if (previouslyVerified) {
      const plan = normalizeGeneratedAptlssPlan({
        summary: `Existing APTLSS checklist retained for ${card.name}.`,
        nextBestAction: existingSteps.find((item) => item.state !== "complete")?.name ?? "Review the completed checklist.",
        stateReason: "The existing APTLSS checklist has a matching successful synchronization record.",
        urgencyLabel: "MEDIUM",
        confidenceScore: 100,
        missingInformation: [],
        steps: existingSteps.map((item) => ({
          title: item.name,
          estimatedMinutes: 30,
          category: "existing_checklist",
          requiresFounder: false,
          blockedBy: null,
          completionCriteria: "The checklist item is complete and its result is verified.",
          riskIfSkipped: "The existing execution plan would remain incomplete.",
          recommendedDecision: null,
        })),
      }, card);
      return {
        success: true,
        cardId: card.id,
        aptlss: plan,
        checklistId: existing.id ?? null,
        itemsCreated: 0,
        appliedToTrello: false,
        reusedExistingChecklist: true,
        validation: { confidenceScore: plan.confidenceScore, minimumConfidence: 0, passed: true, needsReview: false, issues: [] },
      };
    }
  }

  await assertAptlssJobOwnership(context);
  const response = await waitForGeneration(invokeLLM({
    messages: [
      {
        role: "system",
        content: [
          "You are the APTLSS execution planner for a virtual-worker operations platform.",
          "Build a precise evidence-backed plan from the supplied Trello context.",
          "Each step must be executable in one sitting, have a verifiable completion criterion, and preserve approval gates for external communication, payments, deletion, publishing, and card movement.",
          "Identify dependencies, missing facts, quality checks, handoff or follow-up, and decisions requiring the Founder.",
          "Never invent facts or raise confidence because the user wants a high score. Confidence measures evidence sufficiency.",
          "Return only the requested JSON.",
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify(compactCardContext(card, settings.clarifiedGoal)) },
    ],
    maxTokens: 4_000,
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "aptlss_execution_plan", strict: true, schema: generationSchema as unknown as Record<string, unknown> },
    },
  }), context);
  await assertAptlssJobOwnership(context);
  const text = getLLMText(response);
  if (!text) throw new Error("OpenAI returned no APTLSS plan");

  let rawPlan: unknown;
  try {
    rawPlan = JSON.parse(text);
  } catch {
    throw new Error("OpenAI returned an invalid APTLSS plan");
  }
  const plan = normalizeGeneratedAptlssPlan(rawPlan, card);
  const minimumConfidence = clampInteger(settings.minimumConfidence, 0, 100, 70);
  const issues = [...plan.missingInformation];
  if (plan.steps.length < 2) issues.push("The plan has fewer than two executable steps.");
  const passed = plan.confidenceScore >= minimumConfidence && issues.length === 0;

  if (settings.validateBeforeGenerate !== false && !passed) {
    plan.needsReview = true;
  }

  let checklistId: string | null = null;
  let itemsCreated = 0;
  const mayApply = applyToTrello && (settings.validateBeforeGenerate === false || passed);
  if (existing && applyToTrello && !mayApply) {
    throw new Error("The existing APTLSS checklist is not verified as complete, and the replacement plan did not pass validation.");
  }
  if (mayApply) {
    await assertAptlssJobOwnership(context);
    const sync = await createChecklistSyncService(context).syncChecklistToCard(
      card.id,
      plan.steps.map((step) => ({
        step: step.title,
        timeMinutes: step.estimatedMinutes,
        aptlssType: (["A", "P", "T", "L", "S"].includes(step.category.toUpperCase())
          ? step.category.toUpperCase()
          : "T") as "A" | "P" | "T" | "L" | "S",
      })),
      {
        checklistName: "APTLSS Execution Checklist",
        replaceExisting: settings.replaceExisting === true,
        preserveCompleted: true,
      },
    );
    if (!sync.success) throw new Error(sync.error || "Trello checklist synchronization failed");
    checklistId = sync.checklistId ?? null;
    itemsCreated = sync.itemsCreated ?? 0;
  }

  await assertAptlssJobOwnership(context);
  return {
    success: true,
    cardId: card.id,
    aptlss: plan,
    checklistId,
    itemsCreated,
    appliedToTrello: mayApply,
    reusedExistingChecklist: false,
    validation: {
      confidenceScore: plan.confidenceScore,
      minimumConfidence,
      passed,
      needsReview: plan.needsReview,
      issues,
    },
  };
}

export async function fetchAndGenerateAptlss(
  cardId: string,
  settings: AptlssGenerationSettings = {},
  context?: ScheduledJobContext,
) {
  return generateAptlssForCard(await fetchAptlssSourceCard(cardId, context), settings, context);
}
