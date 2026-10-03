import { WORKER_EXECUTION_HOLD_MESSAGE } from "../shared/aptlssManager";
import { assessWorkerSourceChecks, type WorkerSourceCheck } from "../shared/workerSourceChecks";

export type ManagerActionSourceRequirements = {
  sourceKeys: WorkerSourceCheck["key"][];
  hasUnverifiedEvidence: boolean;
  assessedAt: number | null;
};

export type TimerRequiredSourceStatusInput = {
  trelloCache: { cachedAt: string; expiresAt: string } | null;
  gmail: { enabled: boolean; lastSyncedAt: string | null; intervalMinutes: number; lastError?: string | null; sourceConflictPending?: boolean } | null;
  drive: { enabled: boolean; lastSyncedAt: string | null; intervalMinutes: number; lastError?: string | null; sourceConflictPending?: boolean } | null;
  googleConnectionReady: boolean | null;
  now: number;
};

const workerSourceKeys = new Set<WorkerSourceCheck["key"]>([
  "trello", "gmail", "google_drive", "communication",
]);

export function managerActionSourceRequirements(snapshotJson: string, cardId: string): ManagerActionSourceRequirements {
  const snapshot = JSON.parse(snapshotJson) as {
    assessedAt?: unknown;
    actions?: Array<{ cardId?: unknown; blocked?: unknown; evidenceIds?: unknown }>;
    evidence?: Array<{ id?: unknown; cardId?: unknown; source?: unknown; kind?: unknown; metadata?: unknown }>;
  };
  const parsedAssessedAt = typeof snapshot.assessedAt === "string" ? Date.parse(snapshot.assessedAt) : NaN;
  const assessedAt = Number.isFinite(parsedAssessedAt) ? parsedAssessedAt : null;
  const actions = Array.isArray(snapshot.actions) ? snapshot.actions : [];
  const cardActions = actions.filter(action => action.cardId === cardId);
  const action = cardActions.find(item => item.blocked !== true) ?? cardActions[0];
  if (!action) return { sourceKeys: [], hasUnverifiedEvidence: false, assessedAt };
  if (!Array.isArray(action.evidenceIds)) return { sourceKeys: [], hasUnverifiedEvidence: true, assessedAt };
  if (action.evidenceIds.length === 0) return { sourceKeys: [], hasUnverifiedEvidence: false, assessedAt };

  const evidenceById = new Map(
    (Array.isArray(snapshot.evidence) ? snapshot.evidence : [])
      .filter(item => typeof item.id === "string")
      .map(item => [item.id as string, item]),
  );
  const sourceKeys = new Set<WorkerSourceCheck["key"]>();
  let hasUnverifiedEvidence = assessedAt === null;
  for (const evidenceId of action.evidenceIds) {
    if (typeof evidenceId !== "string") {
      hasUnverifiedEvidence = true;
      continue;
    }
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      hasUnverifiedEvidence = true;
      continue;
    }
    if (evidence.cardId !== cardId) {
      hasUnverifiedEvidence = true;
      continue;
    }
    const metadata = evidence.metadata && typeof evidence.metadata === "object"
      ? evidence.metadata as { authority?: unknown; truthClass?: unknown }
      : {};
    if (evidence.kind === "worker" || metadata.authority === "unverified" || metadata.authority === "reported"
      || ["worker_report", "model_proposal", "unknown"].includes(String(metadata.truthClass))) {
      hasUnverifiedEvidence = true;
    }
    if (typeof evidence.source === "string" && workerSourceKeys.has(evidence.source as WorkerSourceCheck["key"])) {
      sourceKeys.add(evidence.source as WorkerSourceCheck["key"]);
    } else if (evidence.kind === "source") {
      hasUnverifiedEvidence = true;
    }
  }

  return { sourceKeys: [...sourceKeys], hasUnverifiedEvidence, assessedAt };
}

