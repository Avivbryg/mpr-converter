// folder.js - auto-convert a folder: every .mpr under the source folder
// (subfolders included) is converted into the output folder, mirroring the
// subfolders. The output folder is "converted" inside the source unless the
// user picks another one. Uses the File System Access API (Chrome / Edge on
// desktop). The conversion itself is core.convert() in the worker.
//
// What the converter wrote is listed in a manifest (.mpr-converter.json) in
// the output folder. A file that already exists but isn't in the manifest is
// never overwritten. A source counts as done when the manifest has it with
// the same size, modification time and settings, and its outputs still exist.

import { call, waitForEngine, buildXlsx, friendlyError } from "./app.js";

const $ = (id) => document.getElementById(id);
const POLL_MS = 5000;
const SETTLE_MS = 10000; // changed more recently than this: EC-Lab may still be writing it
const OUT_DIR = "converted";
const MANIFEST = ".mpr-converter.json";
const EXT = { csv: "csv", tsv: "txt", xlsx: "xlsx" };
const LOG_MAX = 100;

const auto = {
  src: null,          // FileSystemDirectoryHandle
  dst: null,          // only used when the output is not inside the source
  timer: null,        // set while watching
  scanning: false,
  logged: new Map(),  // relative path -> what was last logged for it, so the log doesn't repeat
  memo: new Map(),    // relative path -> {key, kind}: running / skipped / error, not retried until the file changes
};

// -------------------------------------------------------------- settings ---
// Folder handles can only be stored in IndexedDB; the rest goes in localStorage.

function kv(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("mpr-converter", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const kvGet = (key) => kv("readonly", (s) => s.get(key)).catch(() => undefined);
const kvSet = (key, value) => kv("readwrite", (s) => s.put(value, key)).catch(() => {});

const DEFAULTS = { format: "csv", split: false, inside: true, running: false };
function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("auto") || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  try {
    localStorage.setItem("auto", JSON.stringify(settings()));
  } catch {}
}
const settings = () => ({
  format: $("auto-format").value,
  split: $("auto-split").checked,
  inside: $("auto-inside").checked,
  running: $("auto-running").checked,
});

// The output folder; "converted" inside the source is created on first use.
async function outputRoot() {
  return settings().inside ? auto.src.getDirectoryHandle(OUT_DIR, { create: true }) : auto.dst;
}

// -------------------------------------------------------------------- UI ---

function render() {
  const { inside, format, split } = settings();
  $("auto-src-name").textContent = auto.src ? auto.src.name : "not chosen";
  $("auto-dst").hidden = inside;
  $("auto-dst-name").textContent = inside
    ? `${auto.src ? auto.src.name : "source"}/${OUT_DIR}`
    : auto.dst ? auto.dst.name : "not chosen";

  const ready = Boolean(auto.src && (inside || auto.dst));
  $("auto-toggle").disabled = !ready;
  $("auto-check").disabled = !ready;
  $("auto-toggle").textContent = auto.timer ? "Stop watching" : "Start watching";

  const ext = EXT[format];
  $("auto-split-hint").textContent =
    !split ? `Each file becomes name.${ext}.`
    : format === "xlsx" ? "Each file becomes name_cycles.xlsx, one sheet per cycle."
    : `Each file becomes a folder name_cycles/ with one .${ext} per cycle.`;
}

function status(text, kind = "idle") {
  $("auto-status").textContent = text;
  $("auto-status").dataset.kind = kind;
}

function log(rel, kind, text, key = kind) {
  if (auto.logged.get(rel) === key) return;
  auto.logged.set(rel, key);
  const li = document.createElement("li");
  li.dataset.kind = kind;
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  const name = document.createElement("code");
  name.textContent = rel;
  const msg = document.createElement("span");
  msg.textContent = text;
  li.append(time, name, msg);
  $("auto-log").prepend(li);
  while ($("auto-log").children.length > LOG_MAX) $("auto-log").lastChild.remove();
}

// ----------------------------------------------------------- permissions ---

async function permitted(handle, mode) {
  if ((await handle.queryPermission({ mode })) === "granted") return true;
  return (await handle.requestPermission({ mode })) === "granted"; // needs a click
}

// Called from a button click, so the browser may show its permission prompt.
async function ensureAccess() {
  const ok = settings().inside
    ? await permitted(auto.src, "readwrite")
    : (await permitted(auto.src, "read")) && (await permitted(auto.dst, "readwrite"));
  if (!ok) status("The browser was not given access to the folder.", "error");
  return ok;
}

async function pick(which) {
  const writable = which === "dst" || settings().inside;
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: `mpr-${which}`, mode: writable ? "readwrite" : "read" });
  } catch {
    return; // cancelled
  }
  stop();
  auto[which] = handle;
  auto.logged.clear();
  auto.memo.clear();
  kvSet(which, handle);
  render();
  status(`${which === "src" ? "Source" : "Output"} folder set. Start watching or check now.`);
}

