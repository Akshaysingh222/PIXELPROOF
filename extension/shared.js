/* Shared by the in-page checker (content.js) and the side panel (sidepanel.js).
   Uses the same check engine as the web app (lib/engine.js and lib/brandkit.js are copies of js/engine.js
   and js/brandkit.js, made by `npm run build:extension`). */
(function (root) {
  "use strict";
  const PP = root.PP, KIT = root.PP_KIT;
  const DEFAULTS = { apiUrl: "https://pixelproof.vercel.app", aiOn: true, kit: null };

  function settings() {
    return new Promise(ok => chrome.storage.local.get(DEFAULTS, s => ok(Object.assign({}, DEFAULTS, s, { kit: s.kit || KIT.DEMO_KIT }))));
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function counts(issues) { const c = { blocker: 0, warning: 0, suggestion: 0 }; issues.forEach(i => { if (i.status === "open") c[i.severity]++; }); return c; }
  function slimKit(kit) {
    return { brand: kit.brand, voice: kit.voice, messaging: kit.messaging, glossary: kit.glossary,
      rules: kit.rules.map(x => ({ id: x.id, category: x.category, severity: x.severity, title: x.title, detail: x.detail, enabled: x.enabled, examples: x.examples, patterns: x.patterns })) };
  }

  // Rule + fact checks, instantly, in the page. Same as the web app's first two layers.
  function checkLocal(text, kit) { return PP.runLocal(text, kit, PP.todayISO()); }

  // The AI review goes through the extension's background worker to the PixelProof server.
  // Personal data is masked first; the answer is verified by the same code as in the web app.
  async function checkAI(text, kit, contentType, existing) {
    const masked = PP.maskPII(text);
    const body = { text: masked.text, contentType, kit: slimKit(kit), facts: PP.retrieveFacts(text, kit, 8),
      alreadyFound: existing.filter(i => i.excerpt).map(i => ({ ruleId: i.ruleId, excerpt: i.excerpt })) };
    const data = await new Promise(ok => chrome.runtime.sendMessage({ type: "ai-check", body }, r => ok(r || { ok: false, error: "The extension's background worker didn't answer." })));
    if (!data.ok) return { ok: false, error: data.error || "AI check failed." };
    const v = PP.verifyAI(data.ai, text, kit, PP.todayISO(), existing);
    return { ok: true, model: data.model, issues: v.issues, verified: v.verified, dropped: v.dropped.length };
  }

  // Opens the web app with the draft, so it goes into the normal review queue.
  function sendToQueue(text, site, type, title) {
    const json = JSON.stringify({ text, site, type, title });
    const b64 = btoa(String.fromCharCode.apply(null, Array.from(new TextEncoder().encode(json)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    chrome.runtime.sendMessage({ type: "open-app", hash: "#check=" + b64 });
  }

  // The list of issues, as HTML. Buttons carry data-pp-act so the caller can handle clicks.
  function issuesHTML(state, opts) {
    opts = opts || {};
    const r = state.result; if (!r) return "";
    const open = r.issues.filter(i => i.status === "open");
    const c = counts(r.issues);
    let ai = "";
    if (state.ai === "running") ai = `<div class="pp-note pp-ai">AI review running… rule and fact checks are shown below.</div>`;
    else if (state.ai && state.ai.ok) ai = `<div class="pp-note pp-ai">AI review by ${esc(state.ai.model)} added ${state.ai.issues.length} finding${state.ai.issues.length === 1 ? "" : "s"}${state.ai.dropped ? ` (${state.ai.dropped} unverifiable AI answer${state.ai.dropped === 1 ? "" : "s"} thrown out)` : ""}.</div>`;
    else if (state.ai && !state.ai.ok) ai = `<div class="pp-note">${esc(state.ai.error)} <button class="pp-btn pp-small" data-pp-act="retry-ai">Try again</button></div>`;
    else if (state.aiOff) ai = `<div class="pp-note">Rules and facts only (AI review is off in the extension's options).</div>`;
    const list = open.map(i => `<div class="pp-issue pp-${i.severity}">
        <div class="pp-head"><span class="pp-sev pp-${i.severity}">${i.severity}</span><span class="pp-ref">${esc(i.reference)}${i.source === "AI check" ? " · AI" : ""}</span></div>
        ${i.excerpt ? `<div class="pp-excerpt">“${esc(i.excerpt)}”</div>` : ""}
        <div class="pp-msg">${esc(i.message)}</div>
        <div class="pp-actions">${opts.canFix ? i.fixes.map((f, n) => `<button class="pp-btn pp-primary" data-pp-act="fix" data-key="${i.key}" data-n="${n}">${esc(f.label)}</button>`).join("") : ""}<button class="pp-btn" data-pp-act="ignore" data-key="${i.key}">Ignore</button></div>
      </div>`).join("");
    const verified = r.verified.length ? `<div class="pp-sub">Checked against approved facts</div>` + r.verified.map(v => `<div class="pp-ok">✓ “${esc(v.excerpt)}” matches ${esc(v.factId)}</div>`).join("") : "";
    return `<div class="pp-summary"><span class="pp-pill pp-blocker">${c.blocker} blocker${c.blocker === 1 ? "" : "s"}</span><span class="pp-pill pp-warning">${c.warning} warning${c.warning === 1 ? "" : "s"}</span><span class="pp-pill pp-suggestion">${c.suggestion} suggestion${c.suggestion === 1 ? "" : "s"}</span></div>
      ${ai}${list || `<div class="pp-ok pp-big">✓ No open issues. Ready to send for review or publish.</div>`}${verified}`;
  }

  // Styles for the panel (used inside a shadow root in pages, and in the side panel).
  const CSS = `
    :host, .pp-root { all: initial; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c1917; }
    .pp-card { background: #fff; border: 1px solid #e5e0d8; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.15); padding: 14px; box-sizing: border-box; }
    .pp-title { display: flex; align-items: center; gap: 8px; font-weight: 800; font-size: 15px; margin-bottom: 10px; }
    .pp-title .pp-px { width: 12px; height: 12px; background: #e4572e; border-radius: 2px; }
    .pp-title .pp-x { margin-left: auto; }
    .pp-summary { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
    .pp-pill { border-radius: 7px; padding: 3px 9px; font-weight: 700; font-size: 12.5px; }
    .pp-pill.pp-blocker { background: #fdecec; color: #b91c1c; } .pp-pill.pp-warning { background: #fdf3e2; color: #a45a06; } .pp-pill.pp-suggestion { background: #e9f1fb; color: #1f4f82; }
    .pp-note { font-size: 12.5px; background: #f7f4ef; border-radius: 7px; padding: 6px 9px; margin-bottom: 8px; }
    .pp-note.pp-ai { background: #f4f0fd; color: #5b3fb8; }
    .pp-issue { border: 1px solid #e5e0d8; border-left: 4px solid #cfc8bd; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
    .pp-issue.pp-blocker { border-left-color: #b91c1c; } .pp-issue.pp-warning { border-left-color: #d98a1b; } .pp-issue.pp-suggestion { border-left-color: #3b78c4; }
    .pp-head { display: flex; gap: 6px; align-items: center; font-size: 12px; color: #6b645b; }
    .pp-sev { text-transform: uppercase; font-weight: 800; font-size: 10.5px; padding: 1px 6px; border-radius: 4px; }
    .pp-sev.pp-blocker { background: #fdecec; color: #b91c1c; } .pp-sev.pp-warning { background: #fdf3e2; color: #a45a06; } .pp-sev.pp-suggestion { background: #e9f1fb; color: #1f4f82; }
    .pp-excerpt { font-weight: 700; margin: 4px 0 2px; }
    .pp-msg { font-size: 13px; }
    .pp-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .pp-btn { font: inherit; font-size: 12.5px; border: 1px solid #d6d0c6; background: #fff; border-radius: 7px; padding: 4px 9px; cursor: pointer; color: #1c1917; }
    .pp-btn:hover { background: #f7f4ef; } .pp-btn:disabled { opacity: .5; cursor: default; }
    .pp-btn.pp-primary { background: #e4572e; border-color: #e4572e; color: #fff; }
    .pp-btn.pp-dark { background: #1c1917; border-color: #1c1917; color: #fff; }
    .pp-btn.pp-small { padding: 2px 7px; }
    .pp-sub { font-size: 11.5px; text-transform: uppercase; letter-spacing: .4px; color: #6b645b; font-weight: 700; margin: 10px 0 4px; }
    .pp-ok { color: #1d6b3a; font-size: 13px; } .pp-ok.pp-big { background: #e8f5ec; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
    .pp-foot { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; border-top: 1px solid #eee8df; padding-top: 10px; }
    .pp-hint { font-size: 12px; color: #6b645b; }
  `;

  root.PPX = { settings, checkLocal, checkAI, sendToQueue, issuesHTML, counts, esc, CSS };
})(typeof window !== "undefined" ? window : globalThis);
