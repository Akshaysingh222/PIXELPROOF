/* PixelProof shared team workspace.
   A thin layer over Supabase (accounts + database). The rest of the app calls these functions
   and never talks to Supabase directly, so the demo mode works exactly the same without it.
   Security lives in the database (supabase/schema.sql), not here: row level security keeps each
   team's data private, and a trigger stops creators from approving their own work. */
(function () {
  "use strict";
  const LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
  let sb = null;            // the Supabase client, once loaded
  let channel = null;       // live-update subscription for the open workspace
  const T = { configured: false, user: null };

  function loadScript(src) {
    return new Promise((ok, no) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => no(new Error("Couldn't load the sign-in library. Check your connection."));
      document.head.appendChild(s);
    });
  }
  // Turns database and network errors into plain sentences.
  function friendly(err) {
    const m = String((err && (err.message || err.error_description)) || err || "Something went wrong");
    if (/Invalid login credentials/i.test(m)) return "That email and password don't match an account.";
    if (/User already registered/i.test(m)) return "There's already an account with that email. Sign in instead.";
    if (/Password should be/i.test(m)) return "Use a password with at least 6 characters.";
    if (/Failed to fetch|NetworkError|network/i.test(m)) return "Couldn't reach the server. Check your connection and try again.";
    if (/JWT expired|refresh token/i.test(m)) return "Your session expired. Please sign in again.";
    return m.replace(/^.*?exception:\s*/i, "");
  }
  function check(r) { if (r.error) throw new Error(friendly(r.error)); return r.data; }

  // Reads the Supabase settings from the server and loads the library. Safe to call more than once.
  T.init = async function () {
    if (sb) return true;
    let cfg = null;
    try { const r = await fetch("/api/config"); cfg = r.ok ? (await r.json()).team : null; } catch (e) { cfg = null; }
    if (!cfg) { T.configured = false; return false; }
    T.configured = true;
    if (!window.supabase || !window.supabase.createClient) await loadScript(LIB);
    sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data } = await sb.auth.getSession();
    T.user = data && data.session ? data.session.user : null;
    sb.auth.onAuthStateChange((_e, session) => { T.user = session ? session.user : null; });
    return true;
  };

  T.signIn = async function (email, password) {
    const data = check(await sb.auth.signInWithPassword({ email: email.trim(), password }));
    T.user = data.user; return data.user;
  };
  T.signUp = async function (email, password) {
    const data = check(await sb.auth.signUp({ email: email.trim(), password }));
    if (!data.session) throw new Error("Account created. Check your email to confirm it, then sign in.");
    T.user = data.user; return data.user;
  };
  T.signOut = async function () { T.unsubscribe(); await sb.auth.signOut(); T.user = null; };

  // Workspaces this person belongs to, with their role in each.
  T.myWorkspaces = async function () {
    const rows = check(await sb.from("members").select("role, display_name, workspace_id, workspaces(id, name, join_code)").eq("user_id", T.user.id));
    return rows.filter(r => r.workspaces).map(r => ({ id: r.workspaces.id, name: r.workspaces.name, code: r.workspaces.join_code, role: r.role, displayName: r.display_name }));
  };
  T.createWorkspace = async function (name, kit, displayName) {
    return check(await sb.rpc("create_workspace", { p_name: name, p_kit: kit, p_display_name: displayName }));
  };
  T.joinWorkspace = async function (code, displayName) {
    return check(await sb.rpc("join_workspace", { p_code: code, p_display_name: displayName }));
  };
  // Everything needed to show a workspace: its brand kit, members and submitted items.
  T.load = async function (wsId) {
    const ws = check(await sb.from("workspaces").select("id, name, join_code, kit, updated_at").eq("id", wsId).single());
    const members = check(await sb.from("members").select("user_id, role, display_name").eq("workspace_id", wsId).order("joined_at"));
    const rows = check(await sb.from("items").select("id, data, updated_at").eq("workspace_id", wsId).order("updated_at", { ascending: false }).limit(200));
    return { ws, members, items: rows.map(r => Object.assign({}, r.data, { id: r.id })) };
  };
  T.saveItem = async function (wsId, item) {
    check(await sb.from("items").upsert({ id: item.id, workspace_id: wsId, status: item.status, data: item }));
  };
  T.deleteItems = async function (wsId) { check(await sb.from("items").delete().eq("workspace_id", wsId)); };
  T.saveKit = async function (wsId, kit) {
    const rows = check(await sb.from("workspaces").update({ kit }).eq("id", wsId).select("id"));
    if (!rows || !rows.length) throw new Error("Only a brand manager can change the brand kit.");
  };
  T.setRole = async function (wsId, userId, role) { check(await sb.rpc("set_member_role", { p_workspace: wsId, p_user: userId, p_role: role })); };
  T.setDisplayName = async function (wsId, name) { check(await sb.rpc("set_display_name", { p_workspace: wsId, p_name: name })); };

  // Live updates: calls onChange whenever someone on the team changes an item or the brand kit.
  T.subscribe = function (wsId, onChange) {
    T.unsubscribe();
    try {
      channel = sb.channel("ws-" + wsId)
        .on("postgres_changes", { event: "*", schema: "public", table: "items", filter: "workspace_id=eq." + wsId }, onChange)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "workspaces", filter: "id=eq." + wsId }, onChange)
        .subscribe();
    } catch (e) { channel = null; } // polling in app.js still keeps things fresh
  };
  T.unsubscribe = function () { if (channel && sb) { try { sb.removeChannel(channel); } catch (e) { /* ignore */ } } channel = null; };
  T.friendly = friendly;

  window.PPTeam = T;
})();
