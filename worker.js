// worker.js - runs Python (Pyodide) off the main thread so the page never freezes.
//
// Protocol: the page posts {id, cmd, args}; the worker answers {id, ok, result | error}.
// Progress messages while starting up: {type: "progress", text}.
//
// Pyodide 314+ only supports *module* workers, so app.js creates this with
// new Worker("worker.js", { type: "module" }).

const PYODIDE_VERSION = "v314.0.3"; // https://pyodide.org/en/stable/project/changelog.html
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

// Python sources shipped with the site (fetched relative to this file)
const PY_FILES = {
  "core.py": "./py/core.py",
  "galvani/__init__.py": "./py/galvani/__init__.py",
  "galvani/BioLogic.py": "./py/galvani/BioLogic.py",
};
const PY_DIR = "/home/pyodide/app";
const UPLOAD_PATH = "/tmp/upload.mpr";

let py = null;
let core = null;

const progress = (text) => self.postMessage({ type: "progress", text });

async function init() {
  progress("Downloading the Python engine (one time, about 10 MB)…");
  const { loadPyodide } = await import(PYODIDE_URL + "pyodide.mjs");
  py = await loadPyodide({ indexURL: PYODIDE_URL });

  progress("Loading numpy…");
  await py.loadPackage("numpy");

  progress("Loading the .mpr reader…");
  py.FS.mkdirTree(PY_DIR + "/galvani");
  for (const [dest, src] of Object.entries(PY_FILES)) {
    const res = await fetch(new URL(src, import.meta.url));
    if (!res.ok) throw new Error(`Could not load ${src} (${res.status})`);
    py.FS.writeFile(`${PY_DIR}/${dest}`, await res.text());
  }
  py.runPython(`import sys; sys.path.insert(0, "${PY_DIR}")`);
  core = py.pyimport("core");
  return true;
}

// Convert a Python return value to plain JS objects and free the proxy.
function toJs(value) {
  if (value && typeof value.toJs === "function") {
    const out = value.toJs({ dict_converter: Object.fromEntries });
    value.destroy();
    return out;
  }
  return value;
}

const commands = {
  init,

  load({ bytes, name }) {
    py.FS.writeFile(UPLOAD_PATH, new Uint8Array(bytes));
    return toJs(core.load(UPLOAD_PATH, name));
  },

  groups({ groupCol }) {
    return toJs(core.groups(groupCol));
  },

  series({ x, y, groupCol, selected }) {
    const sel = py.toPy(selected);
    try {
      return toJs(core.series(x, y, groupCol, sel));
    } finally {
      sel.destroy();
    }
  },

  preview() {
    return toJs(core.preview(50));
  },

  export({ columns, groupCol, selected, format, split }) {
    const cols = py.toPy(columns);
    const sel = py.toPy(selected);
    // xlsx is assembled in JS from CSV text
    const fmt = format === "xlsx" ? "csv" : format;
    try {
      return toJs(core.export(cols, groupCol, sel, fmt, split));
    } finally {
      cols.destroy();
      sel.destroy();
    }
  },
};

self.onmessage = async ({ data }) => {
  const { id, cmd, args } = data;
  try {
    if (cmd !== "init" && !core) throw new Error("The Python engine is not ready yet.");
    const result = await commands[cmd](args || {});
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    // Python exceptions arrive as long tracebacks; the last line is the useful part
    const msg = String(err && err.message ? err.message : err).trim().split("\n").pop();
    self.postMessage({ id, ok: false, error: msg });
  }
};
