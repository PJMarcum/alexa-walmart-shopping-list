import json
import shutil
import pytest
from conftest import FIXTURES
from walmart_cart.ui_export import build_payload, write_payload


@pytest.fixture
def catalog(tmp_path):
    path = tmp_path / "catalog.json"
    shutil.copy(FIXTURES / "catalog_small.json", path)
    return path


def test_payload_carries_only_what_a_tile_needs(catalog):
    payload = build_payload(catalog)
    item = next(i for i in payload["items"] if i["id"] == "80000001")
    assert set(item) == {
        "id", "name", "category", "bought", "thumb", "url", "phrases",
    }
    assert item["name"].startswith("Value Pantry")
    assert item["category"] == "Dairy & Eggs"


def test_items_are_sorted_most_bought_first(catalog):
    payload = build_payload(catalog)
    ranks = [i["bought"] for i in payload["items"]]
    assert ranks[0] >= ranks[-1]


def test_a_missing_url_falls_back_to_the_canonical_ip_link(catalog):
    # The card needs a working link per tile; walmart.com/ip/<id> redirects.
    payload = build_payload(catalog)
    for item in payload["items"]:
        assert item["url"].startswith("https://www.walmart.com/ip/")


def test_categories_are_listed_for_the_filter_chips(catalog):
    payload = build_payload(catalog)
    assert "Dairy & Eggs" in payload["categories"]
    assert payload["categories"] == sorted(payload["categories"])


def test_aliased_items_are_flagged_so_the_card_can_mark_them(catalog):
    raw = json.loads(catalog.read_text(encoding="utf-8"))
    raw["aliases"] = {"milk": "80000001"}
    catalog.write_text(json.dumps(raw), encoding="utf-8")
    payload = build_payload(catalog)
    by_id = {i["id"]: i for i in payload["items"]}
    assert by_id["80000001"]["aliased"] is True
    assert by_id["80000003"].get("aliased", False) is False


def test_payload_records_its_own_generation_time_and_counts(catalog):
    payload = build_payload(catalog)
    assert payload["count"] == len(payload["items"]) == 4
    assert payload["generated"]


def test_write_payload_is_atomic_and_leaves_no_temp_file(tmp_path, catalog):
    out = tmp_path / "www" / "catalog.json"
    write_payload(catalog, out)
    assert out.exists()
    assert [p.name for p in out.parent.iterdir()] == ["catalog.json"]
    assert json.loads(out.read_text(encoding="utf-8"))["count"] == 4


def test_never_bought_items_sort_last_but_are_kept(catalog):
    raw = json.loads(catalog.read_text(encoding="utf-8"))
    raw["index"]["999"] = {"item_id": "999", "display_name": "Floor Brush",
                           "category": "Home", "bought_count": None}
    catalog.write_text(json.dumps(raw), encoding="utf-8")
    payload = build_payload(catalog)
    assert payload["items"][-1]["id"] == "999"
    assert payload["count"] == 5


def test_aliased_only_exports_just_the_curated_items(catalog):
    # The board starts with only the hand-mapped products: those have verified
    # names and household phrases, where the other scraped rows carry the
    # known category contamination.
    raw = json.loads(catalog.read_text(encoding="utf-8"))
    raw["aliases"] = {"milk": "80000001", "2 milk": "80000001", "bread": "80000003"}
    catalog.write_text(json.dumps(raw), encoding="utf-8")

    payload = build_payload(catalog, aliased_only=True)
    assert payload["count"] == 2
    assert {i["id"] for i in payload["items"]} == {"80000001", "80000003"}
    assert payload["total_skus"] == 4
    assert payload["aliased_only"] is True


def test_aliased_only_defaults_to_false(catalog):
    payload = build_payload(catalog)
    assert payload["count"] == 4
    assert payload["aliased_only"] is False


