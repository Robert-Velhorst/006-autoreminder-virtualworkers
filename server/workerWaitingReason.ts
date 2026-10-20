import {
  interpretWaitingReason,
  type WaitingReasonContext,
  type WaitingReasonInterpretation,
} from "./aptlssWaitingReason";

type WorkerNames = {
  workerName: string;
  founderName: string;
  timeZone?: string;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceName(value: string, source: string, target: string) {
  if (!source.trim() || source.trim().toLowerCase() === target.toLowerCase()) return value;
  return value.replace(new RegExp(`\\b${escapeRegExp(source.trim())}\\b`, "gi"), target);
}

function personalizeText(value: string, names: WorkerNames) {
  return value
    .replace(/\b(?:Joyce|Worker)\b/g, names.workerName)
    .replace(/\bthe assigned worker\b/gi, names.workerName)
    .replace(/\bRobert\b/g, names.founderName)
    .replace(/\bthe VA\b/g, names.workerName)
    .replace(/\bEAT\b/g, names.timeZone || "EAT");
}

export function interpretWaitingReasonForWorker(
  reason: string,
  context: WaitingReasonContext,
  names: WorkerNames,
): WaitingReasonInterpretation {
  const canonicalReason = replaceName(
    replaceName(reason, names.workerName, "Worker"),
    names.founderName,
    "Robert",
  );
  const result = interpretWaitingReason(canonicalReason, context);
  return {
    ...result,
    rawReason: reason.trim(),
    normalizedReason: reason.trim().replace(/\s+/g, " "),
    waitingOnName: result.waitingOn === "worker" || result.waitingOn === "joyce"
      ? names.workerName
      : result.waitingOn === "robert"
        ? names.founderName
        : result.waitingOnName,
    requestedItem: result.requestedItem ? personalizeText(result.requestedItem, names) : null,
    summary: personalizeText(result.summary, names),
    nextAction: personalizeText(result.nextAction, names),
    followUpReason: personalizeText(result.followUpReason, names),
    confidenceReason: personalizeText(result.confidenceReason, names),
    missingInformation: result.missingInformation.map((item) => personalizeText(item, names)),
  };
}
