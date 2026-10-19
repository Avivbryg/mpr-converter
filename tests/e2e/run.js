// Runs the browser test suites against a local copy of the site.
//
//   npm test                  all suites
//   npm test -- themes        only suites whose name contains "themes"
//   npm run screenshot        the viewer suite, also refreshing docs/screenshot.png
//
// Serves the repository root on a free port, so nothing else needs to be running.
// Pyodide, Plotly, SheetJS and JSZip still come from their CDNs.

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SUITES = ["viewer", "themes", "auto-convert"];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = path.join(ROOT, url.endsWith("/") ? `${url}index.html` : url);
  if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("not found");
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
});

const runSuite = (name, env) =>
  new Promise((resolve) => {
    console.log(`\n=== ${name}`);
    spawn(process.execPath, [path.join(__dirname, `${name}.js`)], { stdio: "inherit", env })
      .on("exit", (code) => resolve(code));
  });

server.listen(0, "127.0.0.1", async () => {
  const args = process.argv.slice(2);
  const filters = args.filter((a) => !a.startsWith("--"));
  const chosen = SUITES.filter((s) => !filters.length || filters.some((f) => s.includes(f)));
  const env = { ...process.env, BASE_URL: `http://127.0.0.1:${server.address().port}/` };
  if (args.includes("--screenshot")) env.SCREENSHOT = path.join(ROOT, "docs", "screenshot.png");

  const results = [];
  for (const name of chosen) results.push([name, await runSuite(name, env)]);
  server.close();

  console.log("\n=== summary");
  for (const [name, code] of results) console.log(`${code === 0 ? "ok  " : "FAIL"} ${name}`);
  process.exit(results.every(([, code]) => code === 0) && results.length ? 0 : 1);
});