// --------------------------------------------------------------- watching ---

async function start() {
  if (!(await ensureAccess())) return;
  auto.timer = setInterval(scan, POLL_MS);
  render();
  scan();
}

function stop() {
  if (!auto.timer) return;
  clearInterval(auto.timer);
  auto.timer = null;
  render();
  status("Stopped.");
}

async function checkNow() {
  if (!(await ensureAccess())) return;
  auto.memo.clear(); // retry skipped and failed files, e.g. after a clash was cleared up
  scan();
}

async function scan() {
  if (auto.scanning) return;
  auto.scanning = true;
  status("Checking for new files…", "busy");
  const counts = { total: 0, converted: 0, current: 0, waiting: 0, running: 0, skipped: 0, error: 0 };
  try {
    await waitForEngine();
    const out = await outputRoot();
    const manifest = await readManifest(out);
    for await (const item of walk(auto.src, [], out)) {
      counts.total++;
      counts[await consider(item, out, manifest)]++;
    }
    const parts = [`${counts.total} .mpr file${counts.total === 1 ? "" : "s"}`];
    if (counts.converted) parts.push(`${counts.converted} converted now`);
    if (counts.current) parts.push(`${counts.current} already up to date`);
    if (counts.running) parts.push(`${counts.running} experiment${counts.running === 1 ? "" : "s"} still running`);
    if (counts.waiting) parts.push(`${counts.waiting} still being written`);
    if (counts.skipped) parts.push(`${counts.skipped} skipped (output already exists)`);
    if (counts.error) parts.push(`${counts.error} could not be read`);
    const when = new Date().toLocaleTimeString();
    status(`${auto.timer ? "Watching." : "Checked."} Last check ${when}: ${parts.join(", ")}.`, auto.timer ? "ready" : "idle");
  } catch (err) {
    stop();
    status(`Could not read the folder: ${err.message}`, "error");
  } finally {
    auto.scanning = false;
  }
}

// Every .mpr under dir. Skips the output folder if it sits inside the source,
// and any other folder this tool wrote to (it has a manifest), e.g. the
// "converted" folder after switching to another output folder.
async function* walk(dir, dirs, out) {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "directory") {
      if (!(await handle.isSameEntry(out)) && !(await exists(handle, MANIFEST))) {
        yield* walk(handle, [...dirs, name], out);
      }
    } else if (/\.mpr$/i.test(name)) {
      yield { dirs, name, handle };
    }
  }
}

// Convert one file if needed. Returns which count it belongs to.
async function consider({ dirs, name, handle }, out, manifest) {
  const rel = [...dirs, name].join("/");
  const { format, split, running } = settings();
  const base = name.replace(/\.mpr$/i, "");

  let file;
  try {
    file = await handle.getFile();
  } catch {
    log(rel, "waiting", "in use by another program, will try again");
    return "waiting";
  }
  // second safeguard next to the LOG-module check: don't read a file mid-write
  if (Date.now() - file.lastModified < SETTLE_MS) {
    log(rel, "waiting", "still being written, will convert when it stops changing");
    return "waiting";
  }

  const done = manifest.sources[rel];
  if (done && done.modified === file.lastModified && done.size === file.size
      && done.format === format && done.split === split && (await allExist(out, done.outputs))) {
    return "current";
  }
  const key = `${file.lastModified}|${file.size}|${format}|${split}|${running}`;
  const memo = auto.memo.get(rel);
  if (memo && memo.key === key) return memo.kind;
  const remember = (kind) => (auto.memo.set(rel, { key, kind }), kind);

  let result;
  try {
    result = await call("convert", { bytes: await file.arrayBuffer(), name, format, split, includeRunning: running });
  } catch (err) {
    log(rel, "error", friendlyError(err.message, name), `error|${key}`);
    return remember("error");
  }
  if (!result.files.length) {
    log(rel, "running", "experiment running, will convert when it finishes");
    return remember("running");
  }

  const planned = plan(dirs, base, result.files, format, split);
  for (const p of planned) {
    if (!manifest.written[p.path] && (await exists(out, p.path))) {
      log(rel, "skipped", `skipped: ${p.path} already exists`, `skipped|${key}`);
      return remember("skipped");
    }
  }

  try {
    for (const p of planned) await writeAt(out, p.path, p.data);
  } catch (err) {
    log(rel, "error", `could not write the output: ${err.message}`, `error|${key}`);
    return remember("error");
  }
  manifest.sources[rel] = {
    modified: file.lastModified,
    size: file.size,
    format,
    split,
    finished: result.finished,
    end_date: result.end_date,
    outputs: planned.map((p) => p.path),
    converted: new Date().toISOString(),
  };
  for (const p of planned) manifest.written[p.path] = rel;
  await saveManifest(out, manifest);
  auto.memo.delete(rel);

  const what = planned.length === 1 ? planned[0].path
    : `${planned[0].path.replace(/\/[^/]*$/, "/")} (${planned.length} files)`;
  const partial = result.finished ? "" : " (experiment still running: partial data)";
  log(rel, "done", `→ ${what}${partial}`, `done|${key}`);
  return "converted";
}

