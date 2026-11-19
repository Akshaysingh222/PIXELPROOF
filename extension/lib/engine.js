/* Copied from js/engine.js by scripts/build-extension.js. Edit the original, not this copy. */
/* PixelProof check engine.
   Runs in the browser and in Node (for tests). No dependencies.
   Layer 1: rules (exact, explainable).  Layer 2: claim checks against approved facts.
   Layer 3 (AI) runs on the server; verifyAI() below checks its answer before anything is shown. */
(function (root) {
  "use strict";

  const SEV_ORDER = { blocker: 0, warning: 1, suggestion: 2 };
  // Rules that code checks exactly. The AI is not allowed to raise these, so it can't contradict the rule checks.
  const EXACT_ONLY = new Set(["T-2", "A-2", "A-3", "A-4", "A-5", "A-6", "C-1", "C-3", "V-1", "V-2"]);
  const ACRONYMS = new Set(["DICGC", "UPI", "KYC", "RBI", "NEFT", "IMPS", "IFSC", "EMI", "ATM", "PAN", "OTP", "SIP", "FAQ", "WCAG", "INR", "GST", "IPO", "SEBI", "NPCI"]);
  const STOP = new Set(("a an the and or but of to in on for with by at from is are was were be been our your you we us it its this that these those as up over under per can will just than then so very more most into about across all any each every get got has have had do does not no yes their them they who what when where which how out also via lakh lakhs crore crores percent per year years month months day days million").split(" "));
  const SYN = {
    customer: "saver", customers: "saver", user: "saver", users: "saver", saver: "saver", savers: "saver", people: "saver", members: "saver", member: "saver",
    "return": "interest", returns: "interest", profit: "interest", profits: "interest", interest: "interest", earn: "interest", earns: "interest", rate: "interest", yield: "interest",
    insured: "insure", insurance: "insure", insure: "insure", protected: "insure", covered: "insure",
    minute: "minute", minutes: "minute", mins: "minute", min: "minute",
    deposit: "deposit", deposits: "deposit", depositor: "deposit",
    fee: "fee", fees: "fee", charge: "fee", charges: "fee", free: "fee",
    pot: "pot", pots: "pot", award: "award", awards: "award", won: "award", winner: "award", winning: "award"
  };
  const CAT_LABEL = { Claims: "Claims policy", Tone: "Voice guide", Messaging: "Messaging guide", Accessibility: "Accessibility guide", Visual: "Visual identity", Glossary: "Glossary" };

  // Small helpers.
  // norm() lower-cases text and tidies quotes/spaces so we can compare text fairly.
  // isExpired() is true when a fact's "valid until" date has passed.
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function norm(s) { return String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim(); }
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function isExpired(fact, today) { return !!fact.expires && fact.expires < (today || todayISO()); }
  function ruleById(kit, id) { return (kit.rules || []).find(r => r.id === id); }
  function ruleOn(kit, id) { const r = ruleById(kit, id); return r && r.enabled !== false ? r : null; }
  function refFor(rule) { return rule ? (CAT_LABEL[rule.category] || rule.category) + " · " + rule.id : ""; }

  // Turns a sentence into its important words, e.g. "Join 5 lakh happy customers" -> [join, happy, saver].
  // Small words like "the" are dropped, and synonyms are merged (customers/users/savers -> saver)
  // so we can tell which approved fact a sentence is talking about.
  function topicWords(s) {
    return norm(s).replace(/[^a-z0-9%\s]/g, " ").split(" ")
      .filter(w => w && !STOP.has(w) && !/^\d/.test(w) && w.length > 2)
      .map(w => SYN[w] || w.replace(/s$/, ""));
  }

  // ---------- numbers ----------
  // Finds numbers in text, with their unit: "12%", "5 lakh", "under 3 minutes", "₹5,200".
  const NUM_RE = /(?:₹\s?|rs\.?\s?)?(\d[\d,]*(?:\.\d+)?)\s?(%|percent|lakh|lakhs|crore|crores|k\b|million|minutes?|mins?|years?|months?|days?|x\b)?/gi;
  function unitOf(u) {
    u = (u || "").toLowerCase();
    if (u === "%" || u === "percent") return "%";
    if (u.startsWith("lakh")) return "lakh";
    if (u.startsWith("crore")) return "crore";
    if (u.startsWith("min")) return "minute";
    if (u.startsWith("year")) return "year";
    if (u.startsWith("month")) return "month";
    if (u.startsWith("day")) return "day";
    return u;
  }
  // Returns every number in a piece of text as { raw, value, unit }.
  // "#1" is skipped here because it's a ranking, which rule C-2 handles.
  function extractNumbers(s) {
    const out = []; let m; NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(s))) {
      const before = s.slice(Math.max(0, m.index - 1), m.index);
      if (before === "#" || /no\.\s?$/i.test(s.slice(Math.max(0, m.index - 4), m.index))) continue; // "#1" is a ranking, handled by C-2
      const raw = m[0].trimEnd();
      const after = s.slice(m.index + raw.length, m.index + raw.length + 14), prior = s.slice(Math.max(0, m.index - 14), m.index);
      if (!m[2] && /^[a-z]/i.test(after)) continue; // e.g. "2nd"
      if (!m[2] && isDateOrTime(raw, after, prior)) continue; // "2 November", "Nov 2", "2026", "10:30", "9 am" are not claims
      if (/^[\/-]\d/.test(after) || /\d[\/-]$/.test(prior)) continue; // "24/7", "1-1" are phrases, not figures
      out.push({ raw: raw.trim(), value: parseFloat(m[1].replace(/,/g, "")), unit: unitOf(m[2]), index: m.index });
    }
    return out;
  }
  const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
  function isDateOrTime(raw, after, prior) {
    if (new RegExp("^\\s*(?:st|nd|rd|th)?\\s*(?:of\\s+)?" + MONTH + "\\b", "i").test(after)) return true;   // 2 November, 2nd of Nov
    if (new RegExp(MONTH + "\\.?\\s*$", "i").test(prior)) return true;                                           // November 2, Nov 2026
    if (/^:\d/.test(after) || /\d:$/.test(prior) || /^\s*(?:am|pm|a\.m\.|p\.m\.)\b/i.test(after)) return true; // 10:30, 9 am
    if (/^(19|20)\d\d$/.test(raw) && !/[,\u20b9]/.test(raw)) return true;                                            // a year like 2026
    return false;
  }
  // Two numbers match if the value is the same and the unit is the same (or one has no unit).
  function sameNumber(a, b) { return Math.abs(a.value - b.value) < 1e-9 && (a.unit === b.unit || !a.unit || !b.unit); }

  // ---------- sentences ----------
  // Splits text into sentences and remembers where each one starts.
  function sentences(text) {
    // split on . ! ? only when followed by whitespace/end (so "7.25%" stays whole), and on new lines
    const out = []; const re = /[^\n]*?(?:[.!?]+(?=\s|$)|\n|$)/g; let m;
    while ((m = re.exec(text))) {
      if (m[0] === "" ) { if (re.lastIndex >= text.length) break; re.lastIndex++; continue; }
      const lead = m[0].length - m[0].trimStart().length;
      if (m[0].trim()) out.push({ text: m[0].trim(), index: m.index + lead });
    }
    return out;
  }

  // ---------- issue helper ----------
  let seq = 0;
  // Every problem we find is an "issue" object: which rule, how serious, the exact words,
  // why it's a problem, where the rule comes from, and the suggested fixes.
  function issue(o) {
    return Object.assign({ key: "i" + (++seq), source: "Rule", fixes: [], status: "open" }, o);
  }

  // ---------- Layer 1: rules ----------
  // LAYER 1: RULE CHECKS
  // Goes through each rule in the brand kit and looks for its patterns in the text,
  // for example "guaranteed" (C-1) or "sign up now" (T-1). Every match becomes an issue.
  // These checks are exact: the same text always gives the same result.
  function ruleChecks(text, kit) {
    const out = [];
    for (const r of kit.rules || []) {
      if (r.enabled === false || !r.patterns || !r.patterns.length) continue;
      for (const p of r.patterns) {
        const re = new RegExp(p, "gi"); let m;
        while ((m = re.exec(text))) {
          if (!m[0]) { re.lastIndex++; continue; }
          if (r.id === "C-2") continue; // rankings go through fact check below
          const fixes = [];
          if (r.id === "C-1") fixes.push({ label: "Remove the promise", replacement: "" });
          else if (r.id === "C-4") fixes.push({ label: "Remove the competitor name", replacement: "" });
          else if (r.fix !== undefined && r.fix !== "") fixes.push({ label: "Use “" + r.fix.trim() + "”", replacement: r.fix });
          out.push(issue({ ruleId: r.id, category: r.category, severity: r.severity, excerpt: m[0], index: m.index, pattern: p,
            message: r.title + ". " + r.detail, reference: refFor(r), fixes, examples: r.examples }));
        }
      }
    }
    // Glossary: words the brand wants to avoid, e.g. "customers" -> "savers".
    for (const g of kit.glossary || []) {
      for (const bad of g.avoid || []) {
        const caseSensitive = /[A-Z]/.test(bad);
        const re = new RegExp("(?<![\\w])" + escapeRe(bad) + "(?![\\w])", caseSensitive ? "g" : "gi"); let m;
        while ((m = re.exec(text))) {
          if (text.slice(m.index, m.index + g.use.length) === g.use) continue;
          let rep = g.use;
          if (!caseSensitive && m[0][0] === m[0][0].toUpperCase() && rep[0] === rep[0].toLowerCase()) rep = rep[0].toUpperCase() + rep.slice(1);
          out.push(issue({ ruleId: g.id, category: "Glossary", severity: "suggestion", excerpt: m[0], index: m.index,
            message: "Use “" + g.use + "” instead of “" + m[0] + "”. " + (g.note || ""), reference: "Glossary · " + g.id,
            fixes: [{ label: "Use “" + rep + "”", replacement: rep }] }));
        }
      }
    }
    // A-2 emojis
    if (ruleOn(kit, "A-2")) {
      const emojis = text.match(/\p{Extended_Pictographic}/gu) || [];
      if (emojis.length > 3) {
        const run = /(?:\p{Extended_Pictographic}️?\s*){2,}/u.exec(text) || /\p{Extended_Pictographic}/u.exec(text);
        const r = ruleById(kit, "A-2");
        out.push(issue({ ruleId: "A-2", category: r.category, severity: r.severity, excerpt: run[0].trimEnd(), index: run.index,
          message: r.title + ". This text has " + emojis.length + " emojis. " + r.detail, reference: refFor(r),
          fixes: [{ label: "Keep just one", replacement: [...run[0].trim()].filter(c => /\p{Extended_Pictographic}/u.test(c))[0] || "" }] }));
      }
    }
    // A-3 caps
    if (ruleOn(kit, "A-3")) {
      const r = ruleById(kit, "A-3"); const re = /\b[A-Z][A-Z']{3,}\b/g; let m;
      while ((m = re.exec(text))) {
        if (ACRONYMS.has(m[0])) continue;
        const nice = m[0][0] + m[0].slice(1).toLowerCase();
        out.push(issue({ ruleId: "A-3", category: r.category, severity: r.severity, excerpt: m[0], index: m.index,
          message: r.title + ". " + r.detail, reference: refFor(r), fixes: [{ label: "Use “" + nice + "”", replacement: nice }] }));
      }
    }
    // A-4 long sentences
    if (ruleOn(kit, "A-4")) {
      const r = ruleById(kit, "A-4");
      for (const s of sentences(text)) {
        const n = s.text.split(/\s+/).length;
        if (n > 30) out.push(issue({ ruleId: "A-4", category: r.category, severity: r.severity, excerpt: s.text, index: s.index,
          message: r.title + ". This sentence has " + n + " words. " + r.detail, reference: refFor(r) }));
      }
    }
    // A-6 hashtags
    if (ruleOn(kit, "A-6")) {
      const r = ruleById(kit, "A-6"); const re = /#([a-z][a-z0-9]{5,})\b/g; let m;
      while ((m = re.exec(text))) {
        out.push(issue({ ruleId: "A-6", category: r.category, severity: r.severity, excerpt: m[0], index: m.index,
          message: r.title + ". " + r.detail, reference: refFor(r),
          fixes: camelHashtag(m[1]) ? [{ label: "Use “#" + camelHashtag(m[1]) + "”", replacement: "#" + camelHashtag(m[1]) }] : [] }));
      }
    }
    // M-1 messaging (rule-based fallback; the AI check judges this better)
    if (ruleOn(kit, "M-1")) {
      const words = text.split(/\s+/).filter(Boolean).length;
      const hit = /\b(sav(e|es|ing|er|ers)|safe|safety|insured|secure|small steps?|adds? up|simple|easy|habit)/i.test(text);
      if (words > 12 && !hit) {
        const r = ruleById(kit, "M-1");
        out.push(issue({ ruleId: "M-1", category: r.category, severity: r.severity, excerpt: "", index: -1,
          message: r.title + ". " + r.detail, reference: refFor(r) }));
      }
    }
    return out;
  }

  const HASH_WORDS = ["save", "smart", "savings", "pot", "money", "kitebird", "small", "steps", "diwali", "every", "day", "safe", "simple", "habit", "habits", "goal", "goals", "week", "start", "today", "india", "finance", "fintech", "budget", "spend", "less", "more"];
  // Tries to split a hashtag like "savesmart" into known words so we can suggest "#SaveSmart".
  function camelHashtag(tag) {
    let rest = tag.toLowerCase();
    const parts = [];
    while (rest.length > 0) {
      // take the longest known word at the start of what's left
      let found = "";
      for (const w of HASH_WORDS) {
        if (rest.startsWith(w) && w.length > found.length) found = w;
      }
      if (!found) return null; // can't split it, so don't suggest anything
      parts.push(found[0].toUpperCase() + found.slice(1));
      rest = rest.slice(found.length);
    }
    return parts.length > 1 ? parts.join("") : null;
  }


  // ---------- Layer 2: claims against approved facts ----------
  // How related is a sentence to an approved fact? Counts the important words they share.
  function factScore(claimSentence, fact) {
    const a = new Set(topicWords(claimSentence)); const b = new Set(topicWords(fact.text));
    let n = 0; for (const w of a) if (b.has(w)) n++;
    return n;
  }

  // LAYER 2: FACT CHECKS
  // For every number in every sentence:
  //   1. find the approved facts that talk about the same thing
  //   2. same number in a valid fact      -> verified (shown in green)
  //   3. same number but the fact expired -> blocker, suggest the current fact
  //   4. same topic but different number  -> blocker, suggest the approved number
  //   5. nothing matches                  -> blocker, no source
  // Ranking words (#1, best, fastest...) need a fact that says so, otherwise they're blockers too.
  function claimChecks(text, kit, today) {
    const issues = []; const verified = [];
    const facts = kit.facts || [];
    const c3 = ruleOn(kit, "C-3"); const c2 = ruleOn(kit, "C-2");
    for (const s of sentences(text)) {
      // numbers
      if (c3) for (const num of extractNumbers(s.text)) {
        if (!num.unit && num.value < 10 && !/%/.test(num.raw)) { /* small bare numbers like "1 app" are rarely claims */ }
        const idx = s.index + num.index;
        const ranked = facts.map(f => ({ f, score: factScore(s.text, f), nums: extractNumbers(f.text) }))
          .sort((x, y) => y.score - x.score);
        const live = ranked.filter(r => !isExpired(r.f, today));
        const support = live.find(r => r.score >= 1 && r.nums.some(n => sameNumber(n, num)));
        if (support) {
          verified.push({ excerpt: num.raw, index: idx, factId: support.f.id, fact: support.f.text, source: support.f.source, expires: support.f.expires });
          continue;
        }
        const expired = ranked.find(r => isExpired(r.f, today) && r.score >= 1 && r.nums.some(n => sameNumber(n, num)));
        const sameTopic = live.find(r => r.score >= 1 && r.nums.some(n => n.unit && n.unit === num.unit));
        if (expired) {
          const fixes = [];
          if (sameTopic) { const n2 = sameTopic.nums.find(n => n.unit === num.unit); fixes.push({ label: "Use the current figure from " + sameTopic.f.id, replacement: (/over|up to/i.test(sameTopic.f.text) ? (/up to/i.test(sameTopic.f.text) ? "up to " : "over ") : "") + n2.raw }); }
          issues.push(issue({ ruleId: "C-3", category: "Claims", severity: "blocker", source: "Fact check", excerpt: num.raw, index: idx, factId: expired.f.id,
            message: "This figure comes from an expired fact (" + expired.f.id + ", expired " + expired.f.expires + "): “" + expired.f.text + "”" + (sameTopic ? " The current approved fact is " + sameTopic.f.id + ": “" + sameTopic.f.text + "”" : ""),
            reference: "Fact library · " + expired.f.id + " (expired)", fixes }));
        } else if (sameTopic) {
          const n2 = sameTopic.nums.find(n => n.unit === num.unit);
          const lead = /up to/i.test(sameTopic.f.text) ? "up to " : /\bover\b/i.test(sameTopic.f.text) ? "over " : "";
          issues.push(issue({ ruleId: "C-3", category: "Claims", severity: "blocker", source: "Fact check", excerpt: num.raw, index: idx, factId: sameTopic.f.id,
            message: "This doesn't match the approved fact " + sameTopic.f.id + ": “" + sameTopic.f.text + "” (source: " + sameTopic.f.source + ")",
            reference: "Fact library · " + sameTopic.f.id, fixes: [{ label: "Use the approved figure: " + lead + n2.raw, replacement: lead + n2.raw }] }));
        } else {
          issues.push(issue({ ruleId: "C-3", category: "Claims", severity: c3.severity, source: "Fact check", excerpt: num.raw, index: idx,
            message: "No approved fact supports “" + num.raw + "”. " + c3.detail, reference: refFor(c3) + " · no matching fact",
            fixes: [{ label: "Remove the figure", replacement: "" }] }));
        }
      }
      // rankings / superlatives
      if (c2) for (const p of c2.patterns) {
        const re = new RegExp(p, "gi"); let m;
        while ((m = re.exec(s.text))) {
          const word = norm(m[0]);
          const backing = facts.find(f => !isExpired(f, today) && norm(f.text).includes(word) && factScore(s.text, f) >= 1);
          const idx = s.index + m.index;
          if (backing) { verified.push({ excerpt: m[0], index: idx, factId: backing.id, fact: backing.text, source: backing.source, expires: backing.expires }); continue; }
          const alt = facts.find(f => f.id === "F-01" && !isExpired(f, today));
          issues.push(issue({ ruleId: "C-2", category: "Claims", severity: c2.severity, source: "Fact check", excerpt: m[0], index: idx,
            message: "“" + m[0] + "” is a ranking claim and nothing in the approved fact library backs it up." + (alt ? " An approved alternative: “" + alt.text + "”" : ""),
            reference: refFor(c2) + " · no matching fact", fixes: [{ label: "Remove the ranking", replacement: "" }] }));
        }
      }
    }
    return { issues, verified };
  }

  // ---------- verify the AI's answer (Layer 3 guard) ----------
  // LAYER 3 GUARD: CHECK THE AI'S ANSWER BEFORE SHOWING IT
  // The AI can make mistakes, so we only keep what we can verify in code:
  // - the rule it mentions must exist (and not be one of the exact rules that code already checks)
  // - the words it quotes must really be in the text
  // - a "supported" claim must quote words that really appear in a real, unexpired fact
  // Anything that fails is thrown away (counted in `dropped`) or treated as unsupported.
  function verifyAI(ai, text, kit, today, existing) {
    const out = []; const verified = []; const dropped = [];
    const ntext = norm(text);
    const have = new Set((existing || []).map(i => i.ruleId + "|" + norm(i.excerpt)));
    for (const it of (ai && ai.issues) || []) {
      const rule = ruleById(kit, it.ruleId);
      const ex = String(it.excerpt || "").trim();
      if (!rule || rule.enabled === false) { dropped.push({ why: "unknown rule " + it.ruleId, it }); continue; }
      if (ex && !ntext.includes(norm(ex))) { dropped.push({ why: "excerpt not in text", it }); continue; }
      if (EXACT_ONLY.has(rule.id)) { dropped.push({ why: rule.id + " is checked exactly by code", it }); continue; }
      if (it.fix && norm(it.fix) === norm(ex)) { dropped.push({ why: "suggested fix changes nothing", it }); continue; }
      if (have.has(rule.id + "|" + norm(ex))) continue;
      have.add(rule.id + "|" + norm(ex));
      out.push(issue({ ruleId: rule.id, category: rule.category, severity: SEV_ORDER[it.severity] !== undefined ? it.severity : rule.severity,
        source: "AI check", excerpt: ex, index: ex ? ntext.indexOf(norm(ex)) : -1,
        message: rule.title + ". " + (it.explanation || rule.detail), reference: refFor(rule),
        fixes: it.fix ? [{ label: "Use “" + it.fix + "”", replacement: it.fix }] : [] }));
    }
    for (const c of (ai && ai.claims) || []) {
      const ex = String(c.excerpt || "").trim();
      if (!ex || !ntext.includes(norm(ex))) { dropped.push({ why: "claim not in text", it: c }); continue; }
      if (extractNumbers(ex).length) continue; // numbers are always decided by code (Layer 2)
      const fact = (kit.facts || []).find(f => f.id === c.factId);
      let ok = c.verdict === "supported" && fact && !isExpired(fact, today) && c.quote && norm(fact.text).includes(norm(c.quote));
      if (ok) { verified.push({ excerpt: ex, factId: fact.id, fact: fact.text, source: fact.source, expires: fact.expires, by: "AI, checked by code" }); continue; }
      if ((existing || []).some(i => i.category === "Claims" && norm(ex).includes(norm(i.excerpt)) && i.excerpt)) continue;
      const why = c.verdict === "supported" ? " The AI said this was supported, but the cited fact " + (fact ? (isExpired(fact, today) ? "is expired" : "doesn't contain the quoted words") : "doesn't exist") + ", so PixelProof treats it as unsupported." : "";
      out.push(issue({ ruleId: "C-3", category: "Claims", severity: "blocker", source: "AI check", excerpt: ex, index: ntext.indexOf(norm(ex)),
        message: "No approved fact supports this claim. " + (c.explanation || "") + why, reference: "Claims policy · C-3 · checked against fact library",
        fixes: c.fix ? [{ label: "Use “" + c.fix + "”", replacement: c.fix }] : [] }));
    }
    return { issues: out, verified, dropped };
  }

  // ---------- context sent to the AI (keyword retrieval) ----------
  // Picks the approved facts most related to the text, to send to the AI along with the content.
  function retrieveFacts(text, kit, k, today) {
    return (kit.facts || []).filter(f => !isExpired(f, today))
      .map(f => ({ f, s: factScore(text, f) })).sort((a, b) => b.s - a.s).slice(0, k || 6).map(x => x.f);
  }

  // ---------- run everything local ----------
  // Runs layer 1 and layer 2 together. This part never needs the internet.
  function runLocal(text, kit, today) {
    const rules = ruleChecks(text, kit);
    const claims = claimChecks(text, kit, today);
    const all = rules.concat(claims.issues);
    // drop C-1 duplicates on the same span, keep everything else
    return { issues: sortIssues(dedupe(all)), verified: claims.verified };
  }
  function dedupe(list) {
    const seen = new Set(); const out = [];
    for (const i of list) { const k = i.ruleId + "|" + i.index + "|" + norm(i.excerpt); if (seen.has(k)) continue; seen.add(k); out.push(i); }
    return out;
  }
  function sortIssues(list) {
    return list.slice().sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || ((a.index < 0 ? 1e9 : a.index) - (b.index < 0 ? 1e9 : b.index)));
  }

  // ---------- fixes ----------
  // After a fix is applied: remove double spaces, spaces before punctuation, and fix capital letters.
  function tidy(t) {
    return t.replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?;:])/g, "$1").replace(/\( +/g, "(").replace(/ +\)/g, ")")
      .replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/^\s+/, "");
  }
  // Replaces the flagged words with the chosen fix. Only happens when the user clicks the fix button.
  function applyFix(text, iss, replacement) {
    if (!iss.excerpt) return text;
    let at = -1;
    if (iss.index >= 0 && text.slice(iss.index, iss.index + iss.excerpt.length) === iss.excerpt) at = iss.index;
    if (at < 0) at = text.indexOf(iss.excerpt);
    if (at < 0) { const lo = text.toLowerCase().indexOf(iss.excerpt.toLowerCase()); at = lo; }
    if (at < 0) return text;
    return tidy(text.slice(0, at) + replacement + text.slice(at + iss.excerpt.length));
  }

  // ---------- privacy ----------
  // PRIVACY: hide emails, phone numbers, PAN and ID numbers before any text is sent to the AI.
  function maskPII(text) {
    let n = 0;
    const t = String(text)
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, () => { n++; return "[email]"; })
      .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, () => { n++; return "[PAN]"; })
      .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, () => { n++; return "[ID number]"; })
      .replace(/(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, () => { n++; return "[phone]"; });
    return { text: t, count: n };
  }

  // ---------- visuals ----------
  // COLOUR MATHS
  // contrast() uses the WCAG formula (4.5:1 is the minimum for normal text).
  // deltaE() measures how different two colours look to the human eye (bigger = more different).
  function hexToRgb(h) { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map(c => c + c).join(""); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function rgbToHex(c) { return "#" + c.map(v => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase(); }
  function lin(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function luminance(c) { return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
  function contrast(a, b) { const L1 = luminance(a), L2 = luminance(b); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); }
  function toLab(c) {
    let [r, g, b] = c.map(lin);
    let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, y = r * 0.2126 + g * 0.7152 + b * 0.0722, z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    x = f(x); y = f(y); z = f(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  function deltaE(a, b) { const A = toLab(a), B = toLab(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); }

  // pixels: flat RGBA array. Returns dominant colours and issues.
  // IMAGE CHECKS
  // 1. Count the colours in the image and keep the main ones (4% of the image or more).
  // 2. Compare each main colour with the brand palette. Far from every brand colour = off-palette.
  // 3. Check the contrast between the two main colours.
  // 4. Make sure the image has alt text.
  function analyseImage(pixels, kit, altText) {
    const buckets = new Map(); let total = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 128) continue;
      const key = (pixels[i] >> 4) + "," + (pixels[i + 1] >> 4) + "," + (pixels[i + 2] >> 4);
      const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      b.n++; b.r += pixels[i]; b.g += pixels[i + 1]; b.b += pixels[i + 2]; buckets.set(key, b); total++;
    }
    let cols = [...buckets.values()].map(b => ({ rgb: [b.r / b.n, b.g / b.n, b.b / b.n], share: b.n / total }));
    // merge near-identical colours
    cols.sort((a, b) => b.share - a.share);
    const merged = [];
    for (const c of cols) { const m = merged.find(x => deltaE(x.rgb, c.rgb) < 10); if (m) m.share += c.share; else merged.push({ rgb: c.rgb, share: c.share }); }
    merged.sort((a, b) => b.share - a.share);
    const palette = (kit.palette || []).map(p => ({ name: p.name, hex: p.hex.toUpperCase(), rgb: hexToRgb(p.hex) }));
    const dominant = merged.filter(c => c.share >= 0.04).slice(0, 6).map(c => {
      const near = palette.map(p => ({ p, d: deltaE(c.rgb, p.rgb) })).sort((a, b) => a.d - b.d)[0];
      return { hex: rgbToHex(c.rgb), share: c.share, nearest: near ? near.p : null, distance: near ? near.d : 0, onBrand: near ? near.d <= 15 : true };
    });
    const issues = [];
    const off = dominant.filter(d => !d.onBrand);
    const offShare = off.reduce((s, d) => s + d.share, 0);
    const v1 = ruleOn(kit, "V-1");
    if (v1 && off.length && offShare >= 0.15) {
      issues.push(issue({ ruleId: "V-1", category: "Visual", severity: v1.severity, excerpt: "", index: -1, target: "image",
        message: "About " + Math.round(offShare * 100) + "% of this image uses colours outside the brand palette: " + off.map(d => d.hex + " (closest brand colour: " + d.nearest.name + " " + d.nearest.hex + ")").join(", ") + ".",
        reference: refFor(v1), fixes: [], colours: off }));
    }
    const v2 = ruleOn(kit, "V-2");
    if (v2 && dominant.length >= 2) {
      const ratio = contrast(hexToRgb(dominant[0].hex), hexToRgb(dominant[1].hex));
      if (ratio < 3) issues.push(issue({ ruleId: "V-2", category: "Visual", severity: "suggestion", excerpt: "", index: -1, target: "image",
        message: "The two main colours (" + dominant[0].hex + " and " + dominant[1].hex + ") have a contrast ratio of " + ratio.toFixed(1) + ":1. If text sits on this background it may be hard to read; WCAG AA needs 4.5:1 for body text.",
        reference: refFor(v2), fixes: [] }));
    }
    const a5 = ruleOn(kit, "A-5");
    if (a5 && !String(altText || "").trim()) {
      issues.push(issue({ ruleId: "A-5", category: "Accessibility", severity: a5.severity, excerpt: "", index: -1, target: "image",
        message: a5.title + ". " + a5.detail, reference: refFor(a5), fixes: [] }));
    }
    return { dominant, issues };
  }

  // ---------- word diff for review ----------
  // Shows what changed between two versions, word by word (used in the review screen).
  function diffWords(oldText, newText) {
    const A = String(oldText).split(/(\s+)/); // words and the spaces between them
    const B = String(newText).split(/(\s+)/);
    if (A.length * B.length > 400000) return [{ t: "del", s: oldText }, { t: "add", s: newText }]; // too long to compare
    // same[i][j] = how many words in a row the two versions share, starting from word i and word j
    const same = [];
    for (let i = 0; i <= A.length; i++) same.push(new Array(B.length + 1).fill(0));
    for (let i = A.length - 1; i >= 0; i--) {
      for (let j = B.length - 1; j >= 0; j--) {
        same[i][j] = A[i] === B[j] ? same[i + 1][j + 1] + 1 : Math.max(same[i + 1][j], same[i][j + 1]);
      }
    }
    // walk through both versions: unchanged words stay, others are marked removed or added
    const out = [];
    const push = (t, word) => {
      const last = out[out.length - 1];
      if (last && last.t === t) last.s += word; else out.push({ t, s: word });
    };
    let i = 0, j = 0;
    while (i < A.length && j < B.length) {
      if (A[i] === B[j]) { push("same", A[i]); i++; j++; }
      else if (same[i + 1][j] >= same[i][j + 1]) { push("del", A[i]); i++; }
      else { push("add", B[j]); j++; }
    }
    while (i < A.length) push("del", A[i++]);
    while (j < B.length) push("add", B[j++]);
    return out;
  }


  // ---------- GUIDELINE GAP DETECTOR ----------
  // Looks at everything people did with the flags in submitted work and finds rules that seem unclear.
  // Signals for a rule:
  //   dismissed  - the creator said the flag was wrong (with a reason)
  //   overridden - the reviewer marked an open flag "OK to publish"
  //   disagreed  - the reviewer disagreed with a dismissal (the creator misread the rule)
  //   fixed      - the creator accepted a fix (the rule worked)
  // Only signals newer than the rule's last approved change count, so fixing a rule "resets" it.
  function analyseGaps(items, kit) {
    const byRule = {};
    const seen = new Set();
    const get = id => (byRule[id] = byRule[id] || { ruleId: id, flagged: 0, dismissed: 0, overridden: 0, disagreed: 0, fixed: 0,
      reasons: [], pushedExcerpts: [], fixedExcerpts: [], patterns: {} });
    const ruleOf = id => (kit.rules || []).find(r => r.id === id);
    for (const it of items || []) {
      for (const v of it.versions || []) {
        const at = v.at || "";
        const counts = (id) => { const r = ruleOf(id); return !r || !r.revisedAt || at > r.revisedAt; };
        for (const i of v.issues || []) {
          if (!ruleOf(i.ruleId) || !counts(i.ruleId)) continue;
          const key = it.id + "|" + i.ruleId + "|" + norm(i.excerpt) + "|" + (i.status === "dismissed" ? "d" : "o");
          if (seen.has(key)) continue; // the same flag carried into a later version counts once
          seen.add(key);
          const g = get(i.ruleId); g.flagged++;
          if (i.pattern) g.patterns[i.pattern] = g.patterns[i.pattern] || { flagged: 0, pushed: 0, fixed: 0 };
          if (i.pattern) g.patterns[i.pattern].flagged++;
          if (i.status === "dismissed") {
            g.dismissed++; if (i.reason) g.reasons.push({ kind: "Creator dismissed", text: i.reason, excerpt: i.excerpt });
            if (i.review === "rejected") { g.disagreed++; g.fixedExcerpts.push(i.excerpt); }
            else { g.pushedExcerpts.push(i.excerpt); if (i.pattern) g.patterns[i.pattern].pushed++; }
          }
          if (i.override) {
            g.overridden++; g.reasons.push({ kind: "Reviewer allowed it", text: i.override, excerpt: i.excerpt });
            g.pushedExcerpts.push(i.excerpt); if (i.pattern) g.patterns[i.pattern].pushed++;
          }
        }
        for (const f of v.fixed || []) {
          if (!ruleOf(f.ruleId) || !counts(f.ruleId)) continue;
          const key = it.id + "|" + f.ruleId + "|" + norm(f.excerpt) + "|f";
          if (seen.has(key)) continue; seen.add(key);
          const g = get(f.ruleId); g.flagged++; g.fixed++; g.fixedExcerpts.push(f.excerpt);
          if (f.pattern && g.patterns[f.pattern]) g.patterns[f.pattern].fixed++;
        }
      }
    }
    const out = Object.values(byRule).map(g => {
      g.pushback = g.dismissed + g.overridden; // each one means someone read the rule differently
      g.rate = g.flagged ? g.pushback / g.flagged : 0;
      g.level = g.pushback >= 2 && g.rate >= 0.4 ? "unclear" : g.pushback >= 1 ? "watch" : "ok";
      g.rule = ruleOf(g.ruleId);
      g.pushedExcerpts = uniq(g.pushedExcerpts); g.fixedExcerpts = uniq(g.fixedExcerpts);
      return g;
    }).filter(g => g.pushback > 0);
    out.sort((a, b) => (b.level === "unclear") - (a.level === "unclear") || b.pushback - a.pushback || b.rate - a.rate);
    return out;
  }
  function uniq(a) { const s = new Set(); return a.filter(x => { const k = norm(x); if (!x || s.has(k)) return false; s.add(k); return true; }); }

  // A suggested change worked out by code alone (used when the AI is off, and as the starting point for the AI).
  // - examples come from real content: what people were allowed to publish vs what they fixed
  // - a phrase is suggested for removal if every time it was flagged people pushed back and nobody fixed it
  // - if reviewers keep allowing it, the severity drops one level
  function suggestRuleChange(gap) {
    const r = gap.rule || {};
    const lower = { blocker: "warning", warning: "suggestion", suggestion: "suggestion" };
    const removePatterns = Object.entries(gap.patterns || {})
      .filter(([, c]) => c.pushed >= 1 && c.fixed === 0 && c.pushed === c.flagged).map(([p]) => p);
    return {
      ruleId: r.id,
      detail: r.detail || "",
      allowed: gap.pushedExcerpts.slice(0, 3),
      notAllowed: gap.fixedExcerpts.slice(0, 3),
      severity: gap.overridden >= 2 ? lower[r.severity] || r.severity : r.severity,
      removePatterns,
      rationale: "Based on " + gap.flagged + " flag" + (gap.flagged === 1 ? "" : "s") + ": " + gap.dismissed + " dismissed, " +
        gap.overridden + " allowed by a reviewer, " + gap.fixed + " fixed.",
      source: "code"
    };
  }

  // Checks a suggested change (from the AI or a person) before it can be approved.
  // Patterns can only be removed if they really belong to the rule; severity must be a real level; text is trimmed.
  function validateRuleChange(change, rule) {
    const errors = [];
    const clean = s => String(s || "").replace(/\s+/g, " ").trim().slice(0, 400);
    const list = a => (Array.isArray(a) ? a : String(a || "").split("\n")).map(clean).filter(Boolean).slice(0, 5);
    const out = {
      ruleId: rule.id,
      detail: clean(change.detail),
      allowed: list(change.allowed),
      notAllowed: list(change.notAllowed),
      severity: SEV_ORDER[change.severity] !== undefined ? change.severity : rule.severity,
      removePatterns: (change.removePatterns || []).filter(p => (rule.patterns || []).includes(p)),
      rationale: clean(change.rationale),
      source: change.source || "person"
    };
    if (out.detail.length < 10) errors.push("The rule wording is too short.");
    if (out.removePatterns.length && out.removePatterns.length === (rule.patterns || []).length) errors.push("At least one phrase has to stay, or turn the rule off instead.");
    return { change: out, errors };
  }

  // Applies an approved change to the brand kit and records it in the guideline history.
  // A rule's regular expression as plain words, e.g. "limited time( only)?" -> "limited time (only)"
  function plainPattern(p) {
    return String(p).replace(/\\b/g, "").replace(/\[- \]/g, "-").replace(/\(\?:/g, "(").replace(/\\s[?*+]?/g, " ").replace(/[?*+\\^$]/g, "")
      .replace(/\(\s+/g, "(").replace(/(\S)\(/g, "$1 (").replace(/\s+/g, " ").trim();
  }
  function applyRuleChange(kit, change, by, at) {
    const k = JSON.parse(JSON.stringify(kit));
    const rule = (k.rules || []).find(r => r.id === change.ruleId);
    if (!rule) throw new Error("Rule " + change.ruleId + " not found");
    const before = { detail: rule.detail, severity: rule.severity, patterns: (rule.patterns || []).slice(), examples: rule.examples || null };
    rule.detail = change.detail;
    rule.severity = change.severity;
    rule.patterns = (rule.patterns || []).filter(p => !change.removePatterns.includes(p));
    rule.examples = { allowed: change.allowed, notAllowed: change.notAllowed };
    rule.revisedAt = at;
    k.version = (k.version || 1) + 1;
    const after = { detail: rule.detail, severity: rule.severity, patterns: rule.patterns.slice(), examples: rule.examples };
    k.history = (k.history || []).concat([{ version: k.version, at, by, ruleId: rule.id, title: rule.title, before, after,
      summary: summariseChange(before, after), rationale: change.rationale, source: change.source }]);
    return k;
  }
  function summariseChange(b, a) {
    const parts = [];
    if (b.detail !== a.detail) parts.push("clearer wording");
    if (b.severity !== a.severity) parts.push("severity " + b.severity + " \u2192 " + a.severity);
    const removed = b.patterns.filter(p => !a.patterns.includes(p));
    if (removed.length) parts.push("stopped flagging " + removed.map(p => "\u201c" + plainPattern(p) + "\u201d").join(", "));
    if (a.examples && ((a.examples.allowed || []).length || (a.examples.notAllowed || []).length)) parts.push("added examples");
    return parts.join("; ") || "no change";
  }
  // Puts a rule back to how it was before a recorded change (also recorded in the history).
  function revertRuleChange(kit, entry, by, at) {
    const k = JSON.parse(JSON.stringify(kit));
    const rule = (k.rules || []).find(r => r.id === entry.ruleId);
    if (!rule) throw new Error("Rule " + entry.ruleId + " not found");
    const before = { detail: rule.detail, severity: rule.severity, patterns: (rule.patterns || []).slice(), examples: rule.examples || null };
    rule.detail = entry.before.detail; rule.severity = entry.before.severity; rule.patterns = entry.before.patterns.slice();
    rule.examples = entry.before.examples || undefined; rule.revisedAt = at;
    k.version = (k.version || 1) + 1;
    k.history = (k.history || []).concat([{ version: k.version, at, by, ruleId: rule.id, title: rule.title, before,
      after: entry.before, summary: "undid version " + entry.version, source: "person" }]);
    return k;
  }


  // ---------- Guideline import ----------
  // Turns a brand guideline document into proposed rules, facts and glossary terms. Every proposal must quote
  // a sentence that really is in the document (checked here, by code), and nothing is added until a brand manager approves.
  const CATEGORIES = ["Claims", "Tone", "Messaging", "Accessibility", "Writing", "Glossary", "Visual"];
  const BLAND = "The quick brown fox jumps over the lazy dog. We help people save money every week with a simple app. Read more about our team and our plans for next year.";
  function normQuote(s) { return String(s || "").toLowerCase().replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim(); }
  function quoteInDoc(doc, quote) { const q = normQuote(quote); return q.length >= 8 && normQuote(doc).includes(q); }
  function safePattern(p) {
    p = String(p || "").trim();
    if (p.length < 3 || p.length > 80) return null;
    let re; try { re = new RegExp(p, "gi"); } catch (e) { return null; }
    if (re.test("")) return null;                           // matches nothing at all
    re.lastIndex = 0; if (re.test(BLAND)) return null;       // so broad it flags ordinary writing
    return p;
  }
  function phrasePattern(phrase) { return "\\b" + escapeRe(String(phrase).trim().toLowerCase()).replace(/\s+/g, "\\s+") + "\\b"; }
  function cleanStr(s, max) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max); }

  // Checks a proposal (from the AI or from code) against the document and the current brand kit.
  function validateImport(proposal, doc, kit, today) {
    proposal = proposal || {}; today = today || todayISO();
    const out = { rules: [], facts: [], glossary: [], rejected: [] };
    const reject = (kind, label, why) => out.rejected.push({ kind, label: cleanStr(label, 80), why });
    const existingPatterns = new Set((kit.rules || []).flatMap(r => r.patterns || []).map(x => x.toLowerCase()));
    const existingTitles = new Set((kit.rules || []).map(r => norm(r.title)));
    const avoidSeen = new Set((kit.glossary || []).flatMap(g => g.avoid || []).map(a => a.toLowerCase()));
    const factSeen = new Set((kit.facts || []).map(f => norm(f.text)));
    for (const r of proposal.rules || []) {
      const title = cleanStr(r.title, 80), detail = cleanStr(r.detail, 300);
      if (title.length < 3 || detail.length < 10) { reject("rule", title || detail, "too short to be a rule"); continue; }
      if (!quoteInDoc(doc, r.quote)) { reject("rule", title, "its quote isn't in the document"); continue; }
      if (existingTitles.has(norm(title))) { reject("rule", title, "the brand kit already has this rule"); continue; }
      const patterns = []; let dropped = 0;
      for (const p of (r.patterns || []).slice(0, 8)) { const ok = safePattern(p); if (ok && !existingPatterns.has(ok.toLowerCase()) && !patterns.includes(ok)) patterns.push(ok); else dropped++; }
      out.rules.push({ title, detail, category: CATEGORIES.includes(r.category) ? r.category : "Writing",
        severity: SEV_ORDER.hasOwnProperty(r.severity) ? r.severity : "warning", patterns, fix: cleanStr(r.fix, 60),
        quote: cleanStr(r.quote, 400), droppedPatterns: dropped, on: true });
      existingTitles.add(norm(title));
    }
    for (const f of proposal.facts || []) {
      const text = cleanStr(f.text, 300);
      if (text.length < 10) { reject("fact", text, "too short"); continue; }
      if (!quoteInDoc(doc, f.quote) && !quoteInDoc(doc, text)) { reject("fact", text, "its quote isn't in the document"); continue; }
      if (factSeen.has(norm(text))) { reject("fact", text, "the fact library already has it"); continue; }
      let expires = /^\d{4}-\d{2}-\d{2}$/.test(f.expires || "") && f.expires > today ? f.expires : null;
      if (!expires) { const d = new Date(today); d.setFullYear(d.getFullYear() + 1); expires = d.toISOString().slice(0, 10); }
      out.facts.push({ text, source: cleanStr(f.source, 120), quote: cleanStr(f.quote || text, 400), expires, on: true });
      factSeen.add(norm(text));
    }
    for (const g of proposal.glossary || []) {
      const use = cleanStr(g.use, 40);
      const avoid = (g.avoid || []).map(a => cleanStr(a, 40)).filter(a => a.length >= 2 && a.toLowerCase() !== use.toLowerCase() && !avoidSeen.has(a.toLowerCase()));
      if (use.length < 2 || !avoid.length) { reject("glossary", use, "nothing new to avoid"); continue; }
      if (!quoteInDoc(doc, g.quote)) { reject("glossary", use, "its quote isn't in the document"); continue; }
      avoid.forEach(a => avoidSeen.add(a.toLowerCase()));
      out.glossary.push({ use, avoid, note: cleanStr(g.note, 200), quote: cleanStr(g.quote, 400), on: true });
    }
    return out;
  }

  // A first pass by code, so import works without AI: "Use X, not Y", banned quoted phrases,
  // "Always/Never" sentences, and sentences with figures (proposed as facts).
  function extractGuideline(doc) {
    const text = String(doc || "").replace(/\r/g, "");
    // keep track of the section each sentence is in, so everything under an "Approved facts" heading becomes a fact
    const sentences = []; let section = "";
    // PDFs break long sentences across lines: join a long line that doesn't end a sentence with the next one
    const lines = [];
    for (const l of text.split(/\n+/).map(x => x.trim()).filter(Boolean)) {
      const prev = lines[lines.length - 1];
      if (prev && prev.length > 60 && !/[.!?:]$/.test(prev)) lines[lines.length - 1] = prev + " " + l; else lines.push(l);
    }
    for (const line of lines) {
      if (line.length <= 60 && !/[.!?]$/.test(line)) { section = line; continue; }
      line.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(x => x.length >= 12 && x.length <= 400).forEach(x => sentences.push({ x, section }));
    }
    const Q = "[\"“‘']"; const QE = "[\"”’']";
    const prop = { rules: [], facts: [], glossary: [] };
    for (const { x: sent, section } of sentences) {
      let m;
      if (/\bfacts?\b/i.test(section) && sent.length <= 220) { prop.facts.push({ text: sent, source: "", quote: sent }); continue; }
      const g1 = new RegExp("\\b(?:use|say|write|call (?:it|them|us))\\s+" + Q + "([^\"”’']{2,40})" + QE + ",?\\s*(?:not|never|instead of|rather than)\\s+(.{2,120}?)[.;]?$", "i").exec(sent);
      const g2 = new RegExp("\\b(?:don't|do not|never)\\s+(?:say|use|write)\\s+" + Q + "([^\"”’']{2,40})" + QE + "[;,]?\\s*(?:say|use|write)\\s+" + Q + "([^\"”’']{2,40})" + QE, "i").exec(sent);
      if (g1) {
        const avoid = (g1[2].match(new RegExp(Q + "([^\"”’']{2,40})" + QE, "g")) || []).map(x => x.slice(1, -1));
        if (avoid.length) { prop.glossary.push({ use: g1[1], avoid, note: "", quote: sent }); continue; }
      }
      if (g2) { prop.glossary.push({ use: g2[2], avoid: [g2[1]], note: "", quote: sent }); continue; }
      if (/\b(?:never|don't|do not|avoid|no)\b/i.test(sent) && (m = sent.match(new RegExp(Q + "([^\"”’']{3,40})" + QE, "g")))) {
        const phrases = m.map(x => x.slice(1, -1)).filter(x => !/^\W*$/.test(x));
        if (phrases.length) {
          prop.rules.push({ title: "Avoid " + phrases.slice(0, 2).map(x => "“" + x + "”").join(" and "), detail: sent, category: "Tone", severity: "warning",
            patterns: phrases.map(phrasePattern), fix: "", quote: sent });
          continue;
        }
      }
      if (/^(?:always|never|don't|do not|avoid|every|all)\b/i.test(sent) && sent.length <= 220) {
        prop.rules.push({ title: cleanStr(sent.replace(/[.!]$/, ""), 70), detail: sent, category: "Writing", severity: "suggestion", patterns: [], fix: "", quote: sent });
        continue;
      }
      if (/(?:\d+(?:\.\d+)?\s?%|₹\s?\d|\b\d[\d,]*\s?(?:lakh|crore|minutes?|days?)\b)/i.test(sent) && sent.length <= 220) {
        prop.facts.push({ text: sent, source: "", quote: sent });
      }
    }
    return prop;
  }

  // Adds the approved parts of an import to the brand kit, with new IDs, a new kit version and a history entry.
  function applyImport(kit, accepted, by, at, fileName, source) {
    const k = JSON.parse(JSON.stringify(kit));
    k.rules = k.rules || []; k.facts = k.facts || []; k.glossary = k.glossary || [];
    const next = (prefix, list, pad) => { const n = list.filter(x => String(x.id).startsWith(prefix)).reduce((mx, x) => Math.max(mx, parseInt(String(x.id).slice(prefix.length), 10) || 0), 0) + 1; return prefix + (pad ? String(n).padStart(pad, "0") : n); };
    const added = { rules: [], facts: [], glossary: [] };
    for (const r of accepted.rules || []) {
      const id = next("I-", k.rules);
      k.rules.push({ id, category: r.category, severity: r.severity, title: r.title, detail: r.detail, patterns: r.patterns || [], fix: r.fix || undefined, enabled: true, importedFrom: fileName, quote: r.quote });
      added.rules.push(id);
    }
    for (const f of accepted.facts || []) {
      const id = next("F-", k.facts, 2);
      k.facts.push({ id, text: f.text, source: f.source || ("Brand guideline: " + fileName), owner: "Brand team", expires: f.expires, quote: f.quote });
      added.facts.push(id);
    }
    for (const g of accepted.glossary || []) {
      const id = next("G-", k.glossary);
      k.glossary.push({ id, use: g.use, avoid: g.avoid, note: g.note || "From " + fileName });
      added.glossary.push(id);
    }
    const n = added.rules.length + added.facts.length + added.glossary.length;
    k.version = (k.version || 1) + 1;
    const parts = [];
    if (added.rules.length) parts.push(added.rules.length + " rule" + (added.rules.length === 1 ? "" : "s"));
    if (added.facts.length) parts.push(added.facts.length + " fact" + (added.facts.length === 1 ? "" : "s"));
    if (added.glossary.length) parts.push(added.glossary.length + " glossary term" + (added.glossary.length === 1 ? "" : "s"));
    k.history = (k.history || []).concat([{ version: k.version, at, by, kind: "import", ruleId: "Import", title: fileName,
      summary: n ? "imported " + parts.join(", ") + " from " + fileName : "nothing imported", added, source: source || "code" }]);
    return k;
  }
  function revertImport(kit, entry, by, at) {
    const k = JSON.parse(JSON.stringify(kit)); const a = entry.added || {};
    k.rules = (k.rules || []).filter(r => !(a.rules || []).includes(r.id));
    k.facts = (k.facts || []).filter(f => !(a.facts || []).includes(f.id));
    k.glossary = (k.glossary || []).filter(g => !(a.glossary || []).includes(g.id));
    k.version = (k.version || 1) + 1;
    k.history = (k.history || []).concat([{ version: k.version, at, by, kind: "import-undo", ruleId: "Import", title: entry.title, summary: "undid the import in version " + entry.version, source: "person" }]);
    return k;
  }

  const api = { validateImport, extractGuideline, applyImport, revertImport, quoteInDoc, safePattern, plainPattern, analyseGaps, suggestRuleChange, validateRuleChange, applyRuleChange, revertRuleChange, runLocal, ruleChecks, claimChecks, verifyAI, retrieveFacts, applyFix, maskPII, analyseImage, diffWords, extractNumbers,
    sortIssues, dedupe, isExpired, contrast, hexToRgb, camelHashtag, norm, todayISO, SEV_ORDER };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PP = api;
})(typeof window !== "undefined" ? window : globalThis);
