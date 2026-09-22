import { dashboardOrigin, inventory } from "./collector-core.js";
let running;
async function report() {
  const settings = await chrome.storage.local.get(["dashboardUrl", "collectorToken", "collectorLabel", "collectorId", "enabled"]);
  if (!settings.enabled || !settings.collectorToken) return { ok: false, message: "Collector not paired or reporting disabled." };
  try {
    const origin = dashboardOrigin(settings.dashboardUrl);
    if (!await chrome.permissions.contains({ origins: [origin + "/*"] })) throw new Error("Grant access to the dashboard address in connection settings.");
    const collectorId = settings.collectorId || crypto.randomUUID();
    if (!settings.collectorId) await chrome.storage.local.set({ collectorId });
    const response = await fetch(origin + "/api/browser-tabs/ingest", {
      method: "POST", credentials: "omit", redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: "Bearer " + settings.collectorToken, "Content-Type": "application/json" },
      body: JSON.stringify({ collectorId, collectorLabel: settings.collectorLabel || "Worker browser", tabs: inventory(await chrome.tabs.query({})) }),
    });
    const body = await response.json();
    if (!response.ok || body.success !== true) throw new Error(response.status === 401 ? "Collector token rejected. Pair again from worker Settings." : "Dashboard could not accept the inventory.");
    const result = { ok: true, message: body.shouldWarn ? "End-of-day cleanup needed: " + body.actionableTabs + " tabs open, " + body.allowedTabs + " allowed." : body.actionableTabs + " work tabs reported.", at: new Date().toISOString() };
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
