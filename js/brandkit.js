/* PixelProof demo brand kit.
   Kitebird Money is a made-up savings app used only to demo the product. */
(function (root) {
  const DEMO_KIT = {
    brand: "Kitebird Money",
    about: "A savings app that helps people in India put money aside in small, regular steps.",
    voice: {
      summary: "Calm, clear and friendly, like a friend who is good with money. Never pushy, never hype.",
      do: [
        "Use short sentences and everyday words",
        "Talk about small steps, safety and simple saving",
        "Say \"savers\", not \"customers\" or \"users\""
      ],
      dont: [
        "Promise returns or say anything is risk-free",
        "Use urgency or pressure (\"hurry\", \"act now\")",
        "Use jargon, slang or more than one exclamation mark"
      ],
      goodExample: "Saving a little every week adds up. Set up a Savings Pot in Kitebird Money in under 3 minutes.",
      badExample: "DON'T MISS OUT!!! Guaranteed returns, the best app in India, sign up now!!"
    },
    messaging: [
      "Saving made simple",
      "Your money is safe with us",
      "Small steps add up"
    ],
    rules: [
      { id: "C-1", category: "Claims", severity: "blocker", title: "Never promise returns",
        detail: "We can't guarantee returns or say saving is risk-free. Talk about interest rates only as stated in approved facts.",
        patterns: ["guarantee(?:d|s)?", "assured returns?", "risk[- ]free", "zero risk", "100% safe", "can'?t lose"],
        fix: "" },
      { id: "C-2", category: "Claims", severity: "blocker", title: "Rankings need a source",
        detail: "Words like \"#1\", \"best\", \"leading\" or \"fastest\" need an approved fact that backs them up.",
        patterns: ["#\\s?1\\b", "number one", "no\\.\\s?1\\b", "\\bbest\\b", "\\bleading\\b", "\\bfastest\\b", "\\blargest\\b", "\\bbiggest\\b", "\\btop[- ]rated\\b"],
        fix: "" },
      { id: "C-3", category: "Claims", severity: "blocker", title: "Numbers must match an approved fact",
        detail: "Every number, percentage or statistic must come from the approved fact library and must not be expired.",
        patterns: [], fix: "" },
      { id: "C-4", category: "Claims", severity: "warning", title: "Don't name competitors",
        detail: "We don't compare ourselves to other named apps or banks in marketing.",
        patterns: ["\\bpaytm\\b", "\\bgroww\\b", "\\bphonepe\\b", "\\bgoogle pay\\b", "\\bcred\\b", "\\bjupiter\\b", "\\bfi money\\b"],
        fix: "" },
      { id: "T-1", category: "Tone", severity: "warning", title: "No pressure or urgency",
        detail: "We sound calm. No countdowns, no fear of missing out.",
        patterns: ["sign up now", "download now", "join now", "act now", "act fast", "hurry", "don'?t miss out", "limited time( only)?", "last chance", "before it'?s too late", "once in a lifetime"],
        fix: "Start saving with Kitebird Money" },
      { id: "T-2", category: "Tone", severity: "warning", title: "One exclamation mark at most",
        detail: "A single exclamation mark is fine now and then. Two or more in a row reads as shouting.",
        patterns: ["!{2,}"], fix: "." },
      { id: "T-3", category: "Tone", severity: "warning", title: "No get-rich language",
        detail: "Saving is about steady habits, not quick wins.",
        patterns: ["get rich", "double your money", "make money fast", "no[- ]brainer", "jackpot", "easy money"],
        fix: "grow your savings step by step" },
      { id: "M-1", category: "Messaging", severity: "suggestion", title: "Connect to a brand message",
        detail: "Content should link to at least one message: saving made simple, your money is safe, small steps add up.",
        patterns: [], fix: "" },
      { id: "A-1", category: "Accessibility", severity: "warning", title: "Descriptive link text",
        detail: "\"Click here\" tells screen-reader users nothing. Say where the link goes.",
        patterns: ["click here", "tap here", "read more here"], fix: "Open your Savings Pot" },
      { id: "A-2", category: "Accessibility", severity: "suggestion", title: "Go easy on emojis",
        detail: "Screen readers read every emoji out loud. Keep it to three or fewer.",
        patterns: [], fix: "" },
      { id: "A-3", category: "Accessibility", severity: "suggestion", title: "Avoid ALL CAPS",
        detail: "All-caps text is harder to read and some screen readers spell it out letter by letter.",
        patterns: [], fix: "" },
      { id: "A-4", category: "Accessibility", severity: "suggestion", title: "Keep sentences short",
        detail: "Sentences over 30 words are hard to follow. Split them up.",
        patterns: [], fix: "" },
      { id: "A-5", category: "Accessibility", severity: "warning", title: "Images need alt text",
        detail: "Every image needs a short description for people using screen readers.",
        patterns: [], fix: "" },
      { id: "A-6", category: "Accessibility", severity: "suggestion", title: "Capitalise each word in hashtags",
        detail: "#SaveSmart is read correctly by screen readers; #savesmart is not.",
        patterns: [], fix: "" },
      { id: "W-1", category: "Writing", severity: "warning", title: "Spelling and grammar",
        detail: "Typos, missing spaces and wrong capitals (like \"diwali\" for \"Diwali\") make the brand look careless.",
        patterns: [], fix: "" },
      { id: "V-1", category: "Visual", severity: "warning", title: "Stick to the brand palette",
        detail: "Main colours in images should come from the brand palette.",
        patterns: [], fix: "" },
      { id: "V-2", category: "Visual", severity: "warning", title: "Text and background need enough contrast",
        detail: "Text colour against its background must reach WCAG AA contrast (4.5:1).",
        patterns: [], fix: "" }
    ],
    glossary: [
      { id: "G-1", use: "Kitebird Money", avoid: ["Kitebird", "KiteBird", "Kite Bird", "KBM"], note: "Always the full name." },
      { id: "G-2", use: "Savings Pot", avoid: ["savings pocket", "savings jar", "piggy bank", "savings pots"], note: "Product name, capital S and P." },
      { id: "G-3", use: "savers", avoid: ["customers", "users"], note: "We call the people who use the app savers." },
      { id: "G-4", use: "interest", avoid: ["returns", "profits", "profit"], note: "We pay interest through our partner bank; we don't promise returns." },
      { id: "G-5", use: "partner bank", avoid: ["our bank"], note: "Kitebird Money is not a bank. Deposits sit with our partner bank." }
    ],
    facts: [
      { id: "F-01", text: "Kitebird Money is trusted by over 2 lakh savers across India.", source: "Internal user report, September 2026", owner: "Growth team", expires: "2027-03-31" },
      { id: "F-02", text: "Savings Pots earn up to 7.25% interest per year through our partner bank, Northfield Small Finance Bank.", source: "Partner bank rate card, October 2026", owner: "Finance team", expires: "2026-12-31" },
      { id: "F-03", text: "Kitebird Money is free to download and there is no account opening fee.", source: "Pricing page", owner: "Product team", expires: "2027-06-30" },
      { id: "F-04", text: "Deposits are insured up to 5 lakh per depositor by DICGC through our partner bank.", source: "Partner bank disclosure", owner: "Compliance team", expires: "2027-12-31" },
      { id: "F-05", text: "Most savers set up their first Savings Pot in under 3 minutes.", source: "Product analytics, August 2026", owner: "Product team", expires: "2027-02-28" },
      { id: "F-06", text: "Kitebird Money has 1 lakh savers.", source: "Launch press kit, 2025", owner: "Growth team", expires: "2026-06-30" },
      { id: "F-07", text: "Kitebird Money won the Fintech Startup of the Year award at the Mumbai Fintech Summit 2026.", source: "Award letter, July 2026", owner: "Brand team", expires: "2027-07-31" }
    ],
    palette: [
      { name: "Kite Orange", hex: "#F26B3A" },
      { name: "Deep Navy", hex: "#14213D" },
      { name: "Sky", hex: "#8ECAE6" },
      { name: "Cloud", hex: "#F7F7F2" },
      { name: "White", hex: "#FFFFFF" }
    ]
  };

  const SAMPLES = [
    { label: "Risky LinkedIn post", type: "LinkedIn post", title: "Friday savings post",
      text: "KiteBird is India's #1 savings app with guaranteed 12% returns. Join 5 lakh happy customers today. Sign up now!! \u{1F680}\u{1F680}\u{1F4B0}\u{1F4B0} Click here to start. #savesmart" },
    { label: "Email with outdated fact", type: "Email", title: "Welcome email",
      text: "Hi there,\n\nWelcome to Kitebird Money! You're joining 1 lakh savers who are building better habits. Your Savings Pot can earn up to 7.25% interest per year through our partner bank, and deposits are insured up to 5 lakh by DICGC.\n\nMost savers set up their first Savings Pot in under 3 minutes. Open the app and tap Savings Pots to begin.\n\nTeam Kitebird Money" },
    { label: "Clean ad copy", type: "Advertisement", title: "Diwali ad",
      text: "Small steps add up. Put a little aside every week with a Savings Pot from Kitebird Money. Free to download, no account opening fee. #SaveSmart" }
  ];

  const api = { DEMO_KIT, SAMPLES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PP_KIT = api;
})(typeof window !== "undefined" ? window : globalThis);
