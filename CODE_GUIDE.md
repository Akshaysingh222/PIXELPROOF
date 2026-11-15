# How the PixelProof code works

A plain-English tour of the code, for anyone reading the repository (and for me, to explain it in a demo).

## The files

| File | What it does |
| --- | --- |
| `index.html` | The page skeleton: header, tabs, role switch. Loads the three scripts below. |
| `styles.css` | All the styling. |
| `js/brandkit.js` | The demo brand kit for Kitebird Money (a made-up brand): voice, rules, glossary, approved facts, colour palette, and the three sample texts. |
| `js/engine.js` | The checker. Rules, fact checks, checking the AI's answer, image colours, and the word-by-word diff. No user interface in here, so it can be tested on its own. |
| `js/app.js` | The user interface: the five screens, buttons, saving to the browser, and the review workflow. |
| `api/check.js` | The only server code. A small Vercel function that asks Google Gemini for the AI review. The API key lives here, never in the browser. |
| `tests/engine.test.js` | 15 tests for the checker (`npm test`). |
| `dev-server.js` | Runs the app on your own computer (`node dev-server.js`). |
| `vercel.json` | Gives the AI function up to 60 seconds. |

## What happens when you click "Check"

1. **`runCheck()` in app.js** takes the text from the box.
2. **Layer 1: rules (`ruleChecks()` in engine.js).** Each rule in the brand kit has patterns, for example C-1 looks for "guaranteed" or "risk-free" and T-1 looks for "sign up now". Every match becomes an *issue* with the rule ID, severity, the exact words, the reason, and a suggested fix. The glossary works the same way ("customers" becomes "savers"). There are also small checks for emojis, ALL CAPS, long sentences and hashtags.
3. **Layer 2: facts (`claimChecks()` in engine.js).** Every number in the text is pulled out with its unit ("12%", "5 lakh"). The code finds the approved fact about the same topic by counting shared words. Then:
   - same number in a valid fact = **verified** (green box, shows the source)
   - same number but the fact has expired = **blocker**, suggests the current fact
   - same topic, different number = **blocker**, suggests the approved number
   - no matching fact = **blocker**, "no source"
   Rankings like "#1" or "best" also need a fact that says so.
4. These results show straight away. Steps 2 and 3 run in the browser and don't need the internet.
5. **Layer 3: AI (`runAI()` in app.js, then `api/check.js`).** If an API key is set, the text is sent to our server function with personal details masked (`maskPII()`). The function gives Gemini the brand voice, rules, glossary, the related facts, and what the rules already found, and asks for a fixed JSON answer: extra issues, claims with the fact they rely on, and two rewrites.
6. **Checking the AI (`verifyAI()` in engine.js).** The AI can be wrong, so before anything is shown:
   - the rule it names must exist, and it can't be a rule that code already checks exactly
   - the words it quotes must really be in the text
   - a claim it calls "supported" must quote words that really appear in a real, unexpired fact
   - a "fix" that changes nothing is ignored
   Anything that fails is thrown out (the purple line says how many). The two rewrites are run back through the rules, so you see how many problems they still have.

## Fixing, dismissing and submitting

- **Fix button:** `applyFixTo()` swaps the flagged words for the fix and runs the checks again. Nothing changes unless you click.
- **Dismiss:** you have to type a reason. The reviewer sees it, and it feeds the Insights page.
- **Submit:** only allowed when every blocker is fixed or dismissed with a reason. `submitDraft()` saves the text plus all the check results as a version.

## Review workflow

- Switch between **Riya (Creator)** and **Arjun (Brand manager)** at the top.
- The reviewer sees the content, a word-by-word diff against the last version (`diffWords()`), what was fixed, what was dismissed and why, and verified claims.
- They can approve, request changes (comment required), agree or disagree with a dismissal, or mark a warning "OK to publish".
- "Request changes" sends it back; the creator clicks **Revise in checker**, fixes it, and submits version 2.
- Everything is saved in the browser with `localStorage`, so the demo needs no login.

## Images

`readImage()` shrinks the uploaded image onto a small canvas and reads its pixels. `analyseImage()` groups similar colours, keeps the main ones, and compares each with the brand palette using a colour-difference measure (CIE Lab delta E). It also checks the contrast of the two main colours (WCAG formula) and requires alt text.

## Questions a judge might ask

**Why not let the AI do everything?** AI is good at judging tone, but it can invent facts. Anything code can check exactly (numbers, banned words, colours) is done by code, so it's reliable and explainable. The AI is used for judgment, and its answers are verified before being shown.

**How do you stop the AI making things up?** It must cite a fact ID and quote the fact's words, and code checks that quote against the real fact library. If the check fails, the claim is treated as unsupported.

**What if the AI is down?** The rule and fact checks still run. The server also falls back to a faster model (Gemini 2.5 Flash-Lite) if the main one is slow or busy, and there's a "Try AI review again" button.

**How is private data protected?** Emails, phone numbers, PAN and ID numbers are masked before text goes to the AI, in the browser and again on the server. The API key is only on the server. The demo data stays in the user's browser.

**Why a web app and not the Chrome extension you planned?** Judges and new users need to open a link and use it with no installation. The extension is planned for Round 3, and it will reuse `engine.js` as it is.

**How do you know it works?** `npm test` runs 15 tests: blockers on the risky sample, verified facts, expired facts, AI answers being thrown out, privacy masking, image checks and contrast maths.
