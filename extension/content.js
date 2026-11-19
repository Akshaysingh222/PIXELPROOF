/* PixelProof in LinkedIn, Gmail and X.
   Adds a "Check" button to the compose box you're typing in. Clicking it checks the draft with the same
   engine as the web app, highlights problems in place, and lets you apply fixes without leaving the page. */
(function () {
  "use strict";
  if (window.__pixelproofLoaded) return; window.__pixelproofLoaded = true;
  const PP = window.PP, X = window.PPX;

  const SITES = [
    { test: /(^|\.)linkedin\.com$/, name: "LinkedIn", type: "LinkedIn post", editor: '.ql-editor[contenteditable="true"], div[role="textbox"][contenteditable="true"]' },
    { test: /^mail\.google\.com$/, name: "Gmail", type: "Email", editor: 'div[aria-label="Message Body"][contenteditable="true"], div[role="textbox"][contenteditable="true"][g_editable="true"], div.editable[contenteditable="true"]' },
    { test: /(^|\.)(x|twitter)\.com$/, name: "X", type: "X post", editor: '[data-testid^="tweetTextarea_"][contenteditable="true"], div[role="textbox"][contenteditable="true"]' }
  ];
  const SITE = SITES.find(s => s.test.test(location.hostname));
  if (!SITE) return;

  let cfg = null;            // settings: API address, AI on/off, brand kit
  let editor = null;         // the compose box being checked
  let state = { result: null, ai: null, text: "" };
  const ignored = new Set(); // "ruleId|excerpt" the writer chose to ignore for this draft
  X.settings().then(s => { cfg = s; });
  chrome.storage.onChanged.addListener(() => X.settings().then(s => { cfg = s; if (state.result) recheck(false); }));

  // ---------- reading the compose box ----------
  // Builds the plain text of the editor and remembers which DOM text node each character came from,
  // so issues found in the text can be highlighted and fixed in the page.
  const BLOCK = /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE|UL|OL)$/;
  function readEditor(el) {
    const segs = []; let text = "";
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n = w.nextNode();
    while (n) {
      if (n.nodeType === 3) { const t = n.nodeValue.replace(/​/g, " "); if (t) { segs.push({ node: n, start: text.length, len: t.length }); text += t; } }
      else if (n.tagName === "BR") text += "\n";
      else if (BLOCK.test(n.tagName) && text && !text.endsWith("\n")) text += "\n";
      n = w.nextNode();
    }
    return { text, segs };
  }
  function rangeFor(map, start, end) {
    const a = map.segs.find(s => start >= s.start && start < s.start + s.len);
    const b = map.segs.find(s => end > s.start && end <= s.start + s.len);
    if (!a || !b) return null;
    const r = document.createRange();
    r.setStart(a.node, start - a.start); r.setEnd(b.node, end - b.start);
    return r;
  }
  function locate(text, i) {
    if (!i.excerpt) return -1;
    if (i.index >= 0 && text.slice(i.index, i.index + i.excerpt.length) === i.excerpt) return i.index;
    const at = text.indexOf(i.excerpt); if (at >= 0) return at;
    return text.toLowerCase().indexOf(i.excerpt.toLowerCase());
  }

  // ---------- highlights (CSS Custom Highlight API; nothing is added to the page's text) ----------
  function clearHighlights() { if (window.CSS && CSS.highlights) ["pp-blocker", "pp-warning", "pp-suggestion"].forEach(k => CSS.highlights.delete(k)); }
  function paintHighlights() {
    clearHighlights();
    if (!editor || !state.result || !(window.CSS && CSS.highlights && window.Highlight)) return;
    const map = readEditor(editor); const groups = { blocker: [], warning: [], suggestion: [] };
    state.result.issues.filter(i => i.status === "open").forEach(i => {
      const at = locate(map.text, i); if (at < 0) return;
      const r = rangeFor(map, at, at + i.excerpt.length); if (r) groups[i.severity].push(r);
    });
    Object.entries(groups).forEach(([k, rs]) => { if (rs.length) CSS.highlights.set("pp-" + k, new Highlight(...rs)); });
  }

  // ---------- the floating Check button ----------
  const btnHost = document.createElement("div"); btnHost.id = "pixelproof-button";
  const btnRoot = btnHost.attachShadow({ mode: "open" });
  btnRoot.innerHTML = `<style>
      button { all: initial; font: 700 12.5px system-ui, -apple-system, "Segoe UI", sans-serif; background: #1c1917; color: #fff; border-radius: 999px; padding: 6px 11px; cursor: pointer; box-shadow: 0 3px 10px rgba(0,0,0,.25); display: inline-flex; gap: 6px; align-items: center; }
      button:hover { background: #e4572e; } i { width: 9px; height: 9px; background: #e4572e; border-radius: 2px; display: inline-block; }
      b { background: #e4572e; border-radius: 999px; padding: 0 6px; font-size: 11px; } b:empty { display: none; }
    </style><button type="button" title="Check this draft against your brand kit (PixelProof)"><i></i><span>Check</span><b></b></button>`;
  const btn = btnRoot.querySelector("button");
  btnHost.style.cssText = "position:fixed;z-index:2147483646;display:none;";
  btn.addEventListener("mousedown", e => e.preventDefault()); // keep the caret in the editor
  btn.addEventListener("click", () => { openPanel(); recheck(true); });

  function place() {
    if (!editor || !editor.isConnected) { btnHost.style.display = "none"; return; }
    const r = editor.getBoundingClientRect();
    if (r.width < 40 || r.height < 10 || r.bottom < 0 || r.top > innerHeight) { btnHost.style.display = "none"; return; }
    btnHost.style.display = "block";
    btnHost.style.left = Math.max(4, Math.min(innerWidth - 110, r.right - 100)) + "px";
    btnHost.style.top = Math.max(4, Math.min(innerHeight - 36, r.bottom - 34)) + "px";
  }
  function setBadge() {
    const n = state.result ? state.result.issues.filter(i => i.status === "open").length : 0;
    btnRoot.querySelector("b").textContent = state.result ? String(n) : "";
  }

  // ---------- the results panel ----------
  const panelHost = document.createElement("div"); panelHost.id = "pixelproof-panel";
  const panelRoot = panelHost.attachShadow({ mode: "open" });
  panelHost.style.cssText = "position:fixed;z-index:2147483647;right:16px;top:72px;width:370px;max-width:calc(100vw - 32px);display:none;";
  panelRoot.innerHTML = `<style>${X.CSS} .pp-card { max-height: calc(100vh - 100px); overflow: auto; }</style><div class="pp-root"><div class="pp-card" role="dialog" aria-label="PixelProof results"></div></div>`;
  const card = panelRoot.querySelector(".pp-card");
  function openPanel() { panelHost.style.display = "block"; }
  function closePanel() { panelHost.style.display = "none"; clearHighlights(); }
  function drawPanel() {
    const busy = state.ai === "running";
    card.innerHTML = `<div class="pp-title"><span class="pp-px"></span>PixelProof · ${X.esc(SITE.name)} draft<button class="pp-btn pp-x" data-pp-act="close" aria-label="Close">✕</button></div>
      ${!state.result ? `<div class="pp-hint">Checking…</div>` : !state.text.trim() ? `<div class="pp-hint">Type your draft first, then click Check.</div>` : X.issuesHTML(state, { canFix: true })}
      <div class="pp-foot">
        <button class="pp-btn pp-dark" data-pp-act="recheck" ${busy ? "disabled" : ""}>${busy ? "Checking…" : "Check again"}</button>
        <button class="pp-btn" data-pp-act="queue" ${state.text.trim() ? "" : "disabled"}>Send to review queue</button>
      </div>
      <div class="pp-hint" style="margin-top:6px">Brand kit: ${X.esc(cfg ? cfg.kit.brand : "")} · underlines: red blocker, amber warning, blue suggestion</div>`;
  }
  card.addEventListener("mousedown", e => { if (e.target.closest("button")) e.preventDefault(); });
  card.addEventListener("click", e => {
    const b = e.target.closest("[data-pp-act]"); if (!b || b.disabled) return;
    const act = b.dataset.ppAct;
    if (act === "close") closePanel();
    if (act === "recheck") recheck(true);
    if (act === "retry-ai") runAI();
    if (act === "queue") X.sendToQueue(state.text, SITE.name, SITE.type, SITE.name + " draft: " + state.text.trim().split(/\s+/).slice(0, 5).join(" "));
    if (act === "ignore") { const i = state.result.issues.find(x => x.key === b.dataset.key); if (i) { i.status = "dismissed"; ignored.add(i.ruleId + "|" + i.excerpt); } update(); }
    if (act === "fix") applyFix(b.dataset.key, +b.dataset.n);
  });

  // ---------- checking ----------
  function update() { setBadge(); drawPanel(); paintHighlights(); }
  async function recheck(withAI) {
    if (!editor) return;
    if (!cfg) cfg = await X.settings();
    const text = readEditor(editor).text;
    const prev = state.result;
    const r = X.checkLocal(text, cfg.kit);
    if (prev && !withAI) prev.issues.filter(i => i.source === "AI check" && i.status === "open" && i.excerpt && text.includes(i.excerpt)).forEach(i => r.issues.push(i));
    r.issues.forEach(i => { if (ignored.has(i.ruleId + "|" + i.excerpt)) i.status = "dismissed"; });
    state = { result: r, ai: withAI ? null : state.ai, text, aiOff: !cfg.aiOn };
    update();
    if (withAI && cfg.aiOn && text.trim()) await runAI();
  }
  let aiRun = 0; // only the latest AI request counts
  async function runAI() {
    const r = state.result; if (!r) return;
    const my = ++aiRun;
    state.ai = "running"; drawPanel();
    let res;
    try { res = await X.checkAI(state.text, cfg.kit, SITE.type, r.issues); }
    catch (e) { res = { ok: false, error: "Couldn't reach PixelProof. Rule and fact checks still ran." }; }
    if (my !== aiRun) return;
    // the draft may have changed while the AI was working (a fix or typing): keep only findings that still apply
    const cur = state.result; if (!cur) return;
    state.ai = res;
    if (res.ok) {
      res.issues.filter(i => !i.excerpt || state.text.includes(i.excerpt)).forEach(i => { if (ignored.has(i.ruleId + "|" + i.excerpt)) i.status = "dismissed"; cur.issues.push(i); });
      cur.issues = PP.sortIssues(cur.issues); cur.verified = cur.verified.concat(res.verified.filter(v => state.text.includes(v.excerpt)));
    }
    update();
  }

  // Applies a fix inside the compose box the same way typing would, so LinkedIn/Gmail/X notice the change.
  function applyFix(key, n) {
    const i = state.result && state.result.issues.find(x => x.key === key); if (!i || !editor) return;
    const fix = i.fixes[n]; if (!fix) return;
    const map = readEditor(editor); const at = locate(map.text, i);
    const range = at >= 0 ? rangeFor(map, at, at + i.excerpt.length) : null;
    if (!range) { flash("Couldn't find that text any more. Click Check again."); return; }
    editor.focus();
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    const ok = fix.replacement ? document.execCommand("insertText", false, fix.replacement) : document.execCommand("delete");
    if (!ok) { flash("This page didn't accept the change. Copy the fix: " + (fix.replacement || "(remove the words)")); return; }
    setTimeout(() => recheck(false), 60);
  }
  function flash(msg) { state.ai = { ok: false, error: msg }; drawPanel(); }

  // ---------- following the focused compose box ----------
  function editorFrom(node) {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    const hit = el && el.closest(SITE.editor);
    if (!hit) return null;
    let top = hit; while (top.parentElement && top.parentElement.isContentEditable) top = top.parentElement;
    return top;
  }
  document.addEventListener("focusin", e => {
    const ed = editorFrom(e.target); if (!ed) return;
    if (ed !== editor) { editor = ed; aiRun++; state = { result: null, ai: null, text: "" }; ignored.clear(); setBadge(); if (panelHost.style.display === "block") recheck(false); }
    if (!btnHost.isConnected) document.documentElement.append(btnHost, panelHost);
    place();
  }, true);
  let typing = null;
  document.addEventListener("input", e => {
    if (!editor || !editor.contains(e.target)) return;
    place();
    clearTimeout(typing);
    if (state.result) typing = setTimeout(() => recheck(false), 700); // live rule check while the panel has results
  }, true);
  addEventListener("scroll", () => requestAnimationFrame(place), true);
  addEventListener("resize", () => requestAnimationFrame(place));
  setInterval(place, 1000);
})();
