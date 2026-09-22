import { TRPCError } from "@trpc/server";

// Reject the entire policy on malformed input; never silently broaden or partially enable it.
export function managerPilotWorkerIds(): number[] {
  if (process.env.APTLSS_MANAGER_SHADOW_ONLY !== "true") return [];
  const raw = process.env.APTLSS_MANAGER_PILOT_WORKER_IDS;
  if (!raw?.trim()) return [];
  const parts = raw.split(",").map(part => part.trim());
  if (parts.some(part => !/^[1-9]\d*$/.test(part))) return [];
  const ids = parts.map(Number);
  if (ids.some(id => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) return [];
  return ids;
}

export function managerPilotEnabled() {
  return managerPilotWorkerIds().length > 0;
}

export function isManagerPilotWorker(vaId: number) {
  return managerPilotWorkerIds().includes(vaId);
}

export function assertManagerPilotWorker(vaId: number) {
  if (!isManagerPilotWorker(vaId)) throw new TRPCError({
    code: "FORBIDDEN",
    message: "Manager pilot requires an explicitly allowlisted worker, valid APTLSS_MANAGER_PILOT_WORKER_IDS, and APTLSS_MANAGER_SHADOW_ONLY=true.",
  });
}

export function assertManagerPlanMutationAllowed(vaId: number): never {
  assertManagerPilotWorker(vaId);
  throw new TRPCError({ code: "FORBIDDEN", message: "The manager pilot is shadow-only: active mode and plan mutations are prohibited." });
}
