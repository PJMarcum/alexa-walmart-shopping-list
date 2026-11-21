import json
import pytest
from conftest import FIXTURES
from walmart_cart.catalog import Catalog, CatalogError


def test_loads_the_fixture():
    cat = Catalog.load(FIXTURES / "catalog_small.json")
    assert cat.store_id == "1234"
    assert len(cat.index) == 4
    assert cat.item("80000001")["category"] == "Dairy & Eggs"


def test_missing_file_raises_rather_than_starting_empty():
    # Review Focus 1: an empty default would destroy every learned alias
    # on the next save.
    with pytest.raises(CatalogError, match="not found"):
        Catalog.load(FIXTURES / "does_not_exist.json")


def test_corrupt_file_raises_rather_than_starting_empty():
    # Review Focus 1.
    bad = FIXTURES / "catalog_corrupt.json"
    bad.write_text("{not json", encoding="utf-8")
    try:
        with pytest.raises(CatalogError, match="could not be parsed"):
            Catalog.load(bad)
    finally:
        bad.unlink()


def test_file_missing_required_keys_raises():
    bad = FIXTURES / "catalog_partial.json"
    bad.write_text(json.dumps({"version": 2}), encoding="utf-8")
    try:
        with pytest.raises(CatalogError, match="missing"):
            Catalog.load(bad)
    finally:
        bad.unlink()


def test_alias_lookup_is_normalized():
    cat = Catalog.load(FIXTURES / "catalog_small.json")
    cat.add_alias("Doctor Fizz", "80000002")
    assert cat.lookup_alias("doctor fizz") == "80000002"
    assert cat.lookup_alias("DR FIZZ") == "80000002"


def test_unknown_alias_returns_none():
    cat = Catalog.load(FIXTURES / "catalog_small.json")
    assert cat.lookup_alias("caviar") is None


def test_skip_phrases_are_normalized():
    cat = Catalog.load(FIXTURES / "catalog_small.json")
    cat.add_skip("New Coat")
    assert cat.is_skipped("new coat") is True
    assert cat.is_skipped("new coats") is True
    assert cat.is_skipped("milk") is False


def test_save_then_load_round_trips(tmp_path):
    cat = Catalog.load(FIXTURES / "catalog_small.json")
    cat.add_alias("dad's toothpaste", "80000001")
    cat.add_skip("new coat")
    out = tmp_path / "catalog.json"
    cat.save(out)
    again = Catalog.load(out)
    assert again.lookup_alias("Dads Toothpaste") == "80000001"
    assert again.is_skipped("new coat") is True
    assert len(again.index) == 4


def test_save_is_atomic_and_leaves_no_temp_file(tmp_path):
    cat = Catalog.load(FIXTURES / "catalog_small.json")
    out = tmp_path / "catalog.json"
    cat.save(out)
    assert out.exists()
    assert list(tmp_path.iterdir()) == [out]


def test_alias_keys_from_the_file_are_normalized_on_load(tmp_path):
    # The catalog is hand-editable. An alias written as "doctor fizz" must
    # match, even though normalize() turns the spoken phrase into "dr fizz".
    # Without this, a hand-written alias silently never fires.
    raw = json.loads((FIXTURES / "catalog_small.json").read_text(encoding="utf-8"))
    raw["aliases"] = {"Doctor Fizz": "80000002", "Razor Blades": "80000001"}
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps(raw), encoding="utf-8")

    cat = Catalog.load(path)
    assert cat.lookup_alias("doctor fizz") == "80000002"
    assert cat.lookup_alias("Dr Fizz") == "80000002"
    assert cat.lookup_alias("razor blade") == "80000001"


def test_skip_phrases_from_the_file_are_normalized_on_load(tmp_path):
    raw = json.loads((FIXTURES / "catalog_small.json").read_text(encoding="utf-8"))
    raw["skip_phrases"] = ["New Coats"]
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    assert Catalog.load(path).is_skipped("new coat") is True


def test_save_does_not_clobber_another_writers_alias(tmp_path):
    # A build loads the catalog, spends seconds in SerpAPI, then saves. A
    # tablet pick in that window loads, adds an alias and saves. The build's
    # save must not erase it: on_pick deliberately fires a build, so these
    # two writers are designed to overlap.
    path = tmp_path / "catalog.json"
    path.write_text(
        (FIXTURES / "catalog_small.json").read_text(encoding="utf-8"), encoding="utf-8"
    )

    build_view = Catalog.load(path)          # build starts
    pick_view = Catalog.load(path)           # pick starts
    pick_view.add_alias("rye bread", "80000003")
    pick_view.save(path)                     # pick finishes first
    build_view.pending = [{"phrase": "milk", "candidates": []}]
    build_view.save(path)                    # build finishes second

    final = Catalog.load(path)
    assert final.lookup_alias("rye bread") == "80000003", "pick's alias was lost"
    assert final.pending[0]["phrase"] == "milk", "build's pending was lost"


def test_save_does_not_clobber_another_writers_skip_phrase(tmp_path):
    path = tmp_path / "catalog.json"
    path.write_text(
        (FIXTURES / "catalog_small.json").read_text(encoding="utf-8"), encoding="utf-8"
    )
    first = Catalog.load(path)
    second = Catalog.load(path)
    second.add_skip("new coat")
    second.save(path)
    first.save(path)
    assert Catalog.load(path).is_skipped("new coat") is True


def test_an_exact_product_name_resolves_to_that_product(tmp_path):
    """Tapping a tile in "what we buy" puts the PRODUCT NAME on the list.

    The catalog card adds item.name, so the list receives "Value Pantry Tomato
    Paste, 6 oz" rather than the phrase "tomato paste" that the alias is
    keyed on. Alias lookup missed, so nine items tapped from the grid all
    came back "no match yet" and would have carted nothing on Friday.

    An exact product name is an unambiguous statement of which product is
    wanted, so it resolves to that product.
    """
    from walmart_cart.catalog import Catalog

    cat = Catalog({
        "store_id": "1234",
        "index": {
            "80000006": {"item_id": "80000006",
                         "display_name": "Value Pantry Tomato Paste, 6 oz"},
        },
        "aliases": {"tomato paste": "80000006"},
        "skip_phrases": [],
    })

    assert cat.lookup_alias("tomato paste") == "80000006"
    assert cat.lookup_alias("Value Pantry Tomato Paste, 6 oz") == "80000006"
    # Normalisation applies to the name path too, so case and punctuation
    # from a spoken or retyped version still land.
    assert cat.lookup_alias("value pantry tomato paste 6 oz") == "80000006"
    assert cat.lookup_alias("something we have never bought") is None


def test_an_alias_still_wins_over_a_product_name(tmp_path):
    """Aliases are the deliberate, user-made mapping and must not be shadowed."""
    from walmart_cart.catalog import Catalog

    cat = Catalog({
        "store_id": "1234",
        "index": {
            "111": {"item_id": "111", "display_name": "Cheap Ketchup"},
            "222": {"item_id": "222", "display_name": "Redtop Tomato Ketchup"},
        },
        # Someone deliberately pointed the words "cheap ketchup" at the Redtop.
        "aliases": {"cheap ketchup": "222"},
        "skip_phrases": [],
    })

    assert cat.lookup_alias("Cheap Ketchup") == "222"
