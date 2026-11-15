// PixelProof AI check (Vercel serverless function).
// The Gemini API key lives only here, in the GEMINI_API_KEY environment variable. It is never sent to the browser.
// The browser verifies everything this function returns before showing it (see verifyAI in js/engine.js).

// How this works:
// 1. The browser sends the text + brand kit here (personal details already masked).
// 2. We mask personal details again, build a prompt, and ask Gemini for a JSON answer.
// 3. If the main model is slow or busy we try a faster backup model.
// 4. We send the answer back. The browser verifies it (engine.js verifyAI) before showing it.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite"; // faster backup when the main model is slow or busy
const MAX_CHARS = 6000;
const VERSION = "2026-11-15.4";
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
    .map(r => `- ${r.id} [${r.category}, ${r.severity}] ${r.title}: ${r.detail}`).join("\n");
  const glossary = (kit.glossary || []).map(g => `- ${g.id}: use "${g.use}", avoid ${g.avoid.map(a => `"${a}"`).join(", ")}`).join("\n");
  const factList = facts.map(f => `- ${f.id}: ${f.text}`).join("\n");
  const found = (alreadyFound || []).slice(0, 40).map(i => `- ${i.ruleId}: "${i.excerpt}"`).join("\n") || "- none";
  return `You are a brand reviewer for ${kit.brand}. Check the ${contentType || "content"} below against the brand kit. Be specific and fair. Only use the rules and facts given here.

BRAND VOICE: ${kit.voice.summary}
Do: ${kit.voice.do.join("; ")}
Don't: ${kit.voice.dont.join("; ")}
Good example: ${kit.voice.goodExample}
Bad example: ${kit.voice.badExample}
KEY MESSAGES: ${(kit.messaging || []).join("; ")}

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

async function callGemini(prompt, key, strict, model, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 20000);
  const generationConfig = { temperature: 0.2, responseMimeType: "application/json", maxOutputTokens: 8192 };
  // Gemini 2.5 "thinking" uses up the output budget and can cut the JSON short, so turn it off.
  if (/2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (strict) generationConfig.responseSchema = SCHEMA;
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

async function askGemini(prompt, key) {
  // 1) main model, strict JSON  2) main model, relaxed (if the strict settings were refused)
  // 3) faster backup model if the main one is slow, busy or out of quota
  try { return { ai: await callGemini(prompt, key, true, MODEL, 20000), model: MODEL }; }
  catch (e) {
    const slowOrBusy = e.name === "AbortError" || [429, 500, 503].includes(e.status);
    if (!slowOrBusy) {
      try { return { ai: await callGemini(prompt, key, false, MODEL, 15000), model: MODEL }; } catch (e2) { /* fall through to backup */ }
    }
    if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL) return { ai: await callGemini(prompt, key, true, FALLBACK_MODEL, 15000), model: FALLBACK_MODEL };
    throw e;
  }
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

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const key = process.env.GEMINI_API_KEY;
  if (req.method === "GET") return res.status(200).json({ aiEnabled: !!key, model: key ? MODEL : null, provider: key ? "Google Gemini API" : null, version: VERSION });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
  if (!key) return res.status(200).json({ ok: false, error: "AI is not configured on this deployment. Rule and fact checks still ran." });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "anon";
  const now = Date.now(); const list = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (list.length >= 12) return res.status(200).json({ ok: false, error: "Too many AI checks in a minute. Rule and fact checks still ran; try the AI check again shortly." });
  list.push(now); hits.set(ip, list);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (!body.text || !body.kit) return res.status(400).json({ ok: false, error: "Missing text or brand kit" });
    const masked = maskPII(String(body.text).slice(0, MAX_CHARS));
    const prompt = buildPrompt({ text: masked.text, contentType: body.contentType, kit: body.kit, facts: (body.facts || []).slice(0, 8), alreadyFound: body.alreadyFound });
    const out = await askGemini(prompt, key);
    return res.status(200).json({ ok: true, model: out.model, masked: masked.count, ai: clean(out.ai) });
  } catch (e) {
    const why = e.status === 429 ? "the AI service is busy, try again in a minute" : e.name === "AbortError" ? "it took too long" : String(e.message || e).slice(0, 160);
    return res.status(200).json({ ok: false, error: "The AI check didn't finish (" + why + "). Rule and fact checks still ran." });
  }
};
