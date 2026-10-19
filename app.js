// app.js - page logic: file input, plot, cycle selection and export.
// All number crunching happens in Python (worker.js -> py/core.py).

// ------------------------------------------------------------ worker RPC ---

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let nextId = 0;
const pending = new Map();

worker.onmessage = ({ data }) => {
  if (data.type === "progress") return setEngine(data.text);
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
};

export function call(cmd, args, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, args }, transfer);
  });
}

// ----------------------------------------------------------------- state ---

const $ = (id) => document.getElementById(id);
const NO_GROUP = "(none)";
const state = {
  ready: false,
  info: null,          // summary from core.load()
  groups: [],          // e.g. [1, 2, 3]
  selected: new Set(), // selected group values
  columns: new Set(),  // columns to export
  file: 0,             // bumped on every open; replies for an older file are dropped
};
// True when another file was opened while we were waiting on the worker.
const stale = (file) => file !== state.file;

// ---------------------------------------------------------------- engine ---

function setEngine(text, kind = "") {
  const el = $("engine");
  el.textContent = text;
  el.dataset.kind = kind;
}

call("init")
  .then(() => {
    state.ready = true;
    setEngine("Ready. Your files stay on this computer.", "ready");
  })
  .catch((err) => setEngine(`The Python engine failed to start: ${err.message}. Reload the page to try again.`, "error"));

// ------------------------------------------------------------ open files ---

async function openFile(file) {
  if (!file) return;
  hideError();
  if (!/\.mpr$/i.test(file.name)) {
    return showError(`${file.name} is not an .mpr file. Export from EC-Lab as .mpr, or drop the .mpr from the experiment folder.`);
  }
  const gen = ++state.file;
  if (!state.ready) setEngine("Opening the file as soon as the engine is ready…");
  await waitForEngine();

  setEngine(`Reading ${file.name}…`);
  let info;
  try {
    const bytes = await file.arrayBuffer();
    info = await call("load", { bytes, name: file.name }, [bytes]);
  } catch (err) {
    if (stale(gen)) return;
    setEngine("Ready. Your files stay on this computer.", "ready");
    // back to the drop area, where the error is shown next to "Choose a file"
    state.info = null;
    $("panel").hidden = true;
    $("preview").hidden = true;
    return showError(friendlyError(err.message, file.name));
  }
  if (stale(gen)) return;
  state.info = info;
  setEngine("Ready. Your files stay on this computer.", "ready");
  await showFile();
}

export function waitForEngine() {
  return new Promise((resolve) => {
    const tick = () => (state.ready ? resolve() : setTimeout(tick, 150));
    tick();
  });
}

export function friendlyError(msg, name) {
  if (/Invalid magic/i.test(msg)) return `${name} doesn't look like an EC-Lab .mpr file (the file header is not what BioLogic writes).`;
  if (/Unrecognised version|unknown column/i.test(msg)) return `${name} uses a format version this reader doesn't know yet. Details: ${msg}`;
  return `${name} could not be read. Details: ${msg}`;
}

async function openSample(name) {
  const res = await fetch(`samples/${name}`);
  if (!res.ok) return showError(`The sample ${name} is missing from the site.`);
  openFile(new File([await res.blob()], name));
}

function showError(text) {
  $("error").textContent = text;
  $("error").hidden = false;
  $("empty").hidden = false;
  $("plot").hidden = true;
}
const hideError = () => ($("error").hidden = true);

// --------------------------------------------------------- after loading ---

async function showFile() {
  const info = state.info;
  $("panel").hidden = false;
  $("empty").hidden = true;
  $("plot").hidden = false;
  $("preview").hidden = false;

  $("file-name").textContent = info.filename;
  const date = info.start_date ? `, recorded ${info.start_date}` : "";
  $("file-meta").textContent = `${info.n_points.toLocaleString()} points, ${info.columns.length} columns${date}`;
  $("technique").textContent = info.technique;

  fillSelect($("x-col"), info.columns, info.default_x);
  fillSelect($("y-col"), info.columns, info.default_y);
  fillSelect($("group-col"), info.group_options, info.default_group, groupLabel);

  state.columns = new Set(info.columns);
  renderColumnList();
  const gen = state.file;
  await loadGroups();
  if (stale(gen)) return;
  await renderPreview();
}

function fillSelect(select, values, chosen, label = (v) => v) {
  select.replaceChildren(...values.map((v) => new Option(label(v), v, false, v === chosen)));
}

function groupLabel(v) {
  return {
    "cycle number": "Cycle number",
    "cycle (from half cycle)": "Full cycle (from half cycles)",
    "half cycle": "Half cycle (charge or discharge)",
    "Ns": "Technique sequence (Ns)",
    [NO_GROUP]: "Don't split",
  }[v] || v;
}

async function loadGroups() {
  const groupCol = $("group-col").value;
  const gen = state.file;
  const groups = groupCol === NO_GROUP ? [] : await call("groups", { groupCol });
  if (stale(gen)) return;
  state.groups = groups;
  // Show every cycle by default; for long experiments start with first and last
  state.selected = new Set(
    state.groups.length <= 12 ? state.groups : [state.groups[0], state.groups.at(-1)]
  );
  renderChips();
  await renderPlot();
}

