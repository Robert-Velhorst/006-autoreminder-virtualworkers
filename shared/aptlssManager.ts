import type { ManagerEvidenceMetadata, ManagerGraphConflict, ManagerReliability, ManagerFact } from "./aptlssManagerEvidence";

export const WORKER_EXECUTION_HOLD_MESSAGE = "The full work list has not been checked. Do not start a task yet. Ask your supervisor to restore the missing work information, then check again.";

export function workerFacingManagerQuestion(question: string) {
  if (/which unknown applies now/i.test(question)) {
    return "Open the linked source and confirm the current fact needed for this task: what changed, who confirmed it, and from what date does it apply?";
  }
  return question;
}

export type ManagerEvidence = {
  id: string;
  cardId: string;
  source: string;
  text: string;
  observedAt: string;
  url?: string | null;
  kind: "source" | "worker" | "decision";
  metadata?: ManagerEvidenceMetadata;
};

export type ManagerCard = {
  id: string;
  name: string;
  url: string | null;
  board: string;
  list: string;
  state: string;
  stateReason: string;
  dueAt: string | null;
  overdue: boolean;
  priority: number;
  updatedAt: string;
  steps: Array<{ id: number; title: string; category: string; minutes: number; complete: boolean; requiresDecision: boolean; decisionRejected?: boolean; blocked?: boolean; blockReason?: string; dependsOn: string[]; completionCriteria: string | null }>;
  waiting: { reason: string; action: string; followUpAt: string | null; category: string; confidence: number } | null;
};

export type ManagerTimeSample = {
  id: number;
  cardId: string;
  stepId: number | null;
  category: string;
  minutes: number;
  completed: boolean;
  interrupted: boolean;
  startedAt?: string;
  completedAt?: string;
};

export type ManagerInput = {
  executionCoverageComplete?: boolean;
  assignmentFingerprint?: string;
  now: string;
  cards: ManagerCard[];
  evidence: ManagerEvidence[];
  timeSamples: ManagerTimeSample[];
  sourceGaps: string[];
  graphConflicts?: ManagerGraphConflict[];
  timeSummary?: { waitingMinutes: number; interruptedMinutes: number };
  learning?: { stateHash: string; guidance: ManagerReviewedGuidance[]; withheld: Array<{ cardId: string; topic: string; actionKind: ManagerAction["kind"]; actionId?: string }> };
};

export type ManagerReviewedGuidance = {
  id: number; reviewId: number; cardId: string; scope?: "card" | "worker";
  topic: string; correction: string; evidenceIds: string[]; validUntil: string;
  actionKind: ManagerAction["kind"];
  nextStep?: { actionId: string; title: string; completionCriteria: string };
};

export type ManagerAction = {
  id: string;
  cardId: string;
  title: string;
  where: string;
  kind: "work" | "verify" | "draft" | "decision" | "follow_up";
  stepIds: number[];
  dependsOn: string[];
  minutes: { low: number; likely: number; high: number; samples: number; basis: string };
  reason: string;
  completionCriteria: string;
  evidenceIds: string[];
  notBefore: string | null;
  blocked: boolean;
  priority: number;
  draft: string | null;
  reviewedGuidance?: ManagerReviewedGuidance[];
};

export type ManagerIntervention = {
  id: string;
  cardId: string;
  issueKind?: "source_check" | "reported_difference" | "conflicting_claims" | "missing_dependency" | "dependency_cycle";
  severity: "urgent" | "attention";
  title: string;
  explanation: string;
  question: string;
  safeAction: string;
  evidenceIds: string[];
  verification?: {
    issues: Array<{ id: string; severity: "urgent" | "attention"; title: string; question: string; explanation: string; evidenceIds: string[] }>;
    passages: Array<{ evidenceId: string; source: string; kind: ManagerEvidence["kind"]; quote: string; sender: string | null; sourceDate: string | null; sourceRevision?: string | null; sourceRecordId?: string | null; observedAt?: string; effectiveFrom: string | null }>;
    comparisons?: Array<{ subject: string; topic: string; left: { evidenceId: string; value: string; quote: string; source: string; kind: ManagerEvidence["kind"]; sender: string | null; sourceDate: string | null; url: string | null }; right: { evidenceId: string; value: string; quote: string; source: string; kind: ManagerEvidence["kind"]; sender: string | null; sourceDate: string | null; url: string | null } }>;
  };
};

export type ManagerAssessment = {
  cardId: string;
  state: string;
  explanation: string;
  confidence: number;
  uncertainties: string[];
  evidenceIds: string[];
  actions: ManagerAction[];
  reliability?: ManagerReliability;
  facts?: ManagerFact[];
};

export type ManagerResult = {
  version: 1;
  assessedAt: string;
  executionCoverageComplete?: boolean;
  assessments: ManagerAssessment[];
  actions: ManagerAction[];
  interventions: ManagerIntervention[];
  sourceGaps: string[];
};

export type ManagerPolicy = { enabled: boolean; intervalMinutes: number; mode: "shadow" | "active" };
export type ManagerSnapshot = ManagerResult & {
  semanticReview?: {
    success: boolean; sourceHash: string; attemptedAt: string; retryAfter: string; failures: number;
    failureKind?: "quota";
    provider?: "openai-api" | "codex-subscription";
    attempts?: Array<{
      effort: "low" | "medium" | "high";
      outcome: "accepted" | "context_review" | "invalid_output" | "missing_evidence" | "rejected" | "unavailable" | "unauthenticated" | "limited";
      reason?: "cross_source_context" | "chronology" | "ambiguity" | "validation";
      durationMs: number; inputTokens?: number; outputTokens?: number;
    }>;
  };
  runId: number;
  trigger: string;
  cards: Array<Pick<ManagerCard, "id" | "name" | "url" | "board" | "list">>;
  evidence: ManagerEvidence[];
  changes: string[];
  policy: ManagerPolicy;
  nextCheckAt: string | null;
  proposal?: import("../server/operatorDailyPlan").OperatorDailyPlanPayload;
  planVersion?: string;
  assignmentFingerprint?: string;
  proposalHash?: string;
  applied?: boolean;
  implementationDigest?: string;
  timing?: { samples: number; withinRange: number; meanAbsoluteErrorMinutes: number | null; waitingMinutes: number; interruptedMinutes: number };
};
