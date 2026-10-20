import { TRPCError } from "@trpc/server";

// Keep worker identity separate from the run-mode switch so a bad mode value
// cannot remove pilot workers from the protections used by other features.
export function managerPilotWorkerIds(): number[] {
  const raw = process.env.APTLSS_MANAGER_PILOT_WORKER_IDS;
  if (!raw?.trim()) return [];
  const parts = raw.split(",").map(part => part.trim());
  if (parts.some(part => !/^[1-9]\d*$/.test(part))) return [];
  const ids = parts.map(Number);
  if (ids.some(id => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) return [];
  return ids;
}

export function managerPilotEnabled() {
  return process.env.APTLSS_MANAGER_SHADOW_ONLY === "true" && managerPilotWorkerIds().length > 0;
}

export function isManagerPilotWorker(vaId: number) {
  return managerPilotWorkerIds().includes(vaId);
}

export function assertManagerPilotWorker(vaId: number) {
  if (!isManagerPilotWorker(vaId) || process.env.APTLSS_MANAGER_SHADOW_ONLY !== "true") throw new TRPCError({
    code: "FORBIDDEN",
    message: "Manager pilot requires an explicitly allowlisted worker, valid APTLSS_MANAGER_PILOT_WORKER_IDS, and APTLSS_MANAGER_SHADOW_ONLY=true.",
  });
}

export function assertManagerPlanMutationAllowed(vaId: number): never {
  assertManagerPilotWorker(vaId);
  throw new TRPCError({ code: "FORBIDDEN", message: "The manager pilot is shadow-only: active mode and plan mutations are prohibited." });
}
