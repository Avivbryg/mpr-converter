// folder.js - auto-convert a folder: every .mpr under the source folder
// (subfolders included) is converted into the destination folder, mirroring
// the subfolders. Uses the File System Access API (Chrome / Edge on desktop).
// The conversion itself is core.convert() in the worker.
//
// A file counts as done when its output exists and is newer than the .mpr,
// so nothing has to be remembered between visits, and a file EC-Lab keeps
// writing to is converted again after it changes.

import { call, waitForEngine, buildXlsx, friendlyError } from "./app.js";

const $ = (id) => document.getElementById(id);
const POLL_MS = 5000;
const SETTLE_MS = 10000; // changed more recently than this: EC-Lab may still be writing it
const EXT = { csv: "csv", tsv: "txt", xlsx: "xlsx" };
const LOG_MAX = 100;

const auto = {
  src: null,          // FileSystemDirectoryHandle
  dst: null,
  timer: null,        // set while watching
  scanning: false,
  logged: new Map(),  // relative path -> what was last logged for it, so the log doesn't repeat
  failed: new Map(),  // relative path -> version that failed, not retried until the file changes
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

function loadSettings() {
  try {
    return { format: "csv", split: false, same: true, ...JSON.parse(localStorage.getItem("auto") || "{}") };
  } catch {
    return { format: "csv", split: false, same: true };
  }
}
function saveSettings() {
  try {
    localStorage.setItem("auto", JSON.stringify(settings()));
  } catch {}
}
const settings = () => ({ format: $("auto-format").value, split: $("auto-split").checked, same: $("auto-same").checked });
const target = () => ($("auto-same").checked ? auto.src : auto.dst);

// -------------------------------------------------------------------- UI ---

function render() {
  const same = $("auto-same").checked;
  $("auto-src-name").textContent = auto.src ? auto.src.name : "not chosen";
  $("auto-dst").disabled = same;
  $("auto-dst-name").textContent = same
    ? `same as source${auto.src ? ` (${auto.src.name})` : ""}`
    : auto.dst ? auto.dst.name : "not chosen";

  const ready = Boolean(auto.src && target());
  $("auto-toggle").disabled = !ready;
  $("auto-check").disabled = !ready;
  $("auto-toggle").textContent = auto.timer ? "Stop watching" : "Start watching";

  const { format, split } = settings();
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
  const same = $("auto-same").checked;
  const ok = same
    ? await permitted(auto.src, "readwrite")
    : (await permitted(auto.src, "read")) && (await permitted(auto.dst, "readwrite"));
  if (!ok) status("The browser was not given access to the folder.", "error");
  return ok;
}

async function pick(which) {
  const writable = which === "dst" || $("auto-same").checked;
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: `mpr-${which}`, mode: writable ? "readwrite" : "read" });
  } catch {
    return; // cancelled
  }
  stop();
  auto[which] = handle;
  auto.logged.clear();
  auto.failed.clear();
  kvSet(which, handle);
  render();
  status(`${which === "src" ? "Source" : "Destination"} folder set. Start watching or check now.`);
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
  if (await ensureAccess()) scan();
}

async function scan() {
  if (auto.scanning) return;
  auto.scanning = true;
  status("Checking for new files…", "busy");
  const counts = { total: 0, converted: 0, current: 0, waiting: 0, error: 0 };
  try {
    await waitForEngine();
    const out = target();
    for await (const item of walk(auto.src, [])) {
      counts.total++;
      counts[await consider(item, out)]++;
    }
    const parts = [`${counts.total} .mpr file${counts.total === 1 ? "" : "s"}`];
    if (counts.converted) parts.push(`${counts.converted} converted now`);
    if (counts.current) parts.push(`${counts.current} already up to date`);
    if (counts.waiting) parts.push(`${counts.waiting} still being written`);
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

async function* walk(dir, dirs) {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "directory") yield* walk(handle, [...dirs, name]);
    else if (/\.mpr$/i.test(name)) yield { dirs, name, handle };
  }
}

