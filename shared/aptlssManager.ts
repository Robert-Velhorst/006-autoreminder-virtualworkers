import type { ManagerEvidenceMetadata, ManagerGraphConflict, ManagerReliability, ManagerFact } from "./aptlssManagerEvidence";

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
  steps: Array<{ id: number; title: string; category: string; minutes: number; complete: boolean; requiresDecision: boolean; dependsOn: string[]; completionCriteria: string | null }>;
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
  now: string;
  cards: ManagerCard[];
  evidence: ManagerEvidence[];
  timeSamples: ManagerTimeSample[];
  sourceGaps: string[];
  graphConflicts?: ManagerGraphConflict[];
  timeSummary?: { waitingMinutes: number; interruptedMinutes: number };
  learning?: { stateHash: string; guidance: ManagerReviewedGuidance[]; withheld: Array<{ cardId: string; topic: string; actionKind: ManagerAction["kind"] }> };
};

export type ManagerReviewedGuidance = {
  id: number; reviewId: number; cardId: string; scope?: "card" | "worker";
  topic: string; correction: string; evidenceIds: string[]; validUntil: string;
  actionKind: ManagerAction["kind"];
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
  severity: "urgent" | "attention";
  title: string;
  explanation: string;
  question: string;
  safeAction: string;
  evidenceIds: string[];
  verification?: {
    issues: Array<{ id: string; severity: "urgent" | "attention"; title: string; question: string; explanation: string; evidenceIds: string[] }>;
    passages: Array<{ evidenceId: string; source: string; kind: ManagerEvidence["kind"]; quote: string; sender: string | null; sourceDate: string | null; observedAt?: string; effectiveFrom: string | null }>;
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
  assessments: ManagerAssessment[];
  actions: ManagerAction[];
  interventions: ManagerIntervention[];
  sourceGaps: string[];
};

export type ManagerPolicy = { enabled: boolean; intervalMinutes: number; mode: "shadow" | "active" };
export type ManagerSnapshot = ManagerResult & {
  runId: number;
  trigger: string;
  cards: Array<Pick<ManagerCard, "id" | "name" | "url" | "board" | "list">>;
  evidence: ManagerEvidence[];
  changes: string[];
  policy: ManagerPolicy;
  nextCheckAt: string | null;
  proposal?: import("../server/operatorDailyPlan").OperatorDailyPlanPayload;
  planVersion?: string;
  proposalHash?: string;
  applied?: boolean;
  implementationDigest?: string;
  timing?: { samples: number; withinRange: number; meanAbsoluteErrorMinutes: number | null; waitingMinutes: number; interruptedMinutes: number };
};
