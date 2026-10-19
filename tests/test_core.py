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


def test_convert_leaves_viewer_state_alone():
    core.load(sample("CV_C01.mpr"))
    files = core.convert(sample("020-formation_CB5.mpr"), fmt="csv", split=True)["files"]
    assert [f["name"] for f in files] == [
        "020-formation_CB5_cycle-1.csv", "020-formation_CB5_cycle-2.csv"]
    assert core._STATE["filename"] == "CV_C01.mpr"   # viewer still has its file
    assert core.groups("cycle number") == [1, 2, 3]


def test_convert_whole_file_without_cycles():
    files = core.convert(sample("121_CA_455nm_6V_30min_C01.mpr"), fmt="tsv")["files"]
    assert [f["name"] for f in files] == ["121_CA_455nm_6V_30min_C01.txt"]
    assert len(files[0]["text"].splitlines()) - 1 == 1804
    # same column order as the viewer's export
    header = files[0]["text"].splitlines()[0].split("\t")
    info = core.load(sample("121_CA_455nm_6V_30min_C01.mpr"))
    assert header == info["columns"]
    assert header[:3] == ["time/s", "Ewe/V", "I/mA"]


def strip_log_module(src, dst):
    """Copy an .mpr without its 'VMP LOG' module, like a running experiment."""
    from galvani.BioLogic import MPR_MAGIC, read_VMP_modules

    with open(src, "rb") as f:
        data = f.read()
        f.seek(len(MPR_MAGIC))
        modules = list(read_VMP_modules(f, read_module_data=False))
    out, start = data[:len(MPR_MAGIC)], len(MPR_MAGIC)
    for m in modules:
        end = m["offset"] + m["length"]   # module = magic + header + data
        if m["shortname"].strip() != b"VMP LOG":
            out += data[start:end]
        start = end
    with open(dst, "wb") as f:
        f.write(out)
    return dst


def test_samples_are_finished_experiments():
    for name, end in [("CV_C01.mpr", "2013-11-05"),
                      ("020-formation_CB5.mpr", "2022-05-29"),
                      ("121_CA_455nm_6V_30min_C01.mpr", "2013-12-12")]:
        info = core.load(sample(name))
        assert info["finished"] is True
        assert info["end_date"] == end
        assert core.convert(sample(name))["finished"] is True


def test_running_experiment_without_log_module(tmp_path):
    path = strip_log_module(sample("CV_C01.mpr"), str(tmp_path / "running.mpr"))
    assert os.path.getsize(path) < os.path.getsize(sample("CV_C01.mpr"))

    info = core.load(path)
    assert info["finished"] is False
    assert info["end_date"] is None
    assert info["n_points"] == 12246          # the data itself still reads fine

    skipped = core.convert(path, include_running=False)
    assert skipped == {"finished": False, "end_date": None, "files": []}
    partial = core.convert(path, fmt="csv", include_running=True)
    assert partial["finished"] is False
    assert [f["name"] for f in partial["files"]] == ["running.csv"]


def test_running_fixture_is_up_to_date(tmp_path):
    """tests/fixtures/CV_running.mpr (used by the browser tests) is exactly
    CV_C01.mpr without its LOG module."""
    fixture = os.path.join(ROOT, "tests", "fixtures", "CV_running.mpr")
    fresh = strip_log_module(sample("CV_C01.mpr"), str(tmp_path / "fresh.mpr"))
    with open(fixture, "rb") as a, open(fresh, "rb") as b:
        assert a.read() == b.read()


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