export function managerActionNeedsSourceVerification(
  requirements: ManagerActionSourceRequirements,
  input: TimerRequiredSourceStatusInput,
) {
  if (requirements.hasUnverifiedEvidence) return true;
  if (!requirements.sourceKeys.length) return false;
  if (requirements.assessedAt === null) return true;
  const checks = assessWorkerSourceChecks({
    sources: requirements.sourceKeys.map(key => ({ key, count: 1 })),
    trelloCache: input.trelloCache,
    gmail: input.gmail,
    drive: input.drive,
    googleConnectionReady: input.googleConnectionReady,
    now: input.now,
  }).checks;
  if (checks.some(check => requirements.sourceKeys.includes(check.key) && check.status !== "current")) return true;

  const latestCheckByKey: Partial<Record<WorkerSourceCheck["key"], string | null>> = {
    trello: input.trelloCache?.cachedAt ?? null,
    gmail: input.gmail?.lastSyncedAt ?? null,
    google_drive: input.drive?.lastSyncedAt ?? null,
    communication: null,
  };
  return requirements.sourceKeys.some(key => {
    const checkedAt = latestCheckByKey[key];
    const timestamp = checkedAt ? Date.parse(checkedAt) : NaN;
    return !Number.isFinite(timestamp) || timestamp > requirements.assessedAt!;
  });
}

export function canStartTimerForCard(role: string, hasOperatorCard: boolean) {
  return role !== "worker" || hasOperatorCard;
}

export function timerExecutionBlockReason(input: {
  listName: string;
  hasActiveWaitingReason: boolean;
  actionability: string | null;
  hasManagerIntervention: boolean;
  hasStaleRequiredSource?: boolean;
  executionCoverageComplete?: boolean;
}) {
  if (input.executionCoverageComplete === false) return WORKER_EXECUTION_HOLD_MESSAGE;
  if (input.hasStaleRequiredSource) return "A source required by the next step is out of date or not verified. Check that source before starting work.";
  if (input.hasManagerIntervention) return "APTLSS requires verification before work can continue on this card";
  if (input.hasActiveWaitingReason || /ON[\s_-]?HOLD|WAIT|BLOCK/i.test(input.listName)
    || /^(waiting|blocked)$/i.test(input.actionability ?? "")) {
    return "This card is waiting or blocked; review the reason before starting work";
  }
  return null;
}

export function managerExecutionCoverageComplete(snapshotJson: string, assignmentFingerprint: string | null, now = Date.now()) {
  const snapshot = JSON.parse(snapshotJson) as {
    executionCoverageComplete?: unknown;
    assignmentFingerprint?: unknown;
    assessedAt?: unknown;
    nextCheckAt?: unknown;
    policy?: { enabled?: unknown; intervalMinutes?: unknown };
  };
  if (snapshot.executionCoverageComplete !== true
    || typeof assignmentFingerprint !== "string"
    || assignmentFingerprint.length === 0
    || snapshot.assignmentFingerprint !== assignmentFingerprint
    || snapshot.policy?.enabled !== true
    || !Number.isInteger(snapshot.policy.intervalMinutes)
    || (snapshot.policy.intervalMinutes as number) < 1
    || (snapshot.policy.intervalMinutes as number) > 60
    || typeof snapshot.assessedAt !== "string"
    || typeof snapshot.nextCheckAt !== "string"
    || !Number.isFinite(now)) return false;

  const assessedAt = Date.parse(snapshot.assessedAt);
  const nextCheckAt = Date.parse(snapshot.nextCheckAt);
  if (!Number.isFinite(assessedAt) || !Number.isFinite(nextCheckAt)
    || assessedAt > now || nextCheckAt <= assessedAt) return false;

  const policyDeadline = assessedAt + (snapshot.policy.intervalMinutes as number) * 60_000;
  return now < Math.min(nextCheckAt, policyDeadline);
}

export function managerIntervenesOnCard(snapshotJson: string, cardId: string) {
  const snapshot = JSON.parse(snapshotJson) as {
    interventions?: Array<{ cardId?: string }>;
    actions?: Array<{ cardId?: string; blocked?: unknown; kind?: unknown }>;
  };
  if (!Array.isArray(snapshot.interventions)) throw new Error("Manager interventions are unavailable");
  if (snapshot.interventions.some(item => item.cardId === cardId)) return true;
  if (!Array.isArray(snapshot.actions)) return false;
  const actions = snapshot.actions.filter(item => item.cardId === cardId);
  if (actions.some(item => item.kind === "decision")) return true;
  return actions.length > 0 && actions.every(item => item.blocked === true);
}

export function canRecordWaitingReasonForCard(hasOperatorCard: boolean) {
  return hasOperatorCard;
}
