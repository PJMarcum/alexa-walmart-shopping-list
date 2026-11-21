import pytest
from walmart_cart.cart_url import CartUrlError, build


def test_builds_a_single_item_url():
    assert build(["80000004"]) == (
        "https://affil.walmart.com/cart/buynow?items=80000004"
    )


def test_joins_multiple_ids_with_commas_and_no_quantities():
    # Global constraint: quantity is always 1, so no _QTY suffixes.
    assert build(["80000004", "80000001"]).endswith("items=80000004,80000001")


def test_preserves_order():
    url = build(["3", "1", "2"])
    assert url.endswith("items=3,1,2")


def test_deduplicates_while_preserving_first_position():
    assert build(["80000004", "80000001", "80000004"]).endswith(
        "items=80000004,80000001"
    )


def test_empty_list_raises_rather_than_producing_a_broken_url():
    # Review Focus 5: "?items=" looks like success and is a dead link.
    with pytest.raises(CartUrlError, match="no items"):
        build([])


def test_non_numeric_id_raises():
    # A product_id such as 6XS02JTJK8P2 would silently produce a dead cart.
    with pytest.raises(CartUrlError, match="not numeric"):
        build(["6XS02JTJK8P2"])


def test_accepts_long_numeric_ids():
    # Measured: real ids run to 11 digits, e.g. 80000000009.
    assert build(["80000000009"]).endswith("items=80000000009")


def test_forty_ids_stay_well_under_any_url_limit():
    url = build([str(10000000 + n) for n in range(40)])
    assert len(url) < 1000
