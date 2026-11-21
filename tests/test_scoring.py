import pytest
from conftest import FIXTURES
from walmart_cart.catalog import Catalog
from walmart_cart.scoring import Candidate, frequency, rank


@pytest.fixture
def cat():
    return Catalog.load(FIXTURES / "catalog_small.json")


def test_frequency_parses_plain_and_plus():
    assert frequency("4") == 4.0
    assert frequency("5+") == 5.5
    assert frequency(None) == 0.0


def test_requires_every_query_token_to_appear(cat):
    assert rank("caviar", cat) == []
    assert rank("reduced fat milk", cat) != []


def test_matches_through_normalization(cat):
    # "doctor fizz" must reach "Diet Dr Fizz" via the abbreviation map.
    ids = [c.item_id for c in rank("doctor fizz", cat)]
    assert "80000002" in ids


def test_real_bread_is_in_the_top_candidates(cat):
    # Measured failure: frequency alone ranked Bread Basket soup above bread.
    # The requirement is top-5 recall, not position 1.
    ids = [c.item_id for c in rank("bread", cat, limit=5)]
    assert "80000003" in ids


def test_category_hint_outranks_a_higher_frequency_mismatch(cat):
    # Hearthside bread (5x, Bakery & Bread) must beat Bread Basket soup (5+x, Pantry).
    ranked = rank("bread", cat, limit=5)
    assert ranked[0].item_id == "80000003"


def test_respects_the_limit(cat):
    assert len(rank("milk", cat, limit=1)) <= 1


def test_candidates_carry_display_fields(cat):
    c = rank("reduced fat milk", cat)[0]
    assert c.item_id == "80000001"
    assert "Milk" in c.title
    assert c.category == "Dairy & Eggs"
    assert c.source == "index"


def test_empty_phrase_returns_nothing(cat):
    assert rank("", cat) == []


def test_results_are_sorted_by_descending_score(cat):
    ranked = rank("bread", cat, limit=5)
    assert [c.score for c in ranked] == sorted(
        (c.score for c in ranked), reverse=True
    )


def test_an_index_candidate_keeps_the_picture_the_index_already_has():
    """The catalog stores a thumbnail per product; the candidate dropped it.

    Search results got pictures, but a candidate ranked out of purchase
    history did not, so matching "Apples" offered five nameless grey rows for
    products the household has actually bought and has images for.
    """
    from walmart_cart.scoring import rank

    class Cat:
        index = {
            "80000008": {
                "item_id": "80000008",
                "display_name": "Fresh Gala Apple, Each",
                "category": "Produce",
                "bought_count": 4,
                "thumbnail": "https://i5.walmartimages.com/seo/apple.jpeg",
                "product_page_url": "https://www.walmart.com/ip/80000008",
            }
        }

    out = rank("apples", Cat())
    assert out, "the apple should rank for apples"
    assert out[0].thumbnail == "https://i5.walmartimages.com/seo/apple.jpeg"


def test_a_bare_fruit_name_beats_the_flavour_of_something_popular():
    """"apples" ranked Grainfield Apple Cinnamon bars above a real apple.

    Both titles contain "apple", so both are eligible, and the bars are bought
    far more often. A sweep of every brevity-against-frequency weighting
    showed none that fixes this without breaking "milk": the missing signal is
    not how short or how popular the title is, but that the word names the
    PRODUCT here and a flavour there. That is what the category says.
    """
    from walmart_cart.scoring import rank

    class Cat:
        index = {
            "bars": {
                "item_id": "bars",
                "display_name": "Grainfield Breakfast Bars, Whole Grain, Apple Cinnamon",
                "category": "Breakfast & Cereal",
                "bought_count": 20,
            },
            "apple": {
                "item_id": "apple",
                "display_name": "Fresh Gala Apple, Each",
                "category": "Fresh Produce",
                "bought_count": 1,
            },
        }

    assert rank("apples", Cat())[0].item_id == "apple"


def test_tomato_is_not_hinted_at_produce():
    """Say a household buys tomato PASTE from Pantry and no fresh tomatoes.

    A hint also narrows the resolver's fallback pool to the hinted categories,
    so hinting "tomato" would quietly hide the paste. Same reason "pepper" is
    left out: bell peppers and black pepper are different aisles.
    """
    from walmart_cart.scoring import CATEGORY_HINTS

    assert "tomato" not in CATEGORY_HINTS
    assert "pepper" not in CATEGORY_HINTS
    assert CATEGORY_HINTS["apple"] == frozenset({"Fresh Produce"})
