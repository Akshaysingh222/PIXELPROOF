// PixelProof AI check (Vercel serverless function).
// The Gemini API key lives only here, in the GEMINI_API_KEY environment variable. It is never sent to the browser.
// The browser verifies everything this function returns before showing it (see verifyAI in js/engine.js).

// How this works:
// 1. The browser sends the text + brand kit here (personal details already masked).
// 2. We mask personal details again, build a prompt, and ask Gemini for a JSON answer.
// 3. If the main model is slow or busy we try a faster backup model.
// 4. We send the answer back. The browser verifies it (engine.js verifyAI) before showing it.
// It also has a second job (mode "rule"): drafting clearer wording for a brand rule people keep pushing back on,
// and a third (mode "guide"): proposing rules, facts and glossary terms from a brand guideline document.
// Gemini 3.5 Flash-Lite is fast and good at structured JSON; 3.6 Flash is the backup. Both can be changed in Vercel.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.6-flash";
const MAX_CHARS = 6000;
const VERSION = "2026-11-20.2";
const hits = new Map(); // tiny per-instance rate limit to protect the API quota and cost

function maskPII(text) {
  let n = 0;
  const t = String(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, () => { n++; return "[email]"; })
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, () => { n++; return "[PAN]"; })
    .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, () => { n++; return "[ID number]"; })
    .replace(/(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, () => { n++; return "[phone]"; });
  return { text: t, count: n };
}

// The instructions we give the AI: the brand voice, rules, glossary, the approved facts,
// what our rules already found (so it doesn't repeat them), and the exact answer format.
function buildPrompt({ text, contentType, kit, facts, alreadyFound }) {
  const rules = (kit.rules || []).filter(r => r.enabled !== false && !["V-1", "V-2", "A-5"].includes(r.id))
    .map(r => `- ${r.id} [${r.category}, ${r.severity}] ${r.title}: ${r.detail}` + examplesText(r.examples)).join("\n");
  const glossary = (kit.glossary || []).map(g => `- ${g.id}: use "${g.use}", avoid ${(g.avoid || []).map(a => `"${a}"`).join(", ")}`).join("\n");
  const factList = (facts || []).map(f => `- ${f.id}: ${f.text}`).join("\n") || "- none";
  const voice = kit.voice || {};
  const join = a => (Array.isArray(a) ? a.join("; ") : "");
  const found = (alreadyFound || []).slice(0, 40).map(i => `- ${i.ruleId}: "${i.excerpt}"`).join("\n") || "- none";
  return `You are a brand reviewer for ${kit.brand}. Check the ${contentType || "content"} below against the brand kit. Be specific and fair. Only use the rules and facts given here.

BRAND VOICE: ${voice.summary || "not given"}
Do: ${join(voice.do)}
Don't: ${join(voice.dont)}
Good example: ${voice.goodExample || ""}
Bad example: ${voice.badExample || ""}
KEY MESSAGES: ${join(kit.messaging)}

RULES (cite these ids):
${rules}

GLOSSARY:
${glossary}

APPROVED FACTS (the only facts you may rely on):
${factList}

ALREADY FOUND BY EXACT RULES (do not repeat these):
${found}

CONTENT TO CHECK:
"""
${text}
"""

Return JSON with exactly this shape:
{
 "issues": [ { "ruleId": "T-1", "excerpt": "exact words copied from the content", "severity": "blocker|warning|suggestion", "explanation": "one or two plain sentences: what is wrong and why", "fix": "replacement words for the excerpt, keeping the writer's point" } ],
 "claims": [ { "excerpt": "exact words of a factual claim copied from the content", "verdict": "supported|contradicted|no_source", "factId": "F-xx or empty", "quote": "exact words copied from that approved fact, or empty", "explanation": "one sentence", "fix": "suggested replacement words, or empty" } ],
 "rewrite": { "minimal": "the content with the smallest changes that fix every blocker and warning", "full": "an on-brand rewrite that keeps the same purpose, format and roughly the same length" }
}
Guidance:
- issues: tone, voice, messaging and readability problems not already listed above. Use only rule ids from the list. Excerpts must be copied exactly from the content. Return [] if there are none. Do not invent problems.
- claims: list factual claims about the product or company (for example "free", "insured", "award-winning", "trusted", "fastest", numbers). "supported" only if an approved fact says it, and copy the exact words from that fact into "quote".
- rewrites must not add any fact, number or promise that is not in the approved facts.`;
}

