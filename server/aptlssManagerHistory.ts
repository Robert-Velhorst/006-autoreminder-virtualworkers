import { createHash } from "node:crypto";
import type { ManagerSnapshot } from "../shared/aptlssManager";

// These fields are retained verbatim in each check, not discarded. All other
// fields (including new future fields) must remain identical to reuse a dossier.
const patchFields = ["assessedAt", "nextCheckAt", "trigger", "proposal", "changes"] as const;
type SnapshotPatch = { version: 1; values: Omit<Pick<ManagerSnapshot, typeof patchFields[number]>, "proposal"> & { proposal: ManagerSnapshot["proposal"] | null } };
export const MANAGER_HISTORY_PATCH_LIMIT = 64 * 1024;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export const managerHistoryHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

function stableSnapshot(snapshot: ManagerSnapshot) {
  const stable = { ...snapshot } as Record<string, unknown>;
  delete stable.runId;
  for (const key of patchFields) delete stable[key];
  // Proposed slots, numeric slack, buffers, risks and audit explanations are
  // protected even when the review-sample hash intentionally ignores them.
  stable.changes = snapshot.changes;
  if (snapshot.proposal) {
    const proposal = structuredClone(snapshot.proposal);
    proposal.generatedAt = "";
    for (const entry of proposal.auditTrail) entry.at = "";
    if (proposal.planningImpact) {
      proposal.planningImpact.assessedAt = "";
      for (const assumption of proposal.planningImpact.assumptions) {
        if (assumption.id === "clock" && assumption.inputPath === "now") assumption.value = "";
      }
    }
    stable.proposal = proposal;
  }
  return stable;
}

/** Reuse is deliberately stricter than review-sample deduplication. */
export function managerHistoryPatch(previous: ManagerSnapshot, next: ManagerSnapshot): string | null {
  if (next.applied || previous.applied || next.policy.mode !== "shadow" || previous.policy.mode !== "shadow"
    || !next.proposalHash || previous.proposalHash !== next.proposalHash
    || managerHistoryHash(stableSnapshot(previous)) !== managerHistoryHash(stableSnapshot(next))) return null;
  const values = Object.fromEntries(patchFields.map(key => [key, next[key] ?? (key === "proposal" ? null : next[key])])) as SnapshotPatch["values"];
  const patch = JSON.stringify({ version: 1, values });
  // A large proposal or a tiny dossier gains nothing from indirection.
  return Buffer.byteLength(patch) <= MANAGER_HISTORY_PATCH_LIMIT
    && Buffer.byteLength(patch) * 2 < Buffer.byteLength(JSON.stringify(next)) ? patch : null;
}

export function restoreManagerHistorySnapshot(baseJson: string, runId: number, check: {
  baseSnapshotHash: string; snapshotHash: string; snapshotPatchJson: string;
}): ManagerSnapshot {
  const invalid = () => new Error("Manager assessment history failed its integrity check. The previous plan remains unchanged.");
  let base: ManagerSnapshot;
  let patch: SnapshotPatch;
  try {
    base = JSON.parse(baseJson);
    patch = JSON.parse(check.snapshotPatchJson);
  } catch { throw invalid(); }
  if (!base || typeof base !== "object" || Array.isArray(base)
    || managerHistoryHash(base) !== check.baseSnapshotHash
    || !patch || patch.version !== 1 || Object.keys(patch).sort().join(",") !== "values,version"
    || !patch.values || typeof patch.values !== "object" || Array.isArray(patch.values)
    || Object.keys(patch.values).sort().join(",") !== [...patchFields].sort().join(",")
    || typeof patch.values.assessedAt !== "string" || !Number.isFinite(Date.parse(patch.values.assessedAt))
    || (patch.values.nextCheckAt !== null && (typeof patch.values.nextCheckAt !== "string" || !Number.isFinite(Date.parse(patch.values.nextCheckAt))))
    || typeof patch.values.trigger !== "string" || !Array.isArray(patch.values.changes)
    || patch.values.changes.some(value => typeof value !== "string")
    || (patch.values.proposal !== null && (typeof patch.values.proposal !== "object" || Array.isArray(patch.values.proposal)))
    || Buffer.byteLength(check.snapshotPatchJson) > MANAGER_HISTORY_PATCH_LIMIT) throw invalid();
  const restored: ManagerSnapshot = { ...base, ...patch.values, proposal: patch.values.proposal ?? undefined, runId };
  if (managerHistoryHash(restored) !== check.snapshotHash) throw invalid();
  return restored;
}