def test_each_tile_lists_the_phrases_that_reach_it(catalog):
    # On a curated board the phrases are the point: they tell you what to say
    # to Alexa for that product.
    raw = json.loads(catalog.read_text(encoding="utf-8"))
    raw["aliases"] = {"milk": "80000001", "2 milk": "80000001"}
    catalog.write_text(json.dumps(raw), encoding="utf-8")

    payload = build_payload(catalog, aliased_only=True)
    item = payload["items"][0]
    assert item["phrases"] == ["2 milk", "milk"]


def test_items_without_an_alias_carry_no_phrases(catalog):
    payload = build_payload(catalog)
    assert all(i.get("phrases", []) == [] for i in payload["items"])


def test_categories_reflect_only_the_exported_items(catalog):
    raw = json.loads(catalog.read_text(encoding="utf-8"))
    raw["aliases"] = {"bread": "80000003"}
    catalog.write_text(json.dumps(raw), encoding="utf-8")
    payload = build_payload(catalog, aliased_only=True)
    assert payload["categories"] == ["Bakery & Bread"]


def test_aliased_only_with_no_aliases_is_empty_not_an_error(catalog):
    payload = build_payload(catalog, aliased_only=True)
    assert payload["count"] == 0
    assert payload["items"] == []
    assert payload["categories"] == []


def test_write_payload_passes_the_flag_through(tmp_path, catalog):
    raw = json.loads(catalog.read_text(encoding="utf-8"))
    raw["aliases"] = {"milk": "80000001"}
    catalog.write_text(json.dumps(raw), encoding="utf-8")
    out = tmp_path / "www" / "catalog.json"
    write_payload(catalog, out, aliased_only=True)
    assert json.loads(out.read_text(encoding="utf-8"))["count"] == 1


def test_payload_is_world_readable_so_home_assistant_can_serve_it(tmp_path, catalog, monkeypatch):
    """tempfile.mkstemp creates 0600, which HA's web server cannot read.

    Observed on the real box: the file landed as -rw------- root:root in
    /homeassistant/www/walmart/, so the card would have fetched a 403 and
    rendered blank. POSIX modes are not observable on Windows, so this pins
    the chmod call itself.
    """
    import os

    seen = {}
    real_chmod = os.chmod

    def spy(path, mode, *a, **k):
        seen[str(path)] = mode
        return real_chmod(path, mode, *a, **k)

    monkeypatch.setattr(os, "chmod", spy)
    out = tmp_path / "www" / "catalog.json"
    write_payload(catalog, out)

    # The chmod lands on the temp file BEFORE the rename, which is stronger
    # than fixing it afterwards: the published file is never momentarily
    # visible with the wrong mode.
    assert 0o644 in seen.values(), f"no 0o644 chmod; calls were {seen}"
    chmodded = [p for p, m in seen.items() if m == 0o644]
    assert all(str(out.parent) in p for p in chmodded), chmodded
    assert out.exists()


def test_skip_phrases_are_exported_so_the_panel_can_mark_them(catalog):
    # Without these the panel cannot tell a skipped row from one that never
    # matched, so "Not a product, stop asking" silently does nothing.
    raw = json.loads(catalog.read_text(encoding="utf-8"))
    raw["skip_phrases"] = ["Hamburger Meat", "the paper plates"]
    catalog.write_text(json.dumps(raw), encoding="utf-8")
    payload = build_payload(catalog)
    # Normalized by Catalog.load, which is the form the panel compares against.
    assert payload["skip_phrases"] == ["hamburger meat", "paper plate"]


def test_skip_phrases_are_empty_not_missing_when_nothing_is_skipped(catalog):
    payload = build_payload(catalog)
    assert payload["skip_phrases"] == []


def test_skip_phrases_survive_the_aliased_only_board(catalog):
    raw = json.loads(catalog.read_text(encoding="utf-8"))
    raw["aliases"] = {"milk": "80000001"}
    raw["skip_phrases"] = ["hamburger meat"]
    catalog.write_text(json.dumps(raw), encoding="utf-8")
    payload = build_payload(catalog, aliased_only=True)
    assert payload["skip_phrases"] == ["hamburger meat"]
