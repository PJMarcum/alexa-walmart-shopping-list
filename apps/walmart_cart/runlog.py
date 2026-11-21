"""Per-build run records, so a re-run is safe and a failure is diagnosable.

`default=str` on the dump is deliberate: records carry Resolution objects and
caught exceptions, and a build must never fail because its own audit trail
could not be serialized.
"""

import datetime
import json
import pathlib


def _stamp() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def write(directory, record: dict) -> str:
    directory = pathlib.Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"run-{_stamp()}.json"
    path.write_text(
        json.dumps(record, indent=2, ensure_ascii=False, default=str),
        encoding="utf-8",
        newline="\n",
    )
    return str(path)


def latest(directory):
    directory = pathlib.Path(directory)
    if not directory.exists():
        return None
    runs = sorted(directory.glob("run-*.json"))
    if not runs:
        return None
    return json.loads(runs[-1].read_text(encoding="utf-8"))