// ----------------------------------------------------------- cycle chips ---

function renderChips() {
  const groupCol = $("group-col").value;
  const none = groupCol === NO_GROUP || state.groups.length === 0;
  $("chip-actions").hidden = none;
  $("split").disabled = none;
  $("split-label").textContent =
    groupCol === "half cycle" ? "One file per half cycle"
    : groupCol === "Ns" ? "One file per sequence"
    : "One file per cycle";

  $("chips").replaceChildren(
    ...state.groups.map((g) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = g;
      b.setAttribute("aria-pressed", state.selected.has(g));
      b.addEventListener("click", () => {
        state.selected.has(g) ? state.selected.delete(g) : state.selected.add(g);
        b.setAttribute("aria-pressed", state.selected.has(g));
        updateHints();
        renderPlot();
      });
      return b;
    })
  );
  updateHints();
}

function updateHints() {
  const n = state.selected.size;
  const total = state.groups.length;
  $("chip-hint").textContent =
    total === 0 ? "This file has no cycle information, so all data is shown."
    : n === 0 ? "Nothing selected: the plot and export use all data."
    : `${n} of ${total} selected.`;

  const split = $("split").checked && !$("split").disabled;
  const files = split ? (n || total) : 1;
  const fmt = $("format").value;
  $("export-hint").textContent =
    fmt === "xlsx" && split ? `One workbook with ${files} sheets.`
    : files > 1 ? `${files} files in one .zip.`
    : "";
  $("col-count").textContent = `(${state.columns.size} of ${state.info?.columns.length ?? 0})`;
}

// ------------------------------------------------------------------ plot ---

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Cycles are colored along a ramp, so early and late cycles are easy to tell apart.
function rampColor(i, n) {
  const a = hexToRgb(cssVar("--ramp-start"));
  const b = hexToRgb(cssVar("--ramp-end"));
  const t = n <= 1 ? 1 : i / (n - 1);
  const mix = a.map((v, k) => Math.round(v + (b[k] - v) * t));
  return `rgb(${mix.join(",")})`;
}
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

// Plotly reads titles as pseudo-HTML, so "<I>/mA" would lose its "<I>" as an italic tag.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let plotToken = 0;
async function renderPlot() {
  if (!state.info || !window.Plotly) return;
  const token = ++plotToken; // ignore results from older, slower requests
  const gen = state.file;
  const x = $("x-col").value;
  const y = $("y-col").value;
  const groupCol = $("group-col").value;
  const selected = [...state.selected].sort((a, b) => a - b);

  let traces;
  try {
    traces = await call("series", { x, y, groupCol, selected });
  } catch (err) {
    // a request for a file that has since been replaced fails harmlessly
    if (token !== plotToken || stale(gen)) return;
    return showError(`Could not plot ${y} against ${x}: ${err.message}`);
  }
  if (token !== plotToken || stale(gen)) return;

  const ink = cssVar("--ink");
  const grid = cssVar("--grid-major");
  const single = traces.length === 1;
  const data = traces.map((t, i) => ({
    x: t.x,
    y: t.y,
    name: t.name.replace(/^cycle number /, "Cycle ").replace(/^cycle \(from half cycle\) /, "Cycle "),
    type: "scattergl",
    mode: "lines",
    line: { width: 1.6, color: single ? cssVar("--accent") : rampColor(i, traces.length) },
    hovertemplate: `${esc(x)} %{x:.4g}<br>${esc(y)} %{y:.4g}<extra>%{fullData.name}</extra>`,
  }));

  const axis = (title) => ({
    title: { text: esc(title), font: { size: 13 } },
    gridcolor: grid,
    zerolinecolor: cssVar("--ink-soft"),
    linecolor: ink,
    mirror: true,
    ticks: "outside",
    tickcolor: ink,
    exponentformat: "power",
  });

  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: cssVar("--surface"),
    font: { family: "Schibsted Grotesk, system-ui, sans-serif", color: ink, size: 12 },
    margin: { l: 70, r: 20, t: 20, b: 56 },
    xaxis: axis(x),
    yaxis: axis(y),
    showlegend: !single,
    legend: { orientation: "h", y: 1.02, yanchor: "bottom", x: 0, bgcolor: "rgba(0,0,0,0)" },
    hoverlabel: { font: { family: "IBM Plex Mono, monospace", size: 12 } },
  };

  Plotly.react("plot", data, layout, {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d"],
    toImageButtonOptions: { format: "png", scale: 3, filename: state.info.filename.replace(/\.mpr$/i, "") },
  });
}

// --------------------------------------------------------------- columns ---

