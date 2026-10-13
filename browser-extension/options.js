import { captureSequenceKey, collectorPairingIdentity, collectorResetRequiredKey, dashboardOrigin, isValidCollectorId } from "./collector-core.js";
const form = document.querySelector("#settings-form");
const url = document.querySelector("#dashboard-url");
const label = document.querySelector("#collector-label");
const token = document.querySelector("#collector-token");
const enabled = document.querySelector("#enabled");
const status = document.querySelector("#status");
function show(message, ok) { status.textContent = message; status.className = ok ? "ok" : "error"; }
async function save() {
  const origin = dashboardOrigin(url.value.trim());
  const collectorLabel = typeof label.value === "string" ? label.value.trim() : "";
  const collectorToken = typeof token.value === "string" ? token.value.trim() : "";
  if (!collectorLabel || collectorLabel.length > 128) throw new Error("Enter a collector label of 1 to 128 characters.");
  if (!collectorToken) throw new Error("Enter the collector token from worker Settings.");
  if (enabled.checked && await chrome.permissions.request({ origins: [origin + "/*"] }) !== true) throw new Error("Dashboard access was not granted. Nothing was paired.");
  const current = await chrome.storage.local.get(["dashboardUrl", "collectorToken", "collectorId", "captureSequence"]);
  let previousOrigin;
  try { previousOrigin = dashboardOrigin(current.dashboardUrl); } catch { previousOrigin = null; }
  const hasCurrentId = isValidCollectorId(current.collectorId);
  const sequenceKey = hasCurrentId ? captureSequenceKey(current.collectorId) : undefined;
  const resetKey = hasCurrentId ? collectorResetRequiredKey(current.collectorId) : undefined;
  const scoped = sequenceKey ? await chrome.storage.local.get([sequenceKey, resetKey]) : {};
  if (sequenceKey) current.captureSequence = scoped[sequenceKey] ?? current.captureSequence;
  if (resetKey && scoped[resetKey]) current.collectorId = "";
  const identity = collectorPairingIdentity(current, origin, collectorToken);
  await chrome.storage.local.set({
    dashboardUrl: origin,
    collectorLabel,
    collectorToken,
    enabled: enabled.checked,
    ...identity,
    [captureSequenceKey(identity.collectorId)]: identity.captureSequence,
    [collectorResetRequiredKey(identity.collectorId)]: false,
  });
  let previousPermissionCleanupFailed = false;
  if (previousOrigin && previousOrigin !== origin) {
    try {
      const previousPermission = { origins: [previousOrigin + "/*"] };
      if (await chrome.permissions.contains(previousPermission)
        && !await chrome.permissions.remove(previousPermission)) previousPermissionCleanupFailed = true;
    } catch {
      previousPermissionCleanupFailed = true;
    }
  }
  if (!enabled.checked) await chrome.action.setBadgeText({ text: "" });
  return { identityReset: identity.collectorId !== current.collectorId, previousPermissionCleanupFailed };
}
const stored = await chrome.storage.local.get({ dashboardUrl: "", collectorLabel: "Worker browser", collectorToken: "", enabled: false });
url.value = stored.dashboardUrl; label.value = stored.collectorLabel; token.value = stored.collectorToken; enabled.checked = stored.enabled;
form.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const result = await save();
    const message = result.previousPermissionCleanupFailed
      ? "Pairing saved, but access to the previous dashboard could not be removed. Remove that site from this extension's site access settings."
      : enabled.checked
      ? result.identityReset ? "New pairing saved. Collector identity reset; first inventory is due within one minute." : "Settings saved. First inventory is due within one minute."
      : result.identityReset ? "New pairing saved and collector identity reset. Reporting is disabled." : "Reporting disabled.";
    show(message, !result.previousPermissionCleanupFailed);
  }
  catch (error) { show(error.message, false); }
});
document.querySelector("#test").addEventListener("click", async () => {
  if (!form.reportValidity()) return;
  try { await save(); const result = await chrome.runtime.sendMessage({ type: "report-now" }); show(result?.message || "No response.", Boolean(result?.ok)); }
  catch (error) { show(error.message, false); }
});
