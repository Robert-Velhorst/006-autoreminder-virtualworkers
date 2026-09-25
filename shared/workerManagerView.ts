import type { ManagerAction, ManagerCard, ManagerEvidence, ManagerIntervention } from "./aptlssManager";
import type { ManagerPlanImpact } from "./aptlssManagerPlanImpact";

type WorkerAction = Pick<ManagerAction, "id" | "cardId" | "title" | "where" | "kind" | "reason" | "blocked" | "completionCriteria"> & {
  minutes: Pick<ManagerAction["minutes"], "low" | "likely" | "high">;
};

type WorkerPlanChange = Pick<NonNullable<ManagerPlanImpact["planChanges"]>[number], "kind" | "blockId" | "cardName" | "before" | "after" | "reason">;

export type WorkerManagerPlanImpact = Pick<ManagerPlanImpact, "dateKey" | "baseline" | "scheduleChanged" | "requiresReview" | "availabilityChanged"> & {
  planChanges?: WorkerPlanChange[];
  protectedBlocks: Array<{ preservedExactly: boolean }>;
};

export type WorkerManagerSnapshot = {
  executionReady: boolean;
  actions: WorkerAction[];
  interventions: ManagerIntervention[];
  cards: Array<Pick<ManagerCard, "id" | "name" | "url" | "board" | "list">>;
  evidence: ManagerEvidence[];
  applied?: boolean;
  planVersion?: string;
  proposal?: { planningImpact?: WorkerManagerPlanImpact };
};
