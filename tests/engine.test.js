// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const E = require("../js/engine.js");
const { DEMO_KIT, SAMPLES } = require("../js/brandkit.js");
const TODAY = "2026-11-15";
const kit = JSON.parse(JSON.stringify(DEMO_KIT));
const ids = text => E.runLocal(text, kit, TODAY).issues.map(i => i.ruleId);

test("flags promises, rankings and wrong numbers as blockers", () => {
  const r = E.runLocal(SAMPLES[0].text, kit, TODAY);
  const blockers = r.issues.filter(i => i.severity === "blocker").map(i => i.ruleId + ":" + i.excerpt);
  assert.deepStrictEqual(blockers.sort(), ["C-1:guaranteed", "C-2:#1", "C-3:12%", "C-3:5 lakh"].sort());
});

test("every issue names the rule or source it comes from", () => {
  for (const s of SAMPLES) for (const i of E.runLocal(s.text, kit, TODAY).issues) assert.ok(i.reference && i.message, i.ruleId);
});

test("numbers that match an approved, unexpired fact are verified", () => {
  const r = E.runLocal("Savings Pots earn up to 7.25% interest per year. Deposits are insured up to 5 lakh by DICGC.", kit, TODAY);
  assert.deepStrictEqual(r.issues.filter(i => i.ruleId === "C-3"), []);
  assert.deepStrictEqual(r.verified.map(v => v.factId).sort(), ["F-02", "F-04"]);
});

test("a figure from an expired fact is blocked and the current fact is suggested", () => {
  const r = E.runLocal("Join 1 lakh savers today.", kit, TODAY);
  const i = r.issues.find(x => x.ruleId === "C-3");
  assert.ok(i && /expired/.test(i.message));
  assert.strictEqual(i.fixes[0].replacement, "over 2 lakh");
});

test("numbers with no source are blockers", () => {
  assert.ok(ids("We have 40 branches.").includes("C-3"));
});

test("version numbers like 7.25% are not split into two numbers", () => {
  const n = E.extractNumbers("up to 7.25% interest");
  assert.strictEqual(n.length, 1); assert.strictEqual(n[0].value, 7.25);
});

test("glossary respects the full product name", () => {
  assert.ok(!ids("Kitebird Money is free to download.").includes("G-1"));
  assert.ok(ids("Kitebird is free to download.").includes("G-1"));
});

test("applying every suggested fix leaves the risky sample clean", () => {
  let t = SAMPLES[0].text;
  for (let k = 0; k < 30; k++) {
    const next = E.runLocal(t, kit, TODAY).issues.find(i => i.fixes.length);
    if (!next) break; t = E.applyFix(t, next, next.fixes[0].replacement);
  }
  assert.deepStrictEqual(E.runLocal(t, kit, TODAY).issues.map(i => i.ruleId), []);
});

test("AI answers are only trusted after code verification", () => {
  const text = "Kitebird Money is free to download and award-winning.";
  const ai = {
    issues: [{ ruleId: "Z-9", excerpt: "free", explanation: "made-up rule" }, { ruleId: "T-1", excerpt: "not in the text", explanation: "x" }],
    claims: [
      { excerpt: "free to download", verdict: "supported", factId: "F-03", quote: "free to download" },
      { excerpt: "award-winning", verdict: "supported", factId: "F-07", quote: "this quote is invented" }
    ]
  };
  const v = E.verifyAI(ai, text, kit, TODAY, []);
  assert.strictEqual(v.dropped.length, 2);
  assert.deepStrictEqual(v.verified.map(x => x.factId), ["F-03"]);
  assert.strictEqual(v.issues.length, 1); assert.strictEqual(v.issues[0].ruleId, "C-3");
});

test("AI can't approve a claim using an expired fact", () => {
  const v = E.verifyAI({ claims: [{ excerpt: "loved by savers", verdict: "supported", factId: "F-06", quote: "Kitebird Money has 1 lakh savers" }] }, "Loved by savers.", kit, TODAY, []);
  assert.strictEqual(v.verified.length, 0); assert.strictEqual(v.issues.length, 1);
});

test("personal data is masked before anything goes to the AI", () => {
  const m = E.maskPII("Mail riya@example.com or call +91 98765 43210, PAN ABCDE1234F");
  assert.strictEqual(m.count, 3); assert.ok(!/example|98765|ABCDE/.test(m.text));
});

test("image check flags off-palette colours, low contrast and missing alt text", () => {
  const px = []; for (let i = 0; i < 100; i++) px.push(...(i < 60 ? [120, 40, 160, 255] : [130, 50, 170, 255]));
  const a = E.analyseImage(px, kit, "");
  const r = a.issues.map(i => i.ruleId);
  assert.ok(r.includes("V-1")); assert.ok(r.includes("A-5"));
  const ok = []; for (let i = 0; i < 100; i++) ok.push(...(i < 60 ? [20, 33, 61, 255] : [247, 247, 242, 255]));
  assert.deepStrictEqual(E.analyseImage(ok, kit, "Navy banner").issues, []);
});

test("WCAG contrast maths is right", () => {
  assert.strictEqual(Math.round(E.contrast([0, 0, 0], [255, 255, 255])), 21);
});

