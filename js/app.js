/* PixelProof UI. Plain JavaScript, no build step. All demo data is stored in this browser (localStorage). */
(function () {
  "use strict";
  // This file is the user interface. The checking logic lives in engine.js.
  // Everything is saved in the browser (localStorage), so the demo needs no login or database.
  const PP = window.PP, KIT = window.PP_KIT;
  const STORE = "pixelproof:v1";
  const PEOPLE = { creator: "Riya (Creator)", reviewer: "Arjun (Brand manager)" };
  const TYPES = ["LinkedIn post", "Advertisement", "Email", "Document", "Web copy", "Instagram caption"];
  const $app = document.getElementById("app");
  let AI = { checked: false, enabled: false, model: null, provider: null };
  let toastTimer = null;

  // ---------- state ----------
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function now() { return new Date().toISOString(); }
  function uid() { return Math.random().toString(36).slice(2, 9); }
  function freshDraft() { return { itemId: null, type: "LinkedIn post", title: "", text: "", image: null, result: null }; }

  // Example submissions so the review queue isn't empty the first time someone opens the app.
  function seedItems(kit) {
    const today = PP.todayISO();
    const mk = (title, type, text, status, extra) => {
      const r = PP.runLocal(text, kit, today);
      const issues = r.issues.map(i => Object.assign({}, i, (extra.decide || {})[i.ruleId] || {}));
      const at = new Date(Date.now() - (extra.ago || 1) * 3600e3).toISOString();
      return {
        id: uid(), title, type, status, createdBy: PEOPLE.creator, createdAt: at,
        versions: [{ v: 1, text, at, issues, fixed: [], verified: r.verified, aiUsed: false, image: null }],
        comments: extra.comments || [], history: [{ at, by: PEOPLE.creator, action: "Submitted version 1" }].concat(extra.history || [])
      };
    };
    return [
      mk("Diwali ad", "Advertisement", KIT.SAMPLES[2].text, "approved", { ago: 30,
        comments: [{ by: PEOPLE.reviewer, at: now(), text: "Calm, clear and every claim is backed. Approved." }],
        history: [{ at: now(), by: PEOPLE.reviewer, action: "Approved" }] }),
      mk("Weekly savings tip", "Instagram caption", "Saving ₹100 a week adds up to ₹5,200 in a year. Start a Savings Pot today and watch it grow \u{1F331}", "in_review", { ago: 5,
        decide: { "C-3": { status: "dismissed", reason: "This is simple maths (100 x 52), not a claim about Kitebird Money." } } }),
      mk("App store blurb", "Web copy", "Kitebird Money is the smartest way to save in India. Download now and start today!", "changes_requested", { ago: 20,
        comments: [{ by: PEOPLE.reviewer, at: now(), text: "“Smartest way to save” is a ranking we can't back up, and “Download now” feels pushy. Could you make it calmer?" }],
        history: [{ at: now(), by: PEOPLE.reviewer, action: "Requested changes" }] })
    ];
  }

  function defaultState() {
    const kit = clone(KIT.DEMO_KIT);
    return { tab: "check", role: "creator", kit, items: seedItems(kit), selected: null, draft: freshDraft(), stats: { checks: 0, aiChecks: 0, aiDropped: 0 }, introHidden: false };
  }
  // Load saved data from the browser, or start fresh with the demo brand kit.
  function load() {
    try { const s = JSON.parse(localStorage.getItem(STORE)); if (s && s.kit && s.items) return s; } catch (e) { /* storage unavailable */ }
    return defaultState();
  }
  let S = load();
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(S)); }
    catch (e) { // probably full: drop stored images from older versions and retry
      try { S.items.forEach(it => it.versions.slice(0, -1).forEach(v => { v.image = null; })); localStorage.setItem(STORE, JSON.stringify(S)); } catch (e2) { /* ignore */ }
    }
  }

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function when(iso) { const d = new Date(iso); return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
  function toast(msg) {
    let t = document.querySelector(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
  }
  function sevCount(list) { const c = { blocker: 0, warning: 0, suggestion: 0 }; list.forEach(i => { if (i.status === "open") c[i.severity]++; }); return c; }
  function keyOf(i) { return i.ruleId + "|" + PP.norm(i.excerpt); }
  function isReviewer() { return S.role === "reviewer"; }

  // ---------- checking ----------
  // Runs the rule + fact checks (engine.js) and keeps anything the user already decided:
  // issues they dismissed stay dismissed, and AI findings that still apply are kept.
  function localResult(text, prev) {
    const d = S.draft, today = PP.todayISO();
    const local = PP.runLocal(text, S.kit, today);
    let issues = local.issues;
    if (prev) { // keep AI issues that still apply
      const ntext = PP.norm(text);
      prev.issues.filter(i => i.source === "AI check" && i.status !== "fixed" && (!i.excerpt || ntext.includes(PP.norm(i.excerpt))))
        .forEach(i => { if (!issues.some(x => keyOf(x) === keyOf(i))) issues.push(Object.assign({}, i)); });
    }
    if (d.image && d.image.issues) issues = issues.concat(imageIssues());
    const dismissed = {}; if (prev) prev.issues.forEach(i => { if (i.status === "dismissed") dismissed[keyOf(i)] = i.reason; });
    issues.forEach(i => { if (dismissed[keyOf(i)] !== undefined) { i.status = "dismissed"; i.reason = dismissed[keyOf(i)]; } });
    const verified = local.verified.concat(prev ? prev.verified.filter(v => v.by && PP.norm(text).includes(PP.norm(v.excerpt))) : []);
    return {
      issues: PP.sortIssues(issues), verified, checkedText: text,
      fixed: prev ? prev.fixed : [],
      ai: prev ? Object.assign({}, prev.ai, { rewrite: prev.ai.rewrite && prev.checkedText === text ? prev.ai.rewrite : prev.ai.rewrite }) : { state: AI.enabled ? "idle" : "off" }
    };
  }
  function imageIssues() {
    const img = S.draft.image; if (!img || !img.pixels) return (img && img.issues) || [];
    const a = PP.analyseImage(img.pixels, S.kit, img.alt);
    img.issues = a.issues; img.dominant = a.dominant; return a.issues;
  }

  // What happens when you click "Check":
  // 1. rule + fact checks run instantly in the browser
  // 2. if AI is switched on, the AI review runs (runAI) and its answers are verified before being added
  async function runCheck() {
    const d = S.draft; const text = d.text.trim();
    if (!text && !d.image) { toast("Paste some content or upload a file first."); return; }
    d.result = localResult(d.text, null);
    S.stats.checks++;
    S.stats.lastCheckedAt = now();
    render();
    if (AI.enabled && text) await runAI();
    save(); render();
  }

  // Sends the text (with personal data masked) to our server function /api/check,
  // which asks Gemini. The answer is checked by verifyAI() in engine.js before anything is shown.
  // The suggested rewrites are re-checked by the rules so you can see how many problems they still have.
  async function runAI() {
    const d = S.draft, r = d.result; if (!r) return;
    const text = d.text; const masked = PP.maskPII(text);
    r.ai = { state: "running" }; render();
    try {
      const kit = S.kit;
      const res = await fetch("/api/check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: masked.text, contentType: d.type,
          kit: { brand: kit.brand, voice: kit.voice, messaging: kit.messaging, rules: kit.rules.map(x => ({ id: x.id, category: x.category, severity: x.severity, title: x.title, detail: x.detail, enabled: x.enabled })), glossary: kit.glossary },
          facts: PP.retrieveFacts(text, kit, 8),
          alreadyFound: r.issues.filter(i => i.excerpt).map(i => ({ ruleId: i.ruleId, excerpt: i.excerpt }))
        })
      });
      const data = await res.json();
      if (S.draft.result !== r) return; // a newer check started
      if (!data.ok) { r.ai = { state: "error", msg: data.error || "AI check failed." }; return; }
      const v = PP.verifyAI(data.ai, text, kit, PP.todayISO(), r.issues);
      v.issues.forEach(i => r.issues.push(i));
      r.issues = PP.sortIssues(r.issues);
      v.verified.forEach(x => r.verified.push(x));
      S.stats.aiChecks++; S.stats.aiDropped += v.dropped.length;
      const rw = data.ai.rewrite || {};
      const score = t => { const c = sevCount(PP.runLocal(t, kit, PP.todayISO()).issues.map(i => Object.assign(i, { status: "open" }))); return c; };
      r.ai = { state: "done", model: data.model, dropped: v.dropped.length, masked: masked.count + (data.masked || 0), added: v.issues.length,
        rewrite: { minimal: rw.minimal || "", full: rw.full || "", minimalScore: rw.minimal ? score(rw.minimal) : null, fullScore: rw.full ? score(rw.full) : null } };
    } catch (e) {
      r.ai = { state: "error", msg: "Couldn't reach the AI check. Rule and fact checks still ran." };
    }
  }

  // User clicked a fix button: change the text, remember the fix, and re-run the checks.
  function applyFixTo(issueKey, fixIndex) {
    const d = S.draft, r = d.result; const i = r.issues.find(x => x.key === issueKey); if (!i) return;
    const fix = i.fixes[fixIndex]; const before = d.text;
    d.text = PP.applyFix(d.text, i, fix.replacement);
    if (d.text === before) { toast("Couldn't find that text any more. Try checking again."); return; }
    r.fixed = (r.fixed || []).concat([{ ruleId: i.ruleId, excerpt: i.excerpt, replacement: fix.replacement, severity: i.severity, source: i.source, message: i.message, reference: i.reference }]);
    S.draft.result = localResult(d.text, r);
    save(); render();
    toast("Fixed: “" + i.excerpt + "”" + (fix.replacement ? " → “" + fix.replacement + "”" : " removed"));
  }

  // Saves the content as a new item (or a new version of an item that was sent back)
  // with all the check results, so the reviewer sees exactly what the creator saw.
  function submitDraft() {
    const d = S.draft, r = d.result; if (!r) return;
    const title = d.title.trim() || (d.text.trim().split(/\s+/).slice(0, 6).join(" ") + "…");
    const version = { text: d.text, at: now(), issues: clone(r.issues), fixed: clone(r.fixed || []), verified: clone(r.verified), aiUsed: r.ai && r.ai.state === "done",
      image: d.image ? { dataUrl: d.image.small || d.image.dataUrl, alt: d.image.alt, dominant: d.image.dominant } : null };
    let item = d.itemId && S.items.find(x => x.id === d.itemId);
    if (item) {
      version.v = item.versions.length + 1; item.versions.push(version); item.status = "in_review"; item.title = title; item.type = d.type;
      item.history.push({ at: now(), by: PEOPLE.creator, action: "Submitted version " + version.v });
    } else {
      version.v = 1;
      item = { id: uid(), title, type: d.type, status: "in_review", createdBy: PEOPLE.creator, createdAt: now(), versions: [version], comments: [], history: [{ at: now(), by: PEOPLE.creator, action: "Submitted version 1" }] };
      S.items.unshift(item);
    }
    S.draft = freshDraft(); S.selected = item.id; S.tab = "review"; save(); render();
    toast("Sent for review. Switch to “Arjun · Brand manager” at the top to approve it.");
  }

  // ---------- files ----------
  function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => no(new Error("Couldn't load " + src)); document.head.appendChild(s); }); }
  // Reads text out of uploaded files. PDF and Word readers are only downloaded when needed.
  async function readDocument(file) {
    const name = file.name.toLowerCase();
    if (/\.(txt|md|csv|html?)$/.test(name) || file.type.startsWith("text/")) {
      let t = await file.text(); if (/\.html?$/.test(name)) { const div = document.createElement("div"); div.innerHTML = t; t = div.innerText; } return t;
    }
    if (name.endsWith(".pdf")) {
      if (!window.pdfjsLib) { await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"); window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; }
      const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise; let out = [];
      for (let p = 1; p <= Math.min(pdf.numPages, 15); p++) { const c = await (await pdf.getPage(p)).getTextContent(); out.push(c.items.map(i => i.str + (i.hasEOL ? "\n" : " ")).join("")); }
      return out.join("\n\n").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
    }
    if (name.endsWith(".docx")) {
      if (!window.mammoth) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js");
      const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() }); return r.value.trim();
    }
    throw new Error("That file type isn't supported yet. Try .txt, .md, .pdf or .docx.");
  }
  // Reads an uploaded image into a small canvas so we can count its colours (engine.analyseImage).
  function readImage(file) {
    return new Promise((ok, no) => {
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 160 / Math.max(img.width, img.height));
          const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(img.width * scale)); c.height = Math.max(1, Math.round(img.height * scale));
          const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0, c.width, c.height);
          const pixels = Array.from(ctx.getImageData(0, 0, c.width, c.height).data);
          const s2 = Math.min(1, 480 / Math.max(img.width, img.height)); const c2 = document.createElement("canvas");
          c2.width = Math.round(img.width * s2); c2.height = Math.round(img.height * s2); c2.getContext("2d").drawImage(img, 0, 0, c2.width, c2.height);
          ok({ name: file.name, dataUrl: c2.toDataURL("image/jpeg", 0.8), small: c2.toDataURL("image/jpeg", 0.7), pixels, alt: "" });
        };
        img.onerror = () => no(new Error("Couldn't read that image."));
        img.src = fr.result;
      };
      fr.onerror = () => no(new Error("Couldn't read that file."));
      fr.readAsDataURL(file);
    });
  }

  // ---------- views ----------
  // VIEWS: each function below builds the HTML for one screen or one part of a screen.
  function issueCard(i, opts) {
    opts = opts || {};
    const done = i.status !== "open";
    const fixes = !done && !opts.readonly ? i.fixes.map((f, n) => `<button class="btn small primary" data-act="fix" data-key="${i.key}" data-n="${n}">${esc(f.label)}</button>`).join("") : "";
    let state = "";
    if (i.status === "dismissed") state = `<span class="state dismissed">Dismissed: “${esc(i.reason)}”</span>`;
    const dismiss = !done && !opts.readonly ? `<button class="btn small" data-act="dismiss" data-key="${i.key}">Dismiss…</button>` : "";
    const undo = i.status === "dismissed" && !opts.readonly ? `<button class="btn small ghost" data-act="undismiss" data-key="${i.key}">Undo</button>` : "";
    return `<div class="issue ${i.severity} ${done ? "done" : ""}" id="iss-${i.key}">
      <div class="head"><span class="sev ${i.severity}">${i.severity}</span><span class="src ${i.source === "AI check" ? "ai" : ""}">${esc(i.source === "Rule" ? "Rule check" : i.source)}</span>${i.target === "image" ? '<span class="src">Image</span>' : ""}<span class="ref">${esc(i.reference)}</span></div>
      ${i.excerpt ? `<div class="excerpt">“${esc(i.excerpt)}”</div>` : ""}
      <p class="msg">${esc(i.message)}</p>
      ${opts.extra || ""}
      <div class="actions">${fixes}${dismiss}${state}${undo}</div>
      <div class="dismiss-slot"></div>
    </div>`;
  }

  function highlight(text, issues) {
    const spans = [];
    issues.filter(i => i.status === "open" && i.excerpt && i.target !== "image").forEach(i => {
      let at = i.index >= 0 && text.slice(i.index, i.index + i.excerpt.length) === i.excerpt ? i.index : text.indexOf(i.excerpt);
      if (at < 0) at = text.toLowerCase().indexOf(i.excerpt.toLowerCase());
      if (at >= 0) spans.push({ a: at, b: at + i.excerpt.length, sev: i.severity, key: i.key });
    });
    spans.sort((x, y) => x.a - y.a || PP.SEV_ORDER[x.sev] - PP.SEV_ORDER[y.sev]);
    let out = "", pos = 0;
    for (const s of spans) { if (s.a < pos) continue; out += esc(text.slice(pos, s.a)) + `<mark class="${s.sev}" title="${s.sev}">` + esc(text.slice(s.a, s.b)) + "</mark>"; pos = s.b; }
    return out + esc(text.slice(pos));
  }

  function viewIntro() {
    if (S.introHidden) return "";
    return `<section class="intro" aria-label="Quick start">
      <div><h1>Check content before it goes live.</h1><p>Demo workspace for <b>Kitebird Money</b>, a made-up savings app with a ready-made brand kit.</p>
        <p class="promise">✓ Every number is checked against approved facts by code. The AI can’t pass a claim on its own.</p></div>
      <ol>
        <li>Click <b>Risky LinkedIn post</b> below, then <b>Check</b></li>
        <li>Read why each issue was flagged and which rule it breaks</li>
        <li>Apply fixes or dismiss with a reason, then <b>Submit for review</b></li>
        <li>Switch to <b>Arjun · Brand manager</b> (top right) to approve</li>
      </ol>
      <button class="close" data-act="hide-intro" aria-label="Hide quick start">Got it</button>
    </section>`;
  }

  // Screen 1: write or upload content, run the check, see the results, fix, submit.
  function viewCheck() {
    const d = S.draft, r = d.result;
    const editingItem = d.itemId && S.items.find(x => x.id === d.itemId);
    const stale = r && r.checkedText !== d.text;
    const openBlockers = r ? r.issues.filter(i => i.status === "open" && i.severity === "blocker").length : 0;
    const left = `<section class="card" aria-labelledby="h-write">
      <h2 id="h-write">${editingItem ? "Revising: " + esc(editingItem.title) + ` <span class="status changes_requested">version ${editingItem.versions.length + 1}</span>` : "1. Add your content"}</h2>
      ${editingItem ? `<div class="status-line">Reviewer feedback: “${esc((editingItem.comments.filter(c => c.by === PEOPLE.reviewer).slice(-1)[0] || {}).text || "")}” <button class="btn small ghost" data-act="cancel-revise">Cancel revision</button></div>` : ""}
      <div class="row"><span class="hint">Try a sample:</span><div class="chips">${KIT.SAMPLES.map((s, n) => `<button class="chip" data-act="sample" data-n="${n}">${esc(s.label)}</button>`).join("")}</div></div>
      <div class="row" style="margin-top:6px">
        <div style="flex:1;min-width:160px"><label class="field" for="type">Content type</label><select id="type" data-bind="type">${TYPES.map(t => `<option ${t === d.type ? "selected" : ""}>${t}</option>`).join("")}</select></div>
        <div style="flex:2;min-width:200px"><label class="field" for="title">Title (for the review queue)</label><input id="title" type="text" data-bind="title" value="${esc(d.title)}" placeholder="e.g. Friday savings post"></div>
      </div>
      <label class="field" for="text">Text</label>
      <textarea id="text" data-bind="text" placeholder="Paste a post, ad, email or web copy here…">${esc(d.text)}</textarea>
      <div class="row" style="margin-top:10px">
        <div class="drop" style="flex:1;min-width:220px"><label for="doc"><b>Or upload a document</b> (.pdf, .docx, .txt)</label><br><input id="doc" type="file" accept=".pdf,.docx,.txt,.md,.html" data-act="doc"></div>
        <div class="drop" style="flex:1;min-width:220px"><label for="img"><b>Add an image</b> (checks colours, contrast, alt text)</label><br><input id="img" type="file" accept="image/*" data-act="img"></div>
      </div>
      ${d.image ? `<div class="img-preview"><img src="${d.image.dataUrl}" alt="${esc(d.image.alt || "Uploaded image preview")}"><div style="flex:1"><label class="field" for="alt">Alt text for this image</label><input id="alt" type="text" data-bind="alt" value="${esc(d.image.alt)}" placeholder="Describe the image for screen-reader users"><div class="swatches">${(d.image.dominant || []).map(c => `<span class="swatch ${c.onBrand ? "" : "bad"}"><i style="background:${c.hex}"></i>${c.hex} · ${Math.round(c.share * 100)}%${c.onBrand ? " · " + esc(c.nearest.name) : " · off-palette"}</span>`).join("")}</div><button class="btn small ghost" data-act="remove-img">Remove image</button></div></div>` : ""}
      <div class="row" style="margin-top:14px">
        <button class="btn primary" data-act="check">${r ? "Check again" : "Check against brand kit"}</button>
        ${d.text || d.image ? '<button class="btn ghost" data-act="clear">Clear</button>' : ""}
        <span class="hint">${AI.enabled ? "Rules + fact library + AI review" : "Rules + fact library (AI check not configured)"}</span>
      </div>
      ${r && d.text ? `<h3>Preview with highlights</h3><div class="preview" aria-label="Your text with flagged words highlighted">${highlight(d.text, r.issues)}</div>` : ""}
    </section>`;

    let right;
    if (!r) {
      right = `<section class="card" aria-labelledby="h-res"><h2 id="h-res">2. Results</h2><div class="empty"><div class="big" aria-hidden="true">▪</div><p>Results show up here. Every flag tells you what's wrong, why, and which rule or approved fact it comes from.</p><p class="hint">Every number is checked against approved facts by code, so the AI can\u2019t pass a claim on its own. PixelProof never edits or publishes anything without your click.</p></div></section>`;
    } else {
      const c = sevCount(r.issues);
      const total = c.blocker + c.warning + c.suggestion;
      const ai = r.ai || {};
      let aiLine = "";
      if (ai.state === "running") aiLine = `<div class="status-line ai-run" role="status">AI review running… rule and fact checks are already shown below.</div>`;
      else if (ai.state === "done") aiLine = `<div class="status-line ai-run">AI review by ${esc(ai.model)} added ${ai.added} finding${ai.added === 1 ? "" : "s"}${ai.dropped ? `; ${ai.dropped} AI answer${ai.dropped === 1 ? " was" : "s were"} thrown out because ${ai.dropped === 1 ? "it" : "they"} didn't match the text or a real rule` : ""}.${ai.masked ? ` ${ai.masked} personal detail${ai.masked === 1 ? " was" : "s were"} masked before sending.` : ""}</div>`;
      else if (ai.state === "error") aiLine = `<div class="status-line">${esc(ai.msg)} <button class="btn small" data-act="retry-ai">Try AI review again</button></div>`;
      else if (!AI.enabled) aiLine = `<div class="status-line">Rules-only mode: the AI check isn't configured on this deployment, so tone is checked by rules only.</div>`;
      const open = r.issues.filter(i => i.status === "open"), closed = r.issues.filter(i => i.status !== "open");
      const rw = ai.rewrite && (ai.rewrite.minimal || ai.rewrite.full) ? `<h3>Suggested rewrites (AI, then re-checked by rules)</h3>
        ${["minimal", "full"].filter(k => ai.rewrite[k]).map(k => { const sc = ai.rewrite[k + "Score"]; return `<div class="rewrite"><b>${k === "minimal" ? "Minimal fix" : "Fuller on-brand rewrite"}</b> <span class="hint">· re-check: ${sc ? `${sc.blocker} blockers, ${sc.warning} warnings` : ""}</span><p>${esc(ai.rewrite[k])}</p><button class="btn small" data-act="use-rewrite" data-k="${k}">Use this version</button></div>`; }).join("")}` : "";
      right = `<section class="card" aria-labelledby="h-res"><h2 id="h-res">2. Results</h2>
        ${stale ? `<div class="status-line">You've edited the text since the last check. <button class="btn small primary" data-act="check">Check again</button></div>` : ""}
        <div class="summary">${total === 0 ? '<span class="pill ok">No open issues</span>' : ""}<span class="pill blocker">${c.blocker} blocker${c.blocker === 1 ? "" : "s"}</span><span class="pill warning">${c.warning} warning${c.warning === 1 ? "" : "s"}</span><span class="pill suggestion">${c.suggestion} suggestion${c.suggestion === 1 ? "" : "s"}</span>${(r.fixed || []).length ? `<span class="pill ok">${r.fixed.length} fixed</span>` : ""}</div>
        ${aiLine}
        ${open.map(i => issueCard(i)).join("") || (total === 0 ? `<p class="hint">Nothing left to fix. You can submit this for review.</p>` : "")}
        ${r.verified.length ? `<h3>Claims checked against approved facts</h3>${r.verified.map(v => `<div class="verified"><b>✓ “${esc(v.excerpt)}”</b> is backed by ${esc(v.factId)}: “${esc(v.fact)}” <span class="hint">Source: ${esc(v.source)} · valid until ${esc(v.expires)}${v.by ? " · " + esc(v.by) : ""}</span></div>`).join("")}` : ""}
        ${rw}
        ${closed.length ? `<h3>Dismissed</h3>${closed.map(i => issueCard(i)).join("")}` : ""}
        ${(r.fixed || []).length ? `<h3>Fixed so far</h3>${r.fixed.map(f => `<div class="hint">✓ ${esc(f.reference)}: “${esc(f.excerpt)}” ${f.replacement ? "→ “" + esc(f.replacement) + "”" : "removed"}</div>`).join("")}` : ""}
        <div class="submit-bar">
          <button class="btn dark" data-act="submit" ${openBlockers || stale ? "disabled" : ""}>${editingItem ? "Resubmit for review" : "Submit for review"}</button>
          <span class="hint">${stale ? "Check again before submitting." : openBlockers ? `Fix or dismiss ${openBlockers} blocker${openBlockers === 1 ? "" : "s"} (with a reason) to submit.` : "A reviewer makes the final call. Warnings left open will be visible to them."}</span>
        </div>
      </section>`;
    }
    return viewIntro() + `<div class="grid">${left}${right}</div>`;
  }

  // Screen 2: the review queue. Reviewers approve or request changes; creators revise.
  function viewReview() {
    const items = S.items;
    const sel = items.find(x => x.id === S.selected) || items[0];
    const list = items.map(it => `<button class="qitem" data-act="select" data-id="${it.id}" aria-current="${sel && it.id === sel.id}">
      <div class="row" style="justify-content:space-between"><span class="t">${esc(it.title)}</span><span class="status ${it.status}">${it.status.replace("_", " ")}</span></div>
      <div class="m">${esc(it.type)} · v${it.versions.length} · ${when(it.versions[it.versions.length - 1].at)}</div></button>`).join("");
    let detail = `<div class="card empty">Nothing submitted yet.</div>`;
    if (sel) {
      const v = sel.versions[sel.versions.length - 1], prev = sel.versions[sel.versions.length - 2];
      const c = sevCount(v.issues);
      const dismissed = v.issues.filter(i => i.status === "dismissed");
      const openIssues = v.issues.filter(i => i.status === "open");
      const reviewerBtns = isReviewer() && sel.status === "in_review" ? `<div class="row" style="margin-top:12px"><input type="text" id="rcomment" placeholder="Comment for Riya (required when requesting changes)" style="flex:1;min-width:220px"><button class="btn primary" data-act="approve" data-id="${sel.id}">Approve</button><button class="btn" data-act="changes" data-id="${sel.id}">Request changes</button></div>` : "";
      const creatorBtns = !isReviewer() && sel.status === "changes_requested" ? `<div class="row" style="margin-top:12px"><button class="btn primary" data-act="revise" data-id="${sel.id}">Revise in checker</button><span class="hint">Opens version ${sel.versions.length + 1} with the reviewer's comment.</span></div>` : "";
      const roleNote = !isReviewer() && sel.status === "in_review" ? `<div class="status-line">Waiting for the brand manager. To try approving, switch to <b>Arjun · Brand manager</b> at the top.</div>` : "";
      const approvedNote = sel.status === "approved" ? `<div class="status-line" style="background:var(--ok-bg);color:var(--ok)">Approved. Ready to publish. PixelProof doesn't publish anything itself: copy the final text into your channel. <button class="btn small" data-act="copy" data-id="${sel.id}">Copy text</button></div>` : "";
      detail = `<section class="card" aria-labelledby="h-item">
        <h2 id="h-item">${esc(sel.title)} <span class="status ${sel.status}">${sel.status.replace("_", " ")}</span></h2>
        <div class="hint">${esc(sel.type)} · by ${esc(sel.createdBy)} · version ${v.v} · ${v.aiUsed ? "rules + facts + AI" : "rules + facts"}</div>
        ${roleNote}${approvedNote}
        <h3>${prev ? "Changes since version " + prev.v : "Content"}</h3>
        <div class="diff">${prev ? PP.diffWords(prev.text, v.text).map(p => p.t === "same" ? esc(p.s) : p.t === "add" ? "<ins>" + esc(p.s) + "</ins>" : "<del>" + esc(p.s) + "</del>").join("") : esc(v.text)}</div>
        ${v.image ? `<div class="img-preview"><img src="${v.image.dataUrl}" alt="${esc(v.image.alt || "Submitted image (no alt text given)")}"><div class="hint">Alt text: ${v.image.alt ? "“" + esc(v.image.alt) + "”" : "<b>missing</b>"}</div></div>` : ""}
        <h3>Check results at submission</h3>
        <div class="summary"><span class="pill blocker">${c.blocker} open blockers</span><span class="pill warning">${c.warning} open warnings</span><span class="pill suggestion">${c.suggestion} open suggestions</span><span class="pill ok">${(v.fixed || []).length} fixed by creator</span><span class="pill ok">${v.verified.length} claims verified</span></div>
        ${dismissed.length ? `<h3>Flags the creator dismissed</h3>${dismissed.map(i => `<div class="decision"><span class="sev ${i.severity}">${i.severity}</span><b>${esc(i.reference)}</b> “${esc(i.excerpt)}” — reason: “${esc(i.reason)}” ${i.review ? `<span class="tag">${i.review === "accepted" ? "Reviewer agreed" : "Reviewer disagreed"}</span>` : isReviewer() && sel.status === "in_review" ? `<button class="btn small" data-act="agree" data-id="${sel.id}" data-key="${i.key}">Agree</button><button class="btn small" data-act="disagree" data-id="${sel.id}" data-key="${i.key}">Disagree</button>` : ""}</div>`).join("")}` : ""}
        ${openIssues.length ? `<h3>Still open</h3>${openIssues.map(i => `<div class="decision"><span class="sev ${i.severity}">${i.severity}</span><b>${esc(i.reference)}</b> ${i.excerpt ? "“" + esc(i.excerpt) + "”" : ""} <span class="hint">${esc(i.message)}</span> ${i.override ? `<span class="tag">OK'd by reviewer: ${esc(i.override)}</span>` : isReviewer() && sel.status === "in_review" ? `<button class="btn small" data-act="override" data-id="${sel.id}" data-key="${i.key}">OK to publish</button>` : ""}</div>`).join("")}` : ""}
        ${(v.fixed || []).length ? `<h3>Fixed by the creator</h3>${v.fixed.map(f => `<div class="hint">✓ ${esc(f.reference)}: “${esc(f.excerpt)}” ${f.replacement ? "→ “" + esc(f.replacement) + "”" : "removed"}</div>`).join("")}` : ""}
        ${v.verified.length ? `<h3>Verified claims</h3>${v.verified.map(x => `<div class="verified"><b>✓ “${esc(x.excerpt)}”</b> ← ${esc(x.factId)}: ${esc(x.fact)}</div>`).join("")}` : ""}
        ${reviewerBtns}${creatorBtns}
        <h3>Comments</h3>
        ${sel.comments.map(cm => `<div class="comment"><div class="by">${esc(cm.by)} · ${when(cm.at)}</div>${esc(cm.text)}</div>`).join("") || '<p class="hint">No comments yet.</p>'}
        <div class="row"><input type="text" id="newcomment" placeholder="Add a comment as ${esc(PEOPLE[S.role])}" style="flex:1;min-width:200px"><button class="btn" data-act="comment" data-id="${sel.id}">Comment</button></div>
        <h3>History</h3>
        <ul class="timeline">${sel.history.slice().reverse().map(h => `<li><b>${esc(h.action)}</b> · ${esc(h.by)} · ${when(h.at)}</li>`).join("")}</ul>
      </section>`;
    }
    return `<div class="queue"><section aria-label="Submitted content"><div class="row" style="justify-content:space-between;margin-bottom:8px"><b>Submitted content</b><span class="hint">Viewing as ${esc(PEOPLE[S.role])}</span></div>${list}</section>${detail}</div>`;
  }

  // Screen 3: the brand kit (voice, glossary, facts, palette, rules). Only the brand manager can edit.
  function viewKit() {
    const k = S.kit, edit = isReviewer(), today = PP.todayISO();
    const soon = d => { const days = (new Date(d) - new Date(today)) / 864e5; return days >= 0 && days <= 60; };
    const ro = edit ? "" : `<div class="status-line">You're viewing as a creator, so the brand kit is read-only. Switch to <b>Arjun · Brand manager</b> to edit it.</div>`;
    return `${ro}
    <div class="grid">
      <section class="card"><h2>Brand voice · ${esc(k.brand)}</h2>
        ${edit ? `<label class="field" for="voice">Voice summary</label><textarea id="voice" data-kit="voice" style="min-height:70px">${esc(k.voice.summary)}</textarea>` : `<p>${esc(k.voice.summary)}</p>`}
        <h3>Do</h3><ul>${k.voice.do.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
        <h3>Don't</h3><ul>${k.voice.dont.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
        <h3>Key messages</h3><ul>${k.messaging.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
        <h3>Visual identity: palette</h3>
        <div class="swatches">${k.palette.map((p, n) => `<span class="swatch"><i style="background:${esc(p.hex)}"></i>${esc(p.name)} ${esc(p.hex)}${edit ? ` <button class="btn small ghost" data-act="del-pal" data-n="${n}" aria-label="Remove ${esc(p.name)}">×</button>` : ""}</span>`).join("")}</div>
        ${edit ? `<div class="row" style="margin-top:8px"><input type="text" id="palName" placeholder="Colour name" style="flex:1"><input type="text" id="palHex" placeholder="#RRGGBB" style="width:110px"><button class="btn small" data-act="add-pal">Add colour</button></div>` : ""}
        ${edit ? `<h3>Manage</h3><div class="row"><button class="btn small" data-act="export-kit">Export brand kit (JSON)</button><label class="btn small" for="importKit">Import JSON</label><input id="importKit" type="file" accept=".json" data-act="import-kit" class="sr-only"><button class="btn small ghost" data-act="reset">Reset demo data</button></div>` : ""}
      </section>
      <section class="card"><h2>Glossary</h2>
        <table class="kit"><thead><tr><th>Use</th><th>Avoid</th><th>Why</th>${edit ? "<th></th>" : ""}</tr></thead><tbody>
        ${k.glossary.map((g, n) => `<tr><td class="id">${esc(g.use)}</td><td>${g.avoid.map(esc).join(", ")}</td><td>${esc(g.note)}</td>${edit ? `<td><button class="btn small ghost" data-act="del-gl" data-n="${n}" aria-label="Delete">×</button></td>` : ""}</tr>`).join("")}</tbody></table>
        ${edit ? `<div class="kit-form"><div><label class="field" for="glUse">Use</label><input id="glUse" type="text" placeholder="Savings Pot"></div><div><label class="field" for="glAvoid">Avoid (comma separated)</label><input id="glAvoid" type="text"></div><div><label class="field" for="glNote">Why</label><input id="glNote" type="text"></div><button class="btn small" data-act="add-gl">Add</button></div>` : ""}
      </section>
    </div>
    <section class="card" style="margin-top:20px"><h2>Approved facts</h2>
      <p class="hint">Every number or claim in content must match one of these. Expired facts are rejected automatically.</p>
      <table class="kit"><thead><tr><th>ID</th><th>Fact</th><th>Source</th><th>Valid until</th>${edit ? "<th></th>" : ""}</tr></thead><tbody>
      ${k.facts.map((f, n) => `<tr><td class="id">${esc(f.id)}</td><td>${esc(f.text)}</td><td>${esc(f.source)}<br><span class="hint">${esc(f.owner || "")}</span></td><td>${esc(f.expires)} ${PP.isExpired(f, today) ? '<span class="tag exp">expired</span>' : soon(f.expires) ? '<span class="tag soon">expires soon</span>' : ""}</td>${edit ? `<td><button class="btn small ghost" data-act="del-fact" data-n="${n}" aria-label="Delete">×</button></td>` : ""}</tr>`).join("")}</tbody></table>
      ${edit ? `<div class="kit-form"><div><label class="field" for="fText">New fact</label><input id="fText" type="text" placeholder="e.g. Savers can withdraw any time with no penalty."></div><div><label class="field" for="fSrc">Source</label><input id="fSrc" type="text"></div><div><label class="field" for="fExp">Valid until</label><input id="fExp" type="date"></div><button class="btn small" data-act="add-fact">Add fact</button></div>` : ""}
    </section>
    <section class="card" style="margin-top:20px"><h2>Rules</h2>
      <table class="kit"><thead><tr><th>ID</th><th>Rule</th><th>Area</th><th>Severity</th><th>On</th></tr></thead><tbody>
      ${k.rules.map((r, n) => `<tr class="${r.enabled === false ? "off" : ""}"><td class="id">${esc(r.id)}</td><td><b>${esc(r.title)}</b><br><span class="hint">${esc(r.detail)}</span></td><td>${esc(r.category)}</td>
        <td>${edit ? `<select data-act="sev" data-n="${n}" aria-label="Severity for ${esc(r.id)}">${["blocker", "warning", "suggestion"].map(s => `<option ${s === r.severity ? "selected" : ""}>${s}</option>`).join("")}</select>` : `<span class="sev ${r.severity}">${r.severity}</span>`}</td>
        <td>${edit ? `<input type="checkbox" data-act="toggle-rule" data-n="${n}" ${r.enabled === false ? "" : "checked"} aria-label="Rule ${esc(r.id)} on">` : (r.enabled === false ? "off" : "on")}</td></tr>`).join("")}</tbody></table>
    </section>`;
  }

  // Screen 4: insights worked out from everything submitted (common issues, rules people push back on).
  function viewInsights() {
    const all = []; S.items.forEach(it => it.versions.forEach(v => v.issues.concat((v.fixed || []).map(f => Object.assign({ status: "fixed" }, f))).forEach(i => all.push(i))));
    const by = (arr, f) => { const m = {}; arr.forEach(x => { const k = f(x); if (k) m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
    const ruleTitle = id => { const r = S.kit.rules.find(x => x.id === id); if (r) return id + " · " + r.title; const g = S.kit.glossary.find(x => x.id === id); return g ? id + " · Glossary: " + g.use : id; };
    const byRule = by(all, i => i.ruleId).slice(0, 8);
    const max = byRule.length ? byRule[0][1] : 1;
    const push = {}; S.items.forEach(it => it.versions.forEach(v => v.issues.forEach(i => {
      if (i.status === "dismissed") { push[i.ruleId] = push[i.ruleId] || { d: 0, dis: 0, ov: 0, reasons: [] }; push[i.ruleId].d++; push[i.ruleId].reasons.push(i.reason); if (i.review === "rejected") push[i.ruleId].dis++; }
      if (i.override) { push[i.ruleId] = push[i.ruleId] || { d: 0, dis: 0, ov: 0, reasons: [] }; push[i.ruleId].ov++; push[i.ruleId].reasons.push("Reviewer OK'd: " + i.override); }
    })));
    const pushList = Object.entries(push).sort((a, b) => (b[1].d + b[1].ov) - (a[1].d + a[1].ov));
    const approved = S.items.filter(i => i.status === "approved").length;
    const today = PP.todayISO();
    const expiring = S.kit.facts.filter(f => { const days = (new Date(f.expires) - new Date(today)) / 864e5; return days <= 60; });
    return `<div class="stats">
        <div class="stat"><div class="n">${S.stats.checks}</div><div class="l">checks run in this browser</div></div>
        <div class="stat"><div class="n">${S.items.length}</div><div class="l">pieces submitted</div></div>
        <div class="stat"><div class="n">${approved}</div><div class="l">approved</div></div>
        <div class="stat"><div class="n">${all.length}</div><div class="l">issues found in submitted work</div></div>
      </div>
      <div class="grid">
        <section class="card"><h2>Most common issues</h2>
          ${byRule.map(([id, n]) => `<div class="bar"><span>${esc(ruleTitle(id))}</span><div class="track"><div class="fill" style="width:${(n / max) * 100}%"></div></div><b>${n}</b></div>`).join("") || '<p class="hint">No data yet.</p>'}
          <h3>By area</h3>
          ${by(all, i => i.category).map(([c, n]) => `<div class="bar"><span>${esc(c)}</span><div class="track"><div class="fill alt" style="width:${(n / Math.max(1, all.length)) * 100}%"></div></div><b>${n}</b></div>`).join("")}
        </section>
        <section class="card"><h2>Rules people push back on</h2>
          <p class="hint">When creators keep dismissing a rule, or reviewers keep overriding it, the rule may be unclear. (Early version: the full guideline gap detector with suggested rewording is planned for Round 3.)</p>
          ${pushList.map(([id, p]) => `<div class="flag"><b>${esc(ruleTitle(id))}</b>: dismissed ${p.d}×${p.ov ? `, overridden ${p.ov}×` : ""}${p.dis ? `, reviewer disagreed ${p.dis}×` : ""}${(p.d + p.ov) >= 2 ? ' <span class="tag soon">may be unclear</span>' : ""}<br><span class="hint">Reasons given: ${p.reasons.map(r => "“" + esc(r) + "”").join("; ")}</span></div>`).join("") || '<p class="hint">No dismissals yet.</p>'}
          <h3>Facts to update</h3>
          ${expiring.map(f => `<div class="flag"><b>${esc(f.id)}</b> ${PP.isExpired(f, today) ? "expired on" : "expires on"} ${esc(f.expires)}: “${esc(f.text)}”</div>`).join("") || '<p class="hint">All facts are current.</p>'}
        </section>
      </div>`;
  }

  function viewAbout() {
    return `<section class="card prose"><h2>How PixelProof checks content</h2>
      <p>Content goes in before it's published. PixelProof checks it against the brand kit and every issue comes back with the rule it breaks and a suggested fix. A person always makes the final call.</p>
      <div class="layer"><div class="num">1</div><div><b>Rule checks.</b> Exact checks for banned or pushy phrases, wrong product names, guarantees, competitor names, link text, emoji overload, all caps, long sentences and hashtags. Instant and repeatable: the same text always gets the same result.</div></div>
      <div class="layer"><div class="num">2</div><div><b>Fact checks.</b> Every number and ranking is matched against the approved fact library. If a figure doesn't match, comes from an expired fact or has no source, it's a blocker. This is done in code, not by the AI.</div></div>
      <div class="layer"><div class="num">3</div><div><b>AI review</b> (when configured). Checks tone, voice and messaging, finds non-numeric claims, and suggests rewrites. Before anything is shown, code checks the AI's answer: the quoted words must be in your text, the rule must exist, and a "supported" claim must quote a real, unexpired fact. Anything that fails is thrown out or treated as unsupported. Rewrites are re-checked by the rules.</div></div>
      <div class="layer"><div class="num">4</div><div><b>Visual checks.</b> Uploaded images are analysed in your browser: main colours are compared with the brand palette, the two main colours are checked for contrast, and alt text is required.</div></div>
      <h3>AI use and privacy</h3>
      <ul>
        <li>AI provider: ${AI.enabled ? esc(AI.provider + " (" + AI.model + ")") : "none configured on this deployment, so PixelProof runs in rules-only mode"}.</li>
        <li>Emails, phone numbers, PAN and ID-style numbers are masked before any text is sent to the AI, both in the browser and again on the server.</li>
        <li>The API key stays on the server and is never sent to the browser.</li>
        <li>Findings from the AI are labelled “AI check”. Findings from rules are labelled “Rule check” or “Fact check”.</li>
        <li>This demo stores everything in your browser (localStorage). Nothing is kept on a server. Use “Reset demo data” in the brand kit to start fresh.</li>
        <li>PixelProof can be wrong. It never edits or publishes anything without a person clicking.</li>
      </ul>
      <h3>Demo notes</h3>
      <ul>
        <li>Kitebird Money, its partner bank and its brand kit are made up.</li>
        <li>Switch between <b>Riya · Creator</b> and <b>Arjun · Brand manager</b> at the top to try both sides of the review.</li>
        <li>Built by Team Pixel (Akshay Singh) for CodeNova India 2026. AI assistance was used in building this and is disclosed in the project README.</li>
      </ul></section>`;
  }

  // ---------- render ----------
  // Draws the current screen. Called after every change.
  function render() {
    document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
    document.querySelectorAll(".role button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.role === S.role)));
    const pending = S.items.filter(i => S.role === "reviewer" ? i.status === "in_review" : i.status === "changes_requested").length;
    const qc = document.getElementById("queueCount"); qc.hidden = !pending; qc.textContent = pending;
    const badge = document.getElementById("aiBadge");
    if (AI.checked) { badge.className = "badge " + (AI.enabled ? "on" : "off"); badge.textContent = AI.enabled ? "AI review on" : "Rules-only mode"; }
    const focusId = document.activeElement && document.activeElement.id; const caret = document.activeElement && document.activeElement.selectionStart;
    $app.innerHTML = ({ check: viewCheck, review: viewReview, kit: viewKit, insights: viewInsights, about: viewAbout }[S.tab] || viewCheck)();
    if (focusId) { const el = document.getElementById(focusId); if (el && el.tagName !== "BUTTON") { el.focus(); try { if (caret != null) el.setSelectionRange(caret, caret); } catch (e) { /* not a text input */ } } }
  }

  // ---------- events ----------
  // EVENTS: what happens when the user clicks, types or uploads something.
  document.querySelector("nav.tabs").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (!b) return; S.tab = b.dataset.tab; save(); render(); window.scrollTo(0, 0); });
  document.querySelector(".role").addEventListener("click", e => {
    const b = e.target.closest("button[data-role]"); if (!b) return; S.role = b.dataset.role;
    if (S.role === "reviewer" && S.tab === "check") { const p = S.items.find(i => i.status === "in_review"); if (p) { S.selected = p.id; } }
    save(); render(); toast("Now viewing as " + PEOPLE[S.role]);
  });

  $app.addEventListener("input", e => {
    const t = e.target, b = t.dataset.bind;
    if (b === "text" || b === "title") { S.draft[b] = t.value; save(); if (b === "text" && S.draft.result) { clearTimeout(window.__ppT); window.__ppT = setTimeout(render, 500); } }
    if (b === "alt" && S.draft.image) { S.draft.image.alt = t.value; save(); }
    if (t.dataset.kit === "voice") { S.kit.voice.summary = t.value; save(); }
  });
  $app.addEventListener("change", async e => {
    const t = e.target;
    if (t.dataset.bind === "type") { S.draft.type = t.value; save(); }
    if (t.dataset.bind === "alt" && S.draft.result) { S.draft.result = localResult(S.draft.text, S.draft.result); save(); render(); }
    if (t.dataset.act === "doc" && t.files[0]) {
      const f = t.files[0]; toast("Reading " + f.name + "…");
      try { const text = await readDocument(f); S.draft.text = text; S.draft.type = "Document"; if (!S.draft.title) S.draft.title = f.name.replace(/\.[^.]+$/, ""); S.draft.result = null; save(); render(); await runCheck(); }
      catch (err) { toast(err.message); }
    }
    if (t.dataset.act === "img" && t.files[0]) {
      try { S.draft.image = await readImage(t.files[0]); imageIssues(); if (S.draft.result) S.draft.result = localResult(S.draft.text, S.draft.result); save(); render(); toast("Image added. Add alt text, then check."); }
      catch (err) { toast(err.message); }
    }
    if (t.dataset.act === "import-kit" && t.files[0]) {
      try { const k = JSON.parse(await t.files[0].text()); if (!k.rules || !k.facts || !k.glossary) throw new Error("bad"); S.kit = k; save(); render(); toast("Brand kit imported."); }
      catch (err) { toast("That doesn't look like a PixelProof brand kit file."); }
    }
    if (t.dataset.act === "sev") { S.kit.rules[+t.dataset.n].severity = t.value; save(); render(); }
    if (t.dataset.act === "toggle-rule") { S.kit.rules[+t.dataset.n].enabled = t.checked; save(); render(); }
  });

  $app.addEventListener("click", async e => {
    const b = e.target.closest("[data-act]"); if (!b || b.tagName === "INPUT" || b.tagName === "SELECT") return;
    const act = b.dataset.act, d = S.draft;
    const item = b.dataset.id && S.items.find(x => x.id === b.dataset.id);
    const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
    switch (act) {
      case "hide-intro": S.introHidden = true; break;
      case "sample": { const s = KIT.SAMPLES[+b.dataset.n]; d.text = s.text; d.type = s.type; d.title = s.title; d.result = null; break; }
      case "check": await runCheck(); return;
      case "retry-ai": if (d.result && AI.enabled) { await runAI(); save(); render(); } return;
      case "clear": S.draft = Object.assign(freshDraft(), { itemId: d.itemId }); break;
      case "remove-img": d.image = null; if (d.result) d.result = localResult(d.text, d.result); break;
      case "fix": applyFixTo(b.dataset.key, +b.dataset.n); return;
      case "dismiss": {
        const slot = b.closest(".issue").querySelector(".dismiss-slot");
        slot.innerHTML = `<div class="dismiss-form"><input type="text" placeholder="Why is this OK? (required)" aria-label="Reason for dismissing"><button class="btn small dark" data-act="dismiss-ok" data-key="${b.dataset.key}">Dismiss</button></div>`;
        slot.querySelector("input").focus(); return;
      }
      case "dismiss-ok": {
        const input = b.parentElement.querySelector("input"); const reason = input.value.trim();
        if (reason.length < 4) { input.focus(); toast("Please give a short reason. Reviewers see it."); return; }
        const i = d.result.issues.find(x => x.key === b.dataset.key); if (i) { i.status = "dismissed"; i.reason = reason; }
        break;
      }
      case "undismiss": { const i = d.result.issues.find(x => x.key === b.dataset.key); if (i) { i.status = "open"; delete i.reason; } break; }
      case "use-rewrite": { const k = b.dataset.k; d.text = d.result.ai.rewrite[k]; d.result = null; save(); render(); await runCheck(); toast("Rewrite applied and re-checked."); return; }
      case "submit": submitDraft(); return;
      case "cancel-revise": S.draft = freshDraft(); break;
      case "select": S.selected = b.dataset.id; break;
      case "approve": {
        const txt = val("rcomment"); item.status = "approved"; if (txt) item.comments.push({ by: PEOPLE.reviewer, at: now(), text: txt });
        item.history.push({ at: now(), by: PEOPLE.reviewer, action: "Approved version " + item.versions.length }); toast("Approved. The creator can now publish it."); break;
      }
      case "changes": {
        const txt = val("rcomment"); if (!txt) { toast("Add a comment so the creator knows what to change."); document.getElementById("rcomment").focus(); return; }
        item.status = "changes_requested"; item.comments.push({ by: PEOPLE.reviewer, at: now(), text: txt });
        item.history.push({ at: now(), by: PEOPLE.reviewer, action: "Requested changes" }); toast("Sent back to the creator. Switch to Riya to revise it."); break;
      }
      case "agree": case "disagree": {
        const v = item.versions[item.versions.length - 1]; const i = v.issues.find(x => x.key === b.dataset.key);
        if (i) { i.review = act === "agree" ? "accepted" : "rejected"; item.history.push({ at: now(), by: PEOPLE.reviewer, action: (act === "agree" ? "Agreed with" : "Disagreed with") + " dismissal of " + i.ruleId }); }
        break;
      }
      case "override": {
        const v = item.versions[item.versions.length - 1]; const i = v.issues.find(x => x.key === b.dataset.key);
        const reason = val("rcomment") || "Fine for this piece";
        if (i) { i.override = reason; item.history.push({ at: now(), by: PEOPLE.reviewer, action: "Marked " + i.ruleId + " OK to publish (" + reason + ")" }); }
        break;
      }
      case "revise": {
        const v = item.versions[item.versions.length - 1];
        S.draft = { itemId: item.id, type: item.type, title: item.title, text: v.text, image: null, result: null };
        S.tab = "check"; save(); render(); await runCheck(); return;
      }
      case "comment": { const txt = val("newcomment"); if (!txt) return; item.comments.push({ by: PEOPLE[S.role], at: now(), text: txt }); break; }
      case "copy": { const v = item.versions[item.versions.length - 1]; try { await navigator.clipboard.writeText(v.text); toast("Copied."); } catch (err) { toast("Couldn't copy automatically. Select the text instead."); } return; }
      case "add-gl": { const use = val("glUse"), avoid = val("glAvoid"); if (!use || !avoid) { toast("Fill in both “Use” and “Avoid”."); return; }
        S.kit.glossary.push({ id: "G-" + (S.kit.glossary.length + 1), use, avoid: avoid.split(",").map(x => x.trim()).filter(Boolean), note: val("glNote") }); toast("Glossary term added."); break; }
      case "del-gl": S.kit.glossary.splice(+b.dataset.n, 1); break;
      case "add-fact": { const text = val("fText"); if (!text) { toast("Write the fact first."); return; } const n = S.kit.facts.length + 1;
        S.kit.facts.push({ id: "F-" + String(n).padStart(2, "0"), text, source: val("fSrc") || "Added by brand manager", owner: "Brand team", expires: val("fExp") || new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10) }); toast("Fact added to the library."); break; }
      case "del-fact": S.kit.facts.splice(+b.dataset.n, 1); break;
      case "add-pal": { const name = val("palName") || "Brand colour", hex = val("palHex"); if (!/^#?[0-9a-f]{6}$/i.test(hex)) { toast("Use a hex colour like #F26B3A."); return; } S.kit.palette.push({ name, hex: (hex[0] === "#" ? hex : "#" + hex).toUpperCase() }); break; }
      case "del-pal": S.kit.palette.splice(+b.dataset.n, 1); break;
      case "export-kit": { const blob = new Blob([JSON.stringify(S.kit, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "brand-kit.json"; a.click(); return; }
      case "reset": { const keepRole = S.role; S = defaultState(); S.role = keepRole; S.tab = "kit"; toast("Demo data reset."); break; }
      default: return;
    }
    save(); render();
  });

  // ---------- start ----------
  render();
  fetch("/api/check").then(r => r.ok ? r.json() : null).then(j => {
    AI = { checked: true, enabled: !!(j && j.aiEnabled), model: j && j.model, provider: j && j.provider };
  }).catch(() => { AI = { checked: true, enabled: false }; }).finally(render);
})();