function examplesText(ex) {
  if (!ex) return "";
  const a = (ex.allowed || []).map(x => `"${x}"`).join(", "), n = (ex.notAllowed || []).map(x => `"${x}"`).join(", ");
  return (a ? ` Allowed: ${a}.` : "") + (n ? ` Not allowed: ${n}.` : "");
}

// The prompt for mode "rule": the AI drafts clearer wording for one rule, using what people actually did.
function buildRulePrompt({ kit, rule, gap }) {
  const reasons = (gap.reasons || []).slice(0, 10).map(r => `- ${r.kind} "${r.excerpt}": ${r.text}`).join("\n") || "- none";
  return `You help a brand manager at ${kit.brand || "a company"} fix an unclear brand guideline.
People keep pushing back on this rule, which suggests the wording is unclear or too strict.

RULE ${rule.id}: ${rule.title}
Current wording: ${rule.detail}
Severity: ${rule.severity}
Phrases it flags (regular expressions): ${(rule.patterns || []).map(p => JSON.stringify(p)).join(", ") || "none"}

WHAT HAPPENED (${gap.flagged} flags: ${gap.dismissed} dismissed by creators, ${gap.overridden} allowed by reviewers, ${gap.fixed} fixed):
${reasons}
Words people were allowed to publish: ${(gap.pushedExcerpts || []).map(x => JSON.stringify(x)).join(", ") || "none"}
Words people fixed (the rule worked): ${(gap.fixedExcerpts || []).map(x => JSON.stringify(x)).join(", ") || "none"}

Write a clearer version of the rule that keeps its purpose. Return JSON:
{ "detail": "the new wording, one or two plain sentences that explain the line between allowed and not allowed",
  "allowed": ["up to 3 short examples that are fine"], "notAllowed": ["up to 3 short examples that are not"],
  "severity": "blocker|warning|suggestion", "removePatterns": ["only phrases copied exactly from the list above that should stop being flagged"],
  "rationale": "one sentence explaining the change" }
Do not weaken the rule's purpose. Only remove a phrase if the evidence shows it is usually fine.`;
}
const RULE_SCHEMA = {
  type: "OBJECT",
  properties: { detail: { type: "STRING" }, allowed: { type: "ARRAY", items: { type: "STRING" } }, notAllowed: { type: "ARRAY", items: { type: "STRING" } },
    severity: { type: "STRING" }, removePatterns: { type: "ARRAY", items: { type: "STRING" } }, rationale: { type: "STRING" } },
  required: ["detail", "allowed", "notAllowed", "severity", "removePatterns", "rationale"]
};

// Third job (mode "guide"): read a brand guideline document and propose rules, facts and glossary terms.
// Every proposal must quote the sentence it comes from; the browser checks each quote is really in the document.
const GUIDE_MAX = 20000;
function buildGuidePrompt({ kit, text, fileName }) {
  const rules = (kit.rules || []).map(r => `- ${r.id} ${r.title}`).join("\n") || "- none";
  const glossary = (kit.glossary || []).map(g => `- use "${g.use}", avoid ${(g.avoid || []).map(a => `"${a}"`).join(", ")}`).join("\n") || "- none";
  return `You help a brand manager at ${kit.brand || "a company"} turn their brand guideline document into checkable rules.
Read the document "${fileName || "guideline"}" below and propose:
- rules: things content must or must not do. For each: a short title, the rule in one or two plain sentences (detail),
  category (one of Claims, Tone, Messaging, Accessibility, Writing, Visual), severity (blocker for legal or factual risk, warning for brand voice, suggestion for style),
  patterns: case-insensitive JavaScript regular expressions for exact words or phrases the document says not to use (leave empty if the rule needs judgment),
  fix: a replacement phrase if the document gives one, and quote: the exact sentence from the document, copied word for word.
- facts: statements the brand says are approved and true (figures, product facts). Give text, source if the document names one, and quote.
- glossary: preferred terms. Give use (the preferred word), avoid (words not to use), a short note, and quote.
Only propose what the document actually says. Copy every quote exactly. Skip anything the brand kit already has.

RULES ALREADY IN THE BRAND KIT:
${rules}
GLOSSARY ALREADY IN THE BRAND KIT:
${glossary}

DOCUMENT (between triple quotes):
"""
${text}
"""`;
}
const GUIDE_SCHEMA = {
  type: "OBJECT",
  properties: {
    rules: { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, detail: { type: "STRING" }, category: { type: "STRING" }, severity: { type: "STRING" },
      patterns: { type: "ARRAY", items: { type: "STRING" } }, fix: { type: "STRING" }, quote: { type: "STRING" } }, required: ["title", "detail", "quote"] } },
    facts: { type: "ARRAY", items: { type: "OBJECT", properties: { text: { type: "STRING" }, source: { type: "STRING" }, quote: { type: "STRING" } }, required: ["text", "quote"] } },
    glossary: { type: "ARRAY", items: { type: "OBJECT", properties: { use: { type: "STRING" }, avoid: { type: "ARRAY", items: { type: "STRING" } }, note: { type: "STRING" }, quote: { type: "STRING" } }, required: ["use", "avoid", "quote"] } }
  },
  required: ["rules", "facts", "glossary"]
};
function cleanGuide(ai) {
  const arr = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
  const str = (v, n) => String(v == null ? "" : v).slice(0, n);
  return {
    rules: arr(ai && ai.rules, 30).map(r => ({ title: str(r.title, 100), detail: str(r.detail, 400), category: str(r.category, 20), severity: str(r.severity, 12),
      patterns: arr(r.patterns, 8).map(p => str(p, 100)), fix: str(r.fix, 80), quote: str(r.quote, 500) })),
    facts: arr(ai && ai.facts, 30).map(f => ({ text: str(f.text, 300), source: str(f.source, 120), quote: str(f.quote, 500) })),
    glossary: arr(ai && ai.glossary, 30).map(g => ({ use: str(g.use, 40), avoid: arr(g.avoid, 8).map(a => str(a, 40)), note: str(g.note, 200), quote: str(g.quote, 500) }))
  };
}

