import { dashboardOrigin } from "./collector-core.js";
const form = document.querySelector("#settings-form");
const url = document.querySelector("#dashboard-url");
const label = document.querySelector("#collector-label");
const token = document.querySelector("#collector-token");
const enabled = document.querySelector("#enabled");
const status = document.querySelector("#status");
function show(message, ok) { status.textContent = message; status.className = ok ? "ok" : "error"; }
async function save() {
  const origin = dashboardOrigin(url.value.trim());
  if (enabled.checked && !await chrome.permissions.request({ origins: [origin + "/*"] })) throw new Error("Dashboard access was not granted. Nothing was paired.");
  await chrome.storage.local.set({ dashboardUrl: origin, collectorLabel: label.value.trim(), collectorToken: token.value.trim(), enabled: enabled.checked });
  if (!enabled.checked) await chrome.action.setBadgeText({ text: "" });
}
const stored = await chrome.storage.local.get({ dashboardUrl: "", collectorLabel: "Worker browser", collectorToken: "", enabled: false });
url.value = stored.dashboardUrl; label.value = stored.collectorLabel; token.value = stored.collectorToken; enabled.checked = stored.enabled;
form.addEventListener("submit", async event => {
  event.preventDefault();
  try { await save(); show(enabled.checked ? "Settings saved. First inventory is due within one minute." : "Reporting disabled.", true); }
  catch (error) { show(error.message, false); }
});
document.querySelector("#test").addEventListener("click", async () => {
  if (!form.reportValidity()) return;
  try { await save(); const result = await chrome.runtime.sendMessage({ type: "report-now" }); show(result?.message || "No response.", Boolean(result?.ok)); }
  catch (error) { show(error.message, false); }
});
