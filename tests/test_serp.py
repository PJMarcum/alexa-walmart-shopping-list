import json
import pytest
from conftest import FIXTURES
from walmart_cart.serp import SerpError, search


def loader(name):
    payload = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    captured = {}

    def fetch(url):
        captured["url"] = url
        return payload

    fetch.captured = captured
    return fetch


def test_parses_candidates_and_uses_us_item_id():
    # Global constraint: the cart identifier is us_item_id, never product_id.
    out = search("doctor fizz", "KEY", fetch=loader("serp_doctor_fizz.json"))
    assert [c.item_id for c in out] == ["80000004", "80000010"]
    assert out[0].title.startswith("Dr Fizz")
    assert out[0].source == "serpapi"
    assert out[0].url == "https://www.walmart.com/ip/80000004"


def test_sends_the_query_and_key():
    fetch = loader("serp_doctor_fizz.json")
    search("hamburger meat", "SECRET", fetch=fetch)
    assert "engine=walmart" in fetch.captured["url"]
    assert "hamburger" in fetch.captured["url"]
    assert "SECRET" in fetch.captured["url"]


def test_includes_store_id_when_given():
    fetch = loader("serp_doctor_fizz.json")
    search("milk", "KEY", store_id="1234", fetch=fetch)
    assert "store_id=1234" in fetch.captured["url"]


def test_respects_the_limit():
    out = search("x", "KEY", limit=1, fetch=loader("serp_doctor_fizz.json"))
    assert len(out) == 1


def test_empty_results_return_an_empty_list_without_raising():
    # Review Focus 4.
    assert search("caviar", "KEY", fetch=loader("serp_empty.json")) == []


def test_error_payload_raises_serp_error():
    # Review Focus 4: the caller catches this and leaves the phrase on the list.
    with pytest.raises(SerpError, match="run out of searches"):
        search("x", "KEY", fetch=loader("serp_error.json"))


def test_missing_organic_results_key_returns_empty():
    # Review Focus 4.
    def fetch(url):
        return {"search_information": {"total_results": 5}}

    assert search("x", "KEY", fetch=fetch) == []


def test_transport_failure_raises_serp_error():
    # Review Focus 4.
    def fetch(url):
        raise OSError("connection reset")

    with pytest.raises(SerpError, match="connection reset"):
        search("x", "KEY", fetch=fetch)


def test_result_missing_us_item_id_is_skipped_not_fatal():
    def fetch(url):
        return {"organic_results": [{"title": "No id here"}, {
            "title": "Good", "us_item_id": "123456", "primary_offer": {}}]}

    out = search("x", "KEY", fetch=fetch)
    assert [c.item_id for c in out] == ["123456"]


def test_a_search_result_keeps_its_picture():
    """Choosing between five cuts of pork by title alone is guesswork.

    SerpAPI returns a thumbnail on every organic result, on the same
    i5.walmartimages.com host the catalog uses, so it takes the sizing
    parameters like any other. Dropping it left the review sheet showing a
    warning glyph for exactly the items nobody has bought before, which are
    the only ones that ever need reviewing.
    """
    from walmart_cart.serp import search

    payload = {
        "organic_results": [
            {
                "us_item_id": "80000005",
                "title": "Pork Loin Chops, Boneless, Family Pack",
                "product_page_url": "https://www.walmart.com/ip/80000005",
                "thumbnail": "https://i5.walmartimages.com/seo/chops.jpeg",
            },
            {
                "us_item_id": "80000011",
                "title": "Pork Center Cut Loin Chops, Bone-In",
                "product_page_url": "https://www.walmart.com/ip/80000011",
            },
        ]
    }
    out = search("pork chops", api_key="k", store_id="1234",
                 fetch=lambda url: payload)

    assert out[0].thumbnail == "https://i5.walmartimages.com/seo/chops.jpeg"
    # A result without one must not blow up; the sheet falls back to a glyph.
    assert out[1].thumbnail is None


def test_a_failed_request_never_puts_the_key_in_the_error():
    # requests' HTTPError text ends "for url: <full url>", key included, and
    # the app logs the error message.
    def fetch(url):
        raise RuntimeError(f"401 Client Error: Unauthorized for url: {url}")

    try:
        search("milk", "SUPERSECRETKEY", fetch=fetch)
    except SerpError as exc:
        assert "SUPERSECRETKEY" not in str(exc)
        assert "api_key=***" in str(exc)
        assert exc.__cause__ is None
    else:
        raise AssertionError("expected SerpError")
