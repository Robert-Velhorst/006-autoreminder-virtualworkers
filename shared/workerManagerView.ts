import type { ManagerAction, ManagerCard, ManagerEvidence, ManagerIntervention } from "./aptlssManager";
import type { ManagerPlanImpact } from "./aptlssManagerPlanImpact";

export type WorkerManagerAction = Pick<ManagerAction, "id" | "cardId" | "title" | "where" | "kind" | "reason" | "blocked" | "completionCriteria" | "stepIds"> & {
  minutes: Pick<ManagerAction["minutes"], "low" | "likely" | "high">;
};

type WorkerPlanChange = Pick<NonNullable<ManagerPlanImpact["planChanges"]>[number], "kind" | "blockId" | "cardName" | "before" | "after" | "reason">;

export type WorkerManagerPlanImpact = Pick<ManagerPlanImpact, "dateKey" | "baseline" | "scheduleChanged" | "requiresReview" | "availabilityChanged"> & {
  planChanges?: WorkerPlanChange[];
  protectedBlocks: Array<{ preservedExactly: boolean }>;
};

export type WorkerManagerIntervention = Pick<ManagerIntervention, "id" | "cardId" | "issueKind" | "severity" | "title" | "explanation" | "question" | "safeAction" | "evidenceIds"> & {
  verification?: {
    issues: [];
    passages: NonNullable<ManagerIntervention["verification"]>["passages"];
    comparisons?: WorkerManagerFactComparison[];
  };
};

export type WorkerManagerComparisonSide = {
  evidenceId: string;
  value: string;
  quote: string;
  source: string;
  kind: "source" | "worker";
  sender: string | null;
  sourceDate: string | null;
  url: string | null;
};

export type WorkerManagerFactComparison = {
  topic: "deadline" | "paid" | "approved" | "completed" | "status";
  left: WorkerManagerComparisonSide;
  right: WorkerManagerComparisonSide;
};

export type WorkerManagerEvidence = Pick<ManagerEvidence, "id" | "cardId" | "source" | "text" | "observedAt" | "url"> & {
  kind: "source" | "worker";
  metadata?: Pick<NonNullable<ManagerEvidence["metadata"]>, "sender" | "sourceDate" | "effectiveFrom" | "sourceRecordId" | "contentScope" | "reportKind" | "reportDetail" | "sourceDescription" | "sourceEvidenceId">;
};

export type WorkerManagerSnapshot = {
  executionReady: boolean;
  actions: WorkerManagerAction[];
  interventions: WorkerManagerIntervention[];
  cards: Array<Pick<ManagerCard, "id" | "name" | "url" | "board" | "list">>;
  evidence: WorkerManagerEvidence[];
  applied?: boolean;
  planVersion?: string;
  proposal?: { planningImpact?: WorkerManagerPlanImpact };
};
