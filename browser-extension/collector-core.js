export function dashboardOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use the dashboard origin only, without a path or credentials.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("HTTPS is required except for loopback dashboards.");
  return url.origin;
}
export function inventory(tabs) {
  const reportable = tabs.filter(tab => !tab.incognito && /^(https?|file):/i.test(tab.url || ""));
  if (reportable.length > 250) throw new Error("More than 250 work tabs are open. Close some tabs before reporting; no partial inventory was sent.");
  return reportable.map(tab => {
    const url = new URL(tab.url);
    return { id: String(tab.id), title: url.hostname || "Local file",
      url: url.protocol === "file:" ? "file:///" : url.origin + "/",
      pinned: Boolean(tab.pinned), active: Boolean(tab.active), windowId: tab.windowId };
  });
}

export function nextCaptureVersion(collectorId, sequence, newCollectorId = () => crypto.randomUUID()) {
  const validCollectorId = typeof collectorId === "string" && collectorId.length > 0;
  if (!validCollectorId) return { collectorId: newCollectorId(), captureSequence: 1 };
  if (sequence === undefined || sequence === null) return { collectorId, captureSequence: 1 };
  const validSequence = Number.isSafeInteger(sequence) && sequence >= 0 && sequence < 4_294_967_295;
  if (!validSequence) return { collectorId: newCollectorId(), captureSequence: 1 };
  return { collectorId, captureSequence: sequence + 1 };
}

export function reconcileCaptureVersion(collectorId, localSequence, storedSequence, newCollectorId = () => crypto.randomUUID()) {
  const validCollectorId = typeof collectorId === "string" && collectorId.length > 0;
  const validLocal = Number.isSafeInteger(localSequence) && localSequence >= 0 && localSequence <= 4_294_967_295;
  const validStored = Number.isSafeInteger(storedSequence) && storedSequence >= 0 && storedSequence <= 4_294_967_295;
  if (!validCollectorId || !validLocal || !validStored) return null;
  if (storedSequence >= 4_294_967_295) return { collectorId: newCollectorId(), captureSequence: 0 };
  return { collectorId, captureSequence: Math.max(localSequence, storedSequence) };
}
