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