// Structured output: Gemini must answer in exactly this shape, so the JSON is valid.
const STR = { type: "STRING" };
const SCHEMA = {
  type: "OBJECT",
  properties: {
    issues: { type: "ARRAY", items: { type: "OBJECT", properties: { ruleId: STR, excerpt: STR, severity: STR, explanation: STR, fix: STR }, required: ["ruleId", "excerpt", "explanation"] } },
    claims: { type: "ARRAY", items: { type: "OBJECT", properties: { excerpt: STR, verdict: STR, factId: STR, quote: STR, explanation: STR, fix: STR }, required: ["excerpt", "verdict"] } },
    rewrite: { type: "OBJECT", properties: { minimal: STR, full: STR } }
  },
  required: ["issues", "claims", "rewrite"]
};

// Forgiving JSON parse: strips code fences, takes the outer object, removes trailing commas.
function parseJSON(raw) {
  let t = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch (e) { /* try to repair */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  t = t.replace(/,\s*([}\]])/g, "$1").replace(/[\u201c\u201d]/g, '"');
  return JSON.parse(t);
}

async function callGemini(prompt, key, strict, model, ms, schema) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 20000);
  const generationConfig = { temperature: 0.2, responseMimeType: "application/json", maxOutputTokens: 8192 };
  // Older Gemini 2.5 models "think" by default, which can use up the output budget and cut the JSON short.
  if (/2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (strict) generationConfig.responseSchema = schema || SCHEMA;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig }),
      signal: ctrl.signal
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const err = new Error((data.error && data.error.message) || ("Gemini returned " + r.status)); err.status = r.status; throw err; }
    const cand = (data.candidates || [])[0] || {};
    const parts = (cand.content || {}).parts || [];
    if (cand.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(cand.finishReason)) {
      throw new Error("Gemini stopped early (" + cand.finishReason + ")");
    }
    const raw = parts.filter(p => !p.thought).map(p => p.text || "").join("");
    if (!raw.trim()) throw new Error("Gemini returned an empty answer");
    return parseJSON(raw);
  } finally { clearTimeout(timer); }
}

async function askGemini(prompt, key, schema, ms) {
  ms = ms || 20000;
  // 1) main model, strict JSON  2) main model, relaxed (if the strict settings were refused)
  // 3) backup model if the main one is slow, busy, retired or out of quota
  try { return { ai: await callGemini(prompt, key, true, MODEL, ms, schema), model: MODEL }; }
  catch (e) {
    const slowOrBusy = e.name === "AbortError" || [404, 429, 500, 503].includes(e.status);
    if (!slowOrBusy) {
      try { return { ai: await callGemini(prompt, key, false, MODEL, 15000, schema), model: MODEL }; } catch (e2) { /* fall through to backup */ }
    }
    if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL) return { ai: await callGemini(prompt, key, true, FALLBACK_MODEL, ms, schema), model: FALLBACK_MODEL };
    throw e;
  }
}

