(function () {
  "use strict";
  const DEFAULT_API = "https://pixelproof.vercel.app";
  const $ = id => document.getElementById(id);
  let kit = null;
  function say(m) { $("msg").textContent = m; setTimeout(() => { if ($("msg").textContent === m) $("msg").textContent = ""; }, 4000); }
  chrome.storage.local.get({ apiUrl: DEFAULT_API, aiOn: true, kit: null }, s => {
    $("apiUrl").value = s.apiUrl; $("aiOn").checked = s.aiOn; kit = s.kit;
    $("kitName").textContent = kit ? kit.brand + " (imported)" : window.PP_KIT.DEMO_KIT.brand + " (demo)";
  });
  $("kitFile").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const k = JSON.parse(await f.text());
      if (!Array.isArray(k.rules) || !k.rules.length || !Array.isArray(k.facts) || !Array.isArray(k.glossary)) throw new Error("bad");
      kit = k; $("kitName").textContent = (k.brand || "Brand kit") + " (imported, not saved yet)";
    } catch (err) { say("That doesn't look like a PixelProof brand kit file."); e.target.value = ""; }
  });
  $("kitReset").addEventListener("click", () => { kit = null; $("kitName").textContent = window.PP_KIT.DEMO_KIT.brand + " (demo, not saved yet)"; });
  $("save").addEventListener("click", () => {
    let url = $("apiUrl").value.trim().replace(/\/+$/, "") || DEFAULT_API;
    if (!/^https:\/\/[^\s/]+$|^http:\/\/localhost(:\d+)?$/.test(url)) { say("Use an address like https://pixelproof.vercel.app"); return; }
    chrome.storage.local.set({ apiUrl: url, aiOn: $("aiOn").checked, kit }, () => {
      $("kitName").textContent = kit ? kit.brand + " (imported)" : window.PP_KIT.DEMO_KIT.brand + " (demo)";
      say("Saved.");
    });
  });
})();
