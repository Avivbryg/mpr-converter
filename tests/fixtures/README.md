# Test fixtures

| File | What it is |
|---|---|
| `CV_running.mpr` | `samples/CV_C01.mpr` with its `VMP LOG` module removed, which is what a still-running EC-Lab experiment is expected to look like. Made with `strip_log_module()` in `tests/test_core.py`; `test_running_fixture_is_up_to_date` checks it still matches. |

Derived from the galvani test data, CC-BY-4.0, copyright 2010-2014 Christopher Kerr (see `samples/README.md`).

Whether real running experiments lack the LOG module has not been checked on a file from an experiment that is actually running yet.
