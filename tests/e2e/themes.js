// Color themes, "Open another file", switching files quickly, broken files,
// theme persistence, Auto on a dark system, and the phone layout.

const path = require("path");
const { BASE, SAMPLES, suite, ready } = require("./lib");

suite("themes", async ({ browser, check, watch, out }) => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1.5, colorScheme: "light" });
  const page = watch(await ctx.newPage());
  const fileName = (n) => page.waitForFunction((n) => document.getElementById("file-name").textContent === n, n, { timeout: 30000 });
  const waitTraces = (n) => page.waitForFunction((n) => (document.getElementById("plot").data || []).length === n, n, { timeout: 20000 });
  const openAnother = async (file) => {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#open-another")]);
    await chooser.setFiles(file);
  };

  await page.goto(BASE);
  await ready(page);
  check(await page.isChecked('input[name=theme][value=auto]'), "default theme is Auto");

  // Open files one after another without waiting for the plot in between:
  // late replies for the previous file must not break the new one.
  await page.click('[data-sample="CV_C01.mpr"]');
  await fileName("CV_C01.mpr");
  check(await page.isVisible("#open-another"), '"Open another file" button visible after loading');
  await openAnother(path.join(SAMPLES, "020-formation_CB5.mpr"));
  await fileName("020-formation_CB5.mpr");
  check(true, "opened a second file with the button");
  await openAnother(path.join(SAMPLES, "CV_C01.mpr"));
  await fileName("CV_C01.mpr");
  await page.evaluate(() => (document.getElementById("file-name").textContent = "x"));
  await openAnother(path.join(SAMPLES, "CV_C01.mpr"));
  await fileName("CV_C01.mpr");
  check(true, "picking the same file twice reloads it");
  await waitTraces(3);
  check(await page.isHidden("#error"), "no error after switching files quickly");

  // a broken .mpr while a file is open: back to the drop area with the error
  await openAnother({ name: "broken.mpr", mimeType: "application/octet-stream", buffer: Buffer.from("not really an mpr file") });
  await page.waitForSelector("#error:not([hidden])");
  check(await page.isHidden("#panel") && await page.isHidden("#plot") && await page.isVisible("#empty"),
        `broken file resets to the drop area: ${await page.textContent("#error")}`);
  await page.evaluate(() => (document.getElementById("file-name").textContent = ""));
  await page.click('[data-sample="CV_C01.mpr"]');
  await fileName("CV_C01.mpr");
  await waitTraces(3);
  check(await page.isHidden("#error"), "loading a good file after that clears the error");

  for (const t of ["day", "sepia", "dusk", "night", "auto"]) {
    await page.click(`input[name=theme][value=${t}] + .swatch`);
    await page.waitForTimeout(700);
    const st = await page.evaluate(() => {
      const plot = document.getElementById("plot");
      return {
        attr: document.documentElement.dataset.theme || "auto",
        surface: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
        plotBg: plot.layout.plot_bgcolor,
        plotWidth: plot._fullLayout.width,
        boxWidth: plot.clientWidth,
      };
    });
    check(st.attr === t && st.plotBg === st.surface && st.plotWidth === st.boxWidth,
          `${t}: plot background ${st.plotBg} = --surface, plot ${st.plotWidth}px fills its ${st.boxWidth}px box`);
    if (t !== "auto") await page.screenshot({ path: path.join(out, `theme-${t}.png`) });
  }

  await page.click("input[name=theme][value=dusk] + .swatch");
  await page.reload();
  await ready(page);
  const after = await page.evaluate(() => ({
    attr: document.documentElement.dataset.theme,
    checked: document.querySelector("input[name=theme]:checked").value,
  }));
  check(after.attr === "dusk" && after.checked === "dusk", `theme survives reload: ${JSON.stringify(after)}`);

  // layout-only pages, closed while Pyodide may still be loading, so not watched
  const dark = await (await browser.newContext({ colorScheme: "dark" })).newPage();
  await dark.goto(BASE);
  const paper = await dark.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--paper").trim());
  check(paper === "#0e171d", `Auto on a dark system uses Night (${paper})`);

  const phone = await (await browser.newContext({ viewport: { width: 375, height: 800 } })).newPage();
  await phone.goto(BASE);
  const scrollWidth = await phone.evaluate(() => document.documentElement.scrollWidth);
  check(scrollWidth <= 375, `no horizontal scroll at 375px (scrollWidth ${scrollWidth})`);
  await phone.screenshot({ path: path.join(out, "phone.png") });
});
