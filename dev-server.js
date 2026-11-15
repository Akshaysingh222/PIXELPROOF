// Local preview: `node dev-server.js` then open http://localhost:3000
// Serves the static files and the /api/check function the same way Vercel does.
// Optional: set GEMINI_API_KEY in your terminal first to try the AI review locally.
const http = require("http"), fs = require("fs"), path = require("path");
const handler = require("./api/check.js");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url.startsWith("/api/check")) {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => {
      req.body = body ? JSON.parse(body) : {};
      res.status = c => { res.statusCode = c; return res; };
      res.json = o => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
      handler(req, res);
    });
    return;
  }
  const file = path.join(__dirname, decodeURIComponent(req.url.split("?")[0]) === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(__dirname)) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end("Not found"); }
    res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream"); res.end(data);
  });
}).listen(port, () => console.log("PixelProof running at http://localhost:" + port));
