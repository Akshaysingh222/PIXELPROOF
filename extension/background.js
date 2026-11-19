/* PixelProof extension background worker.
   - Sends AI checks to the PixelProof server (the API key stays on the server).
   - "Check with PixelProof" on the right-click menu opens the side panel with the selected text.
   - Opens the web app's review queue with a draft. */
const DEFAULT_API = "https://pixelproof.vercel.app";
function apiUrl() { return new Promise(ok => chrome.storage.local.get({ apiUrl: DEFAULT_API }, s => ok(String(s.apiUrl || DEFAULT_API).replace(/\/+$/, "")))); }

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "pp-check", title: "Check with PixelProof", contexts: ["selection"] });
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "pp-check") return;
  // open first (must happen straight away, while the click still counts as a user action), then hand over the text
  if (chrome.sidePanel && tab) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  chrome.storage.session.set({ pending: { text: info.selectionText || "", at: Date.now(), url: tab ? tab.url : "" } });
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "ai-check") {
    (async () => {
      try {
        const base = await apiUrl();
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000);
        const res = await fetch(base + "/api/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg.body), signal: ctrl.signal });
        clearTimeout(t);
        const data = await res.json().catch(() => ({ ok: false, error: "PixelProof sent back something unexpected." }));
        reply(data);
      } catch (e) {
        reply({ ok: false, error: e.name === "AbortError" ? "The AI check took too long. Rule and fact checks still ran." : "Couldn't reach PixelProof. Rule and fact checks still ran." });
      }
    })();
    return true; // answer asynchronously
  }
  if (msg && msg.type === "open-app") {
    apiUrl().then(base => chrome.tabs.create({ url: base + "/" + msg.hash }));
  }
  return false;
});
