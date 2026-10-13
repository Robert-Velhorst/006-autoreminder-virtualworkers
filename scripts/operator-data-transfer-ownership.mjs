export function classifyBrowserCollectorImport(existingRows, incoming) {
  const byCollector = existingRows.filter((row) => row.collectorId === incoming.collectorId);
  const byId = incoming.id == null
    ? []
    : existingRows.filter((row) => String(row.id) === String(incoming.id));
  const matches = new Map([...byCollector, ...byId].map((row) => [String(row.id), row]));

  if (matches.size > 1) {
    return { action: "conflict", reason: "collector ID and row ID identify different records" };
  }

  const existing = matches.values().next().value;
  if (!existing) return { action: "insert" };
  if (existing.collectorId !== incoming.collectorId
    || (incoming.id != null && String(existing.id) !== String(incoming.id))) {
    return { action: "conflict", reason: "row ID or collector ID belongs to another collector" };
  }
  if (Number(existing.vaId) !== Number(incoming.vaId)) {
    return { action: "conflict", reason: "collector belongs to a different worker" };
  }

  const existingSequence = Number(existing.captureSequence ?? 0);
  const incomingSequence = Number(incoming.captureSequence ?? 0);
  if (!Number.isSafeInteger(existingSequence) || existingSequence < 0
    || !Number.isSafeInteger(incomingSequence) || incomingSequence < 0) {
    return { action: "conflict", reason: "collector sequence is invalid" };
  }
  if (incomingSequence < existingSequence) {
    return { action: "skip", existing, reason: "exported browser snapshot is older than the target" };
  }

  if (incomingSequence === existingSequence) {
    const sameInventory = ["collectorLabel", "totalTabs", "pinnedTabs", "windowCount", "tabsJson"]
      .every((field) => existing[field] === incoming[field]);
    return sameInventory
      ? { action: "skip", existing, reason: "identical collector snapshot already exists" }
      : { action: "conflict", reason: "same collector sequence contains different data" };
  }

  return { action: "update", existing };
}
