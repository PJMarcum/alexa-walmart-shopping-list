import json
import shutil
import pytest
from conftest import FIXTURES
from test_ha_list import STATES, FakeClient
from walmart_cart.build import Config, build_cart
from walmart_cart.scoring import Candidate
from walmart_cart.serp import SerpError


@pytest.fixture
def cfg(tmp_path):
    catalog = tmp_path / "catalog.json"
    shutil.copy(FIXTURES / "catalog_small.json", catalog)
    return Config(
        catalog_path=str(catalog),
        run_dir=str(tmp_path / "runs"),
        store_id="1234",
        serpapi_key="KEY",
    )


def items(*names):
    return [{"summary": n, "status": "needs_action"} for n in names]


def set_catalog(cfg, **changes):
    catalog = json.loads(open(cfg.catalog_path, encoding="utf-8").read())
    catalog.update(changes)
    with open(cfg.catalog_path, "w", encoding="utf-8") as fh:
        json.dump(catalog, fh)


def no_search(query, api_key, store_id, limit):
    raise AssertionError(f"SerpAPI must not be called for {query!r}")


def test_empty_list_pushes_nothing_to_build_and_no_url(cfg):
    # Review Focus 5.
    client = FakeClient(items=[], states=STATES)
    out = build_cart(client, cfg, searcher=no_search)
    assert out["status"] == "nothing_to_build"
    assert out["cart_url"] is None
    assert "url" not in out["notification"]["data"]


def test_list_of_only_completed_items_is_nothing_to_build(cfg):
    # Review Focus 5.
    client = FakeClient(items=[{"summary": "Milk", "status": "completed"}], states=STATES)
    assert build_cart(client, cfg, searcher=no_search)["status"] == "nothing_to_build"


def test_aliased_item_is_carted_and_consumed(cfg):
    set_catalog(cfg, aliases={"doctor fizz": "80000002"})
    client = FakeClient(items=items("Doctor fizz"), states=STATES)
    out = build_cart(client, cfg, searcher=no_search)
    assert out["status"] == "built"
    assert out["cart_url"].endswith("items=80000002")
    assert client.items == []


def test_pending_item_is_not_carted_and_not_consumed(cfg):
    # Spec: pending items roll into the next build.
    client = FakeClient(items=items("bread"), states=STATES)
    out = build_cart(client, cfg, searcher=no_search)
    assert out["status"] == "nothing_to_build"
    assert [i["summary"] for i in client.items] == ["bread"]


def test_unresolved_item_calls_serpapi_and_stays_on_the_list(cfg):
    calls = []

    def searcher(query, api_key, store_id, limit):
        calls.append(query)
        return [Candidate(item_id="999111", title="Crunchy Dill Pickles", source="serpapi")]

    client = FakeClient(items=items("pickles"), states=STATES)
    out = build_cart(client, cfg, searcher=searcher)
    assert calls == ["pickles"]
    assert [i["summary"] for i in client.items] == ["pickles"]
    assert out["status"] == "nothing_to_build"


def test_serp_failure_leaves_the_item_and_does_not_raise(cfg):
    # Review Focus 4.
    def searcher(query, api_key, store_id, limit):
        raise SerpError("out of searches")

    client = FakeClient(items=items("pickles"), states=STATES)
    out = build_cart(client, cfg, searcher=searcher)
    assert "pickles" in out["notification"]["message"]
    assert [i["summary"] for i in client.items] == ["pickles"]


def test_duplicate_phrases_resolving_to_one_id_cart_once(cfg):
    set_catalog(cfg, aliases={"milk": "80000001", "2 milk": "80000001"})
    client = FakeClient(items=items("Milk", "2% milk"), states=STATES)
    out = build_cart(client, cfg, searcher=no_search)
    assert out["cart_url"].endswith("items=80000001")
    assert client.items == []


def test_a_failed_consume_is_reported_and_the_list_is_intact(cfg):
    # Review Focus 2.
    set_catalog(cfg, aliases={"milk": "80000001"})
    client = FakeClient(items=items("Milk"), states=STATES, drop_writes=True)
    out = build_cart(client, cfg, searcher=no_search)
    assert out["status"] == "built_consume_failed"
    assert [i["summary"] for i in client.items] == ["Milk"]


def test_dry_run_builds_a_url_but_consumes_nothing(cfg):
    set_catalog(cfg, aliases={"milk": "80000001"})
    cfg.dry_run = True
    client = FakeClient(items=items("Milk"), states=STATES)
    out = build_cart(client, cfg, searcher=no_search)
    assert out["cart_url"].endswith("items=80000001")
    assert [i["summary"] for i in client.items] == ["Milk"]


def test_missing_list_entity_is_a_clean_failure(cfg):
    client = FakeClient(items=[], states=[STATES[0]])
    out = build_cart(client, cfg, searcher=no_search)
    assert out["status"] == "failed"
    assert client.reloads == 1


def test_corrupt_catalog_is_a_clean_failure_that_changes_nothing(cfg):
    # Review Focus 1, at the pipeline level.
    with open(cfg.catalog_path, "w", encoding="utf-8") as fh:
        fh.write("{not json")
    client = FakeClient(items=items("Milk"), states=STATES)
    out = build_cart(client, cfg, searcher=no_search)
    assert out["status"] == "failed"
    assert [i["summary"] for i in client.items] == ["Milk"]
    assert client.calls == []