function renderColumnList() {
  $("col-list").replaceChildren(
    ...state.info.columns.map((c) => {
      const label = document.createElement("label");
      label.className = "check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = state.columns.has(c);
      box.addEventListener("change", () => {
        box.checked ? state.columns.add(c) : state.columns.delete(c);
        updateHints();
      });
      const name = document.createElement("code");
      name.textContent = c;
      label.append(box, " ", name);
      return label;
    })
  );
  updateHints();
}

// ---------------------------------------------------------------- export ---

async function download() {
  if (!state.info) return;
  const btn = $("download");
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try {
    const format = $("format").value;
    const split = $("split").checked && !$("split").disabled;
    // keep the column order of the file, not the order they were ticked
    const columns = state.info.columns.filter((c) => state.columns.has(c));
    const files = await call("export", {
      columns,
      groupCol: $("group-col").value,
      selected: [...state.selected].sort((a, b) => a - b),
      format,
      split,
    });

    const base = state.info.filename.replace(/\.mpr$/i, "");
    if (format === "xlsx") {
      save(buildXlsx(files), `${base}.xlsx`);
    } else if (files.length === 1) {
      save(new Blob([files[0].text], { type: "text/plain;charset=utf-8" }), files[0].name);
    } else {
      const zip = new JSZip();
      files.forEach((f) => zip.file(f.name, f.text));
      save(await zip.generateAsync({ type: "blob" }), `${base}.zip`);
    }
    btn.textContent = "Downloaded";
  } catch (err) {
    $("export-hint").textContent = `Export failed: ${err.message}`;
    btn.textContent = "Download";
  } finally {
    btn.disabled = false;
    setTimeout(() => (btn.textContent = "Download"), 1600);
  }
}

// One workbook from core's CSV texts: one sheet per file.
export function buildXlsx(files) {
  const wb = XLSX.utils.book_new();
  for (const f of files) {
    const sheet = XLSX.read(f.text, { type: "string", raw: false }).Sheets.Sheet1;
    XLSX.utils.book_append_sheet(wb, sheet, f.sheet.slice(0, 31));
  }
  const data = XLSX.write(wb, { bookType: "xlsx", type: "array", compression: true });
  return new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// --------------------------------------------------------------- preview ---

async function renderPreview() {
  const gen = state.file;
  const { columns, rows } = await call("preview");
  if (stale(gen)) return;
  const thead = document.createElement("thead");
  const hr = thead.insertRow();
  columns.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c;
    hr.append(th);
  });
  const tbody = document.createElement("tbody");
  rows.forEach((r) => {
    const tr = tbody.insertRow();
    r.forEach((v) => (tr.insertCell().textContent = v));
  });
  $("table").replaceChildren(thead, tbody);
}

// ---------------------------------------------------------------- events ---

$("file-input").addEventListener("change", (e) => {
  openFile(e.target.files[0]);
  e.target.value = ""; // so picking the same file again still fires "change"
});
$("open-another").addEventListener("click", () => $("file-input").click());
document.querySelectorAll("[data-sample]").forEach((b) =>
  b.addEventListener("click", () => openSample(b.dataset.sample))
);

["x-col", "y-col"].forEach((id) => $(id).addEventListener("change", renderPlot));
$("swap").addEventListener("click", () => {
  const x = $("x-col").value;
  $("x-col").value = $("y-col").value;
  $("y-col").value = x;
  renderPlot();
});
$("group-col").addEventListener("change", loadGroups);
$("select-all").addEventListener("click", () => {
  state.selected = new Set(state.groups);
  renderChips();
  renderPlot();
});
$("select-none").addEventListener("click", () => {
  state.selected.clear();
  renderChips();
  renderPlot();
});
$("split").addEventListener("change", updateHints);
$("format").addEventListener("change", updateHints);
$("cols-all").addEventListener("click", () => {
  state.columns = new Set(state.info.columns);
  renderColumnList();
});
$("cols-plot").addEventListener("click", () => {
  state.columns = new Set([$("x-col").value, $("y-col").value]);
  renderColumnList();
});
$("download").addEventListener("click", download);

// Drag & drop anywhere on the page
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (++dragDepth === 1) $("veil").hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth === 0) $("veil").hidden = true;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("veil").hidden = true;
  openFile(e.dataTransfer.files[0]);
});

// ----------------------------------------------------------------- theme ---
// index.html applies the saved theme before the first paint; this keeps the
// picker in sync and redraws the plot in the new colors.

const themeInputs = document.querySelectorAll('input[name="theme"]');
const currentTheme = document.documentElement.dataset.theme || "auto";
themeInputs.forEach((input) => {
  input.checked = input.value === currentTheme;
  input.addEventListener("change", () => {
    if (input.value === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = input.value;
    try {
      localStorage.setItem("theme", input.value);
    } catch {}
    renderPlot();
  });
});

// Plotly's "responsive" only follows window resizes. This also catches the
// plot box changing size on its own, e.g. being shown again after an error.
new ResizeObserver(() => {
  if (window.Plotly && $("plot").data && !$("plot").hidden) Plotly.Plots.resize("plot");
}).observe($("plot"));

// In Auto, redraw with the right colors when the system switches light/dark
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderPlot);
