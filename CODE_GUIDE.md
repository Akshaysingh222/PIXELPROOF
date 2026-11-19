# How the PixelProof code works

A plain-English tour of the code, for anyone reading the repository (and for me, to explain it in a demo).

## The files

| File | What it does |
| --- | --- |
| `index.html` | The page skeleton: header, tabs, role switch, account badge. Loads the scripts below. |
| `styles.css` | All the styling. |
| `js/brandkit.js` | The demo brand kit for Kitebird Money (a made-up brand): voice, rules, glossary, approved facts, colour palette, and the three sample texts. |
| `js/engine.js` | The checker. Rules, fact checks, checking the AI's answer, image colours, the word-by-word diff, and the guideline gap detector. No user interface in here, so it can be tested on its own and reused by the extension. |
| `js/team.js` | The team workspace: sign in, workspaces, roles, loading and saving the shared queue and brand kit, live updates. The only file that talks to Supabase. |
| `js/app.js` | The user interface: the six screens, buttons, saving, the review workflow, the gap detector screens and team mode. |
| `api/check.js` | A small Vercel function that asks Google Gemini for the AI review (and, with `mode: "rule"`, for a clearer rule wording). The API key lives here, never in the browser. |
| `api/config.js` | Tells the browser the team database's public address and key, if the team workspace is set up. |
| `supabase/schema.sql` | The team database: tables, row level security, the approval guard, and the create/join functions. |
| `extension/` | The Chrome extension. `content.js` runs inside LinkedIn, Gmail and X; `background.js` sends AI checks to the server; `sidepanel.*` and `options.*` are its two pages; `lib/` is a copy of the engine and demo brand kit. |
| `scripts/build-extension.js` | Copies the engine into the extension and builds the zip (`npm run build:extension`). |
| `tests/` | 30 tests (`npm test`): the checker, the gap detector, the API function and the extension. `supabase/test/` has the database security test. |
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

## Guideline gap detector (Insights)

1. **`analyseGaps()` in engine.js** goes through every submitted version and counts, per rule: how often it was flagged, dismissed by the creator, allowed by a reviewer ("OK to publish"), disagreed with, and fixed. It keeps the reasons people gave and the exact words. It also counts per phrase, so it knows if a phrase like "limited time" was always allowed and never fixed. Only checks made after the rule's last change are counted, so a fixed rule drops off the list.
2. A rule with at least two pushbacks and a pushback rate of 40% or more is **likely unclear**; one pushback is **worth watching**.
3. **Suggest a clearer rule:** `suggestRuleChange()` drafts a change from the evidence alone (stop flagging phrases that were always allowed, lower the severity if reviewers keep allowing it, examples from real content). If the AI is on, `askAIForRule()` in app.js sends the rule and the evidence to `api/check.js` with `mode: "rule"`, and Gemini returns clearer wording with allowed and not-allowed examples.
4. **`validateRuleChange()`** checks whatever came back: only phrases the rule really has can be removed, at least one must stay, the wording must be a real sentence, severity must be valid.
5. The brand manager edits and clicks **Approve**. **`applyRuleChange()`** updates the rule, raises the brand kit version and adds a history entry (who, when, before, after, who drafted it). The next check uses the new rule straight away, and **See the next check change** re-checks real content that was pushed back on.
6. **Undo** (`revertRuleChange()`) puts the old rule back and records that too.

## Team workspace

- **Demo mode** (no sign-in) keeps everything in the browser. **Team mode** keeps the brand kit and review queue in Supabase.
- `js/team.js` signs people in, lists their workspaces, creates one (`create_workspace` makes you admin and gives a 6-character code) or joins one (`join_workspace` makes you a creator).
- Each submitted item is one row: its status plus the full item (versions, comments, history) as JSON. The brand kit is a JSON column on the workspace.
- **Security is in the database, not the screen.** Row level security means you only see workspaces you belong to. A trigger (`items_guard`) refuses "approved" or "changes requested" from a creator, even if someone edits the page's code. Only brand managers and admins can change the brand kit; only admins change roles, and the last admin can't be removed. `supabase/test/rls_test.sql` tests all of this.
- **Live updates:** `subscribe()` listens for database changes, and the app also re-loads every 20 seconds as a backup. If you're typing in a box when an update arrives, the screen waits until you leave the box.

## Chrome extension

- `content.js` watches for the compose box you click into (LinkedIn's Quill editor, Gmail's message body, X's Draft.js editor) and puts a **Check** button at its corner.
- `readEditor()` turns the box into plain text and remembers which piece of the page each character came from. That's how an issue found in the text becomes an underline (`paintHighlights()`, using the browser's Custom Highlight API so the page's own code isn't disturbed) and how a fix replaces exactly the right words (`applyFix()`, which selects them and uses the browser's insert-text command, so the site sees it as typing).
- The rule and fact checks run in the page using the same `engine.js`. The AI review goes through `background.js` to the PixelProof server, and the answer is checked by the same `verifyAI()`.
- **Send to review queue** opens the web app with the draft in the link (`#check=...`); the app reads it, checks it and lets you submit.
- The side panel does the same for any selected text, on any site.

## Images

`readImage()` shrinks the uploaded image onto a small canvas and reads its pixels. `analyseImage()` groups similar colours, keeps the main ones, and compares each with the brand palette using a colour-difference measure (CIE Lab delta E). It also checks the contrast of the two main colours (WCAG formula) and requires alt text.

## Questions a judge might ask

**Why not let the AI do everything?** AI is good at judging tone, but it can invent facts. Anything code can check exactly (numbers, banned words, colours) is done by code, so it's reliable and explainable. The AI is used for judgment, and its answers are verified before being shown.

**How do you stop the AI making things up?** It must cite a fact ID and quote the fact's words, and code checks that quote against the real fact library. If the check fails, the claim is treated as unsupported.

**What if the AI is down?** The rule and fact checks still run. The server also falls back to a backup model if the main one is slow, busy or retired, and there's a "Try AI review again" button. The gap detector still drafts a rule change from the evidence without the AI.

**How is private data protected?** Emails, phone numbers, PAN and ID numbers are masked before text goes to the AI, in the browser and again on the server. The API key is only on the server. Demo data stays in the user's browser; team data is protected by row level security.

**Can't a creator just change the page's code to approve their own post?** They can change the page, but the database refuses it: the approval guard runs inside Postgres and checks their role.

**Could the AI rewrite the rules on its own?** No. It only drafts a suggestion, code validates it, and a brand manager has to approve it. Every change is in the history and can be undone.

**Why does the extension send drafts through the web app instead of saving them itself?** So there's one place where content is submitted and one set of permissions to get right.

**How do you know it works?** `npm test` runs 30 tests. The database security test runs on real Postgres. Browser tests in Chrome go through the whole journey, the gap detector, the bad-input cases, two people in one team workspace, and the extension on pages with the same editors as LinkedIn, Gmail and X. The README's Testing section has the details.