def test_a_run_record_is_written_every_time(cfg):
    client = FakeClient(items=[], states=STATES)
    out = build_cart(client, cfg, searcher=no_search)
    assert json.loads(open(out["run_path"], encoding="utf-8").read())["status"]


def test_skipped_phrase_is_neither_carted_nor_searched(cfg):
    set_catalog(cfg, skip_phrases=["new coat"])
    client = FakeClient(items=items("New coat"), states=STATES)
    out = build_cart(client, cfg, searcher=no_search)
    assert out["status"] == "nothing_to_build"


def test_pending_candidates_are_persisted_for_the_review_view(cfg):
    client = FakeClient(items=items("bread"), states=STATES)
    build_cart(client, cfg, searcher=no_search)
    saved = json.loads(open(cfg.catalog_path, encoding="utf-8").read())
    assert saved["pending"][0]["phrase"] == "bread"
    assert saved["pending"][0]["candidates"][0]["item_id"] == "80000003"


def test_notification_counts_unique_items_not_requests(cfg):
    # Spec: dedupe on item_id. Two phrases for one SKU is one item in the
    # cart, not two, and the push must not overstate what was added.
    set_catalog(cfg, aliases={"milk": "80000001", "2 milk": "80000001"})
    client = FakeClient(items=items("Milk", "2% milk"), states=STATES)
    out = build_cart(client, cfg, searcher=no_search)
    assert out["notification"]["message"].startswith("1 in the cart")


def test_consume_read_back_failure_still_records_and_notifies(cfg):
    # Finding 1 at the pipeline level: nothing may escape build_cart without
    # a run record and a notification.
    from test_ha_list import ReadFailsAfterWrite

    set_catalog(cfg, aliases={"milk": "80000001"})
    client = ReadFailsAfterWrite(items=items("Milk"))
    client.states = STATES
    out = build_cart(client, cfg, searcher=no_search)
    assert out["run_path"]
    assert out["notification"]["message"]
    assert out["status"] in {"built_consume_failed", "failed"}


def test_a_bad_alias_id_fails_cleanly_with_a_record_and_a_push(cfg):
    # Finding 4: a hand-typed pick can paste a product_id. cart_url rejects
    # it, and that must not escape as an unhandled crash.
    set_catalog(cfg, aliases={"milk": "6XS02JTJK8P2"})
    client = FakeClient(items=items("Milk"), states=STATES)
    out = build_cart(client, cfg, searcher=no_search)
    assert out["status"] == "failed"
    assert out["run_path"]
    assert "url" not in out["notification"]["data"]
    assert [i["summary"] for i in client.items] == ["Milk"]


def test_reload_failure_does_not_escape(cfg):
    # Finding 12: reload_config_entry can 500, and that is not an HaListError.
    class ReloadExplodes(FakeClient):
        def reload_config_entry(self, entity_id):
            raise OSError("500 on reload")

    client = ReloadExplodes(items=[], states=[STATES[0]])
    out = build_cart(client, cfg, searcher=no_search)
    assert out["status"] == "failed"
    assert out["run_path"]


def test_a_row_without_a_summary_does_not_escape(cfg):
    # Finding 11: an unguarded item["summary"] subscript.
    client = FakeClient(items=[{"status": "needs_action"}], states=STATES)
    out = build_cart(client, cfg, searcher=no_search)
    assert out["run_path"]
    assert out["status"] in {"nothing_to_build", "failed"}


def test_result_carries_the_counts_so_the_announcement_can_speak_them(cfg):
    """The returned dict must expose counts, not just the run record.

    Live defect 2026-10-01: the Echo announced "Nothing to build, your
    Walmart list is empty" on a run that carted 3 items. _finish returned
    status/notification/cart_url/resolutions/run_path and no counts, so the
    AppDaemon adapter's result.get("counts") was always {} and
    compose_announcement got (0, 0, 0) every time.

    The push looked correct throughout, which is what hid the bug: the push
    consumes the pre-composed notification string, while the announcement
    and the SMS recompute from the raw numbers. Both consumers must be fed
    from the same source.
    """
    set_catalog(cfg, aliases={"milk": "80000001", "bread": "80000003"})
    client = FakeClient(items=items("Milk", "Bread"), states=STATES)
    out = build_cart(client, cfg, searcher=no_search)

    record = json.loads(open(out["run_path"], encoding="utf-8").read())
    assert out["counts"] == record["counts"], (
        "result counts must match the run record's counts"
    )
    assert out["counts"]["items_carted"] >= 1


def test_counts_are_present_even_when_there_is_nothing_to_build(cfg):
    # The zero case must be a real zero from the pipeline, not a missing key
    # that happens to read as zero.
    client = FakeClient(items=[], states=STATES)
    out = build_cart(client, cfg, searcher=no_search)
    assert "counts" in out
    assert out["counts"]["items_carted"] == 0


def test_counts_are_present_on_a_clean_failure(cfg):
    # A failure finishes through the same _finish, so the key must exist
    # there too or the announcement path crashes on a KeyError instead.
    client = FakeClient(items=items("Milk"), states=[STATES[0]])
    out = build_cart(client, cfg, searcher=no_search)
    assert out["status"] == "failed"
    assert "counts" in out
