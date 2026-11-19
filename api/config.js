// Tells the browser how to reach the shared team workspace (Supabase), if it's set up on this deployment.
// SUPABASE_URL and SUPABASE_ANON_KEY are public by design: the database's row level security protects the data.
// The service-role (secret) key must never be used here.
module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const url = process.env.SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  const ok = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(url) && anonKey.length > 20;
  res.status(200).json({ team: ok ? { url: url.replace(/\/$/, ""), anonKey } : null });
};
