// Copies the shared check engine into the extension and packs it as downloads/pixelproof-extension.zip.
// Run with: npm run build:extension   (no dependencies needed)
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");

// 1. the extension uses exactly the same engine and demo brand kit as the web app
fs.mkdirSync(path.join(EXT, "lib"), { recursive: true });
for (const f of ["engine.js", "brandkit.js"]) {
  const src = fs.readFileSync(path.join(ROOT, "js", f), "utf8");
  fs.writeFileSync(path.join(EXT, "lib", f), "/* Copied from js/" + f + " by scripts/build-extension.js. Edit the original, not this copy. */\n" + src);
}

// 2. a plain zip file (stored with deflate), written by hand so no packages are needed
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]); }
const files = walk(EXT).sort();
const parts = [], central = []; let offset = 0;
const dosTime = 0, dosDate = (2026 - 1980) << 9 | 11 << 5 | 19; // fixed date so builds are identical
for (const file of files) {
  const name = Buffer.from("pixelproof-extension/" + path.relative(EXT, file).split(path.sep).join("/"));
  const data = fs.readFileSync(file); const comp = zlib.deflateRawSync(data, { level: 9 }); const crc = zlib.crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  parts.push(local, name, comp);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(8, 10);
  c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24);
  c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
  central.push(c, name);
  offset += 30 + name.length + comp.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
fs.mkdirSync(path.join(ROOT, "downloads"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "downloads", "pixelproof-extension.zip"), Buffer.concat(parts.concat([cd, end])));
console.log("Built downloads/pixelproof-extension.zip with " + files.length + " files.");
