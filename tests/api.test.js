// Tests for the AI function (api/check.js). Gemini is replaced by a fake, so no key or network is needed.
const test = require("node:test");
const assert = require("node:assert");
const { DEMO_KIT } = require("../js/brandkit.js");

function call(handler, req) {
  return new Promise(resolve => {
    const res = { headers: {}, code: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
      json(o) { resolve({ code: this.code, body: o, headers: this.headers }); }, end() { resolve({ code: this.code, body: null, headers: this.headers }); } };
    handler(Object.assign({ headers: {} }, req), res);
  });
}
function fresh(fakeGemini) {
  delete require.cache[require.resolve("../api/check.js")];
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_MODEL; delete process.env.GEMINI_FALLBACK_MODEL;
  global.fetch = fakeGemini;
  return require("../api/check.js");
}
const answer = obj => async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(obj) }] } }] }) });

test("rejects requests with no text or no brand kit with a clear message", async () => {
  const h = fresh(answer({}));
  assert.strictEqual((await call(h, { method: "POST", body: { kit: DEMO_KIT, text: "   " } })).code, 400);
  assert.strictEqual((await call(h, { method: "POST", body: { text: "hi" } })).code, 400);
  assert.strictEqual((await call(h, { method: "POST", body: "{not json" })).code, 400);
});

test("masks personal data before it reaches the AI", async () => {
  let sent = "";
  const h = fresh(async (url, opts) => { sent = opts.body; return answer({ issues: [], claims: [], rewrite: {} })(); });
  await call(h, { method: "POST", body: { kit: DEMO_KIT, text: "Call 98765 43210 or mail a@b.com" } });
  assert.ok(!/98765|a@b\.com/.test(sent));
});

test("falls back to the backup model when the main one is retired or busy", async () => {
  const tried = [];
  const h = fresh(async url => {
    const m = String(url).match(/models\/([^:]+)/)[1]; tried.push(m);
    if (m === "gemini-3.5-flash-lite") return { ok: false, status: 404, json: async () => ({ error: { message: "no longer available" } }) };
    return answer({ issues: [], claims: [], rewrite: {} })();
  });
  const r = await call(h, { method: "POST", body: { kit: DEMO_KIT, text: "Small steps add up." } });
  assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.model, "gemini-3.6-flash");
});

test("rule mode returns a cleaned suggestion", async () => {
  const h = fresh(answer({ detail: "No false urgency.", allowed: ["Offer ends 2 Nov"], notAllowed: ["Hurry"], severity: "warning", removePatterns: ["hurry"], rationale: "x" }));
  const rule = DEMO_KIT.rules.find(r => r.id === "T-1");
  const r = await call(h, { method: "POST", body: { mode: "rule", kit: DEMO_KIT, rule, gap: { flagged: 2, reasons: [] } } });
  assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.change.detail, "No false urgency.");
});

test("answers the browser extension's preflight request", async () => {
  const h = fresh(answer({}));
  const r = await call(h, { method: "OPTIONS" });
  assert.strictEqual(r.code, 204); assert.strictEqual(r.headers["Access-Control-Allow-Origin"], "*");
});

test("a cut-off or broken AI reply becomes a friendly error, not a crash", async () => {
  const h = fresh(async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"issues":[' }] } }] }) }));
  const r = await call(h, { method: "POST", body: { kit: DEMO_KIT, text: "Hello savers." } });
  assert.strictEqual(r.body.ok, false); assert.match(r.body.error, /Rule and fact checks still ran/);
});

test("guide mode returns cleaned proposals from a guideline document", async () => {
  let prompt = "";
  const h = fresh(async (url, opts) => { prompt = JSON.parse(opts.body).contents[0].parts[0].text;
    return answer({ rules: [{ title: "No hype", detail: "Never say best in class.", quote: "Never say best in class.", patterns: ["best in class"], extra: "x" }], facts: [], glossary: [] })(); });
  const r = await call(h, { method: "POST", body: { mode: "guide", kit: DEMO_KIT, text: "Never say best in class. Email us at a@b.com", fileName: "guide.pdf" } });
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.proposal.rules[0].patterns, ["best in class"]);
  assert.strictEqual(r.body.proposal.rules[0].extra, undefined);
  assert.ok(prompt.includes("[email]") && !prompt.includes("a@b.com"));
});
