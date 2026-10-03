export function dashboardOrigin(value) {
  if (typeof value !== "string" || value.length > 2_048 || value !== value.trim() || /\s/.test(value)) {
    throw new Error("Enter a valid dashboard origin without a path, credentials, query, or fragment.");
  }
  const authority = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1];
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid dashboard origin without a path, credentials, query, or fragment.");
  }
  if (!authority || authority.includes("@") || url.username || url.password || url.href !== `${url.origin}/`) {
    throw new Error("Use the dashboard origin only, without a path or credentials.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("HTTPS is required except for loopback dashboards.");
  return url.origin;
}
export const MAX_CAPTURE_SEQUENCE = 0xffff_ffff;
const COLLECTOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidCollectorId(value) {
  return typeof value === "string" && COLLECTOR_ID_PATTERN.test(value);
}

export function captureSequenceKey(collectorId) {
  return `captureSequence:${collectorId}`;
}

export function collectorResetRequiredKey(collectorId) {
  return `collectorResetRequired:${collectorId}`;
}

export function inventory(tabs) {
  if (!Array.isArray(tabs)) throw new Error("The browser returned a malformed tab inventory. No inventory was sent.");
  const reportable = [];
  for (const tab of tabs) {
    if (!tab || typeof tab !== "object" || Array.isArray(tab)) throw new Error("The browser returned a malformed tab inventory. No inventory was sent.");
    if (tab.incognito !== undefined && typeof tab.incognito !== "boolean") throw new Error("The browser returned a malformed tab inventory. No inventory was sent.");
    if (tab.incognito) continue;
    if (typeof tab.url !== "string" || !/^(https?:\/\/|file:\/\/)/i.test(tab.url)) continue;

    let url;
    try {
      url = new URL(tab.url);
    } catch {
      throw new Error("The browser returned a malformed tab inventory. No inventory was sent.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "file:") continue;

    const id = Number.isSafeInteger(tab.id) && tab.id >= 0 ? String(tab.id) : "";
    if (!id || id.length > 16 || !Number.isSafeInteger(tab.windowId) || tab.windowId < -1
      || (tab.pinned !== undefined && typeof tab.pinned !== "boolean")
      || (tab.active !== undefined && typeof tab.active !== "boolean")) {
      throw new Error("The browser returned a malformed tab inventory. No inventory was sent.");
    }

    reportable.push({ id, title: url.protocol === "file:" ? "Local file" : url.hostname,
      url: url.protocol === "file:" ? "file:///" : url.origin + "/",
      pinned: Boolean(tab.pinned), active: Boolean(tab.active), windowId: tab.windowId });
  }
  if (reportable.length > 250) throw new Error("More than 250 work tabs are open. Close some tabs before reporting; no partial inventory was sent.");
  return reportable;
}

export function nextCaptureVersion(collectorId, sequence, newCollectorId = () => crypto.randomUUID()) {
  if (!isValidCollectorId(collectorId)) return { collectorId: newCollectorId(), captureSequence: 1 };
  if (sequence === undefined || sequence === null) return { collectorId, captureSequence: 1 };
  const validSequence = Number.isSafeInteger(sequence) && sequence >= 0 && sequence < MAX_CAPTURE_SEQUENCE;
  if (!validSequence) return { collectorId: newCollectorId(), captureSequence: 1 };
  return { collectorId, captureSequence: sequence + 1 };
}

export function collectorPairingIdentity(current, dashboardUrl, collectorToken, newCollectorId = () => crypto.randomUUID()) {
  const previous = current && typeof current === "object" ? current : {};
  const hasIdentity = isValidCollectorId(previous.collectorId);
  const hasValidSequence = previous.captureSequence === undefined || previous.captureSequence === null
    || (Number.isSafeInteger(previous.captureSequence) && previous.captureSequence >= 0
      && previous.captureSequence <= MAX_CAPTURE_SEQUENCE);
  const pairingChanged = previous.dashboardUrl !== dashboardUrl || previous.collectorToken !== collectorToken;
  if (pairingChanged || !hasIdentity || !hasValidSequence) {
    return { collectorId: newCollectorId(), captureSequence: 0 };
  }
  return {
    collectorId: previous.collectorId,
    captureSequence: previous.captureSequence ?? 0,
  };
}

export function reconcileCaptureVersion(collectorId, localSequence, storedSequence, newCollectorId = () => crypto.randomUUID()) {
  const validLocal = Number.isSafeInteger(localSequence) && localSequence >= 0 && localSequence <= MAX_CAPTURE_SEQUENCE;
  const validStored = Number.isSafeInteger(storedSequence) && storedSequence >= 0 && storedSequence <= MAX_CAPTURE_SEQUENCE;
  if (!isValidCollectorId(collectorId) || !validLocal || !validStored) return null;
  if (storedSequence >= MAX_CAPTURE_SEQUENCE) return { collectorId: newCollectorId(), captureSequence: 0 };
  return { collectorId, captureSequence: Math.max(localSequence, storedSequence) };
}
