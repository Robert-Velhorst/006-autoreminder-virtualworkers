import { dashboardOrigin, inventory, nextCaptureVersion, reconcileCaptureVersion } from "./collector-core.js";
let running;
async function report() {
  const settings = await chrome.storage.local.get(["dashboardUrl", "collectorToken", "collectorLabel", "collectorId", "captureSequence", "enabled"]);
  if (!settings.enabled || !settings.collectorToken) return { ok: false, message: "Collector not paired or reporting disabled." };
  try {
    const origin = dashboardOrigin(settings.dashboardUrl);
    if (!await chrome.permissions.contains({ origins: [origin + "/*"] })) throw new Error("Grant access to the dashboard address in connection settings.");
    const capture = nextCaptureVersion(settings.collectorId, settings.captureSequence);
    await chrome.storage.local.set(capture);
    const tabs = inventory(await chrome.tabs.query({}));
    const sourceCapturedAt = new Date().toISOString();
    const response = await fetch(origin + "/api/browser-tabs/ingest", {
      method: "POST", credentials: "omit", redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: "Bearer " + settings.collectorToken, "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: 2, ...capture, sourceCapturedAt, collectorLabel: settings.collectorLabel || "Worker browser", tabs }),
    });
    const body = await response.json();
    if (!response.ok || body.success !== true) {
      if (response.status === 409) {
        await chrome.storage.local.set({ collectorId: crypto.randomUUID(), captureSequence: 0 });
      }
      const message = response.status === 401 ? "Collector token rejected. Pair again from worker Settings."
        : response.status === 426 ? "Update the browser collector from worker Settings, then reload the extension."
        : response.status === 409 ? "Collector identity was reset. The next report will retry automatically."
        : "Dashboard could not accept the inventory.";
      throw new Error(message);
    }
    if (body.staleIgnored === true) {
      const synchronized = reconcileCaptureVersion(capture.collectorId, capture.captureSequence, body.storedCaptureSequence);
      if (synchronized) await chrome.storage.local.set(synchronized);
    }
    const result = { ok: true, message: body.staleIgnored ? "A newer browser inventory is already stored." : body.shouldWarn ? "End-of-day cleanup needed: " + body.actionableTabs + " tabs open, " + body.allowedTabs + " allowed." : body.actionableTabs + " work tabs reported.", at: new Date().toISOString() };
    await chrome.action.setBadgeText({ text: body.shouldWarn ? "!" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: body.shouldWarn ? "#c2410c" : "#166534" });
    await chrome.action.setTitle({ title: result.message });
    await chrome.storage.local.set({ lastResult: result });
    return result;
  } catch (error) {
    const result = { ok: false, message: error instanceof Error ? error.message : "Collector unavailable.", at: new Date().toISOString() };
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
