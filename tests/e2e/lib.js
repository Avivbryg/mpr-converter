// Shared helpers for the browser test suites. Each suite is a plain Node
// script; run.js serves the site and passes its address in BASE_URL.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const BASE = process.env.BASE_URL || "http://127.0.0.1:8765/";
const SAMPLES = path.join(ROOT, "samples");
const FIXTURES = path.join(ROOT, "tests", "fixtures");

// Run a suite: fn gets {browser, check, watch, out}. Exits non-zero when a
// check fails, the suite throws, or a watched page logs an error.
function suite(name, fn) {
  const problems = [];
  const errors = [];
  const check = (cond, msg) => {
    console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
    if (!cond) problems.push(msg);
  };
  // collect console errors, uncaught exceptions and failed requests of a page
  const watch = (page) => {
    page.on("console", (m) => m.type() === "error" && errors.push(`[console] ${m.text()}`));
    page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
    page.on("requestfailed", (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
    page.on("response", (r) => r.status() >= 400 && errors.push(`[http ${r.status()}] ${r.url()}`));
    return page;
  };
  const out = path.join(__dirname, "output", name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  (async () => {
    const { chromium } = require("playwright");
    const browser = await chromium.launch();
    try {
      await fn({ browser, check, watch, out });
    } catch (err) {
      problems.push(err.message);
      console.log(`FAIL ${err.stack}`);
    } finally {
      await browser.close();
    }
    console.log(errors.length ? `console errors:\n${errors.join("\n")}` : "console errors: none");
    if (errors.length) problems.push("console errors");
    console.log(problems.length ? `${problems.length} FAILURES` : "ALL CHECKS PASSED");
    process.exitCode = problems.length ? 1 : 0;
  })();
}

// Wait until the Python engine reports "Ready".
const ready = (page) =>
  page.waitForFunction(() => document.getElementById("engine").dataset.kind === "ready", null, { timeout: 120000 });

module.exports = { ROOT, BASE, SAMPLES, FIXTURES, suite, ready };
