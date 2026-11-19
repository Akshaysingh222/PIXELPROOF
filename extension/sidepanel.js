/* Side panel: the fallback for any page. Checks pasted or selected text, applies fixes to the text here,
   and can send it to the web app's review queue. */
(function () {
  "use strict";
  const X = window.PPX, PP = window.PP;
  document.getElementById("ppcss").textContent = X.CSS;
  const $text = document.getElementById("text"), $type = document.getElementById("type"), $out = document.getElementById("out");
  let state = { result: null, ai: null, text: "" }, cfg = null;

  async function check() {
    cfg = await X.settings();
    const text = $text.value;
    if (!text.trim()) { $out.innerHTML = `<div class="pp-note">Paste or select some text first.</div>`; return; }
    state = { result: X.checkLocal(text, cfg.kit), ai: null, text, aiOff: !cfg.aiOn };
    draw();
    if (cfg.aiOn) await runAI();
  }
  async function runAI() {
    const r = state.result; state.ai = "running"; draw();
    let res; try { res = await X.checkAI(state.text, cfg.kit, $type.value, r.issues); } catch (e) { res = { ok: false, error: "Couldn't reach PixelProof." }; }
    if (state.result !== r) return;
    state.ai = res;
    if (res.ok) { r.issues = PP.sortIssues(r.issues.concat(res.issues)); r.verified = r.verified.concat(res.verified); }
    draw();
  }
  function draw() {
    $out.innerHTML = X.issuesHTML(state, { canFix: true }) + (state.result ? `<div class="pp-hint">Brand kit: ${X.esc(cfg.kit.brand)}</div>` : "");
    document.getElementById("check").disabled = state.ai === "running";
  }
  $out.addEventListener("click", e => {
    const b = e.target.closest("[data-pp-act]"); if (!b) return;
    const i = state.result && state.result.issues.find(x => x.key === b.dataset.key);
    if (b.dataset.ppAct === "retry-ai") runAI();
    if (b.dataset.ppAct === "ignore" && i) { i.status = "dismissed"; draw(); }
    if (b.dataset.ppAct === "fix" && i) {
      const fix = i.fixes[+b.dataset.n];
      $text.value = PP.applyFix($text.value, i, fix.replacement);
      const keepAI = state.result.issues.filter(x => x.source === "AI check" && x.status === "open" && x !== i && x.excerpt && $text.value.includes(x.excerpt));
      state = { result: X.checkLocal($text.value, cfg.kit), ai: state.ai, text: $text.value, aiOff: state.aiOff };
      state.result.issues = PP.sortIssues(state.result.issues.concat(keepAI));
      draw();
    }
  });
  document.getElementById("check").addEventListener("click", check);
  $text.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) check(); });
  document.getElementById("queue").addEventListener("click", () => {
    if (!$text.value.trim()) return;
    X.sendToQueue($text.value, "the extension", $type.value, "From the extension: " + $text.value.trim().split(/\s+/).slice(0, 5).join(" "));
  });
  document.getElementById("copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText($text.value); } catch (e) { $text.select(); } });

  // text selected on a page + "Check with PixelProof"
  function takePending(p) { if (p && p.text) { $text.value = p.text; chrome.storage.session.remove("pending"); check(); } }
  chrome.storage.session.get("pending", s => takePending(s.pending));
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "session" && ch.pending && ch.pending.newValue) takePending(ch.pending.newValue); });
})();
