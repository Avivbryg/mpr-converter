// Viewer: engine start, the three samples, cycle chips, axis titles and every
// download format, with the downloaded files opened and checked.
// SCREENSHOT=<path> also saves the CV sample with all cycles plotted.

const fs = require("fs");
const path = require("path");
const { BASE, suite, ready } = require("./lib");

// points per cycle, from the files themselves (see tests/test_core.py)
const SAMPLES = {
  "CV_C01.mpr": { cycles: [3006, 5967, 3273], first: "time/s", y: "<I>/mA" },
  "020-formation_CB5.mpr": { cycles: [856, 467], first: "time/s", y: "Ewe/V" },
  "121_CA_455nm_6V_30min_C01.mpr": { cycles: [1804], first: "time/s", y: "I/mA" },
};
const sum = (a) => a.reduce((s, v) => s + v, 0);

suite("viewer", async ({ browser, check, watch, out }) => {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2, colorScheme: "light" });
  const page = watch(await ctx.newPage());
  const traces = () => page.evaluate(() => (document.getElementById("plot").data || []).length);
  const waitTraces = (n) => page.waitForFunction((n) => (document.getElementById("plot").data || []).length === n, n, { timeout: 20000 });

  await page.goto(BASE);
  await ready(page);
  check(true, `engine ready: ${await page.textContent("#engine")}`);

  async function loadSample(name) {
    await page.goto(BASE); // back to the empty state, where the sample buttons are
    await ready(page);
    await page.click(`[data-sample="${name}"]`);
    await page.waitForFunction((n) => document.getElementById("file-name").textContent === n, name, { timeout: 30000 });
    await page.waitForFunction(() => (document.getElementById("plot").data || []).length > 0, null, { timeout: 30000 });
  }

  // Open a downloaded file with the page's own SheetJS / JSZip.
  const inspect = (file) => page.evaluate(async ([b64, name]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const lines = (t) => t.replace(/\n$/, "").split("\n");
    if (/\.(csv|txt)$/.test(name)) {
      const l = lines(new TextDecoder().decode(bytes));
      return { rows: l.length - 1, header: l[0].split(name.endsWith(".txt") ? "\t" : ",") };
    }
    if (name.endsWith(".zip")) {
      const zip = await JSZip.loadAsync(bytes);
      const files = [];
      for (const f of Object.values(zip.files)) files.push({ name: f.name, rows: lines(await f.async("string")).length - 1 });
      return { files };
    }
    const wb = XLSX.read(bytes, { type: "array" });
    return {
      sheets: wb.SheetNames.map((n) => {
        const s = wb.Sheets[n];
        return { name: n, rows: XLSX.utils.decode_range(s["!ref"]).e.r, header: s.A1.v, a2: s.A2.t };
      }),
    };
  }, [fs.readFileSync(file).toString("base64"), path.basename(file)]);

  async function download(format, split, label) {
    await page.selectOption("#format", format);
    if (!(await page.isDisabled("#split"))) await page.setChecked("#split", split);
    const [d] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.click("#download")]);
    const file = path.join(out, `${label}${split ? "-split" : ""}__${d.suggestedFilename()}`);
    await d.saveAs(file);
    await page.waitForFunction(() => !document.getElementById("download").disabled);
    return { name: d.suggestedFilename(), info: await inspect(file) };
  }

  for (const [name, expect] of Object.entries(SAMPLES)) {
    console.log(`\n== ${name}`);
    await loadSample(name);
    const total = sum(expect.cycles);
    const chips = await page.locator(".chip").count();
    check((await traces()) > 0, `plot drawn, ${await traces()} traces; technique "${await page.textContent("#technique")}"`);
    check(await page.locator("#table tbody tr").count() > 0, "preview table has rows");
    const yTitle = await page.textContent("#plot .ytitle");
    check(yTitle === expect.y && yTitle === (await page.inputValue("#y-col")), `y axis title matches column: "${yTitle}"`);

    if (chips > 1) {
      await page.locator(".chip").first().click();
      await waitTraces(chips - 1);
      await page.locator(".chip").first().click();
      await waitTraces(chips);
      check(true, `chip toggles: ${chips} -> ${chips - 1} -> ${chips} traces`);
      await page.click("#select-none");
      await waitTraces(1);
      await page.click("#select-all");
      await waitTraces(chips);
      check(true, `Clear -> 1 trace (all data), Select all -> ${chips} traces`);
    }

    const label = name.replace(".mpr", "");
    const csv = await download("csv", false, label);
    check(csv.info.rows === total && csv.info.header[0] === expect.first && csv.info.header.length > 3,
          `CSV ${csv.name}: ${csv.info.rows} rows, ${csv.info.header.length} columns`);
    const tsv = await download("tsv", false, label);
    check(tsv.name.endsWith(".txt") && tsv.info.rows === total && tsv.info.header.length === csv.info.header.length,
          `TXT ${tsv.name}: ${tsv.info.rows} rows, tab separated`);
    const xlsx = await download("xlsx", false, label);
    check(xlsx.info.sheets.length === 1 && xlsx.info.sheets[0].rows === total && xlsx.info.sheets[0].a2 === "n",
          `XLSX ${xlsx.name}: ${xlsx.info.sheets[0].rows} rows, numbers stored as numbers`);

    if (chips > 1) {
      const zip = await download("csv", true, label);
      const rows = zip.info.files.map((f) => f.rows);
      check(zip.name.endsWith(".zip") && JSON.stringify(rows) === JSON.stringify(expect.cycles),
            `zip ${zip.name}: ${zip.info.files.map((f) => `${f.name} (${f.rows})`).join(", ")}`);
      const book = await download("xlsx", true, label);
      const sheets = book.info.sheets;
      check(JSON.stringify(sheets.map((s) => s.rows)) === JSON.stringify(expect.cycles) && sheets.every((s) => s.a2 === "n"),
            `multi-sheet XLSX ${book.name}: ${sheets.map((s) => `${s.name} (${s.rows})`).join(", ")}`);
    }
  }

  if (process.env.SCREENSHOT) {
    await loadSample("CV_C01.mpr");
    await page.click("#select-all");
    await waitTraces(3);
    await page.waitForTimeout(800);
    await page.screenshot({ path: process.env.SCREENSHOT });
    console.log(`saved ${process.env.SCREENSHOT}`);
  }
});