function cleanRule(ai) {
  const s = v => (typeof v === "string" ? v.slice(0, 600) : "");
  const list = a => (Array.isArray(a) ? a : []).slice(0, 5).map(s).filter(Boolean);
  return { detail: s(ai.detail), allowed: list(ai.allowed), notAllowed: list(ai.notAllowed), severity: s(ai.severity),
    removePatterns: list(ai.removePatterns), rationale: s(ai.rationale) };
}

// Keep only the fields we expect, and limit their length.
function clean(ai) {
  const s = v => (typeof v === "string" ? v.slice(0, 2000) : "");
  return {
    issues: (Array.isArray(ai.issues) ? ai.issues : []).slice(0, 25).map(i => ({ ruleId: s(i.ruleId), excerpt: s(i.excerpt), severity: s(i.severity), explanation: s(i.explanation), fix: s(i.fix) })),
    claims: (Array.isArray(ai.claims) ? ai.claims : []).slice(0, 25).map(c => ({ excerpt: s(c.excerpt), verdict: s(c.verdict), factId: s(c.factId), quote: s(c.quote), explanation: s(c.explanation), fix: s(c.fix) })),
    rewrite: { minimal: s(ai.rewrite && ai.rewrite.minimal), full: s(ai.rewrite && ai.rewrite.full) }
  };
}

// Lets the Chrome extension call this function from LinkedIn, Gmail and X.
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const key = process.env.GEMINI_API_KEY;
  if (req.method === "GET") return res.status(200).json({ aiEnabled: !!key, model: key ? MODEL : null, backupModel: key ? FALLBACK_MODEL : null, provider: key ? "Google Gemini API" : null, version: VERSION });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
  if (!key) return res.status(200).json({ ok: false, error: "AI is not configured on this deployment. Rule and fact checks still ran." });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "anon";
  const now = Date.now(); const list = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (list.length >= (+process.env.AI_CHECKS_PER_MINUTE || 12)) return res.status(200).json({ ok: false, error: "Too many AI checks in a minute. Rule and fact checks still ran; try the AI check again shortly." });
  list.push(now); hits.set(ip, list);

  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: "The request wasn't valid JSON." }); }
  const kit = body.kit && typeof body.kit === "object" ? body.kit : null;
  if (!kit || !Array.isArray(kit.rules)) return res.status(400).json({ ok: false, error: "Missing brand kit." });

  try {
    if (body.mode === "rule") {
      const rule = body.rule && typeof body.rule === "object" ? body.rule : null;
      if (!rule || !rule.id) return res.status(400).json({ ok: false, error: "Missing rule." });
      const out = await askGemini(buildRulePrompt({ kit, rule, gap: body.gap || {} }), key, RULE_SCHEMA);
      return res.status(200).json({ ok: true, model: out.model, change: cleanRule(out.ai) });
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return res.status(400).json({ ok: false, error: "There's no text to check." });
    if (body.mode === "guide") {
      const masked = maskPII(text.slice(0, GUIDE_MAX));
      const out = await askGemini(buildGuidePrompt({ kit, text: masked.text, fileName: String(body.fileName || "").slice(0, 120) }), key, GUIDE_SCHEMA, 27000);
      return res.status(200).json({ ok: true, model: out.model, truncated: text.length > GUIDE_MAX, proposal: cleanGuide(out.ai) });
    }
    const masked = maskPII(text.slice(0, MAX_CHARS));
    const prompt = buildPrompt({ text: masked.text, contentType: body.contentType, kit, facts: (body.facts || []).slice(0, 8), alreadyFound: body.alreadyFound });
    const out = await askGemini(prompt, key);
    return res.status(200).json({ ok: true, model: out.model, masked: masked.count, truncated: text.length > MAX_CHARS, ai: clean(out.ai) });
  } catch (e) {
    const why = e.status === 429 ? "the AI service is busy, try again in a minute" : e.name === "AbortError" ? "it took too long" : String(e.message || e).slice(0, 160);
    return res.status(200).json({ ok: false, error: "The AI check didn't finish (" + why + "). Rule and fact checks still ran." });
  }
};

// Exported for the tests.
module.exports.maskPII = maskPII;
module.exports.parseJSON = parseJSON;
module.exports.buildPrompt = buildPrompt;
