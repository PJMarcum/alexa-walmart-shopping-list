import pytest
from conftest import FIXTURES
from walmart_cart.catalog import Catalog
from walmart_cart.resolver import (
    STATUS_PENDING,
    STATUS_RESOLVED,
    STATUS_SKIPPED,
    STATUS_UNRESOLVED,
    resolve_local,
)


@pytest.fixture
def cat():
    return Catalog.load(FIXTURES / "catalog_small.json")


def test_exact_alias_resolves_with_no_candidates(cat):
    cat.add_alias("doctor fizz", "80000002")
    r = resolve_local("Doctor Fizz", cat)
    assert r.status == STATUS_RESOLVED
    assert r.item_id == "80000002"
    assert r.candidates == []


def test_skipped_phrase_short_circuits(cat):
    cat.add_skip("new coat")
    r = resolve_local("New Coat", cat)
    assert r.status == STATUS_SKIPPED
    assert r.item_id is None


def test_skip_beats_alias(cat):
    cat.add_alias("new coat", "80000001")
    cat.add_skip("new coat")
    assert resolve_local("new coat", cat).status == STATUS_SKIPPED


def test_index_hit_is_pending_with_candidates(cat):
    r = resolve_local("bread", cat)
    assert r.status == STATUS_PENDING
    assert r.item_id is None
    assert len(r.candidates) >= 1
    assert r.candidates[0].item_id == "80000003"


def test_no_local_hit_is_unresolved(cat):
    r = resolve_local("pickles", cat)
    assert r.status == STATUS_UNRESOLVED
    assert r.candidates == []


def test_household_name_with_no_alias_stays_local(cat):
    # Searching Walmart for "dad's toothpaste" returns nothing useful, so
    # the resolver must not hand this phrase to SerpAPI.
    r = resolve_local("Dad's toothpaste", cat)
    assert r.status == STATUS_PENDING
    assert "household" in r.note


def test_household_name_phrase_is_never_unresolved(cat):
    # Even with no index hit at all, a named phrase must not fall through to
    # search. It routes to the review view instead.
    r = resolve_local("Sam's shampoo", cat)
    assert r.status == STATUS_PENDING
    assert "household" in r.note


def test_empty_phrase_is_unresolved(cat):
    assert resolve_local("   ", cat).status == STATUS_UNRESOLVED
