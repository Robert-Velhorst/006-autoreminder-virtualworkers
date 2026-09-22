const list = document.querySelector("#tabs");

function reportable(tab) {
  return !tab.pinned && /^(https?|file):/i.test(tab.url || "");
}

async function render() {
  const tabs = (await chrome.tabs.query({})).filter(reportable);
  list.replaceChildren();
  if (!tabs.length) {
    const empty = document.createElement("div");
    empty.id = "empty";
    empty.textContent = "No non-pinned work tabs are open.";
    list.append(empty);
    return;
  }
  for (const tab of tabs) {
    const row = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(tab.id);
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = tab.title || "Untitled tab";
    const host = document.createElement("small");
    try { host.textContent = new URL(tab.url).hostname || tab.url; } catch { host.textContent = tab.url || ""; }
    text.append(title, host);
    row.append(checkbox, text);
    list.append(row);
  }
}

document.querySelector("#select-all").addEventListener("click", () => {
  for (const checkbox of list.querySelectorAll('input[type="checkbox"]')) checkbox.checked = true;
});

document.querySelector("#close-selected").addEventListener("click", async () => {
  const ids = [...list.querySelectorAll('input[type="checkbox"]:checked')].map((item) => Number(item.value)).filter(Number.isFinite);
  if (!ids.length) return;
  if (!confirm(`Close ${ids.length} selected tab${ids.length === 1 ? "" : "s"}?`)) return;
  await chrome.tabs.remove(ids);
  await chrome.runtime.sendMessage({ type: "report-now" });
  await render();
});

void render();

document.querySelector("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.storage.local.get(["lastResult"]).then(({lastResult}) => { document.querySelector("#status").textContent = lastResult?.message || "Not connected. Open connection settings."; });
