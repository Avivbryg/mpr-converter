"""
Local tests for py/core.py - run from the project root:

    pip install numpy pytest
    pytest tests/

No browser needed: this is the same core.py that runs in Pyodide.
"""

import csv
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "py"))

import core  # noqa: E402

SAMPLES = os.path.join(ROOT, "samples")


def sample(name):
    return os.path.join(SAMPLES, name)


def test_cv_file():
    info = core.load(sample("CV_C01.mpr"))
    assert info["technique"].startswith("Cyclic")
    assert info["default_x"] == "Ewe/V"
    assert info["default_y"] == "<I>/mA"          # original name is kept
    assert info["default_group"] == "cycle number"
    assert core.groups("cycle number") == [1, 2, 3]
    assert "ox/red" in info["columns"]             # flags were expanded


def test_gcpl_file():
    info = core.load(sample("020-formation_CB5.mpr"))
    assert info["technique"].startswith("Galvanostatic")
    assert info["default_group"] == core.DERIVED_CYCLE
    assert core.groups("half cycle") == [0, 1, 2, 3]
    assert core.groups(core.DERIVED_CYCLE) == [1, 2]


def test_ca_file_has_no_cycles():
    info = core.load(sample("121_CA_455nm_6V_30min_C01.mpr"))
    assert info["technique"].startswith("Chronoamperometry")
    assert info["group_options"] == ["Ns", core.NO_GROUP]


def test_export_roundtrip():
    info = core.load(sample("CV_C01.mpr"))
    files = core.export(["time/s", "Ewe/V", "<I>/mA"], "cycle number", [2], "csv")
    assert len(files) == 1
    rows = list(csv.reader(io.StringIO(files[0]["text"])))
    assert rows[0] == ["time/s", "Ewe/V", "<I>/mA"]
    n_cycle2 = int((core._STATE["cols"]["cycle number"] == 2).sum())
    assert len(rows) - 1 == n_cycle2


def test_export_split_per_cycle():
    core.load(sample("CV_C01.mpr"))
    files = core.export([], "cycle number", [], "tsv", split=True)
    assert [f["name"] for f in files] == [
        "CV_C01_cycle-1.txt", "CV_C01_cycle-2.txt", "CV_C01_cycle-3.txt"]
    assert "\t" in files[0]["text"].splitlines()[0]


def test_series_downsampling():
    core.load(sample("CV_C01.mpr"))
    traces = core.series("Ewe/V", "<I>/mA", "cycle number", [1, 3], max_points=500)
    assert [t["name"] for t in traces] == ["cycle number 1", "cycle number 3"]
    assert all(len(t["x"]) <= 1000 for t in traces)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
