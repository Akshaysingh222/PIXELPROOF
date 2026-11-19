// The extension must ship the same engine as the web app, and its manifest must point at real files.
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, ".."), EXT = path.join(ROOT, "extension");

test("extension lib/ is an up-to-date copy of js/ (run npm run build:extension if this fails)", () => {
  for (const f of ["engine.js", "brandkit.js"]) {
    const copy = fs.readFileSync(path.join(EXT, "lib", f), "utf8");
    const src = fs.readFileSync(path.join(ROOT, "js", f), "utf8");
    assert.ok(copy.endsWith(src), f + " is out of date");
  }
});

test("manifest is valid MV3 and every file it names exists", () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  assert.strictEqual(m.manifest_version, 3);
  const files = [m.background.service_worker, m.side_panel.default_path, m.options_page, ...Object.values(m.icons),
    ...m.content_scripts.flatMap(c => c.js.concat(c.css || []))];
  for (const f of files) assert.ok(fs.existsSync(path.join(EXT, f)), "missing " + f);
  const hosts = m.content_scripts[0].matches.join(" ");
  for (const site of ["linkedin.com", "mail.google.com", "x.com"]) assert.ok(hosts.includes(site), "no content script for " + site);
});

test("the extension's shared code runs on top of the engine", () => {
  global.window = global; global.chrome = { storage: { local: { get: (d, cb) => cb(d) } }, runtime: {} };
  require(path.join(EXT, "lib", "brandkit.js")); // sets module.exports in Node; expose like the browser does
  global.PP = require(path.join(EXT, "lib", "engine.js")); global.PP_KIT = require(path.join(EXT, "lib", "brandkit.js"));
  require(path.join(EXT, "shared.js"));
  const r = global.PPX.checkLocal("Hurry! Guaranteed returns of 12%.", global.PP_KIT.DEMO_KIT);
  assert.ok(r.issues.some(i => i.ruleId === "C-1"));
  const html = global.PPX.issuesHTML({ result: r, ai: null }, { canFix: true });
  assert.ok(html.includes("data-pp-act=\"fix\""));
  delete global.window; delete global.chrome;
});