// The files to write for one source, as paths relative to the output folder.
// Split output gets its own name, so switching the setting writes new files.
function plan(dirs, base, files, format, split) {
  const at = (...parts) => [...dirs, ...parts].join("/");
  if (format === "xlsx") return [{ path: at(split ? `${base}_cycles.xlsx` : `${base}.xlsx`), data: buildXlsx(files) }];
  if (!split) return [{ path: at(`${base}.${EXT[format]}`), data: files[0].text }];
  return files.map((f) => ({ path: at(`${base}_cycles`, f.name), data: f.text }));
}

// ---------------------------------------------------------------- manifest ---

async function readManifest(root) {
  try {
    const m = JSON.parse(await (await (await root.getFileHandle(MANIFEST)).getFile()).text());
    if (m && m.sources && m.written) return m;
  } catch {}
  // missing or unreadable: start empty, so every existing file counts as not ours
  return { tool: "MPR Converter", version: 1, sources: {}, written: {} };
}

const saveManifest = (root, manifest) => writeAt(root, MANIFEST, JSON.stringify(manifest, null, 1));

// ----------------------------------------------------------------- files ---

async function folderOf(root, path, create) {
  let dir = root;
  for (const d of path.split("/").slice(0, -1)) dir = await dir.getDirectoryHandle(d, { create });
  return dir;
}

async function exists(root, path) {
  try {
    await (await folderOf(root, path, false)).getFileHandle(path.split("/").at(-1));
    return true;
  } catch (err) {
    return err.name !== "NotFoundError"; // e.g. a folder with that name: don't touch it either
  }
}

async function allExist(root, paths) {
  for (const p of paths) if (!(await exists(root, p))) return false;
  return true;
}

async function writeAt(root, path, data) {
  const dir = await folderOf(root, path, true);
  const w = await (await dir.getFileHandle(path.split("/").at(-1), { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

// ------------------------------------------------------------------ init ---

async function init() {
  const s = loadSettings();
  $("auto-format").value = s.format;
  $("auto-split").checked = s.split;
  $("auto-inside").checked = s.inside;
  $("auto-running").checked = s.running;

  $("auto-src").addEventListener("click", () => pick("src"));
  $("auto-dst").addEventListener("click", () => pick("dst"));
  $("auto-toggle").addEventListener("click", () => (auto.timer ? stop() : start()));
  $("auto-check").addEventListener("click", checkNow);
  for (const id of ["auto-format", "auto-split", "auto-inside", "auto-running"]) {
    $(id).addEventListener("change", () => {
      if (id === "auto-inside") stop();
      saveSettings();
      render();
    });
  }
  // background tabs check less often; catch up as soon as the tab is back
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && auto.timer) scan();
  });

  auto.src = (await kvGet("src")) || null;
  auto.dst = (await kvGet("dst")) || null;
  render();
  status(auto.src && (s.inside || auto.dst)
    ? "Folders remembered from last time. Start watching to continue (the browser may ask to confirm access)."
    : "Choose a source folder to begin.");
}

if ("showDirectoryPicker" in window) {
  init();
} else {
  $("auto-unsupported").hidden = false;
  $("auto-body").hidden = true;
}
