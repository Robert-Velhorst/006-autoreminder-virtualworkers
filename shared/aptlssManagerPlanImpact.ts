/** A comparison of retained inputs and proposed slots, not a completion forecast. */
export type ManagerPlanImpact = {
  version: 1;
  assessedAt: string;
  dateKey: string;
  timezone: string;
  baseline: "same_day_plan" | "different_day_plan" | "no_plan";
  scheduleChanged: boolean;
  requiresReview: boolean;
  planChanges?: Array<{
    kind: "added" | "moved" | "updated" | "removed";
    blockId: string;
    cardName: string;
    before: { startTime: string; endTime: string } | null;
    after: { startTime: string; endTime: string } | null;
    reason: string;
    assumptionIds: string[];
  }>;
  availabilityChanged?: boolean;
  assumptions: Array<{
    id: string;
    inputPath: string;
    value: unknown;
    limitation: string;
  }>;
  deadlines: Array<{
    cardId: string;
    dueAt: string | null;
    before: ManagerDeadlinePosition;
    after: ManagerDeadlinePosition;
    movement:
      | "earlier"
      | "later"
      | "unchanged"
      | "added"
      | "removed"
      | "unknown";
    assumptionIds: string[];
  }>;
  dependencies: Array<{
    actionId: string;
    dependency: string;
    completionRecorded: boolean;
    before: ManagerDependencyPosition;
    after: ManagerDependencyPosition;
    assumptionIds: string[];
  }>;
  buffer: {
    before: ManagerPlanBuffer | null;
    after: ManagerPlanBuffer;
    unallocatedDeltaMinutes: number | null;
    reservations: Array<{
      blockId: string;
      startTime: string;
      endTime: string;
      basis: "action_likely_estimate" | "planner_fallback_30_minutes";
    }>;
    assumptionIds: string[];
  };
  protectedBlocks: Array<{
    blockId: string;
    reasons: Array<"non_planned_status" | "already_started" | "active_timer">;
    preservedExactly: boolean;
    assumptionIds: string[];
  }>;
  alternative: {
    kind: "keep_current_plan";
    available: boolean;
    blockIds: string[];
    deadlineRiskCardIds: string[];
    dependencyRiskActionIds: string[];
    buffer: ManagerPlanBuffer | null;
    limitation: string;
  };
  risks: Array<{
    code: string;
    subjectId: string;
    detail: string;
    assumptionIds: string[];
    requiresReview: boolean;
  }>;
  limitations: string[];
};

export type ManagerDeadlinePosition = {
  blockIds: string[];
  unscheduledActionIds: string[];
  latestScheduledEndAt: string | null;
  slackMinutes: number | null;
  status:
    | "within_deadline"
    | "after_deadline"
    | "unscheduled"
    | "deadline_not_provided"
    | "unknown";
};

export type ManagerDependencyPosition = {
  scheduled: boolean;
  startAt: string | null;
  predecessorEndAt: string | null;
  ordering:
    | "recorded_complete"
    | "before_start"
    | "violated"
    | "unscheduled"
    | "unknown";
};

export type ManagerPlanBuffer = {
  unallocatedMinutes: number | null;
  largestWindowMinutes: number | null;
  additionalHighEstimateMinutes: number | null;
  afterHighEstimatesMinutes: number | null;
  minimumKnownDeficitMinutes: number | null;
  unknownEstimateBlockIds: string[];
};
