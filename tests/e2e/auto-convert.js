// Folder auto-convert. A native folder picker can't be scripted, so
// showDirectoryPicker is replaced by folders "src" and "dst" in the
// browser's private file system (OPFS), which has the same handle API.
// tests/fixtures/CV_running.mpr is CV_C01.mpr without its "VMP LOG"
// module, i.e. what a still-running experiment is expected to look like.

const fs = require("fs");
const path = require("path");
const { BASE, SAMPLES, FIXTURES, suite, ready } = require("./lib");

const RUNNING = path.join(FIXTURES, "CV_running.mpr");
const FOREIGN = "my own notes, not from the converter";

suite("auto-convert", async ({ browser, check, watch, out }) => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, deviceScaleFactor: 1.5 });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async ({ id }) =>
      (await navigator.storage.getDirectory()).getDirectoryHandle(id === "mpr-src" ? "src" : "dst", { create: true });
  });
  const page = watch(await ctx.newPage());
  const runningB64 = fs.readFileSync(RUNNING).toString("base64");

  const status = () => page.textContent("#auto-status");
  const waitStatus = (re, timeout = 40000) => page.waitForFunction(
    (re) => new RegExp(re).test(document.getElementById("auto-status").textContent), re.source, { timeout });
  const logLines = () => page.$$eval("#auto-log li", (items) => items.map((li) =>
    `${li.dataset.kind} ${li.querySelector("code").textContent} ${li.querySelector("span").textContent}`));
  const waitLog = (kind, rel, re = /./, timeout = 40000) => page.waitForFunction(([kind, rel, re]) =>
    [...document.querySelectorAll(`#auto-log li[data-kind="${kind}"]`)]
      .some((li) => li.querySelector("code").textContent === rel && new RegExp(re).test(li.textContent)),
    [kind, rel, re.source], { timeout });

  // OPFS helpers: list a tree as {path: lastModified}, read a file, write a file
  const tree = (root) => page.evaluate(async (root) => {
    const res = {};
    async function walk(d, p) {
      for await (const [n, h] of d.entries()) {
        if (h.kind === "directory") await walk(h, `${p}${n}/`);
        else res[p + n] = (await h.getFile()).lastModified;
      }
    }
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(root), "");
    return res;
  }, root);
  const readText = (root, p) => page.evaluate(async ([root, p]) => {
    let d = await (await navigator.storage.getDirectory()).getDirectoryHandle(root);
    const parts = p.split("/");
    for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x);
    return (await (await d.getFileHandle(parts.at(-1))).getFile()).text();
  }, [root, p]);
  // source: a sample file name, "RUNNING" for the fixture, or literal text
  const put = (dest, source) => page.evaluate(async ([dest, source, runningB64]) => {
    let d = await (await navigator.storage.getDirectory()).getDirectoryHandle("src", { create: true });
    const parts = dest.split("/");
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const data = source === "RUNNING" ? Uint8Array.from(atob(runningB64), (c) => c.charCodeAt(0))
      : source.endsWith(".mpr") ? await (await fetch(`samples/${source}`)).blob()
      : source;
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(data);
    await w.close();
  }, [dest, source, runningB64]);

  await page.goto(BASE);
  await ready(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
  });
  await put("CV_C01.mpr", "CV_C01.mpr");
  await put("run2/020-formation_CB5.mpr", "020-formation_CB5.mpr");
  await put("run2/deep/121_CA_455nm_6V_30min_C01.mpr", "121_CA_455nm_6V_30min_C01.mpr");
  await put("broken.mpr", "this is not an mpr file");
  await put("running/live.mpr", "RUNNING");
  await put("converted/stray.mpr", "CV_C01.mpr");                    // inside the output folder: ignored
  await put("converted/run2/020-formation_CB5.csv", FOREIGN);         // not written by the converter

  console.log("== viewer");
  await page.setInputFiles("#file-input", { name: "live.mpr", mimeType: "application/octet-stream", buffer: fs.readFileSync(RUNNING) });
  await page.waitForFunction(() => document.getElementById("file-name").textContent === "live.mpr");
  await page.waitForFunction(() => (document.getElementById("plot").data || []).length === 3);
  check(await page.isVisible("#running"), `running experiment opens, with notice: ${await page.textContent("#running")}`);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#open-another")]);
  await chooser.setFiles(path.join(SAMPLES, "CV_C01.mpr"));
  await page.waitForFunction(() => document.getElementById("file-name").textContent === "CV_C01.mpr");
  await page.waitForFunction(() => (document.getElementById("plot").data || []).length === 3);
  check(await page.isHidden("#running"), "finished experiment has no notice");

  console.log("== default output folder");
  check(await page.isChecked("#auto-inside") && await page.isHidden("#auto-dst") && !(await page.isChecked("#auto-running")),
        "defaults: output inside the source, running experiments skipped");
  check(await page.isDisabled("#auto-toggle"), "Start is disabled before a folder is chosen");
  await page.click("#auto-src");
  await page.waitForFunction(() => document.getElementById("auto-src-name").textContent === "src");
  check(await page.textContent("#auto-dst-name") === "src/converted", "output shown as src/converted");
  await page.click("#auto-toggle");
  await waitStatus(/Watching\./);
  check(/5 \.mpr files, 5 still being written/.test(await status()), `converted/ is not scanned; fresh files wait: ${await status()}`);

  await waitStatus(/converted now/);
  const s1 = await status();
  check(/2 converted now/.test(s1) && /1 experiment still running/.test(s1) && /1 skipped/.test(s1) && /1 could not be read/.test(s1),
        `after settling: ${s1}`);
  const outs = Object.keys(await tree("src")).filter((k) => k.startsWith("converted/")).sort();
  check(JSON.stringify(outs) === JSON.stringify([
    "converted/.mpr-converter.json", "converted/CV_C01.csv", "converted/run2/020-formation_CB5.csv",
    "converted/run2/deep/121_CA_455nm_6V_30min_C01.csv", "converted/stray.mpr"]), `output folder: ${outs.join(", ")}`);
  check(await readText("src", "converted/run2/020-formation_CB5.csv") === FOREIGN, "foreign file left untouched");
  const lines = await logLines();
  check(lines.includes("skipped run2/020-formation_CB5.mpr skipped: run2/020-formation_CB5.csv already exists"),
        "log: skipped: run2/020-formation_CB5.csv already exists");
  check(lines.includes("running running/live.mpr experiment running, will convert when it finishes"),
        "log: experiment running, will convert when it finishes");
  check(lines.some((l) => /^error broken\.mpr .*doesn't look like an EC-Lab/.test(l)), "log: broken file explained");
  const m1 = JSON.parse(await readText("src", "converted/.mpr-converter.json"));
  check(m1.sources["CV_C01.mpr"]?.finished === true && m1.sources["CV_C01.mpr"].end_date === "2013-11-05"
        && m1.written["CV_C01.csv"] === "CV_C01.mpr" && !m1.written["run2/020-formation_CB5.csv"],
        `manifest lists what was written: ${Object.keys(m1.written).join(", ")}`);

  await page.locator(".chip").first().click();
  await page.waitForFunction(() => (document.getElementById("plot").data || []).length === 2);
  check(await page.textContent("#file-name") === "CV_C01.mpr" && await page.isHidden("#error"), "viewer unaffected by auto-convert");

  console.log("== own output updated, running experiment finishes");
  const before = (await tree("src"))["converted/CV_C01.csv"];
  await put("CV_C01.mpr", "CV_C01.mpr");          // EC-Lab rewrote it
  await put("running/live.mpr", "CV_C01.mpr");     // the experiment finished: LOG module now present
  await waitLog("done", "running/live.mpr", /→ running\/live\.csv$/);
  // the log already has CV_C01.mpr from the first round, so wait on the file itself
  let t2 = await tree("src");
  for (let i = 0; i < 40 && !(t2["converted/CV_C01.csv"] > before); i++) {
    await page.waitForTimeout(1000);
    t2 = await tree("src");
  }
  check(t2["converted/CV_C01.csv"] > before, "own output overwritten after its source changed");
  check(t2["converted/running/live.csv"] > 0, "running experiment converted automatically once it finished");
  check(await readText("src", "converted/run2/020-formation_CB5.csv") === FOREIGN, "foreign file still untouched");

  console.log("== opt-in: running experiments");
  await page.check("#auto-running");
  await put("running/live2.mpr", "RUNNING");
  await waitLog("done", "running/live2.mpr", /partial data/);
  check(true, `opt-in converts a running experiment: ${(await logLines())[0]}`);
  const m2 = JSON.parse(await readText("src", "converted/.mpr-converter.json"));
  check(m2.sources["running/live2.mpr"]?.finished === false, "manifest marks it as unfinished");
  await page.waitForTimeout(6000);
  check(!/converted now/.test(await status()), `next check converts nothing again: ${await status()}`);

  console.log("== reload");
  await page.reload();
  await ready(page);
  check(await page.textContent("#auto-src-name") === "src" && await page.isChecked("#auto-running") && await page.isChecked("#auto-inside"),
        "folders and settings remembered");
  await page.click("#auto-check");
  await waitStatus(/Checked\./);
  check(!/converted now/.test(await status()) && /1 skipped/.test(await status()),
        `nothing converted twice, foreign file still skipped: ${await status()}`);
  await page.locator("#auto").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, "auto-convert.png"), fullPage: true });

  console.log("== another output folder");
  await page.uncheck("#auto-inside");
  check(await page.isVisible("#auto-dst") && await page.isDisabled("#auto-toggle"), "choose-folder button shown, Start waits for it");
  await page.click("#auto-dst");
  await page.click("#auto-check");
  await waitStatus(/Checked\./);
  const t3 = Object.keys(await tree("dst"));
  check(t3.includes("run2/020-formation_CB5.csv") && t3.includes(".mpr-converter.json") && t3.includes("running/live2.csv")
        && !t3.some((k) => k.includes("stray")),
        `written to the other folder, old converted/ not scanned: ${t3.sort().join(", ")}`);

  // not watched: closed while Pyodide may still be loading
  const plain = await (await browser.newContext()).newPage();
  await plain.addInitScript(() => { delete window.showDirectoryPicker; });
  await plain.goto(BASE);
  check(await plain.isVisible("#auto-unsupported") && await plain.isHidden("#auto-body"),
        "browsers without folder access get an explanation");
});
