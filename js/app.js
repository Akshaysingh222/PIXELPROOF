/* PixelProof user interface. Plain JavaScript, no build step.
   The checking logic lives in engine.js; this file draws the screens and handles clicks.

   Two ways to use it:
   - Demo mode (default): everything is saved in this browser. Switch between Riya (creator) and
     Arjun (brand manager) at the top to try both sides of the review.
   - Team workspace: sign in (team.js + Supabase) and the brand kit and review queue are shared
     with your team, live, across devices. */
(function () {
  "use strict";
  const PP = window.PP, KIT = window.PP_KIT, TEAMAPI = window.PPTeam;
  const STORE = "pixelproof:v2";
  const DEMO_PEOPLE = { creator: "Riya (Creator)", reviewer: "Arjun (Brand manager)" };
  const ROLE_LABEL = { creator: "Creator", reviewer: "Brand manager", admin: "Admin" };
  const TYPES = ["LinkedIn post", "Advertisement", "Email", "Document", "Web copy", "Instagram caption", "X post"];
  const AI_LIMIT = 6000;
  const DEMO_ACCOUNTS = [
    { name: "Arjun", role: "Brand manager (admin)", email: "arjun.manager@pixelproof-demo.com" },
    { name: "Riya", role: "Creator", email: "riya.creator@pixelproof-demo.com" }
  ];
  const DEMO_PASSWORD = "PixelProof-Demo-2026";
  const $app = document.getElementById("app");
  let AI = { checked: false, enabled: false, model: null, provider: null };
  let busy = false;              // a check is running
  let toastTimer = null, pendingRender = false;

  // The team workspace, when signed in. TEAM.on = true means the screens show shared team data.
  const TEAM = { configured: false, ready: false, on: false, ws: null, role: null, me: null, members: [], list: null, form: "signin", working: false, error: "", poll: null };

  // ---------- small helpers ----------
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function now() { return new Date().toISOString(); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function when(iso) { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
  function toast(msg) {
    let t = document.querySelector(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  function sevCount(list) { const c = { blocker: 0, warning: 0, suggestion: 0 }; list.forEach(i => { if (i.status === "open" && c[i.severity] !== undefined) c[i.severity]++; }); return c; }
  function keyOf(i) { return i.ruleId + "|" + PP.norm(i.excerpt); }
  function nextId(prefix, list, pad) { // e.g. F-08 after F-07, even if some were deleted
    const n = list.reduce((m, x) => Math.max(m, parseInt(String(x.id || "").replace(/\D/g, ""), 10) || 0), 0) + 1;
    return prefix + (pad ? String(n).padStart(pad, "0") : n);
  }
  function freshDraft() { return { itemId: null, type: "LinkedIn post", title: "", text: "", image: null, result: null }; }
  const humanPattern = p => PP.plainPattern(p);

  // ---------- browser storage ----------
  let STORAGE_OK = true;
  try { localStorage.setItem("pp:probe", "1"); localStorage.removeItem("pp:probe"); } catch (e) { STORAGE_OK = false; }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  // ---------- who is using it ----------
  function isReviewer() { return TEAM.on ? TEAM.role === "reviewer" || TEAM.role === "admin" : S.role === "reviewer"; }
  function isAdmin() { return TEAM.on ? TEAM.role === "admin" : S.role === "reviewer"; }
  function myName() { return TEAM.on ? TEAM.me.name + " (" + ROLE_LABEL[TEAM.role] + ")" : DEMO_PEOPLE[S.role]; }
  function myRole() { return isReviewer() ? "reviewer" : "creator"; }

  // ---------- demo data ----------
  // Example submissions so the review queue and insights aren't empty the first time someone opens the app.
  // Two of them show the gap detector at work: creators and reviewers keep pushing back on the "limited time" phrase.
  function seedItems(kit) {
    const today = PP.todayISO();
    const mk = (title, type, text, status, extra) => {
      const r = PP.runLocal(text, kit, today);
      const issues = r.issues.map(i => Object.assign({}, i, (extra.decide || {})[i.ruleId] || {}));
      const at = new Date(Date.now() - (extra.ago || 1) * 3600e3).toISOString();
      const later = new Date(Date.now() - (extra.ago || 1) * 3600e3 + 1800e3).toISOString();
      return {
        id: uid(), title, type, status, createdBy: DEMO_PEOPLE.creator, createdAt: at,
        versions: [{ v: 1, text, at, issues, fixed: [], verified: r.verified, aiUsed: false, image: null }],
        comments: (extra.comments || []).map(c => Object.assign({ at: later }, c)),
        history: [{ at, by: DEMO_PEOPLE.creator, action: "Submitted version 1" }].concat((extra.history || []).map(h => Object.assign({ at: later }, h)))
      };
    };
    const arjun = { by: DEMO_PEOPLE.reviewer, role: "reviewer" };
    return [
      mk("Diwali ad", "Advertisement", KIT.SAMPLES[2].text, "approved", { ago: 52,
        comments: [Object.assign({ text: "Calm, clear and every claim is backed. Approved." }, arjun)],
        history: [{ by: DEMO_PEOPLE.reviewer, action: "Approved version 1" }] }),
      mk("Diwali offer email", "Email", "Our Diwali offer is for a limited time: open a Savings Pot before 2 November and we'll send you a Kitebird Money diary.", "approved", { ago: 40,
        decide: { "T-1": { status: "dismissed", reason: "It's a real offer that ends on 2 November. Legal approved the wording.", review: "accepted" } },
        comments: [Object.assign({ text: "Agreed, a real deadline stated calmly is fine." }, arjun)],
        history: [{ by: DEMO_PEOPLE.reviewer, action: "Agreed with dismissal of T-1" }, { by: DEMO_PEOPLE.reviewer, action: "Approved version 1" }] }),
      mk("Festive banner copy", "Advertisement", "Limited time only: festive savings goals for the whole family.", "approved", { ago: 28,
        decide: { "T-1": { override: "The festive campaign really does end on Sunday; this isn't pressure." } },
        history: [{ by: DEMO_PEOPLE.reviewer, action: "Marked T-1 OK to publish" }, { by: DEMO_PEOPLE.reviewer, action: "Approved version 1" }] }),
      mk("App store blurb", "Web copy", "Kitebird Money is the smartest way to save in India. Download now and start today!", "changes_requested", { ago: 20,
        comments: [Object.assign({ text: "“Smartest way to save” is a ranking we can't back up, and “Download now” feels pushy. Could you make it calmer?" }, arjun)],
        history: [{ by: DEMO_PEOPLE.reviewer, action: "Requested changes" }] }),
      mk("Weekly savings tip", "Instagram caption", "Saving ₹100 a week adds up to ₹5,200 in a year. Start a Savings Pot today and watch it grow \u{1F331}", "in_review", { ago: 5,
        decide: { "C-3": { status: "dismissed", reason: "This is simple maths (100 x 52), not a claim about Kitebird Money." } } })
    ];
  }
  function defaultState() {
    const kit = clone(KIT.DEMO_KIT);
    return { tab: "check", role: "creator", kit, items: seedItems(kit), selected: null, draft: freshDraft(), stats: { checks: 0, aiChecks: 0, aiDropped: 0 }, introHidden: false, gapEdit: null, gapNote: null };
  }
  // Adds rules that were introduced after this browser saved its brand kit (only for the built-in demo brand).
  function upgradeKit(kit) {
    if (!kit || !Array.isArray(kit.rules)) return clone(KIT.DEMO_KIT);
    kit.version = kit.version || 1; kit.history = kit.history || [];
    if (kit.brand === KIT.DEMO_KIT.brand) for (const r of KIT.DEMO_KIT.rules) if (!kit.rules.some(x => x.id === r.id)) kit.rules.push(clone(r));
    return kit;
  }
  // If the page was refreshed while the AI was still working, say so instead of showing "running" forever.
  function fixInterrupted(s) {
    const r = s.draft && s.draft.result;
    if (r && r.ai && r.ai.state === "running") r.ai = { state: "error", msg: "The AI review was interrupted because the page was reloaded." };
    s.gapEdit = null; s.importEdit = null;
    return s;
  }
  function load() {
    const s = lsGet(STORE);
    if (s && s.kit && Array.isArray(s.items) && s.draft) { s.kit = upgradeKit(s.kit); return fixInterrupted(s); }
    return defaultState();
  }
  let S = load();

  function teamKey() { return "pixelproof:team:" + (TEAM.ws ? TEAM.ws.id : "none"); }
  function save() {
    if (TEAM.on) { lsSet(teamKey(), { draft: S.draft, stats: S.stats, tab: S.tab, selected: S.selected, gapNote: S.gapNote }); return; }
    if (lsSet(STORE, S)) return;
    S.items.forEach(it => it.versions.slice(0, -1).forEach(v => { v.image = null; })); // probably full: drop old images and retry
    if (S.draft.image) S.draft.image.pixels = null;
    if (!lsSet(STORE, S)) STORAGE_OK = false;
  }

  // ---------- saving shared data (team workspace) ----------
  async function persistItem(item) {
    save();
    if (!TEAM.on) return;
    try { await TEAMAPI.saveItem(TEAM.ws.id, item); }
    catch (e) { toast("Couldn't save to the team workspace: " + TEAMAPI.friendly(e)); await refreshTeam(); }
  }
  async function persistKit() {
    save();
    if (!TEAM.on) return;
    try { await TEAMAPI.saveKit(TEAM.ws.id, S.kit); }
    catch (e) { toast("Couldn't save the brand kit: " + TEAMAPI.friendly(e)); await refreshTeam(); }
  }

  // ---------- checking ----------
  // Runs the rule + fact checks (engine.js) and keeps anything the user already decided:
  // issues they dismissed stay dismissed, and AI findings that still apply are kept.
  function localResult(text, prev) {
    const d = S.draft, today = PP.todayISO();
    const local = PP.runLocal(text, S.kit, today);
    let issues = local.issues;
    if (prev) {
      const ntext = PP.norm(text);
      prev.issues.filter(i => i.source === "AI check" && i.status !== "fixed" && (!i.excerpt || ntext.includes(PP.norm(i.excerpt))))
        .forEach(i => { if (!issues.some(x => keyOf(x) === keyOf(i))) issues.push(Object.assign({}, i)); });
    }
    if (d.image) issues = issues.concat(imageIssues());
    const dismissed = {}; if (prev) prev.issues.forEach(i => { if (i.status === "dismissed") dismissed[keyOf(i)] = i.reason; });
    issues.forEach(i => { if (dismissed[keyOf(i)] !== undefined) { i.status = "dismissed"; i.reason = dismissed[keyOf(i)]; } });
    const verified = local.verified.concat(prev ? prev.verified.filter(v => v.by && PP.norm(text).includes(PP.norm(v.excerpt))) : []);
    return { issues: PP.sortIssues(issues), verified, checkedText: text, fixed: prev ? prev.fixed : [], ai: prev ? prev.ai : { state: AI.enabled ? "idle" : "off" } };
  }
  function imageIssues() {
    const img = S.draft.image; if (!img) return [];
    if (img.pixels) { const a = PP.analyseImage(img.pixels, S.kit, img.alt); img.issues = a.issues; img.dominant = a.dominant; return a.issues; }
    // pixels weren't kept (storage was full): reuse the colour results, but recheck the alt text
    return (img.issues || []).filter(i => i.ruleId !== "A-5" || !String(img.alt || "").trim());
  }

  // What happens when you click "Check":
  // 1. rule + fact checks run instantly in the browser
  // 2. if AI is switched on, the AI review runs (runAI) and its answers are verified before being added
  async function runCheck() {
    if (busy) return;
    const d = S.draft; const text = d.text.trim();
    if (!text && !d.image) { toast("Paste some content or upload a file first."); return; }
    busy = true;
    try {
      d.result = localResult(d.text, null);
      S.stats.checks++;
      render();
      if (AI.enabled && text) await runAI();
    } finally { busy = false; save(); render(); }
  }

  // Sends the text (with personal data masked) to our server function /api/check, which asks Gemini.
  // The answer is checked by verifyAI() in engine.js before anything is shown.
  // The suggested rewrites are re-checked by the rules so you can see how many problems they still have.
  function slimKit(kit) {
    return { brand: kit.brand, voice: kit.voice, messaging: kit.messaging, glossary: kit.glossary,
      rules: kit.rules.map(x => ({ id: x.id, category: x.category, severity: x.severity, title: x.title, detail: x.detail, enabled: x.enabled, examples: x.examples, patterns: x.patterns })) };
  }
  async function runAI() {
    const d = S.draft, r = d.result; if (!r) return;
    const text = d.text; const masked = PP.maskPII(text);
    r.ai = { state: "running" }; render();
    try {
      const kit = S.kit;
      const res = await fetch("/api/check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: masked.text, contentType: d.type, kit: slimKit(kit), facts: PP.retrieveFacts(text, kit, 8),
          alreadyFound: r.issues.filter(i => i.excerpt).map(i => ({ ruleId: i.ruleId, excerpt: i.excerpt })) })
      });
      const data = await res.json().catch(() => ({ ok: false, error: "The AI service sent back something unexpected." }));
      if (S.draft.result !== r) return; // a newer check started
      if (!data.ok) { r.ai = { state: "error", msg: data.error || "AI check failed." }; return; }
      const v = PP.verifyAI(data.ai, text, kit, PP.todayISO(), r.issues);
      v.issues.forEach(i => r.issues.push(i));
      r.issues = PP.sortIssues(r.issues);
      v.verified.forEach(x => r.verified.push(x));
      S.stats.aiChecks++; S.stats.aiDropped += v.dropped.length;
      const rw = data.ai.rewrite || {};
      const score = t => sevCount(PP.runLocal(t, kit, PP.todayISO()).issues.map(i => Object.assign(i, { status: "open" })));
      r.ai = { state: "done", model: data.model, dropped: v.dropped.length, masked: masked.count + (data.masked || 0), added: v.issues.length, truncated: !!data.truncated,
        rewrite: { minimal: rw.minimal || "", full: rw.full || "", minimalScore: rw.minimal ? score(rw.minimal) : null, fullScore: rw.full ? score(rw.full) : null } };
    } catch (e) {
      if (S.draft.result === r) r.ai = { state: "error", msg: "Couldn't reach the AI check. Rule and fact checks still ran." };
    }
  }

  // User clicked a fix button: change the text, remember the fix, and re-run the checks.
  function applyFixTo(issueKey, fixIndex) {
    const d = S.draft, r = d.result; if (!r) return;
    const i = r.issues.find(x => x.key === issueKey); if (!i || !i.fixes[fixIndex]) return;
    const fix = i.fixes[fixIndex]; const before = d.text;
    d.text = PP.applyFix(d.text, i, fix.replacement);
    if (d.text === before) { toast("Couldn't find that text any more. Try checking again."); return; }
    r.fixed = (r.fixed || []).concat([{ ruleId: i.ruleId, pattern: i.pattern, excerpt: i.excerpt, replacement: fix.replacement, severity: i.severity, source: i.source, message: i.message, reference: i.reference }]);
    S.draft.result = localResult(d.text, r);
    save(); render();
    toast("Fixed: “" + i.excerpt + "”" + (fix.replacement ? " → “" + fix.replacement + "”" : " removed"));
  }

  // Saves the content as a new item (or a new version of an item that was sent back)
  // with all the check results, so the reviewer sees exactly what the creator saw.
  async function submitDraft() {
    const d = S.draft, r = d.result; if (!r || busy) return;
    const title = (d.title.trim() || (d.text.trim().split(/\s+/).slice(0, 6).join(" ") + "…")).slice(0, 120);
    const version = { text: d.text, at: now(), issues: clone(r.issues), fixed: clone(r.fixed || []), verified: clone(r.verified), aiUsed: !!(r.ai && r.ai.state === "done"),
      kitVersion: S.kit.version || 1,
      image: d.image ? { dataUrl: d.image.small || d.image.dataUrl, alt: d.image.alt, dominant: d.image.dominant } : null };
    let item = d.itemId && S.items.find(x => x.id === d.itemId);
    if (item && item.status !== "changes_requested") item = null; // the original was already handled; submit as new
    if (item) {
      version.v = item.versions.length + 1; item.versions.push(version); item.status = "in_review"; item.title = title; item.type = d.type;
      item.history.push({ at: now(), by: myName(), action: "Submitted version " + version.v });
    } else {
      version.v = 1;
      item = { id: uid(), title, type: d.type, status: "in_review", createdBy: myName(), createdAt: now(), versions: [version], comments: [], history: [{ at: now(), by: myName(), action: "Submitted version 1" }] };
      S.items.unshift(item);
    }
    S.draft = freshDraft(); S.selected = item.id; S.tab = "review";
    render();
    await persistItem(item);
    toast(TEAM.on ? "Sent for review. Your brand manager will see it in the team queue." : "Sent for review. Switch to “Arjun · Brand manager” at the top to approve it.");
  }

  // ---------- files ----------
  function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => no(new Error("Couldn't load the file reader. Check your connection and try again.")); document.head.appendChild(s); }); }
  // Reads text out of uploaded files. PDF and Word readers are only downloaded when needed.
  async function readDocument(file) {
    const name = file.name.toLowerCase();
    if (file.size > 15 * 1024 * 1024) throw new Error("That file is over 15 MB. Try a smaller one, or paste the text.");
    if (/\.(txt|md|csv|html?)$/.test(name) || file.type.startsWith("text/")) {
      let t = await file.text(); if (/\.html?$/.test(name)) { const div = document.createElement("div"); div.innerHTML = t; t = div.innerText; } return t;
    }
    if (name.endsWith(".pdf")) {
      if (!window.pdfjsLib) { await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"); window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; }
      let pdf;
      try { pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise; }
      catch (e) { throw new Error("Couldn't open that PDF. It may be damaged or password-protected."); }
      const out = [];
      for (let p = 1; p <= Math.min(pdf.numPages, 15); p++) { const c = await (await pdf.getPage(p)).getTextContent(); out.push(c.items.map(i => i.str + (i.hasEOL ? "\n" : " ")).join("")); }
      if (pdf.numPages > 15) toast("Only the first 15 pages were read.");
      return out.join("\n\n").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
    }
    if (name.endsWith(".docx")) {
      if (!window.mammoth) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js");
      try { const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() }); return r.value.trim(); }
      catch (e) { throw new Error("Couldn't read that Word file. Try saving it again as .docx."); }
    }
    if (name.endsWith(".doc")) throw new Error("Old .doc files aren't supported. Save it as .docx or PDF first.");
    throw new Error("That file type isn't supported. Try .txt, .md, .pdf or .docx.");
  }
  // Reads an uploaded image into a small canvas so we can count its colours (engine.analyseImage).
  function readImage(file) {
    return new Promise((ok, no) => {
      if (!/^image\//.test(file.type)) { no(new Error("That isn't an image file.")); return; }
      if (file.size > 20 * 1024 * 1024) { no(new Error("That image is over 20 MB. Try a smaller one.")); return; }
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 160 / Math.max(img.width, img.height));
          const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(img.width * scale)); c.height = Math.max(1, Math.round(img.height * scale));
          const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0, c.width, c.height);
          const pixels = Array.from(ctx.getImageData(0, 0, c.width, c.height).data);
          const s2 = Math.min(1, 480 / Math.max(img.width, img.height)); const c2 = document.createElement("canvas");
          c2.width = Math.max(1, Math.round(img.width * s2)); c2.height = Math.max(1, Math.round(img.height * s2)); c2.getContext("2d").drawImage(img, 0, 0, c2.width, c2.height);
          ok({ name: file.name, dataUrl: c2.toDataURL("image/jpeg", 0.8), small: c2.toDataURL("image/jpeg", 0.7), pixels, alt: "" });
        };
        img.onerror = () => no(new Error("Couldn't read that image. Try a PNG or JPG."));
        img.src = fr.result;
      };
      fr.onerror = () => no(new Error("Couldn't read that file."));
      fr.readAsDataURL(file);
    });
  }

  // ---------- guideline gap detector ----------
  // Starts a suggested change for a rule: first worked out by code from the evidence, then (if AI is on)
  // improved by the AI. Nothing changes until a brand manager approves it.
  function gapFor(ruleId) { return PP.analyseGaps(S.items, S.kit).find(g => g.ruleId === ruleId); }
  async function startGapEdit(ruleId) {
    const gap = gapFor(ruleId); if (!gap) return;
    S.gapEdit = { ruleId, change: PP.suggestRuleChange(gap), errors: [], ai: AI.enabled ? "running" : "off" };
    render();
    if (AI.enabled) await askAIForRule(ruleId);
  }
  async function askAIForRule(ruleId) {
    const gap = gapFor(ruleId); if (!gap || !S.gapEdit) return;
    S.gapEdit.ai = "running"; render();
    try {
      const res = await fetch("/api/check", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "rule", kit: slimKit(S.kit), rule: gap.rule,
          gap: { flagged: gap.flagged, dismissed: gap.dismissed, overridden: gap.overridden, fixed: gap.fixed, reasons: gap.reasons, pushedExcerpts: gap.pushedExcerpts, fixedExcerpts: gap.fixedExcerpts } }) });
      const data = await res.json().catch(() => ({ ok: false }));
      if (!S.gapEdit || S.gapEdit.ruleId !== ruleId) return;
      if (!data.ok) { S.gapEdit.ai = "error"; S.gapEdit.aiMsg = String(data.error || "The AI suggestion didn't arrive.").replace(/ ?Rule and fact checks still ran[.;]?/, "") + " The code-based suggestion is shown."; return; }
      const code = S.gapEdit.change;
      const v = PP.validateRuleChange(Object.assign({}, data.change, { source: "AI (" + data.model + "), checked by code" }), gap.rule);
      // keep the evidence-based phrase removals too; the manager can untick any of them
      v.change.removePatterns = Array.from(new Set(v.change.removePatterns.concat(code.removePatterns)));
      if (!v.change.allowed.length) v.change.allowed = code.allowed;
      if (!v.change.notAllowed.length) v.change.notAllowed = code.notAllowed;
      if (v.change.detail.length >= 10) { S.gapEdit.change = v.change; S.gapEdit.ai = "done"; }
      else { S.gapEdit.ai = "error"; S.gapEdit.aiMsg = "The AI's wording was too short, so the code-based suggestion is shown."; }
    } catch (e) {
      if (S.gapEdit && S.gapEdit.ruleId === ruleId) { S.gapEdit.ai = "error"; S.gapEdit.aiMsg = "Couldn't reach the AI. The code-based suggestion is shown."; }
    } finally { render(); }
  }
  function readGapForm() {
    const val = id => { const el = document.getElementById(id); return el ? el.value : ""; };
    const rule = S.kit.rules.find(r => r.id === S.gapEdit.ruleId);
    const removePatterns = Array.from(document.querySelectorAll("input[data-gx-pat]:checked")).map(x => x.value);
    return PP.validateRuleChange({ detail: val("gx-detail"), allowed: val("gx-allowed"), notAllowed: val("gx-notallowed"), severity: val("gx-sev"),
      removePatterns, rationale: S.gapEdit.change.rationale, source: S.gapEdit.change.source }, rule);
  }
  async function approveGapEdit() {
    if (!S.gapEdit || !isReviewer()) return;
    const { change, errors } = readGapForm();
    if (errors.length) { S.gapEdit.errors = errors; render(); return; }
    const gap = gapFor(change.ruleId);
    S.kit = PP.applyRuleChange(S.kit, change, myName(), now());
    const entry = S.kit.history[S.kit.history.length - 1];
    // find real content that was pushed back on, so the manager can see the next check change straight away
    let tryText = null;
    if (gap) for (const it of S.items) { const v = it.versions[it.versions.length - 1]; if (gap.pushedExcerpts.some(x => v.text.includes(x))) { tryText = { text: v.text, title: it.title, type: it.type }; break; } }
    S.gapEdit = null;
    S.gapNote = { ruleId: entry.ruleId, version: entry.version, summary: entry.summary, tryText };
    render();
    await persistKit();
    toast("Guideline " + entry.ruleId + " updated (brand kit version " + entry.version + "). New checks use it straight away.");
  }

  // ---------- guideline import (Brand kit) ----------
  // Reads a brand guideline document and proposes rules, facts and glossary terms. Code proposes first (works without AI),
  // then the AI adds what code can't see. Every proposal must quote a sentence that's really in the document,
  // and nothing changes until the brand manager ticks what to keep and approves.
  async function startImport(fileName, text, tryText) {
    const code = PP.validateImport(PP.extractGuideline(text), text, S.kit);
    S.importEdit = { fileName, text, tryText: tryText || null, v: code, codeCount: code.rules.length + code.facts.length + code.glossary.length, ai: AI.enabled ? "running" : "off" };
    S.importNote = null; render();
    const el = document.getElementById("import-card"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    if (AI.enabled) await askAIForGuide();
  }
  async function askAIForGuide() {
    const e = S.importEdit; if (!e) return;
    e.ai = "running"; render();
    try {
      const res = await fetch("/api/check", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "guide", kit: slimKit(S.kit), text: PP.maskPII(e.text).text, fileName: e.fileName }) });
      const data = await res.json().catch(() => ({ ok: false }));
      if (S.importEdit !== e) return;
      if (!data.ok) { e.ai = "error"; e.aiMsg = String(data.error || "The AI didn't answer.").replace(/ ?Rule and fact checks still ran[.;]?/, ""); return; }
      const ai = PP.mergeImports(PP.validateImport(data.proposal, e.text, S.kit), e.v);
      e.v = ai; e.ai = "done"; e.model = data.model; e.truncated = data.truncated;
    } catch (err) {
      if (S.importEdit === e) { e.ai = "error"; e.aiMsg = "Couldn't reach the AI."; }
    } finally { render(); }
  }
  function importCard() {
    const e = S.importEdit;
    const head = `<section class="card" id="import-card" style="margin-top:20px"><h2>Import from a brand guideline</h2>
      <p class="hint">Upload your brand guideline (PDF, Word or text). PixelProof proposes rules, approved facts and glossary terms from it. Each one quotes the sentence it came from, and code checks that sentence really is in your document. Nothing is added until you approve.</p>`;
    if (S.importNote) return head + `<div class="status-line ok-line" role="status">\u2713 ${esc(S.importNote.summary)} (brand kit version ${S.importNote.version}). New checks use them straight away.
      ${S.importNote.tryText ? `<button class="btn small" data-act="guide-try">See it work: check a sentence that breaks the new rules</button>` : ""} <button class="btn small ghost" data-act="guide-note-close">Import another</button></div></section>`;
    if (!e) return head + `<div class="row"><label class="btn primary" for="guideFile">Upload a guideline\u2026</label><input id="guideFile" type="file" accept=".pdf,.docx,.txt,.md" data-act="guide-file" class="sr-only">
      <button class="btn" data-act="guide-sample">Try the sample guideline</button>
      <a class="hint" href="/docs/sample-brand-guideline.pdf" download>Download the sample as a PDF</a></div></section>`;
    const v = e.v, total = v.rules.length + v.facts.length + v.glossary.length;
    const aiLine = e.ai === "running" ? `<div class="status-line ai-run" role="status">Reading \u201c${esc(e.fileName)}\u201d with the AI\u2026 ${e.codeCount} proposal${e.codeCount === 1 ? "" : "s"} found by code are shown meanwhile.</div>`
      : e.ai === "done" ? `<div class="status-line ai-run">Proposals from code and ${esc(e.model)}, each checked against the document.${v.rejected.length ? ` ${v.rejected.length} thrown out (quote not in the document, already in the kit, or too vague).` : ""}${e.truncated ? " The AI read the first 20,000 characters." : ""}</div>`
      : e.ai === "error" ? `<div class="status-line">${esc(e.aiMsg)} The proposals found by code are shown. <button class="btn small" data-act="guide-ai">Try the AI again</button></div>`
      : `<div class="status-line">Proposals found by code (AI review is off on this deployment).</div>`;
    const quote = q => `<div class="hint">From the document: \u201c${esc(q)}\u201d</div>`;
    const rules = v.rules.map((r, n) => `<label class="imp"><input type="checkbox" data-imp="rules" data-n="${n}" ${r.on ? "checked" : ""}><span><b>${esc(r.title)}</b> <select data-imp-sev="${n}" aria-label="Severity">${["blocker", "warning", "suggestion"].map(x => `<option ${x === r.severity ? "selected" : ""}>${x}</option>`).join("")}</select><br>${esc(r.detail)}
      <div class="hint">${r.patterns.length ? "Flags: " + r.patterns.map(p => "\u201c" + esc(PP.plainPattern(p)) + "\u201d").join(", ") : "No exact phrases: the AI review applies it"}${r.fix ? " \u00b7 fix: \u201c" + esc(r.fix) + "\u201d" : ""}</div>${quote(r.quote)}</span></label>`).join("");
    const facts = v.facts.map((f, n) => `<label class="imp"><input type="checkbox" data-imp="facts" data-n="${n}" ${f.on ? "checked" : ""}><span>${esc(f.text)}<div class="hint">Valid until ${esc(f.expires)} (change it later in the fact table)</div></span></label>`).join("");
    const gl = v.glossary.map((g, n) => `<label class="imp"><input type="checkbox" data-imp="glossary" data-n="${n}" ${g.on ? "checked" : ""}><span>Use <b>${esc(g.use)}</b>, not ${g.avoid.map(a => "\u201c" + esc(a) + "\u201d").join(", ")}${quote(g.quote)}</span></label>`).join("");
    return head + aiLine + (total ? `
      ${v.rules.length ? `<h3>Rules (${v.rules.length})</h3>${rules}` : ""}
      ${v.facts.length ? `<h3>Approved facts (${v.facts.length})</h3>${facts}` : ""}
      ${v.glossary.length ? `<h3>Glossary (${v.glossary.length})</h3>${gl}` : ""}` : `<p class="hint">Nothing that looks like a rule, fact or glossary term was found yet.</p>`)
      + (v.rejected.length ? `<details class="hint" style="margin-top:8px"><summary>Thrown out (${v.rejected.length})</summary><ul>${v.rejected.slice(0, 20).map(r => `<li>${esc(r.kind)}: \u201c${esc(r.label)}\u201d \u2014 ${esc(r.why)}</li>`).join("")}</ul></details>` : "")
      + `<div class="row" style="margin-top:12px"><button class="btn primary" data-act="guide-approve" ${e.ai === "running" || !total ? "disabled" : ""}>Add the ticked items to the brand kit</button><button class="btn ghost" data-act="guide-cancel">Discard</button><span class="hint">From \u201c${esc(e.fileName)}\u201d</span></div></section>`;
  }
  async function approveImport() {
    const e = S.importEdit; if (!e || !isReviewer()) return;
    const pick = kind => e.v[kind].filter((x, n) => { const box = document.querySelector(`input[data-imp="${kind}"][data-n="${n}"]`); return box ? box.checked : x.on; });
    e.v.rules.forEach((r, n) => { const sel = document.querySelector(`select[data-imp-sev="${n}"]`); if (sel) r.severity = sel.value; });
    const accepted = { rules: pick("rules"), facts: pick("facts"), glossary: pick("glossary") };
    if (!accepted.rules.length && !accepted.facts.length && !accepted.glossary.length) { toast("Tick at least one item to add."); return; }
    S.kit = PP.applyImport(S.kit, accepted, myName(), now(), e.fileName, e.ai === "done" ? "code + AI (" + e.model + "), checked against the document" : "code");
    const entry = S.kit.history[S.kit.history.length - 1];
    S.importNote = { summary: entry.summary.charAt(0).toUpperCase() + entry.summary.slice(1), version: entry.version, tryText: e.tryText };
    S.importEdit = null; render();
    await persistKit();
    toast("Brand kit updated to version " + entry.version + ".");
  }

  // ---------- team workspace ----------
  async function initTeam() {
    try { TEAM.configured = await TEAMAPI.init(); } catch (e) { TEAM.configured = false; TEAM.error = TEAMAPI.friendly(e); }
    TEAM.ready = true;
    if (TEAM.configured && TEAMAPI.user) {
      const last = lsGet("pixelproof:lastWorkspace");
      if (last) { try { await openWorkspace(last, true); } catch (e) { /* fall back to the list */ } }
    }
    handoffDraft = null;
    render();
  }
  async function loadWorkspaceList() {
    if (TEAM.listLoading) return;
    TEAM.listLoading = true;
    try { TEAM.list = await TEAMAPI.myWorkspaces(); } catch (e) { TEAM.list = []; TEAM.error = TEAMAPI.friendly(e); }
    TEAM.listLoading = false;
    render();
  }
  function applyTeamData(data) {
    TEAM.ws = { id: data.ws.id, name: data.ws.name, code: data.ws.join_code };
    TEAM.members = data.members;
    const me = data.members.find(m => m.user_id === TEAMAPI.user.id);
    if (!me) throw new Error("You're no longer a member of this workspace.");
    TEAM.role = me.role; TEAM.me = { id: me.user_id, name: me.display_name };
    S.kit = upgradeKit(data.ws.kit);
    S.items = data.items;
  }
  async function openWorkspace(wsId, quiet) {
    TEAM.working = true; render();
    try {
      const data = await TEAMAPI.load(wsId);
      if (!TEAM.on) lsSet(STORE, S); // keep the demo safe while the team workspace is open
      const local = lsGet("pixelproof:team:" + wsId) || {};
      S = { tab: quiet ? (local.tab || "check") : "review", role: "creator", kit: null, items: [], selected: local.selected || null,
        draft: local.draft || freshDraft(), stats: local.stats || { checks: 0, aiChecks: 0, aiDropped: 0 }, introHidden: true, gapEdit: null, gapNote: local.gapNote || null };
      S = fixInterrupted(S);
      applyTeamData(data);
      TEAM.on = true;
      if (useHandoff()) { handoffDraft = null; const go = () => busy ? setTimeout(go, 250) : runCheck(); setTimeout(go, 0); }
      lsSet("pixelproof:lastWorkspace", wsId);
      TEAMAPI.subscribe(wsId, scheduleRefresh);
      clearInterval(TEAM.poll); TEAM.poll = setInterval(() => { if (document.visibilityState === "visible") refreshTeam(); }, 20000);
      if (!quiet) toast("Opened " + TEAM.ws.name + ". You're signed in as " + TEAM.me.name + " (" + ROLE_LABEL[TEAM.role] + ").");
    } catch (e) {
      if (!quiet) toast("Couldn't open that workspace: " + TEAMAPI.friendly(e));
      throw e;
    } finally { TEAM.working = false; render(); }
  }
  let refreshTimer = null;
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshTeam, 400); }
  async function refreshTeam() {
    if (!TEAM.on) return;
    try {
      const data = await TEAMAPI.load(TEAM.ws.id);
      const before = TEAM.role;
      applyTeamData(data);
      if (before !== TEAM.role) toast("Your role is now " + ROLE_LABEL[TEAM.role] + ".");
      safeRender();
    } catch (e) {
      if (/no longer a member|JWT|sign in/i.test(String(e.message))) { leaveTeam(); toast(TEAMAPI.friendly(e)); }
    }
  }
  function leaveTeam() {
    if (TEAM.on) save();
    TEAMAPI.unsubscribe && TEAMAPI.unsubscribe();
    clearInterval(TEAM.poll);
    TEAM.on = false; TEAM.ws = null; TEAM.role = null; TEAM.me = null; TEAM.members = [];
    S = load(); S.tab = "team";
    render();
  }

  // ---------- views ----------
  // Each function below builds the HTML for one screen or one part of a screen.
  function issueCard(i, opts) {
    opts = opts || {};
    const done = i.status !== "open";
    const fixes = !done && !opts.readonly ? i.fixes.map((f, n) => `<button class="btn small primary" data-act="fix" data-key="${i.key}" data-n="${n}">${esc(f.label)}</button>`).join("") : "";
    let state = "";
    if (i.status === "dismissed") state = `<span class="state dismissed">Dismissed: “${esc(i.reason)}”</span>`;
    const dismiss = !done && !opts.readonly ? `<button class="btn small" data-act="dismiss" data-key="${i.key}">Dismiss…</button>` : "";
    const undo = i.status === "dismissed" && !opts.readonly ? `<button class="btn small ghost" data-act="undismiss" data-key="${i.key}">Undo</button>` : "";
    const ex = i.examples && ((i.examples.allowed || []).length || (i.examples.notAllowed || []).length)
      ? `<p class="examples">${(i.examples.allowed || []).length ? `<span>✓ Allowed: ${i.examples.allowed.map(x => "“" + esc(x) + "”").join(", ")}</span>` : ""}${(i.examples.notAllowed || []).length ? `<span>✗ Not allowed: ${i.examples.notAllowed.map(x => "“" + esc(x) + "”").join(", ")}</span>` : ""}</p>` : "";
    return `<div class="issue ${i.severity} ${done ? "done" : ""}" id="iss-${i.key}">
      <div class="head"><span class="sev ${i.severity}">${i.severity}</span><span class="src ${i.source === "AI check" ? "ai" : ""}">${esc(i.source === "Rule" ? "Rule check" : i.source)}</span>${i.target === "image" ? '<span class="src">Image</span>' : ""}<span class="ref">${esc(i.reference)}</span></div>
      ${i.excerpt ? `<div class="excerpt">“${esc(i.excerpt)}”</div>` : ""}
      <p class="msg">${esc(i.message)}</p>${ex}
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

  function notices() {
    let out = "";
    if (!STORAGE_OK && !TEAM.on) out += `<div class="status-line warn" role="alert">This browser isn't letting PixelProof save anything (private mode or full storage), so your work will be lost if you reload the page.</div>`;
    if (TEAM.on) out += `<div class="status-line team-line">Team workspace <b>${esc(TEAM.ws.name)}</b> · signed in as <b>${esc(TEAM.me.name)}</b> (${ROLE_LABEL[TEAM.role]}) · changes are shared with your team live <button class="btn small ghost" data-act="tab" data-tab="team">Team settings</button></div>`;
    return out;
  }

  // Screen 1: write or upload content, run the check, see the results, fix, submit.
  function viewCheck() {
    const d = S.draft, r = d.result;
    const editingItem = d.itemId && S.items.find(x => x.id === d.itemId && x.status === "changes_requested");
    const stale = r && r.checkedText !== d.text;
    const openBlockers = r ? r.issues.filter(i => i.status === "open" && i.severity === "blocker").length : 0;
    const lastReviewerNote = editingItem ? (editingItem.comments.filter(c => c.role === "reviewer" || c.by === DEMO_PEOPLE.reviewer).slice(-1)[0] || {}).text : "";
    const len = d.text.length;
    const left = `<section class="card" aria-labelledby="h-write">
      <h2 id="h-write">${editingItem ? "Revising: " + esc(editingItem.title) + ` <span class="status changes_requested">version ${editingItem.versions.length + 1}</span>` : "1. Add your content"}</h2>
      ${editingItem ? `<div class="status-line">Reviewer feedback: “${esc(lastReviewerNote || "")}” <button class="btn small ghost" data-act="cancel-revise">Cancel revision</button></div>` : ""}
      <div class="row"><span class="hint">Try a sample:</span><div class="chips">${KIT.SAMPLES.map((s, n) => `<button class="chip" data-act="sample" data-n="${n}">${esc(s.label)}</button>`).join("")}</div></div>
      <div class="row" style="margin-top:6px">
        <div style="flex:1;min-width:160px"><label class="field" for="type">Content type</label><select id="type" data-bind="type">${TYPES.map(t => `<option ${t === d.type ? "selected" : ""}>${t}</option>`).join("")}</select></div>
        <div style="flex:2;min-width:200px"><label class="field" for="title">Title (for the review queue)</label><input id="title" type="text" maxlength="120" data-bind="title" value="${esc(d.title)}" placeholder="e.g. Friday savings post"></div>
      </div>
      <label class="field" for="text">Text</label>
      <textarea id="text" data-bind="text" placeholder="Paste a post, ad, email or web copy here…">${esc(d.text)}</textarea>
      <div class="hint counter" id="counter">${len ? len.toLocaleString() + " characters" + (len > AI_LIMIT && AI.enabled ? " · the AI review reads the first 6,000; rule and fact checks cover all of it" : "") + " · Ctrl+Enter to check" : ""}</div>
      <div class="row" style="margin-top:10px">
        <div class="drop" style="flex:1;min-width:220px"><label for="doc"><b>Or upload a document</b> (.pdf, .docx, .txt)</label><br><input id="doc" type="file" accept=".pdf,.docx,.txt,.md,.html" data-act="doc"></div>
        <div class="drop" style="flex:1;min-width:220px"><label for="img"><b>Add an image</b> (checks colours, contrast, alt text)</label><br><input id="img" type="file" accept="image/*" data-act="img"></div>
      </div>
      ${d.image ? `<div class="img-preview"><img src="${d.image.dataUrl}" alt="${esc(d.image.alt || "Uploaded image preview")}"><div style="flex:1"><label class="field" for="alt">Alt text for this image</label><input id="alt" type="text" maxlength="250" data-bind="alt" value="${esc(d.image.alt)}" placeholder="Describe the image for screen-reader users"><div class="swatches">${(d.image.dominant || []).map(c => `<span class="swatch ${c.onBrand ? "" : "bad"}"><i style="background:${c.hex}"></i>${c.hex} · ${Math.round(c.share * 100)}%${c.onBrand ? " · " + esc(c.nearest.name) : " · off-palette"}</span>`).join("")}</div><button class="btn small ghost" data-act="remove-img">Remove image</button></div></div>` : ""}
      <div class="row" style="margin-top:14px">
        <button class="btn primary" data-act="check" ${busy ? "disabled" : ""}>${busy ? "Checking…" : r ? "Check again" : "Check against brand kit"}</button>
        ${d.text || d.image ? `<button class="btn ghost" data-act="clear" ${busy ? "disabled" : ""}>Clear</button>` : ""}
        <span class="hint">${AI.enabled ? "Rules + fact library + AI review" : AI.checked ? "Rules + fact library (AI review is off on this deployment)" : "Rules + fact library"}</span>
      </div>
      ${r && d.text ? `<h3>Preview with highlights</h3><div class="preview" aria-label="Your text with flagged words highlighted">${highlight(d.text, r.issues)}</div>` : ""}
    </section>`;

    let right;
    if (!r) {
      right = `<section class="card" aria-labelledby="h-res"><h2 id="h-res">2. Results</h2><div class="empty"><div class="big" aria-hidden="true">▪</div><p>Results show up here. Every flag tells you what's wrong, why, and which rule or approved fact it comes from.</p><p class="hint">Every number is checked against approved facts by code, so the AI can’t pass a claim on its own. PixelProof never edits or publishes anything without your click.</p></div></section>`;
    } else {
      const c = sevCount(r.issues);
      const total = c.blocker + c.warning + c.suggestion;
      const ai = r.ai || {};
      let aiLine = "";
      if (ai.state === "running") aiLine = `<div class="status-line ai-run" role="status">AI review running… rule and fact checks are already shown below.</div>`;
      else if (ai.state === "done") aiLine = `<div class="status-line ai-run">AI review by ${esc(ai.model)} added ${ai.added} finding${ai.added === 1 ? "" : "s"}${ai.dropped ? `; ${ai.dropped} AI answer${ai.dropped === 1 ? " was" : "s were"} thrown out because ${ai.dropped === 1 ? "it" : "they"} didn't match the text or a real rule` : ""}.${ai.masked ? ` ${ai.masked} personal detail${ai.masked === 1 ? " was" : "s were"} masked before sending.` : ""}${ai.truncated ? " The AI read the first 6,000 characters." : ""}</div>`;
      else if (ai.state === "error") aiLine = `<div class="status-line">${esc(ai.msg)} <button class="btn small" data-act="retry-ai" ${busy ? "disabled" : ""}>Try AI review again</button></div>`;
      else if (AI.checked && !AI.enabled) aiLine = `<div class="status-line">Rules-only mode: the AI review isn't configured on this deployment, so tone and spelling aren't checked.</div>`;
      const open = r.issues.filter(i => i.status === "open"), closed = r.issues.filter(i => i.status !== "open");
      const rw = ai.rewrite && (ai.rewrite.minimal || ai.rewrite.full) ? `<h3>Suggested rewrites (AI, then re-checked by rules)</h3>
        ${["minimal", "full"].filter(k => ai.rewrite[k]).map(k => { const sc = ai.rewrite[k + "Score"]; return `<div class="rewrite"><b>${k === "minimal" ? "Minimal fix" : "Fuller on-brand rewrite"}</b> <span class="hint">· re-check: ${sc ? `${sc.blocker} blockers, ${sc.warning} warnings` : ""}</span><p>${esc(ai.rewrite[k])}</p><button class="btn small" data-act="use-rewrite" data-k="${k}" ${busy ? "disabled" : ""}>Use this version</button></div>`; }).join("")}` : "";
      const submitHint = busy ? "Wait for the check to finish." : stale ? "Check again before submitting." : openBlockers ? `Fix or dismiss ${openBlockers} blocker${openBlockers === 1 ? "" : "s"} (with a reason) to submit.` : "A reviewer makes the final call. Warnings left open will be visible to them.";
      right = `<section class="card" aria-labelledby="h-res"><h2 id="h-res">2. Results</h2>
        ${stale && !busy ? `<div class="status-line">You've edited the text since the last check. <button class="btn small primary" data-act="check">Check again</button></div>` : ""}
        <div class="summary">${total === 0 ? '<span class="pill ok">No open issues</span>' : ""}<span class="pill blocker">${c.blocker} blocker${c.blocker === 1 ? "" : "s"}</span><span class="pill warning">${c.warning} warning${c.warning === 1 ? "" : "s"}</span><span class="pill suggestion">${c.suggestion} suggestion${c.suggestion === 1 ? "" : "s"}</span>${(r.fixed || []).length ? `<span class="pill ok">${r.fixed.length} fixed</span>` : ""}</div>
        ${aiLine}
        ${open.map(i => issueCard(i)).join("") || (total === 0 ? `<p class="hint">Nothing left to fix. You can submit this for review.</p>` : "")}
        ${r.verified.length ? `<h3>Claims checked against approved facts</h3>${r.verified.map(v => `<div class="verified"><b>✓ “${esc(v.excerpt)}”</b> is backed by ${esc(v.factId)}: “${esc(v.fact)}” <span class="hint">Source: ${esc(v.source)} · valid until ${esc(v.expires)}${v.by ? " · " + esc(v.by) : ""}</span></div>`).join("")}` : ""}
        ${rw}
        ${closed.length ? `<h3>Dismissed</h3>${closed.map(i => issueCard(i)).join("")}` : ""}
        ${(r.fixed || []).length ? `<h3>Fixed so far</h3>${r.fixed.map(f => `<div class="hint">✓ ${esc(f.reference)}: “${esc(f.excerpt)}” ${f.replacement ? "→ “" + esc(f.replacement) + "”" : "removed"}</div>`).join("")}` : ""}
        <div class="submit-bar">
          <button class="btn dark" data-act="submit" ${openBlockers || stale || busy ? "disabled" : ""}>${editingItem ? "Resubmit for review" : "Submit for review"}</button>
          <span class="hint">${submitHint}</span>
        </div>
      </section>`;
    }
    return notices() + viewIntro() + `<div class="grid">${left}${right}</div>`;
  }

  // Screen 2: the review queue. Reviewers approve or request changes; creators revise.
  function viewReview() {
    const items = S.items;
    if (!items.length) return notices() + `<section class="card empty"><div class="big" aria-hidden="true">▪</div><p>Nothing has been submitted yet.</p><p class="hint">Check some content, then click <b>Submit for review</b>, and it will show up here.</p><button class="btn primary" data-act="tab" data-tab="check">Check content</button></section>`;
    const sel = items.find(x => x.id === S.selected) || items[0];
    const list = items.map(it => `<button class="qitem" data-act="select" data-id="${esc(it.id)}" aria-current="${sel && it.id === sel.id}">
      <div class="row" style="justify-content:space-between"><span class="t">${esc(it.title)}</span><span class="status ${it.status}">${it.status.replace("_", " ")}</span></div>
      <div class="m">${esc(it.type)} · v${it.versions.length} · ${esc(it.createdBy || "")} · ${when(it.versions[it.versions.length - 1].at)}</div></button>`).join("");
    let detail = "";
    if (sel) {
      const v = sel.versions[sel.versions.length - 1], prev = sel.versions[sel.versions.length - 2];
      const c = sevCount(v.issues);
      const dismissed = v.issues.filter(i => i.status === "dismissed");
      const openIssues = v.issues.filter(i => i.status === "open");
      const live = sel.status === "in_review";
      const reviewerBtns = isReviewer() && live ? `<div class="row" style="margin-top:12px"><input type="text" id="rcomment" maxlength="500" placeholder="Comment for the creator (required when requesting changes)" style="flex:1;min-width:220px"><button class="btn primary" data-act="approve" data-id="${esc(sel.id)}">Approve</button><button class="btn" data-act="changes" data-id="${esc(sel.id)}">Request changes</button></div>` : "";
      const creatorBtns = !isReviewer() && sel.status === "changes_requested" ? `<div class="row" style="margin-top:12px"><button class="btn primary" data-act="revise" data-id="${esc(sel.id)}">Revise in checker</button><span class="hint">Opens version ${sel.versions.length + 1} with the reviewer's comment.</span></div>` : "";
      const roleNote = !isReviewer() && live ? `<div class="status-line">Waiting for the brand manager.${TEAM.on ? " They'll see it in the team queue straight away." : " To try approving, switch to <b>Arjun · Brand manager</b> at the top."}</div>` : "";
      const approvedNote = sel.status === "approved" ? `<div class="status-line ok-line">Approved. Ready to publish. PixelProof doesn't publish anything itself: copy the final text into your channel. <button class="btn small" data-act="copy" data-id="${esc(sel.id)}">Copy text</button></div>` : "";
      const kitNote = v.kitVersion && (S.kit.version || 1) > v.kitVersion ? `<div class="hint">Checked against brand kit version ${v.kitVersion}; the kit is now on version ${S.kit.version}.</div>` : "";
      detail = `<section class="card" aria-labelledby="h-item">
        <h2 id="h-item">${esc(sel.title)} <span class="status ${sel.status}">${sel.status.replace("_", " ")}</span></h2>
        <div class="hint">${esc(sel.type)} · by ${esc(sel.createdBy)} · version ${v.v} · ${v.aiUsed ? "rules + facts + AI" : "rules + facts"}</div>${kitNote}
        ${roleNote}${approvedNote}
        <h3>${prev ? "Changes since version " + prev.v : "Content"}</h3>
        <div class="diff">${prev ? PP.diffWords(prev.text, v.text).map(p => p.t === "same" ? esc(p.s) : p.t === "add" ? "<ins>" + esc(p.s) + "</ins>" : "<del>" + esc(p.s) + "</del>").join("") : esc(v.text)}</div>
        ${v.image ? `<div class="img-preview"><img src="${v.image.dataUrl}" alt="${esc(v.image.alt || "Submitted image (no alt text given)")}"><div class="hint">Alt text: ${v.image.alt ? "“" + esc(v.image.alt) + "”" : "<b>missing</b>"}</div></div>` : ""}
        <h3>Check results at submission</h3>
        <div class="summary"><span class="pill blocker">${c.blocker} open blockers</span><span class="pill warning">${c.warning} open warnings</span><span class="pill suggestion">${c.suggestion} open suggestions</span><span class="pill ok">${(v.fixed || []).length} fixed by creator</span><span class="pill ok">${v.verified.length} claims verified</span></div>
        ${dismissed.length ? `<h3>Flags the creator dismissed</h3>${dismissed.map(i => `<div class="decision"><span class="sev ${i.severity}">${i.severity}</span><b>${esc(i.reference)}</b> “${esc(i.excerpt)}” — reason: “${esc(i.reason)}” ${i.review ? `<span class="tag">${i.review === "accepted" ? "Reviewer agreed" : "Reviewer disagreed"}</span>` : isReviewer() && live ? `<button class="btn small" data-act="agree" data-id="${esc(sel.id)}" data-key="${i.key}">Agree</button><button class="btn small" data-act="disagree" data-id="${esc(sel.id)}" data-key="${i.key}">Disagree</button>` : ""}</div>`).join("")}` : ""}
        ${openIssues.length ? `<h3>Still open</h3>${openIssues.map(i => `<div class="decision"><span class="sev ${i.severity}">${i.severity}</span><b>${esc(i.reference)}</b> ${i.excerpt ? "“" + esc(i.excerpt) + "”" : ""} <span class="hint">${esc(i.message)}</span> ${i.override ? `<span class="tag">OK'd by reviewer: ${esc(i.override)}</span>` : isReviewer() && live ? `<button class="btn small" data-act="override" data-id="${esc(sel.id)}" data-key="${i.key}">OK to publish</button>` : ""}</div>`).join("")}` : ""}
        ${(v.fixed || []).length ? `<h3>Fixed by the creator</h3>${v.fixed.map(f => `<div class="hint">✓ ${esc(f.reference)}: “${esc(f.excerpt)}” ${f.replacement ? "→ “" + esc(f.replacement) + "”" : "removed"}</div>`).join("")}` : ""}
        ${v.verified.length ? `<h3>Verified claims</h3>${v.verified.map(x => `<div class="verified"><b>✓ “${esc(x.excerpt)}”</b> ← ${esc(x.factId)}: ${esc(x.fact)}</div>`).join("")}` : ""}
        ${reviewerBtns}${creatorBtns}
        <h3>Comments</h3>
        ${sel.comments.map(cm => `<div class="comment"><div class="by">${esc(cm.by)} · ${when(cm.at)}</div>${esc(cm.text)}</div>`).join("") || '<p class="hint">No comments yet.</p>'}
        <div class="row"><input type="text" id="newcomment" maxlength="500" placeholder="Add a comment as ${esc(myName())}" style="flex:1;min-width:200px"><button class="btn" data-act="comment" data-id="${esc(sel.id)}">Comment</button></div>
        <h3>History</h3>
        <ul class="timeline">${sel.history.slice().reverse().map(h => `<li><b>${esc(h.action)}</b> · ${esc(h.by)} · ${when(h.at)}</li>`).join("")}</ul>
      </section>`;
    }
    return notices() + `<div class="queue"><section aria-label="Submitted content"><div class="row" style="justify-content:space-between;margin-bottom:8px"><b>Submitted content</b><span class="hint">Viewing as ${esc(myName())}</span></div>${list}</section>${detail}</div>`;
  }

  // Screen 3: the brand kit (voice, glossary, facts, palette, rules, guideline history). Only reviewers can edit.
  function viewKit() {
    const k = S.kit, edit = isReviewer(), today = PP.todayISO();
    const soon = d => { const days = (new Date(d) - new Date(today)) / 864e5; return days >= 0 && days <= 60; };
    const ro = edit ? "" : `<div class="status-line">You're viewing as a creator, so the brand kit is read-only.${TEAM.on ? " Ask a brand manager to change it." : " Switch to <b>Arjun · Brand manager</b> to edit it."}</div>`;
    const hist = (k.history || []).slice().reverse();
    return notices() + `${ro}
    <div class="grid">
      <section class="card"><h2>Brand voice · ${esc(k.brand)} <span class="tag">kit version ${k.version || 1}</span></h2>
        ${edit ? `<label class="field" for="voice">Voice summary</label><textarea id="voice" data-kit="voice" maxlength="600" style="min-height:70px">${esc(k.voice && k.voice.summary)}</textarea>` : `<p>${esc(k.voice && k.voice.summary)}</p>`}
        <h3>Do</h3><ul>${((k.voice && k.voice.do) || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
        <h3>Don't</h3><ul>${((k.voice && k.voice.dont) || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
        <h3>Key messages</h3><ul>${(k.messaging || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
        <h3>Visual identity: palette</h3>
        <div class="swatches">${(k.palette || []).map((p, n) => `<span class="swatch"><i style="background:${esc(p.hex)}"></i>${esc(p.name)} ${esc(p.hex)}${edit ? ` <button class="btn small ghost" data-act="del-pal" data-n="${n}" aria-label="Remove ${esc(p.name)}">×</button>` : ""}</span>`).join("")}</div>
        ${edit ? `<div class="row" style="margin-top:8px"><input type="text" id="palName" maxlength="40" placeholder="Colour name" style="flex:1"><input type="text" id="palHex" maxlength="7" placeholder="#RRGGBB" style="width:110px"><button class="btn small" data-act="add-pal">Add colour</button></div>` : ""}
        ${edit ? `<h3>Manage</h3><div class="row"><button class="btn small" data-act="export-kit">Export brand kit (JSON)</button><label class="btn small" for="importKit">Import JSON</label><input id="importKit" type="file" accept=".json,application/json" data-act="import-kit" class="sr-only">${TEAM.on ? (isAdmin() ? `<button class="btn small ghost" data-act="team-reset">Reset to sample content</button>` : "") : `<button class="btn small ghost" data-act="reset">Reset demo data</button>`}</div>` : ""}
      </section>
      <section class="card"><h2>Glossary</h2>
        <table class="kit"><thead><tr><th>Use</th><th>Avoid</th><th>Why</th>${edit ? "<th></th>" : ""}</tr></thead><tbody>
        ${(k.glossary || []).map((g, n) => `<tr><td class="id">${esc(g.use)}</td><td>${(g.avoid || []).map(esc).join(", ")}</td><td>${esc(g.note)}</td>${edit ? `<td><button class="btn small ghost" data-act="del-gl" data-n="${n}" aria-label="Delete">×</button></td>` : ""}</tr>`).join("") || `<tr><td colspan="4" class="hint">No glossary terms yet.</td></tr>`}</tbody></table>
        ${edit ? `<div class="kit-form"><div><label class="field" for="glUse">Use</label><input id="glUse" type="text" maxlength="60" placeholder="Savings Pot"></div><div><label class="field" for="glAvoid">Avoid (comma separated)</label><input id="glAvoid" type="text" maxlength="200"></div><div><label class="field" for="glNote">Why</label><input id="glNote" type="text" maxlength="200"></div><button class="btn small" data-act="add-gl">Add</button></div>` : ""}
      </section>
    </div>
    <section class="card" style="margin-top:20px"><h2>Approved facts</h2>
      <p class="hint">Every number or claim in content must match one of these. Expired facts are rejected automatically.</p>
      <table class="kit"><thead><tr><th>ID</th><th>Fact</th><th>Source</th><th>Valid until</th>${edit ? "<th></th>" : ""}</tr></thead><tbody>
      ${(k.facts || []).map((f, n) => `<tr><td class="id">${esc(f.id)}</td><td>${esc(f.text)}</td><td>${esc(f.source)}<br><span class="hint">${esc(f.owner || "")}</span></td><td>${esc(f.expires)} ${PP.isExpired(f, today) ? '<span class="tag exp">expired</span>' : soon(f.expires) ? '<span class="tag soon">expires soon</span>' : ""}</td>${edit ? `<td><button class="btn small ghost" data-act="del-fact" data-n="${n}" aria-label="Delete">×</button></td>` : ""}</tr>`).join("") || `<tr><td colspan="5" class="hint">No approved facts yet, so every number will be flagged.</td></tr>`}</tbody></table>
      ${edit ? `<div class="kit-form"><div><label class="field" for="fText">New fact</label><input id="fText" type="text" maxlength="300" placeholder="e.g. Savers can withdraw any time with no penalty."></div><div><label class="field" for="fSrc">Source</label><input id="fSrc" type="text" maxlength="120"></div><div><label class="field" for="fExp">Valid until</label><input id="fExp" type="date"></div><button class="btn small" data-act="add-fact">Add fact</button></div>` : ""}
    </section>
    ${edit ? importCard() : ""}
    <section class="card" style="margin-top:20px"><h2>Rules</h2>
      <table class="kit"><thead><tr><th>ID</th><th>Rule</th><th>Area</th><th>Severity</th><th>On</th></tr></thead><tbody>
      ${k.rules.map((r, n) => `<tr class="${r.enabled === false ? "off" : ""}"><td class="id">${esc(r.id)}${r.revisedAt ? '<br><span class="tag soon">revised</span>' : ""}${r.importedFrom ? '<br><span class="tag">imported</span>' : ""}</td><td><b>${esc(r.title)}</b><br><span class="hint">${esc(r.detail)}</span>${r.quote ? `<br><span class="hint">From the guideline: \u201c${esc(r.quote)}\u201d</span>` : ""}${r.importedFrom && !(r.patterns || []).length ? `<br><span class="hint">Checked by the AI review (no exact phrases to match).</span>` : ""}${r.examples && (r.examples.allowed || []).length ? `<br><span class="hint">✓ Allowed: ${r.examples.allowed.map(x => "“" + esc(x) + "”").join(", ")}</span>` : ""}${r.examples && (r.examples.notAllowed || []).length ? `<br><span class="hint">✗ Not allowed: ${r.examples.notAllowed.map(x => "“" + esc(x) + "”").join(", ")}</span>` : ""}</td><td>${esc(r.category)}</td>
        <td>${edit ? `<select data-act="sev" data-n="${n}" aria-label="Severity for ${esc(r.id)}">${["blocker", "warning", "suggestion"].map(s => `<option ${s === r.severity ? "selected" : ""}>${s}</option>`).join("")}</select>` : `<span class="sev ${r.severity}">${r.severity}</span>`}</td>
        <td>${edit ? `<input type="checkbox" data-act="toggle-rule" data-n="${n}" ${r.enabled === false ? "" : "checked"} aria-label="Rule ${esc(r.id)} on">` : (r.enabled === false ? "off" : "on")}</td></tr>`).join("")}</tbody></table>
    </section>
    <section class="card" style="margin-top:20px"><h2>Guideline history</h2>
      <p class="hint">Every rule change approved from the guideline gap detector (Insights) and every guideline import is recorded here and can be undone.</p>
      ${hist.length ? `<table class="kit"><thead><tr><th>Version</th><th>Rule</th><th>What changed</th><th>By</th>${edit ? "<th></th>" : ""}</tr></thead><tbody>${hist.map(h => `<tr><td class="id">v${h.version}</td><td><b>${esc(h.ruleId)}</b> ${esc(h.title || "")}</td><td>${esc(h.summary)}${h.kind && h.kind.startsWith("import") ? "" : `<br><span class="hint">Before: “${esc(h.before && h.before.detail)}”<br>After: “${esc(h.after && h.after.detail)}”${h.source ? " · suggested by " + esc(h.source) : ""}</span>`}</td><td>${esc(h.by)}<br><span class="hint">${when(h.at)}</span></td>${edit ? `<td>${h.kind === "import-undo" ? "" : `<button class="btn small" data-act="kit-undo" data-v="${h.version}">Undo</button>`}</td>` : ""}</tr>`).join("")}</tbody></table>` : `<p class="hint">No changes yet. Open <b>Insights</b> to see rules people keep pushing back on.</p>`}
    </section>`;
  }

  // Screen 4: insights and the guideline gap detector.
  function viewInsights() {
    const all = []; S.items.forEach(it => it.versions.forEach(v => v.issues.concat((v.fixed || []).map(f => Object.assign({ status: "fixed" }, f))).forEach(i => all.push(i))));
    const by = (arr, f) => { const m = {}; arr.forEach(x => { const k = f(x); if (k) m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
    const ruleTitle = id => { const r = S.kit.rules.find(x => x.id === id); if (r) return id + " · " + r.title; const g = (S.kit.glossary || []).find(x => x.id === id); return g ? id + " · Glossary: " + g.use : id; };
    const byRule = by(all, i => i.ruleId).slice(0, 8);
    const max = byRule.length ? byRule[0][1] : 1;
    const approved = S.items.filter(i => i.status === "approved").length;
    const today = PP.todayISO();
    const expiring = (S.kit.facts || []).filter(f => { const days = (new Date(f.expires) - new Date(today)) / 864e5; return days <= 60; });
    const gaps = PP.analyseGaps(S.items, S.kit);
    const note = S.gapNote ? `<div class="status-line ok-line" role="status">✓ Guideline <b>${esc(S.gapNote.ruleId)}</b> updated in brand kit version ${S.gapNote.version}: ${esc(S.gapNote.summary)}. ${S.gapNote.tryText ? `<button class="btn small" data-act="gap-try">See the next check change: re-check “${esc(S.gapNote.tryText.title)}”</button>` : ""} <button class="btn small ghost" data-act="gap-note-close">Close</button></div>` : "";
    const gapCards = gaps.map(g => {
      const r = g.rule; const editing = S.gapEdit && S.gapEdit.ruleId === g.ruleId;
      const lvl = g.level === "unclear" ? '<span class="tag soon">likely unclear</span>' : '<span class="tag">worth watching</span>';
      return `<div class="gap ${g.level}">
        <div class="row" style="justify-content:space-between"><b>${esc(ruleTitle(g.ruleId))}</b>${lvl}</div>
        <div class="gap-stats"><span><b>${g.flagged}</b> flagged</span><span><b>${g.dismissed}</b> dismissed by creators</span><span><b>${g.overridden}</b> allowed by reviewers</span><span><b>${g.disagreed}</b> reviewer disagreed</span><span><b>${g.fixed}</b> fixed</span><span><b>${Math.round(g.rate * 100)}%</b> pushback</span></div>
        <p class="hint">Current wording: “${esc(r.detail)}”</p>
        ${g.reasons.length ? `<ul class="reasons">${g.reasons.slice(0, 4).map(x => `<li><b>${esc(x.kind)}</b> “${esc(x.excerpt)}”: ${esc(x.text)}</li>`).join("")}</ul>` : ""}
        ${editing ? gapEditor(g) : isReviewer() ? `<button class="btn small primary" data-act="gap-suggest" data-rule="${esc(g.ruleId)}">Suggest a clearer rule</button>` : `<p class="hint">Your brand manager can update this rule from here.</p>`}
      </div>`;
    }).join("");
    return notices() + `<div class="stats">
        <div class="stat"><div class="n">${S.stats.checks}</div><div class="l">checks run ${TEAM.on ? "on this device" : "in this browser"}</div></div>
        <div class="stat"><div class="n">${S.items.length}</div><div class="l">pieces submitted</div></div>
        <div class="stat"><div class="n">${approved}</div><div class="l">approved</div></div>
        <div class="stat"><div class="n">${gaps.filter(g => g.level === "unclear").length}</div><div class="l">rules that look unclear</div></div>
      </div>
      ${note}
      <section class="card gaps-card"><h2>Guideline gap detector</h2>
        <p class="hint">When creators keep dismissing a rule, or reviewers keep letting it through, the rule is probably unclear. PixelProof ranks those rules, drafts clearer wording from what people actually did, and the brand manager approves the change. Approved changes apply to the very next check.</p>
        ${gapCards || `<p class="hint">No rule is getting pushback right now. When people dismiss or override flags, the rules involved will show up here.</p>`}
      </section>
      <div class="grid" style="margin-top:20px">
        <section class="card"><h2>Most common issues</h2>
          ${byRule.map(([id, n]) => `<div class="bar"><span>${esc(ruleTitle(id))}</span><div class="track"><div class="fill" style="width:${(n / max) * 100}%"></div></div><b>${n}</b></div>`).join("") || '<p class="hint">No data yet.</p>'}
          <h3>By area</h3>
          ${by(all, i => i.category).map(([c, n]) => `<div class="bar"><span>${esc(c)}</span><div class="track"><div class="fill alt" style="width:${(n / Math.max(1, all.length)) * 100}%"></div></div><b>${n}</b></div>`).join("") || '<p class="hint">No data yet.</p>'}
        </section>
        <section class="card"><h2>Facts to update</h2>
          ${expiring.map(f => `<div class="flag"><b>${esc(f.id)}</b> ${PP.isExpired(f, today) ? "expired on" : "expires on"} ${esc(f.expires)}: “${esc(f.text)}”</div>`).join("") || '<p class="hint">All facts are current.</p>'}
        </section>
      </div>`;
  }
  function gapEditor(g) {
    const e = S.gapEdit, ch = e.change, r = g.rule;
    const aiLine = e.ai === "running" ? `<div class="status-line ai-run" role="status">The AI is drafting clearer wording from this evidence… a code-based draft is shown meanwhile.</div>`
      : e.ai === "done" ? `<div class="status-line ai-run">Drafted by ${esc(ch.source)}. Edit anything before approving.</div>`
      : e.ai === "error" ? `<div class="status-line">${esc(e.aiMsg || "The AI suggestion didn't arrive.")} <button class="btn small" data-act="gap-ai">Try the AI again</button></div>`
      : `<div class="status-line">Drafted by code from the evidence above (AI review is off). Edit anything before approving.</div>`;
    return `<div class="gap-editor" aria-label="Suggested change for ${esc(r.id)}">
      ${aiLine}
      <label class="field" for="gx-detail">New wording</label><textarea id="gx-detail" maxlength="400" style="min-height:64px">${esc(ch.detail)}</textarea>
      <div class="row"><div style="flex:1;min-width:200px"><label class="field" for="gx-allowed">✓ Allowed examples (one per line)</label><textarea id="gx-allowed" style="min-height:60px">${esc(ch.allowed.join("\n"))}</textarea></div>
      <div style="flex:1;min-width:200px"><label class="field" for="gx-notallowed">✗ Not allowed examples (one per line)</label><textarea id="gx-notallowed" style="min-height:60px">${esc(ch.notAllowed.join("\n"))}</textarea></div></div>
      <div class="row"><div><label class="field" for="gx-sev">Severity</label><select id="gx-sev">${["blocker", "warning", "suggestion"].map(s => `<option ${s === ch.severity ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      ${(r.patterns || []).length ? `<fieldset class="pats"><legend class="field">Stop flagging these phrases</legend>${r.patterns.map(p => `<label><input type="checkbox" data-gx-pat value="${esc(p)}" ${ch.removePatterns.includes(p) ? "checked" : ""}> ${esc(humanPattern(p))}</label>`).join("")}</fieldset>` : ""}</div>
      ${ch.rationale ? `<p class="hint">Why: ${esc(ch.rationale)}</p>` : ""}
      ${e.errors.length ? `<div class="status-line warn" role="alert">${e.errors.map(esc).join(" ")}</div>` : ""}
      <div class="row"><button class="btn primary" data-act="gap-approve" ${e.ai === "running" ? "disabled" : ""}>Approve and update the guideline</button><button class="btn ghost" data-act="gap-cancel">Discard</button></div>
    </div>`;
  }

  // Screen 5: the team workspace (sign in, create or join a workspace, members and roles).
  function viewTeam() {
    if (!TEAM.ready) return `<section class="card empty"><p>Checking for a team workspace…</p></section>`;
    const intro = `<p>In demo mode everything stays in this browser. A <b>team workspace</b> shares the brand kit and the review queue with your team, live, on any device. A creator submits on their laptop and the brand manager approves on theirs.</p>`;
    if (!TEAM.configured) {
      return `<section class="card prose"><h2>Team workspace</h2>${intro}
        <div class="status-line">The team workspace isn't set up on this deployment yet. Everything else works in demo mode.</div>
        <p class="hint">To set it up: create a free Supabase project, run <code>supabase/schema.sql</code>, and add <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> to the deployment. Full steps are in the README.</p></section>`;
    }
    if (!TEAMAPI.user) {
      const signup = TEAM.form === "signup";
      return `<div class="grid"><section class="card"><h2>${signup ? "Create an account" : "Sign in to your team"}</h2>${intro}
        <form id="authForm" class="auth">
          <label class="field" for="tEmail">Email</label><input id="tEmail" type="email" autocomplete="email" required maxlength="120">
          <label class="field" for="tPass">Password</label><input id="tPass" type="password" autocomplete="${signup ? "new-password" : "current-password"}" required minlength="6" maxlength="72">
          <div class="row" style="margin-top:12px"><button class="btn primary" type="submit" ${TEAM.working ? "disabled" : ""}>${TEAM.working ? "Please wait…" : signup ? "Create account" : "Sign in"}</button>
          <button class="btn ghost" type="button" data-act="team-form" data-form="${signup ? "signin" : "signup"}">${signup ? "I already have an account" : "Create a new account"}</button></div>
          ${TEAM.error ? `<div class="status-line warn" role="alert" style="margin-top:10px">${esc(TEAM.error)}</div>` : ""}
        </form></section>
        <section class="card"><h2>Try it with the demo team</h2>
          <p>Two demo accounts let you try it as a team. <b>Sign in as Arjun</b> makes a fresh private copy of the Kitebird Money workspace just for you, so nobody else's changes get in your way. Then open a private window, <b>sign in as Riya</b>, and join with the code Arjun's screen shows. Submissions and approvals appear live in both.</p>
          ${DEMO_ACCOUNTS.map(a => `<div class="demo-acct"><div><b>${esc(a.name)}</b> · ${esc(a.role)}<br><span class="hint">${esc(a.email)} · password ${esc(DEMO_PASSWORD)}</span></div><button class="btn small primary" data-act="team-demo" data-email="${esc(a.email)}" ${TEAM.working ? "disabled" : ""}>Sign in as ${esc(a.name)}</button></div>`).join("")}
          <p class="hint">Please don't put real content in the demo accounts: anyone trying the app can sign in to them.</p>
        </section></div>`;
    }
    if (!TEAM.on) {
      if (TEAM.list === null) { setTimeout(loadWorkspaceList, 0); return `<section class="card empty"><p>Loading your workspaces…</p></section>`; }
      return `<div class="grid"><section class="card"><h2>Your workspaces</h2><p class="hint">Signed in as ${esc(TEAMAPI.user.email)} <button class="btn small ghost" data-act="team-signout">Sign out</button></p>
        ${TEAM.list.map(w => `<div class="demo-acct"><div><b>${esc(w.name)}</b><br><span class="hint">You're ${esc(ROLE_LABEL[w.role])} as “${esc(w.displayName)}”</span></div><button class="btn small primary" data-act="team-open" data-id="${esc(w.id)}" ${TEAM.working ? "disabled" : ""}>Open</button></div>`).join("") || `<p class="hint">You're not in a workspace yet. Create one, or join with a code from your team.</p>`}
        ${TEAM.error ? `<div class="status-line warn" role="alert">${esc(TEAM.error)}</div>` : ""}
        <p class="hint" style="margin-top:12px"><button class="btn small ghost" data-act="tab" data-tab="check">Back to demo mode</button></p></section>
        <section class="card"><h2>Join a workspace</h2>${TEAM.demoJoin ? `<div class="status-line ok-line">Signed in as Riya. Enter the 6-character code shown on Arjun's Team page.</div>` : ""}
          <form id="joinForm"><label class="field" for="jCode">6-character code from your team</label><input id="jCode" type="text" maxlength="6" required style="text-transform:uppercase;letter-spacing:2px">
          <label class="field" for="jName">Your name (shown to the team)</label><input id="jName" type="text" maxlength="60" required value="${TEAM.demoJoin ? "Riya" : ""}">
          <div class="row" style="margin-top:10px"><button class="btn primary" type="submit" ${TEAM.working ? "disabled" : ""}>Join</button></div></form>
          <h2 style="margin-top:22px">Create a workspace</h2>
          <form id="createForm"><label class="field" for="cName">Workspace name</label><input id="cName" type="text" maxlength="80" required placeholder="e.g. Kitebird Money marketing">
          <label class="field" for="cMe">Your name (shown to the team)</label><input id="cMe" type="text" maxlength="60" required>
          <label class="check"><input id="cSample" type="checkbox" checked> Start with the Kitebird Money demo brand kit and sample content</label>
          <div class="row" style="margin-top:10px"><button class="btn primary" type="submit" ${TEAM.working ? "disabled" : ""}>Create</button></div></form>
        </section></div>`;
    }
    const admin = isAdmin() && TEAM.role === "admin";
    return `<div class="grid"><section class="card"><h2>${esc(TEAM.ws.name)}</h2>
        <p>You're signed in as <b>${esc(TEAM.me.name)}</b> (${ROLE_LABEL[TEAM.role]}). Changes to the review queue and brand kit are shared with everyone here, live.</p>
        <div class="demo-acct"><div><b>Join code</b><br><span class="code">${esc(TEAM.ws.code)}</span></div><button class="btn small" data-act="copy-code">Copy</button></div>
        <p class="hint">Share this code with teammates. They create an account, then join with it as creators. ${admin ? "You can then change their role below." : ""}</p>
        <div class="row"><button class="btn small" data-act="team-leave">Back to demo mode</button><button class="btn small ghost" data-act="team-signout">Sign out</button></div>
      </section>
      <section class="card"><h2>Team members</h2>
        <table class="kit"><thead><tr><th>Name</th><th>Role</th></tr></thead><tbody>
        ${TEAM.members.map(m => `<tr><td>${esc(m.display_name)}${m.user_id === TEAM.me.id ? " (you)" : ""}</td><td>${admin && m.user_id !== TEAM.me.id ? `<select data-act="team-role" data-user="${esc(m.user_id)}" aria-label="Role for ${esc(m.display_name)}">${["creator", "reviewer", "admin"].map(r => `<option value="${r}" ${r === m.role ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select>` : ROLE_LABEL[m.role]}</td></tr>`).join("")}
        </tbody></table>
        <p class="hint">Creators check and submit content. Brand managers also approve, request changes and edit the brand kit. Admins also manage roles. These permissions are enforced by the database, not just the screen.</p>
      </section></div>`;
  }

  function viewAbout() {
    return notices() + `<section class="card prose"><h2>How PixelProof checks content</h2>
      <p>Content goes in before it's published. PixelProof checks it against the brand kit and every issue comes back with the rule it breaks and a suggested fix. A person always makes the final call.</p>
      <div class="layer"><div class="num">1</div><div><b>Rule checks.</b> Exact checks for banned or pushy phrases, wrong product names, guarantees, competitor names, link text, emoji overload, all caps, long sentences and hashtags. Instant and repeatable: the same text always gets the same result.</div></div>
      <div class="layer"><div class="num">2</div><div><b>Fact checks.</b> Every number and ranking is matched against the approved fact library. If a figure doesn't match, comes from an expired fact or has no source, it's a blocker. Dates and times aren't treated as claims. This is done in code, not by the AI.</div></div>
      <div class="layer"><div class="num">3</div><div><b>AI review</b> (when configured). Checks tone, voice, messaging, spelling and grammar, finds claims without numbers, and suggests rewrites. Before anything is shown, code checks the AI's answer: the quoted words must be in your text, the rule must exist, and a "supported" claim must quote a real, unexpired fact. Anything that fails is thrown out or treated as unsupported. Rewrites are re-checked by the rules.</div></div>
      <div class="layer"><div class="num">4</div><div><b>Visual checks.</b> Uploaded images are analysed in your browser: main colours are compared with the brand palette, the two main colours are checked for contrast, and alt text is required.</div></div>
      <div class="layer"><div class="num">5</div><div><b>Guideline gap detector.</b> When people keep dismissing or overriding a rule, Insights ranks it as unclear, drafts clearer wording with examples from real content, and the brand manager approves it. Every change is recorded in the brand kit's history and can be undone.</div></div>
      <h3>Check where you write: the Chrome extension</h3>
      <p>The PixelProof extension adds a <b>Check</b> button to the compose box on <b>LinkedIn, Gmail and X</b>, highlights problems right in your draft, and lets you apply fixes in place. On any other page, select text and right-click <b>Check with PixelProof</b>.</p>
      <ol><li><a href="/downloads/pixelproof-extension.zip" download>Download the extension (.zip)</a> and unzip it.</li><li>In Chrome, open <code>chrome://extensions</code> and turn on <b>Developer mode</b> (top right).</li><li>Click <b>Load unpacked</b> and choose the unzipped <code>pixelproof-extension</code> folder.</li><li>Open a LinkedIn post, a Gmail draft or an X post, type, and click the <b>▪ Check</b> button.</li></ol>
      <h3>AI use and privacy</h3>
      <ul>
        <li>AI provider: ${AI.enabled ? esc(AI.provider + " (" + AI.model + (AI.backupModel ? ", backup " + AI.backupModel : "") + ")") : "none configured on this deployment, so PixelProof runs in rules-only mode"}.</li>
        <li>Emails, phone numbers, PAN and ID-style numbers are masked before any text is sent to the AI, both in the browser and again on the server.</li>
        <li>The API key stays on the server and is never sent to the browser.</li>
        <li>Findings from the AI are labelled “AI check”. Findings from rules are labelled “Rule check” or “Fact check”.</li>
        <li>Demo mode stores everything in your browser. Team workspaces store the brand kit and review queue in a database where row level security keeps each team's data private.</li>
        <li>PixelProof can be wrong. It never edits or publishes anything without a person clicking.</li>
      </ul>
      <h3>Demo notes</h3>
      <ul>
        <li>Kitebird Money, its partner bank and its brand kit are made up.</li>
        <li>In demo mode, switch between <b>Riya · Creator</b> and <b>Arjun · Brand manager</b> at the top. In a team workspace, each person signs in.</li>
        <li>Built by Team Pixel (Akshay Singh) for CodeNova India 2026. AI assistance was used in building this and is disclosed in the project README.</li>
      </ul></section>`;
  }

  // ---------- render ----------
  // Draws the current screen. Called after every change.
  function render() {
    pendingRender = false;
    document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
    const roleBox = document.querySelector(".role");
    roleBox.hidden = TEAM.on;
    document.querySelectorAll(".role button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.role === S.role)));
    const acct = document.getElementById("account");
    acct.hidden = !TEAM.on;
    if (TEAM.on) acct.innerHTML = `<button class="badge team" data-tab-link="team" title="Team workspace">▪ ${esc(TEAM.ws.name)} · ${esc(TEAM.me.name)} (${ROLE_LABEL[TEAM.role]})</button>`;
    const pending = S.items.filter(i => isReviewer() ? i.status === "in_review" : i.status === "changes_requested").length;
    const qc = document.getElementById("queueCount"); qc.hidden = !pending; qc.textContent = pending;
    const badge = document.getElementById("aiBadge");
    if (AI.checked) { badge.className = "badge " + (AI.enabled ? "on" : "off"); badge.textContent = AI.enabled ? "AI review on" : "Rules-only mode"; }
    const focusId = document.activeElement && document.activeElement.id; const caret = document.activeElement && document.activeElement.selectionStart;
    const views = { check: viewCheck, review: viewReview, kit: viewKit, insights: viewInsights, team: viewTeam, about: viewAbout };
    $app.innerHTML = (views[S.tab] || viewCheck)();
    if (focusId) { const el = document.getElementById(focusId); if (el && el.tagName !== "BUTTON") { el.focus(); try { if (caret != null) el.setSelectionRange(caret, caret); } catch (e) { /* not a text input */ } } }
  }
  // Re-draws without wiping out something the person is in the middle of typing (used for live team updates).
  function safeRender() {
    const a = document.activeElement;
    const typing = a && $app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !a.dataset.bind && (a.value || "").length > 0;
    if (typing || S.gapEdit || S.importEdit) { pendingRender = true; return; }
    render();
  }
  $app.addEventListener("focusout", () => { if (pendingRender) setTimeout(() => { if (pendingRender) safeRender(); }, 150); });

  // ---------- events ----------
  // What happens when the user clicks, types or uploads something.
  function go(tab) { S.tab = tab; save(); render(); window.scrollTo(0, 0); }
  document.querySelector("nav.tabs").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) go(b.dataset.tab); });
  document.getElementById("account").addEventListener("click", e => { if (e.target.closest("[data-tab-link]")) go("team"); });
  document.querySelector(".role").addEventListener("click", e => {
    const b = e.target.closest("button[data-role]"); if (!b || TEAM.on) return;
    S.role = b.dataset.role; S.gapEdit = null;
    if (S.role === "reviewer" && S.tab === "check") { const p = S.items.find(i => i.status === "in_review"); if (p) S.selected = p.id; }
    save(); render(); toast("Now viewing as " + DEMO_PEOPLE[S.role]);
  });

  $app.addEventListener("input", e => {
    const t = e.target, b = t.dataset.bind;
    if (b === "text" || b === "title") {
      S.draft[b] = t.value; save();
      if (b === "text") {
        const c = document.getElementById("counter"); const n = t.value.length;
        if (c) c.textContent = n ? n.toLocaleString() + " characters" + (n > AI_LIMIT && AI.enabled ? " · the AI review reads the first 6,000; rule and fact checks cover all of it" : "") + " · Ctrl+Enter to check" : "";
        if (S.draft.result) { clearTimeout(window.__ppT); window.__ppT = setTimeout(render, 600); }
      }
    }
    if (b === "alt" && S.draft.image) { S.draft.image.alt = t.value; save(); }
    if (t.dataset.kit === "voice" && isReviewer()) { S.kit.voice.summary = t.value; save(); clearTimeout(window.__ppV); window.__ppV = setTimeout(persistKit, 800); }
  });
  $app.addEventListener("keydown", e => {
    if (e.target.id === "text" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runCheck(); }
  });
  $app.addEventListener("change", async e => {
    const t = e.target;
    if (t.dataset.bind === "type") { S.draft.type = t.value; save(); }
    if (t.dataset.bind === "alt" && S.draft.result) { S.draft.result = localResult(S.draft.text, S.draft.result); save(); render(); }
    if (t.dataset.act === "doc" && t.files[0]) {
      const f = t.files[0]; toast("Reading " + f.name + "…");
      try {
        const text = await readDocument(f);
        if (!text.trim()) throw new Error("No text was found in that file. If it's a scanned image, paste the text instead.");
        S.draft.text = text; S.draft.type = "Document"; if (!S.draft.title) S.draft.title = f.name.replace(/\.[^.]+$/, "").slice(0, 120); S.draft.result = null; save(); render(); await runCheck();
      } catch (err) { toast(err.message); t.value = ""; }
    }
    if (t.dataset.act === "img" && t.files[0]) {
      try { S.draft.image = await readImage(t.files[0]); imageIssues(); if (S.draft.result) S.draft.result = localResult(S.draft.text, S.draft.result); save(); render(); toast("Image added. Add alt text, then check."); }
      catch (err) { toast(err.message); t.value = ""; }
    }
    if (t.dataset.imp && S.importEdit) { const x = S.importEdit.v[t.dataset.imp][+t.dataset.n]; if (x) x.on = t.checked; return; }
    if (t.dataset.impSev !== undefined && S.importEdit) { const r = S.importEdit.v.rules[+t.dataset.impSev]; if (r) r.severity = t.value; return; }
    if (t.dataset.act === "guide-file" && t.files[0] && isReviewer()) {
      const f = t.files[0]; toast("Reading " + f.name + "\u2026");
      try {
        const text = await readDocument(f);
        if (text.trim().length < 40) throw new Error("There's almost no text in that file. If it's a scanned document, try a text PDF or Word file.");
        await startImport(f.name, text);
      } catch (err) { toast(err.message); }
      t.value = "";
      return;
    }
    if (t.dataset.act === "import-kit" && t.files[0]) {
      try {
        const k = JSON.parse(await t.files[0].text());
        const okRules = Array.isArray(k.rules) && k.rules.length && k.rules.every(r => r && r.id && r.title && typeof r.detail === "string");
        if (!okRules || !Array.isArray(k.facts) || !Array.isArray(k.glossary)) throw new Error("bad");
        k.palette = Array.isArray(k.palette) ? k.palette.filter(p => p && /^#[0-9a-f]{6}$/i.test(p.hex)) : [];
        k.voice = k.voice && typeof k.voice === "object" ? k.voice : { summary: "", do: [], dont: [] };
        k.messaging = Array.isArray(k.messaging) ? k.messaging : [];
        k.rules.forEach(r => { r.patterns = Array.isArray(r.patterns) ? r.patterns.filter(p => { try { new RegExp(p); return true; } catch (er) { return false; } }) : []; if (!PP.SEV_ORDER.hasOwnProperty(r.severity)) r.severity = "warning"; });
        k.version = (S.kit.version || 1) + 1; k.history = S.kit.history || [];
        S.kit = k; render(); await persistKit(); toast("Brand kit imported.");
      } catch (err) { toast("That doesn't look like a PixelProof brand kit file (it needs rules, facts and a glossary)."); }
      t.value = "";
    }
    if (t.dataset.act === "sev" && isReviewer()) { S.kit.rules[+t.dataset.n].severity = t.value; render(); await persistKit(); }
    if (t.dataset.act === "toggle-rule" && isReviewer()) { S.kit.rules[+t.dataset.n].enabled = t.checked; render(); await persistKit(); }
    if (t.dataset.act === "team-role") {
      try { await TEAMAPI.setRole(TEAM.ws.id, t.dataset.user, t.value); toast("Role updated."); } catch (err) { toast(TEAMAPI.friendly(err)); }
      await refreshTeam(); render();
    }
  });

  $app.addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target;
    if (TEAM.working) return;
    // read the form before re-drawing the screen (re-drawing clears the inputs)
    const v = {}; f.querySelectorAll("input").forEach(el => { v[el.id] = el.type === "checkbox" ? el.checked : el.value.trim(); });
    if (f.id === "authForm") v.tPass = f.querySelector("#tPass").value;
    TEAM.working = true; TEAM.error = ""; render();
    try {
      if (f.id === "authForm") {
        if (TEAM.form === "signup") await TEAMAPI.signUp(v.tEmail, v.tPass); else await TEAMAPI.signIn(v.tEmail, v.tPass);
        TEAM.list = null;
      } else if (f.id === "joinForm") {
        const id = await TEAMAPI.joinWorkspace(v.jCode.toUpperCase(), v.jName);
        TEAM.working = false; await openWorkspace(id); return;
      } else if (f.id === "createForm") {
        const sample = v.cSample;
        const kit = sample ? clone(KIT.DEMO_KIT) : blankKit(v.cName);
        const ws = await TEAMAPI.createWorkspace(v.cName, kit, v.cMe);
        if (sample) { for (const it of seedItems(kit)) await TEAMAPI.saveItem(ws.id, it); }
        TEAM.working = false; await openWorkspace(ws.id); return;
      }
    } catch (err) { TEAM.error = TEAMAPI.friendly(err); }
    TEAM.working = false; render();
    // put back what was typed (except the password) so a mistake doesn't mean starting over
    Object.keys(v).forEach(id => { const el = document.getElementById(id); if (el && id !== "tPass") { if (el.type === "checkbox") el.checked = v[id]; else el.value = v[id]; } });
  });
  function blankKit(name) {
    const k = clone(KIT.DEMO_KIT);
    return Object.assign(k, { brand: name.trim() || "My brand", about: "", facts: [], glossary: [], messaging: [], palette: [{ name: "Black", hex: "#000000" }, { name: "White", hex: "#FFFFFF" }],
      voice: { summary: "Describe how your brand sounds.", do: [], dont: [], goodExample: "", badExample: "" }, version: 1, history: [] });
  }

  $app.addEventListener("click", async e => {
    const b = e.target.closest("[data-act]"); if (!b || b.tagName === "INPUT" || b.tagName === "SELECT" || b.disabled) return;
    const act = b.dataset.act, d = S.draft;
    const item = b.dataset.id && S.items.find(x => x.id === b.dataset.id);
    const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
    const live = item && item.status === "in_review";
    switch (act) {
      case "tab": go(b.dataset.tab); return;
      case "hide-intro": S.introHidden = true; break;
      case "sample": { if (busy) return; const s = KIT.SAMPLES[+b.dataset.n]; d.text = s.text; d.type = s.type; d.title = s.title; d.result = null; break; }
      case "check": await runCheck(); return;
      case "retry-ai": if (d.result && AI.enabled && !busy) { busy = true; try { await runAI(); } finally { busy = false; save(); render(); } } return;
      case "clear": if (busy) return; S.draft = Object.assign(freshDraft(), { itemId: d.itemId }); break;
      case "remove-img": d.image = null; if (d.result) d.result = localResult(d.text, d.result); break;
      case "fix": if (busy) return; applyFixTo(b.dataset.key, +b.dataset.n); return;
      case "dismiss": {
        const slot = b.closest(".issue").querySelector(".dismiss-slot");
        slot.innerHTML = `<div class="dismiss-form"><input type="text" maxlength="300" placeholder="Why is this OK? (required)" aria-label="Reason for dismissing"><button class="btn small dark" data-act="dismiss-ok" data-key="${b.dataset.key}">Dismiss</button></div>`;
        const input = slot.querySelector("input"); input.focus();
        input.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); slot.querySelector("button").click(); } });
        return;
      }
      case "dismiss-ok": {
        const input = b.parentElement.querySelector("input"); const reason = input.value.trim();
        if (reason.length < 4) { input.focus(); toast("Please give a short reason. Reviewers see it."); return; }
        const i = d.result && d.result.issues.find(x => x.key === b.dataset.key); if (i) { i.status = "dismissed"; i.reason = reason; }
        break;
      }
      case "undismiss": { const i = d.result && d.result.issues.find(x => x.key === b.dataset.key); if (i) { i.status = "open"; delete i.reason; } break; }
      case "use-rewrite": { if (busy || !d.result || !d.result.ai.rewrite) return; const k = b.dataset.k; d.text = d.result.ai.rewrite[k]; d.result = null; save(); render(); await runCheck(); toast("Rewrite applied and re-checked."); return; }
      case "submit": await submitDraft(); return;
      case "cancel-revise": S.draft = freshDraft(); break;
      case "select": S.selected = b.dataset.id; break;
      case "approve": {
        if (!live || !isReviewer()) return;
        const txt = val("rcomment"); item.status = "approved"; if (txt) item.comments.push({ by: myName(), role: "reviewer", at: now(), text: txt });
        item.history.push({ at: now(), by: myName(), action: "Approved version " + item.versions.length });
        render(); await persistItem(item); toast("Approved. The creator can now publish it."); return;
      }
      case "changes": {
        if (!live || !isReviewer()) return;
        const txt = val("rcomment"); if (!txt) { toast("Add a comment so the creator knows what to change."); const el = document.getElementById("rcomment"); if (el) el.focus(); return; }
        item.status = "changes_requested"; item.comments.push({ by: myName(), role: "reviewer", at: now(), text: txt });
        item.history.push({ at: now(), by: myName(), action: "Requested changes" });
        render(); await persistItem(item); toast(TEAM.on ? "Sent back to the creator." : "Sent back to the creator. Switch to Riya to revise it."); return;
      }
      case "agree": case "disagree": {
        if (!live || !isReviewer()) return;
        const v = item.versions[item.versions.length - 1]; const i = v.issues.find(x => x.key === b.dataset.key);
        if (i && !i.review) { i.review = act === "agree" ? "accepted" : "rejected"; item.history.push({ at: now(), by: myName(), action: (act === "agree" ? "Agreed with" : "Disagreed with") + " dismissal of " + i.ruleId }); }
        render(); await persistItem(item); return;
      }
      case "override": {
        if (!live || !isReviewer()) return;
        const v = item.versions[item.versions.length - 1]; const i = v.issues.find(x => x.key === b.dataset.key);
        const reason = val("rcomment") || "Fine for this piece";
        if (i && !i.override) { i.override = reason; item.history.push({ at: now(), by: myName(), action: "Marked " + i.ruleId + " OK to publish (" + reason + ")" }); }
        render(); await persistItem(item); return;
      }
      case "revise": {
        if (!item || item.status !== "changes_requested" || busy) return;
        const v = item.versions[item.versions.length - 1];
        S.draft = { itemId: item.id, type: item.type, title: item.title, text: v.text, image: null, result: null };
        S.tab = "check"; save(); render(); await runCheck(); return;
      }
      case "comment": {
        if (!item) return; const txt = val("newcomment"); if (!txt) { toast("Write a comment first."); return; }
        item.comments.push({ by: myName(), role: myRole(), at: now(), text: txt }); render(); await persistItem(item); return;
      }
      case "copy": { const v = item.versions[item.versions.length - 1]; try { await navigator.clipboard.writeText(v.text); toast("Copied."); } catch (err) { toast("Couldn't copy automatically. Select the text instead."); } return; }
      case "add-gl": {
        if (!isReviewer()) return;
        const use = val("glUse"), avoid = val("glAvoid"); if (!use || !avoid) { toast("Fill in both “Use” and “Avoid”."); return; }
        S.kit.glossary.push({ id: nextId("G-", S.kit.glossary), use, avoid: avoid.split(",").map(x => x.trim()).filter(Boolean), note: val("glNote") });
        render(); await persistKit(); toast("Glossary term added."); return;
      }
      case "del-gl": if (!isReviewer()) return; S.kit.glossary.splice(+b.dataset.n, 1); render(); await persistKit(); return;
      case "add-fact": {
        if (!isReviewer()) return;
        const text = val("fText"); if (text.length < 5) { toast("Write the fact first."); return; }
        const exp = val("fExp"); if (exp && exp < PP.todayISO()) { toast("That date has already passed. Pick a future “valid until” date."); return; }
        S.kit.facts.push({ id: nextId("F-", S.kit.facts, 2), text, source: val("fSrc") || "Added by " + myName(), owner: "Brand team", expires: exp || new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10) });
        render(); await persistKit(); toast("Fact added to the library."); return;
      }
      case "del-fact": {
        if (!isReviewer()) return;
        const f = S.kit.facts[+b.dataset.n]; if (!f || !confirm("Delete fact " + f.id + "? Content that relies on it will be flagged.")) return;
        S.kit.facts.splice(+b.dataset.n, 1); render(); await persistKit(); return;
      }
      case "add-pal": {
        if (!isReviewer()) return;
        const name = val("palName") || "Brand colour", hex = val("palHex"); if (!/^#?[0-9a-f]{6}$/i.test(hex)) { toast("Use a hex colour like #F26B3A."); return; }
        S.kit.palette.push({ name, hex: (hex[0] === "#" ? hex : "#" + hex).toUpperCase() }); render(); await persistKit(); return;
      }
      case "del-pal": if (!isReviewer()) return; S.kit.palette.splice(+b.dataset.n, 1); render(); await persistKit(); return;
      case "export-kit": { const blob = new Blob([JSON.stringify(S.kit, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "brand-kit.json"; a.click(); return; }
      case "reset": { if (!confirm("Reset the demo? This clears everything you've done in this browser.")) return; const keepRole = S.role; S = defaultState(); S.role = keepRole; S.tab = "kit"; toast("Demo data reset."); break; }
      case "kit-undo": {
        if (!isReviewer()) return;
        const entry = (S.kit.history || []).find(h => String(h.version) === b.dataset.v); if (!entry) return;
        if (entry.kind === "import") { S.kit = PP.revertImport(S.kit, entry, myName(), now()); S.importNote = null; render(); await persistKit(); toast("Undone. Everything imported in version " + entry.version + " was removed."); return; }
        S.kit = PP.revertRuleChange(S.kit, entry, myName(), now()); S.gapNote = null; render(); await persistKit(); toast("Undone. " + entry.ruleId + " is back to how it was before version " + entry.version + "."); return;
      }
      // guideline import
      case "guide-sample": if (!isReviewer()) return; await startImport(KIT.SAMPLE_GUIDE.fileName, KIT.SAMPLE_GUIDE.text, KIT.SAMPLE_GUIDE.tryText); return;
      case "guide-ai": await askAIForGuide(); return;
      case "guide-approve": await approveImport(); return;
      case "guide-cancel": S.importEdit = null; break;
      case "guide-note-close": S.importNote = null; break;
      case "guide-try": {
        const t = S.importNote && S.importNote.tryText; if (!t || busy) return;
        S.draft = Object.assign(freshDraft(), { text: t, title: "Guideline import check", type: "LinkedIn post" });
        S.tab = "check"; save(); render(); await runCheck(); return;
      }
      // guideline gap detector
      case "gap-suggest": if (!isReviewer()) return; await startGapEdit(b.dataset.rule); return;
      case "gap-ai": if (S.gapEdit) await askAIForRule(S.gapEdit.ruleId); return;
      case "gap-cancel": S.gapEdit = null; break;
      case "gap-approve": await approveGapEdit(); return;
      case "gap-note-close": S.gapNote = null; break;
      case "gap-try": {
        const t = S.gapNote && S.gapNote.tryText; if (!t || busy) return;
        S.draft = Object.assign(freshDraft(), { text: t.text, title: t.title + " (re-check)", type: t.type });
        S.tab = "check"; save(); render(); await runCheck(); return;
      }
      // team workspace
      case "team-form": TEAM.form = b.dataset.form; TEAM.error = ""; break;
      case "team-demo": {
        // Demo accounts are shared by everyone trying the app. So that visitors never see (or break) each other's demo,
        // Arjun gets a fresh private workspace with the sample content every time, and Riya joins it with its code.
        if (TEAM.working) return; TEAM.working = true; TEAM.error = ""; render();
        const isArjun = /^arjun/.test(b.dataset.email);
        try {
          await TEAMAPI.signIn(b.dataset.email, DEMO_PASSWORD);
          if (isArjun) {
            const kit = clone(KIT.DEMO_KIT);
            const stamp = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
            const ws = await TEAMAPI.createWorkspace("Kitebird Money demo " + stamp, kit, "Arjun");
            for (const it of seedItems(kit)) await TEAMAPI.saveItem(ws.id, it);
            TEAM.working = false;
            await openWorkspace(ws.id, true);
            S.tab = "team"; render();
            toast("A fresh demo workspace was made just for you. Open a private window, sign in as Riya and join with the code below.");
            return;
          }
          TEAM.list = await TEAMAPI.myWorkspaces(); TEAM.demoJoin = true; TEAM.form = "signin";
        } catch (err) { TEAM.error = TEAMAPI.friendly(err) + " (The demo accounts may not be set up on this deployment yet.)"; }
        TEAM.working = false; break;
      }
      case "team-open": try { await openWorkspace(b.dataset.id); } catch (err) { /* toast already shown */ } return;
      case "team-leave": leaveTeam(); return;
      case "team-signout": { if (TEAM.on) leaveTeam(); try { await TEAMAPI.signOut(); } catch (err) { /* already signed out */ } TEAM.list = null; TEAM.demoJoin = false; lsSet("pixelproof:lastWorkspace", null); S.tab = "team"; toast("Signed out."); break; }
      case "copy-code": try { await navigator.clipboard.writeText(TEAM.ws.code); toast("Join code copied."); } catch (err) { toast("Join code: " + TEAM.ws.code); } return;
      case "team-reset": {
        if (!TEAM.on || TEAM.role !== "admin" || !confirm("Replace this workspace's content and brand kit with the Kitebird Money samples? Everyone in the team will see the change.")) return;
        try {
          await TEAMAPI.deleteItems(TEAM.ws.id);
          S.kit = clone(KIT.DEMO_KIT); await TEAMAPI.saveKit(TEAM.ws.id, S.kit);
          for (const it of seedItems(S.kit)) await TEAMAPI.saveItem(TEAM.ws.id, it);
          await refreshTeam(); toast("Sample content restored.");
        } catch (err) { toast(TEAMAPI.friendly(err)); }
        render(); return;
      }
      default: return;
    }
    save(); render();
  });

  // ---------- links from the Chrome extension ----------
  // The extension opens PixelProof with #check=... so a draft from LinkedIn/Gmail/X lands in the checker.
  // A draft sent from the extension. Kept until the team workspace (if any) has opened, so it isn't replaced by it.
  let handoffDraft = null;
  function useHandoff() {
    if (!handoffDraft) return false;
    S.draft = clone(handoffDraft); S.tab = "check"; S.introHidden = true; save();
    return true;
  }
  function readHandoff() {
    const m = /^#check=([A-Za-z0-9_-]+)$/.exec(location.hash || ""); if (!m) return false;
    history.replaceState(null, "", location.pathname + location.search);
    try {
      const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
      const json = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
      const p = JSON.parse(json);
      if (typeof p.text !== "string" || !p.text.trim()) return false;
      handoffDraft = Object.assign(freshDraft(), { text: p.text.slice(0, 50000), title: String(p.title || "From " + (p.site || "the extension")).slice(0, 120), type: TYPES.includes(p.type) ? p.type : "LinkedIn post" });
      useHandoff();
      return true;
    } catch (e) { toast("Couldn't read the draft sent from the extension."); return false; }
  }

  window.addEventListener("hashchange", () => { if (readHandoff()) { if (TEAM.ready) handoffDraft = null; render(); runCheck(); } });

  // ---------- start ----------
  const handoff = readHandoff();
  render();
  fetch("/api/check").then(r => r.ok ? r.json() : null).then(j => {
    AI = { checked: true, enabled: !!(j && j.aiEnabled), model: j && j.model, backupModel: j && j.backupModel, provider: j && j.provider };
  }).catch(() => { AI = { checked: true, enabled: false }; }).finally(() => { render(); if (handoff) runCheck(); });
  initTeam();
})();