test("disabled rules don't fire", () => {
  const k2 = JSON.parse(JSON.stringify(kit)); k2.rules.find(r => r.id === "T-1").enabled = false;
  assert.ok(!E.runLocal("Sign up now.", k2, TODAY).issues.some(i => i.ruleId === "T-1"));
});

test("AI can't raise rules that code checks exactly, or suggest a fix that changes nothing", () => {
  const text = "Small steps add up. #SaveSmart";
  const v = E.verifyAI({ issues: [
    { ruleId: "A-6", excerpt: "#SaveSmart", explanation: "capitalise", fix: "#SaveSmart" },
    { ruleId: "T-1", excerpt: "Small steps", explanation: "x", fix: "small steps" }
  ] }, text, kit, TODAY, []);
  assert.strictEqual(v.issues.length, 0); assert.strictEqual(v.dropped.length, 2);
});

// ---------- guideline gap detector ----------
function mkItem(id, at, issues, fixed) { return { id, versions: [{ v: 1, at, issues, fixed: fixed || [] }] }; }
const gapItems = () => [
  mkItem("a", "2026-11-20T10:00:00Z", [{ ruleId: "T-1", excerpt: "limited time", pattern: "limited time( only)?", status: "dismissed", reason: "Real offer, ends Sunday" }]),
  mkItem("b", "2026-11-20T11:00:00Z", [{ ruleId: "T-1", excerpt: "Limited time", pattern: "limited time( only)?", status: "open", override: "Legal approved the deadline" }]),
  mkItem("c", "2026-11-20T12:00:00Z", [], [{ ruleId: "T-1", excerpt: "Hurry", pattern: "hurry", replacement: "" }])
];

test("gap detector flags a rule people keep pushing back on", () => {
  const gaps = E.analyseGaps(gapItems(), kit);
  assert.strictEqual(gaps[0].ruleId, "T-1");
  assert.strictEqual(gaps[0].level, "unclear");
  assert.strictEqual(gaps[0].dismissed, 1); assert.strictEqual(gaps[0].overridden, 1); assert.strictEqual(gaps[0].fixed, 1);
  assert.strictEqual(gaps[0].reasons.length, 2);
});

test("the same flag carried into a second version only counts once", () => {
  const it = { id: "x", versions: [
    { at: "2026-11-20T10:00:00Z", issues: [{ ruleId: "T-1", excerpt: "act now", status: "dismissed", reason: "ok here" }] },
    { at: "2026-11-20T11:00:00Z", issues: [{ ruleId: "T-1", excerpt: "act now", status: "dismissed", reason: "ok here" }] }] };
  assert.strictEqual(E.analyseGaps([it], kit)[0].dismissed, 1);
});

test("suggested change uses real examples and only removes phrases nobody fixed", () => {
  const g = E.analyseGaps(gapItems(), kit)[0];
  const s = E.suggestRuleChange(g);
  assert.deepStrictEqual(s.removePatterns, ["limited time( only)?"]);
  assert.ok(s.allowed.includes("limited time")); assert.ok(s.notAllowed.includes("Hurry"));
});

test("an approved change updates the next check and is recorded in history", () => {
  const rule = kit.rules.find(r => r.id === "T-1");
  const { change, errors } = E.validateRuleChange({ detail: "No false urgency. A real deadline is fine if you give the date calmly.",
    severity: "warning", removePatterns: ["limited time( only)?", "not-a-real-pattern"], allowed: ["Offer ends 2 Nov"], notAllowed: ["Hurry!"] }, rule);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(change.removePatterns, ["limited time( only)?"]); // made-up patterns are ignored
  const before = E.runLocal("Limited time offer for savers.", kit, TODAY).issues.filter(i => i.ruleId === "T-1").length;
  const k2 = E.applyRuleChange(kit, change, "Arjun", "2026-11-20T13:00:00Z");
  const after = E.runLocal("Limited time offer for savers.", k2, TODAY).issues.filter(i => i.ruleId === "T-1").length;
  assert.strictEqual(before, 1); assert.strictEqual(after, 0);
  assert.strictEqual(k2.history.length, 1); assert.match(k2.history[0].summary, /stopped flagging/);
  // older signals no longer count once the rule has been revised
  assert.strictEqual(E.analyseGaps(gapItems(), k2).length, 0);
  // and the change can be undone
  const k3 = E.revertRuleChange(k2, k2.history[0], "Arjun", "2026-11-20T14:00:00Z");
  assert.strictEqual(E.runLocal("Limited time offer for savers.", k3, TODAY).issues.filter(i => i.ruleId === "T-1").length, 1);
});

test("a change can't remove every phrase or have empty wording", () => {
  const rule = kit.rules.find(r => r.id === "T-2");
  const { errors } = E.validateRuleChange({ detail: "x", removePatterns: rule.patterns }, rule);
  assert.strictEqual(errors.length, 2);
});

test("dates, years and times aren't treated as claims, but real figures still are", () => {
  const raw = t => E.extractNumbers(t).map(n => n.raw);
  assert.deepStrictEqual(raw("Offer ends 2 November 2026."), []);
  assert.deepStrictEqual(raw("Open by Nov 2 at 10:30 or 9 am, 24/7."), []);
  assert.deepStrictEqual(raw("Join 2,000 savers earning 12%."), ["2,000", "12%"]);
});
