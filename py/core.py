"""
core.py - the conversion logic for MPR Converter.

Pure Python + numpy. No UI code here, so the same module works:
  * in the browser (via Pyodide, called from worker.js)
  * locally from the command line (see tests/test_core.py)

Reading of the .mpr binary format is done by galvani (GPL-3.0-or-later):
https://github.com/echemdata/galvani
"""

import io
import os
import warnings

import numpy as np
from galvani import BioLogic

# Columns that should appear first in the axis pickers, in this order.
PREFERRED_ORDER = [
    "time/s", "Ewe/V", "<Ewe>/V", "I/mA", "<I>/mA", "control/V", "control/mA",
    "control/V/mA", "cycle number", "half cycle", "Q charge/discharge/mA.h",
    "(Q-Qo)/mA.h", "(Q-Qo)/C", "freq/Hz", "Re(Z)/Ohm", "-Im(Z)/Ohm",
]

DERIVED_CYCLE = "cycle (from half cycle)"
NO_GROUP = "(none)"

# Holds the currently loaded file between calls from JavaScript.
_STATE = {}


# ---------------------------------------------------------------- loading ---

def _read_mpr(path):
    """Read an .mpr file and return (columns dict, galvani MPRfile).

    Note: galvani must be given a *path* (not a file object) - with a file
    object it references an undefined variable for files without a loop
    module. In the browser we therefore write the bytes to Pyodide's virtual
    file system first (see worker.js).
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            mpr = BioLogic.MPRfile(path)
        except NotImplementedError:
            # Unknown column IDs: let galvani try to guess their dtypes
            mpr = BioLogic.MPRfile(path, error_on_unknown_column=False)

    data = mpr.data
    cols = {}

    # 1. The 'flags' byte packs several values (mode, ox/red, ...).
    #    Expand them into separate columns like EC-Lab's .mpt export does.
    if "flags" in data.dtype.names:
        for flag_name in mpr.flags_dict:
            cols[flag_name] = mpr.get_flag(flag_name).astype(np.int64)

    # 2. Regular columns. Original names are kept as-is (no stripping of
    #    '<' / '>'), so '<I>/mA' and 'I/mA' can never collide.
    for name in data.dtype.names:
        if name == "flags":
            continue
        arr = np.asarray(data[name])
        if arr.dtype.kind == "f" and name in ("cycle number",):
            arr = arr.astype(np.int64)
        cols[name] = arr

    # 3. Derived full-cycle index for galvanostatic data (GCPL etc.)
    if "half cycle" in cols:
        cols[DERIVED_CYCLE] = cols["half cycle"].astype(np.int64) // 2 + 1

    return cols, mpr


def guess_technique(names):
    """Best-effort guess of the technique from the column names.

    The .mpr settings block does contain the technique, but its layout is
    undocumented, so we use columns instead and present the result to the
    user as a *guess*.
    Returns (label, default_x, default_y).
    """
    s = set(names)
    current = next((c for c in ("<I>/mA", "I/mA") if c in s), None)
    ewe = next((c for c in ("Ewe/V", "<Ewe>/V") if c in s), None)
    galvanostatic = "control/mA" in s or "control/V/mA" in s

    if "freq/Hz" in s:
        return "EIS (impedance)", "Re(Z)/Ohm", "-Im(Z)/Ohm"
    if galvanostatic and ("half cycle" in s or "Q charge/discharge/mA.h" in s):
        x = "Q charge/discharge/mA.h" if "Q charge/discharge/mA.h" in s else "time/s"
        return "Galvanostatic cycling (GCPL-like)", x, ewe
    if "control/V" in s and "cycle number" in s and current:
        return "Cyclic / staircase voltammetry (CV-like)", ewe, current
    if "control/V" in s and current:
        return "Chronoamperometry (CA-like)", "time/s", current
    if galvanostatic:
        return "Chronopotentiometry / galvanostatic", "time/s", ewe
    if ewe and not current:
        return "Open circuit (OCV-like)", "time/s", ewe
    return "Unknown", "time/s", ewe or current


def load(path, filename=None):
    """Load a file and return a summary dict for the UI."""
    cols, mpr = _read_mpr(path)
    names = list(cols)
    ordered = [c for c in PREFERRED_ORDER if c in cols] + \
              [c for c in names if c not in PREFERRED_ORDER]

    technique, dx, dy = guess_technique(names)
    if dx not in cols:
        dx = ordered[0]
    if dy not in cols:
        dy = ordered[1] if len(ordered) > 1 else ordered[0]

    group_options = [c for c in ("cycle number", DERIVED_CYCLE, "half cycle", "Ns")
                     if c in cols]
    default_group = group_options[0] if group_options else NO_GROUP
    group_options.append(NO_GROUP)

    filename = filename or os.path.basename(path)
    _STATE.clear()
    _STATE.update(cols=cols, filename=filename)

    start = getattr(mpr, "startdate", None)
    return {
        "filename": filename,
        "n_points": int(len(next(iter(cols.values())))),
        "columns": ordered,
        "technique": technique,
        "default_x": dx,
        "default_y": dy,
        "group_options": group_options,
        "default_group": default_group,
        "start_date": start.isoformat() if start else None,
    }


def groups(group_col):
    """Distinct values of the grouping column, e.g. [1, 2, 3]."""
    cols = _STATE["cols"]
    if group_col == NO_GROUP or group_col not in cols:
        return []
    return [int(v) for v in np.unique(cols[group_col])]


# ----------------------------------------------------------- selection ---

def _mask(group_col, selected):
    cols = _STATE["cols"]
    n = len(next(iter(cols.values())))
    if group_col == NO_GROUP or group_col not in cols or not selected:
        return np.ones(n, dtype=bool)
    return np.isin(cols[group_col], [int(s) for s in selected])


def series(x, y, group_col, selected, max_points=5000):
    """Data for the plot: one trace per selected group, downsampled."""
    cols = _STATE["cols"]
    if group_col == NO_GROUP or group_col not in cols or not selected:
        parts = [("all data", np.ones(len(cols[x]), dtype=bool))]
    else:
        parts = [(f"{group_col} {int(g)}", cols[group_col] == int(g))
                 for g in selected]

    traces = []
    for name, m in parts:
        xs, ys = cols[x][m], cols[y][m]
        step = max(1, len(xs) // max_points)
        traces.append({
            "name": name,
            "x": xs[::step].astype(float).tolist(),
            "y": ys[::step].astype(float).tolist(),
            "n": int(len(xs)),
        })
    return traces


def preview(n=50):
    """First n rows for the table view."""
    cols = _STATE["cols"]
    names = list(cols)
    rows = [[_fmt_cell(cols[c][i]) for c in names]
            for i in range(min(n, len(cols[names[0]])))]
    return {"columns": names, "rows": rows}


def _fmt_cell(v):
    if isinstance(v, (np.integer, int)):
        return str(int(v))
    return f"{float(v):.6g}"


# --------------------------------------------------------------- export ---

FORMATS = {
    # key: (delimiter, extension)
    "csv": (",", "csv"),
    "tsv": ("\t", "txt"),   # tab-separated .txt - opens cleanly in Origin
}


def _to_text(columns, mask, delimiter):
    cols = _STATE["cols"]
    arrays = [cols[c][mask] for c in columns]
    # integers as integers; float32 columns get 7 significant digits so
    # 0.1833 isn't written as 0.1832999954 (float32 -> float64 noise)
    fmts = ["%d" if a.dtype.kind in "iub"
            else "%.7g" if a.dtype.itemsize == 4 else "%.10g"
            for a in arrays]
    buf = io.StringIO()
    buf.write(delimiter.join(columns) + "\n")
    if len(arrays) and len(arrays[0]):
        table = np.column_stack([a.astype(np.float64) for a in arrays])
        np.savetxt(buf, table, delimiter=delimiter, fmt=fmts)
    return buf.getvalue()


def export(columns, group_col, selected, fmt="csv", split=False):
    """Return a list of {"name", "text"} files.

    split=False -> one file with the selected groups (all data if none).
    split=True  -> one file per selected group (per all groups if none).
    For 'xlsx' the JavaScript side converts these CSV texts into sheets.
    """
    cols = _STATE["cols"]
    columns = [c for c in columns if c in cols] or list(cols)
    delimiter, ext = FORMATS.get(fmt, FORMATS["csv"])
    base = os.path.splitext(_STATE["filename"])[0]

    can_split = group_col != NO_GROUP and group_col in cols
    if split and can_split:
        chosen = selected or groups(group_col)
        label = "cycle" if "cycle" in group_col else group_col.replace(" ", "-")
        return [{
            "name": f"{base}_{label}-{int(g)}.{ext}",
            "sheet": f"{label} {int(g)}",
            "text": _to_text(columns, cols[group_col] == int(g), delimiter),
        } for g in chosen]

    return [{
        "name": f"{base}.{ext}",
        "sheet": "data",
        "text": _to_text(columns, _mask(group_col, selected), delimiter),
    }]