// Convert one file if needed. Returns which count it belongs to.
async function consider({ dirs, name, handle }, out) {
  const rel = [...dirs, name].join("/");
  const { format, split } = settings();
  const base = name.replace(/\.mpr$/i, "");

  let file;
  try {
    file = await handle.getFile();
  } catch {
    log(rel, "waiting", "in use by another program, will try again");
    return "waiting";
  }
  if (Date.now() - file.lastModified < SETTLE_MS) {
    log(rel, "waiting", "still being written, will convert when it stops changing");
    return "waiting";
  }

  const version = `${file.lastModified}|${file.size}|${format}|${split}`;
  const folder = await subfolder(out, dirs, false);
  if (folder && (await upToDate(folder, output(base, format, split), file.lastModified))) return "current";
  if (auto.failed.get(rel) === version) return "error";

  try {
    const files = await call("convert", { bytes: await file.arrayBuffer(), name, format, split });
    const written = await write(await subfolder(out, dirs, true), base, files, format, split);
    auto.failed.delete(rel);
    log(rel, "done", `→ ${[...dirs, written].join("/")}`, `done|${version}`);
    return "converted";
  } catch (err) {
    auto.failed.set(rel, version);
    log(rel, "error", friendlyError(err.message, name), `error|${version}`);
    return "error";
  }
}

// What a converted file is called. Split output gets its own name, so
// switching the setting writes new files instead of overwriting.
function output(base, format, split) {
  if (!split) return { file: `${base}.${EXT[format]}` };
  return format === "xlsx" ? { file: `${base}_cycles.xlsx` } : { dir: `${base}_cycles` };
}

async function upToDate(folder, out, mtime) {
  try {
    if (out.file) return (await (await folder.getFileHandle(out.file)).getFile()).lastModified >= mtime;
    const dir = await folder.getDirectoryHandle(out.dir);
    for await (const h of dir.values()) {
      if (h.kind === "file" && (await h.getFile()).lastModified >= mtime) return true;
    }
    return false;
  } catch {
    return false; // not there yet
  }
}

// The destination subfolder mirroring the source; null if it doesn't exist and create is false.
async function subfolder(root, dirs, create) {
  let dir = root;
  try {
    for (const d of dirs) dir = await dir.getDirectoryHandle(d, { create });
  } catch (err) {
    if (!create && err.name === "NotFoundError") return null;
    throw err;
  }
  return dir;
}

async function write(folder, base, files, format, split) {
  const out = output(base, format, split);
  if (format === "xlsx") {
    await writeFile(folder, out.file, buildXlsx(files));
    return out.file;
  }
  if (out.file) {
    await writeFile(folder, out.file, files[0].text);
    return out.file;
  }
  const dir = await folder.getDirectoryHandle(out.dir, { create: true });
  for (const f of files) await writeFile(dir, f.name, f.text);
  return `${out.dir}/ (${files.length} file${files.length === 1 ? "" : "s"})`;
}

async function writeFile(folder, name, data) {
  const w = await (await folder.getFileHandle(name, { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

// ------------------------------------------------------------------ init ---

async function init() {
  const s = loadSettings();
  $("auto-format").value = s.format;
  $("auto-split").checked = s.split;
  $("auto-same").checked = s.same;

  $("auto-src").addEventListener("click", () => pick("src"));
  $("auto-dst").addEventListener("click", () => pick("dst"));
  $("auto-toggle").addEventListener("click", () => (auto.timer ? stop() : start()));
  $("auto-check").addEventListener("click", checkNow);
  for (const id of ["auto-format", "auto-split", "auto-same"]) {
    $(id).addEventListener("change", () => {
      if (id === "auto-same") stop();
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
  status(auto.src && target()
    ? "Folders remembered from last time. Start watching to continue (the browser may ask to confirm access)."
    : "Choose a source folder to begin.");
}

if ("showDirectoryPicker" in window) {
  init();
} else {
  $("auto-unsupported").hidden = false;
  $("auto-body").hidden = true;
}
