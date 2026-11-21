import json
from walmart_cart.runlog import latest, write


def test_write_creates_the_directory_and_returns_the_path(tmp_path):
    target = tmp_path / "runs"
    path = write(target, {"status": "built"})
    assert target.is_dir()
    assert json.loads(open(path, encoding="utf-8").read())["status"] == "built"


def test_filename_is_a_sortable_timestamp(tmp_path):
    path = write(tmp_path / "runs", {"status": "built"})
    name = path.replace("\\", "/").rsplit("/", 1)[-1]
    assert name.startswith("run-")
    assert name.endswith("Z.json")


def test_non_serializable_values_do_not_raise(tmp_path):
    # Run records carry Resolution objects and exceptions; neither is JSON.
    class Opaque:
        def __repr__(self):
            return "<opaque>"

    path = write(tmp_path / "runs", {"status": "failed", "error": Opaque()})
    assert "opaque" in open(path, encoding="utf-8").read()


def test_latest_returns_none_when_the_directory_is_absent(tmp_path):
    assert latest(tmp_path / "nope") is None


def test_latest_returns_none_when_there_are_no_runs(tmp_path):
    empty = tmp_path / "runs"
    empty.mkdir()
    assert latest(empty) is None


def test_latest_returns_the_most_recent_record(tmp_path):
    target = tmp_path / "runs"
    target.mkdir()
    (target / "run-20260101T000000Z.json").write_text(
        json.dumps({"status": "old"}), encoding="utf-8"
    )
    (target / "run-20260930T000000Z.json").write_text(
        json.dumps({"status": "new"}), encoding="utf-8"
    )
    assert latest(target)["status"] == "new"
