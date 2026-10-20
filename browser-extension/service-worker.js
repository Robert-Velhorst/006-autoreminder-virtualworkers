import { captureSequenceKey, collectorResetRequiredKey, dashboardOrigin, inventory, isValidCollectorId, MAX_CAPTURE_SEQUENCE, nextCaptureVersion, reconcileCaptureVersion } from "./collector-core.js";
let running;
let collectionDisabledDuringReport = false;
let pairingChangedDuringReport = false;
let activeRequestController;

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.enabled && changes.enabled.newValue !== true) collectionDisabledDuringReport = true;
  if (["dashboardUrl", "collectorToken", "collectorId"].some(key => Object.prototype.hasOwnProperty.call(changes, key))) {
    pairingChangedDuringReport = true;
  }
  if (collectionDisabledDuringReport || pairingChangedDuringReport) activeRequestController?.abort();
});

async function pairingIsCurrent(settings, collectorId) {
  const current = await chrome.storage.local.get(["dashboardUrl", "collectorToken", "collectorId"]);
  return current.dashboardUrl === settings.dashboardUrl
    && current.collectorToken === settings.collectorToken
    && current.collectorId === collectorId;
}

async function requirePairingIsCurrent(settings, collectorId) {
  if (pairingChangedDuringReport || !await pairingIsCurrent(settings, collectorId)) {
    throw new Error("The browser pairing changed during this report. No older collector state was saved; retry with the current pairing.");
  }
}

async function requireCollectionEnabled() {
  if (collectionDisabledDuringReport) {
    throw new Error("Browser collection was disabled during this report. No further inventory will be sent.");
  }
  const current = await chrome.storage.local.get(["enabled"]);
  if (current.enabled !== true || collectionDisabledDuringReport) {
    throw new Error("Browser collection was disabled during this report. No further inventory will be sent.");
  }
}

async function persistCapture(settings, expectedCollectorId, capture) {
  await requirePairingIsCurrent(settings, expectedCollectorId);
  await requireCollectionEnabled();
  await chrome.storage.local.set({ [captureSequenceKey(capture.collectorId)]: capture.captureSequence });
}

async function requirePairingReset(collectorId) {
  if (isValidCollectorId(collectorId)) {
    await chrome.storage.local.set({ [collectorResetRequiredKey(collectorId)]: true });
  }
  throw new Error("The collector sequence needs to be reset. Open worker Settings and save the pairing again.");
}

function validIngestResponse(body, submittedSequence) {
  const validShape = body !== null && typeof body === "object" && !Array.isArray(body)
    && body.success === true
    && typeof body.staleIgnored === "boolean"
    && Number.isSafeInteger(body.storedCaptureSequence)
    && body.storedCaptureSequence >= 1 && body.storedCaptureSequence <= MAX_CAPTURE_SEQUENCE
    && typeof body.shouldWarn === "boolean"
    && Number.isSafeInteger(body.actionableTabs) && body.actionableTabs >= 0 && body.actionableTabs <= 250
    && Number.isSafeInteger(body.allowedTabs) && body.allowedTabs >= 0 && body.allowedTabs <= 50;
  if (!validShape) return false;
  return body.staleIgnored
    ? body.storedCaptureSequence > submittedSequence
    : body.storedCaptureSequence === submittedSequence;
}

async function report() {
  collectionDisabledDuringReport = false;
  pairingChangedDuringReport = false;
  const settings = await chrome.storage.local.get(["dashboardUrl", "collectorToken", "collectorLabel", "collectorId", "captureSequence", "enabled"]);
  if (settings.enabled !== true) return { ok: false, message: "Collector not paired or reporting disabled." };
  if (typeof settings.collectorToken !== "string" || !settings.collectorToken || settings.collectorToken.trim() !== settings.collectorToken) {
    return { ok: false, message: "Collector not paired or reporting disabled." };
  }
  let requestTimedOut = false;
  try {
    if (!isValidCollectorId(settings.collectorId)) throw new Error("Open worker Settings and save the pairing again to reset the collector identity.");
    if (settings.collectorLabel !== undefined && settings.collectorLabel !== null && typeof settings.collectorLabel !== "string") {
      throw new Error("The collector label is invalid. Open worker Settings and save the pairing again.");
    }
    const collectorLabel = typeof settings.collectorLabel === "string" ? settings.collectorLabel.trim() : "";
    if (collectorLabel.length > 128) throw new Error("The collector label is invalid. Open worker Settings and save the pairing again.");
    const resetKey = collectorResetRequiredKey(settings.collectorId);
    const resetState = await chrome.storage.local.get([resetKey]);
    if (resetState[resetKey]) throw new Error("Open worker Settings and save the pairing again to reset the collector identity.");
    const origin = dashboardOrigin(settings.dashboardUrl);
    if (!await chrome.permissions.contains({ origins: [origin + "/*"] })) throw new Error("Grant access to the dashboard address in connection settings.");
    const sequenceKey = captureSequenceKey(settings.collectorId);
    const storedSequence = await chrome.storage.local.get([sequenceKey]);
    const currentSequence = storedSequence[sequenceKey] ?? settings.captureSequence;
    let capture = nextCaptureVersion(settings.collectorId, currentSequence);
    if (capture.collectorId !== settings.collectorId) await requirePairingReset(settings.collectorId);
    await persistCapture(settings, settings.collectorId, capture);
    const tabs = inventory(await chrome.tabs.query({}));
    const sourceCapturedAt = new Date().toISOString();
    let body;
    let staleRetries = 0;
    while (true) {
      const requestController = new AbortController();
      activeRequestController = requestController;
      const timeout = setTimeout(() => {
        requestTimedOut = true;
        requestController.abort();
      }, 15_000);
      let response;
      try {
        await requirePairingIsCurrent(settings, capture.collectorId);
        await requireCollectionEnabled();
        response = await fetch(origin + "/api/browser-tabs/ingest", {
          method: "POST", credentials: "omit", redirect: "error",
          signal: requestController.signal,
          headers: { Authorization: "Bearer " + settings.collectorToken, "Content-Type": "application/json" },
          body: JSON.stringify({ protocolVersion: 2, ...capture, sourceCapturedAt, collectorLabel: collectorLabel || "Worker browser", tabs }),
        });
      } finally {
        clearTimeout(timeout);
        if (activeRequestController === requestController) activeRequestController = undefined;
      }
      if (!response.ok) {
        let identityReset = false;
        if (response.status === 409 && !pairingChangedDuringReport && await pairingIsCurrent(settings, capture.collectorId)) {
          await chrome.storage.local.set({ [collectorResetRequiredKey(capture.collectorId)]: true });
          identityReset = true;
        }
        const message = response.status === 401 ? "Collector token rejected. Pair again from worker Settings."
          : response.status === 426 ? "Update the browser collector from worker Settings, then reload the extension."
          : response.status === 409 ? identityReset ? "Collector identity needs a reset. Open worker Settings and save the pairing again." : "Pairing changed while the request was in flight. The current pairing was left unchanged."
          : "Dashboard could not accept the inventory.";
        throw new Error(message);
      }
      try {
        body = await response.json();
      } catch {
        throw new Error("Dashboard returned an invalid inventory response.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body) || body.success !== true) {
        throw new Error("Dashboard could not accept the inventory.");
      }
      if (!validIngestResponse(body, capture.captureSequence)) throw new Error("Dashboard returned an invalid inventory response.");
      if (body.staleIgnored !== true) {
        await requirePairingIsCurrent(settings, capture.collectorId);
        await requireCollectionEnabled();
        break;
      }

      await requirePairingIsCurrent(settings, capture.collectorId);
      await requireCollectionEnabled();
      const synchronized = reconcileCaptureVersion(capture.collectorId, capture.captureSequence, body.storedCaptureSequence);
      if (!synchronized) throw new Error("Dashboard returned an invalid collector sequence.");
      if (synchronized.collectorId !== capture.collectorId) await requirePairingReset(capture.collectorId);
      await persistCapture(settings, capture.collectorId, synchronized);
      if (staleRetries >= 2) {
        throw new Error("The dashboard kept rejecting older inventories. The sequence was synchronized, but this report was not accepted; it will retry automatically.");
      }
      capture = nextCaptureVersion(synchronized.collectorId, synchronized.captureSequence);
      await persistCapture(settings, synchronized.collectorId, capture);
      staleRetries += 1;
    }
    await requirePairingIsCurrent(settings, capture.collectorId);
    await requireCollectionEnabled();
    const result = { ok: true, message: body.shouldWarn ? "End-of-day cleanup needed: " + body.actionableTabs + " tabs open, " + body.allowedTabs + " allowed." : body.actionableTabs + " work tabs reported.", at: new Date().toISOString() };
    await chrome.action.setBadgeText({ text: body.shouldWarn ? "!" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: body.shouldWarn ? "#c2410c" : "#166534" });
    await chrome.action.setTitle({ title: result.message });
    await chrome.storage.local.set({ lastResult: result });
    return result;
  } catch (error) {
    const message = collectionDisabledDuringReport ? "Browser collection was disabled during this report. No further inventory will be sent."
      : pairingChangedDuringReport ? "The browser pairing changed during this report. No older collector state was saved; retry with the current pairing."
      : requestTimedOut ? "The dashboard request timed out."
      : error instanceof Error ? error.message : "Collector unavailable.";
    const result = { ok: false, message, at: new Date().toISOString() };
    await chrome.storage.local.set({ lastResult: result });
    await chrome.action.setBadgeText({ text: "?" });
    return result;
  }
}
function sendInventory() {
  if (!running) running = report().finally(() => { running = undefined; });
  return running;
}
async function schedule() { await chrome.alarms.create("report-tabs", { periodInMinutes: 1 }); }
chrome.runtime.onInstalled.addListener(() => { void schedule(); void chrome.runtime.openOptionsPage(); });
chrome.runtime.onStartup.addListener(() => { void schedule(); void sendInventory(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "report-tabs") void sendInventory(); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "report-now") return false;
  void sendInventory().then(reply); return true;
});
