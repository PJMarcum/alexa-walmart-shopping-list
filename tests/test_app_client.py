"""Tests for the one piece of real logic in the AppDaemon adapter.

AppDaemon is not installed here and is not a dependency of the walmart_cart
package, so a stub module is registered before importing the app. Everything
else in walmart_cart_app.py is thin forwarding, verified manually on the box.
"""

import sys
import types

import pytest

# Stub appdaemon.plugins.hass.hassapi so the app module imports.
for name in ("appdaemon", "appdaemon.plugins", "appdaemon.plugins.hass",
             "appdaemon.plugins.hass.hassapi"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["appdaemon.plugins.hass.hassapi"].Hass = type("Hass", (), {})

from walmart_cart_app import AdClient  # noqa: E402


class FakeApp:
    """Models AppDaemon's REAL get_state API, not my first guess at it.

    Measured against the live add-on: get_state(attribute="all") with no
    entity raises ValueError("Querying a specific attribute is only possible
    for a single entity"). The real shapes are:
      get_state("todo")                      -> {entity_id: state_string}
      get_state(entity_id, attribute="all")  -> {state, attributes, ...}
    """

    def __init__(self, states):
        self._states = states or {}
        self.calls = []
        self.args = {}

    def get_state(self, entity=None, attribute=None):
        if entity is None and attribute is not None:
            raise ValueError(
                "Querying a specific attribute is only possible for a "
                "single entity"
            )
        if entity is None:
            return {k: (v or {}).get("state") for k, v in self._states.items()}
        if "." not in entity:  # a domain, e.g. "todo"
            return {
                k: (v or {}).get("state")
                for k, v in self._states.items()
                if k.startswith(entity + ".")
            }
        return self._states.get(entity)

    def call_service(self, service, **data):
        self.calls.append((service, data))
        return {}

    def sleep(self, seconds):
        self.calls.append(("sleep", seconds))


def test_get_states_returns_todo_entities_with_their_attributes():
    # Only the todo domain is fetched: it is all ha_list filters on, and
    # pulling every entity in the instance to find four was wasteful as well
    # as unsupported.
    app = FakeApp({
        "todo.walmart": {"state": "3", "attributes": {"friendly_name": "acct walmart"}},
        "sensor.x": {"state": "1", "attributes": {"friendly_name": "X"}},
    })
    out = AdClient(app).get_states()
    assert {s["entity_id"] for s in out} == {"todo.walmart"}
    assert out[0]["attributes"]["friendly_name"] == "acct walmart"


def test_get_states_never_asks_for_an_attribute_without_an_entity():
    # The live failure: get_state(attribute="all") with no entity raises.
    app = FakeApp({"todo.a": {"state": "1", "attributes": {}}})
    AdClient(app).get_states()  # must not raise


def test_get_states_tolerates_none_entries():
    # AppDaemon returns None for an entity that has gone unavailable mid-read.
    app = FakeApp({"todo.walmart": None,
                   "todo.other": {"attributes": {"friendly_name": "other"}}})
    out = AdClient(app).get_states()
    assert [s["entity_id"] for s in out] == ["todo.other"]


def test_get_states_tolerates_a_missing_attributes_key():
    app = FakeApp({"todo.walmart": {"state": "0"}})
    out = AdClient(app).get_states()
    assert out == [{"entity_id": "todo.walmart", "attributes": {}}]


def test_get_states_of_an_empty_instance_is_empty():
    assert AdClient(FakeApp(None)).get_states() == []


def test_get_states_survives_a_domain_query_returning_none():
    class Blank(FakeApp):
        def get_state(self, entity=None, attribute=None):
            return None

    assert AdClient(Blank({})).get_states() == []


def test_reload_config_entry_uses_the_configured_anchor():
    app = FakeApp({})
    app.args = {"reload_anchor_entity": "todo.anchor"}
    AdClient(app).reload_config_entry(None)
    service, data = app.calls[0]
    assert service == "homeassistant/reload_config_entry"
    assert data["entity_id"] == "todo.anchor"


def test_reload_config_entry_prefers_an_explicit_entity():
    app = FakeApp({})
    AdClient(app).reload_config_entry("todo.explicit")
    assert app.calls[0][1]["entity_id"] == "todo.explicit"


def _bare_app(tmp_path, catalog_src):
    """A WalmartCart with its base-class __init__ bypassed."""
    import shutil
    from walmart_cart.build import Config
    from walmart_cart_app import WalmartCart

    catalog = tmp_path / "catalog.json"
    shutil.copy(catalog_src, catalog)
    app = object.__new__(WalmartCart)
    app.cfg = Config(
        catalog_path=str(catalog), run_dir=str(tmp_path / "runs"), store_id="1234"
    )
    app.notify_targets = ["notify/test"]
    app.announce_targets = []
    app.sms_service = "notify/sms"
    app.sms_recipients = []
    app.client = None
    app.pushes = []
    app.logs = []
    app.log = lambda *a, **k: app.logs.append(a)
    app.call_service = lambda svc, **kw: app.pushes.append((svc, kw))
    app.fire_event = lambda *a, **k: None
    app.set_state = lambda *a, **k: None
    return app


def test_on_build_does_not_mutate_the_shared_config(tmp_path):
    # Finding 8: a real build arriving while a dry run is in flight flipped
    # the in-flight run to dry_run=False and let it consume the Alexa list.
    import walmart_cart_app
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    seen = []
    walmart_cart_app.build_cart = lambda client, cfg: (
        seen.append(cfg.dry_run),
        {"status": "dry_run", "notification": {"title": "t", "message": "m", "data": {}}},
    )[1]

    app.on_build("e", {"dry_run": True}, {})
    assert seen == [True]
    assert app.cfg.dry_run is False, "shared config was mutated"

    app.on_build("e", {"dry_run": False}, {})
    assert seen == [True, False]
    assert app.cfg.dry_run is False


def test_the_push_survives_a_failure_to_publish_pending(tmp_path):
    # Finding 5: on a corrupt catalog, build_cart composes a readable failure
    # message and then _publish_pending raised, so the push never went out.
    import walmart_cart_app
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    walmart_cart_app.build_cart = lambda client, cfg: {
        "status": "failed",
        "notification": {"title": "Walmart cart failed", "message": "bad catalog",
                         "data": {}},
    }
    app.set_state = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no catalog"))

    app.on_build("e", {}, {})
    assert app.pushes, "notification was lost"
    assert app.pushes[0][1]["message"] == "bad catalog"


def _push_app(tmp_path, targets):
    import walmart_cart_app
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    app.notify_targets = targets
    walmart_cart_app.build_cart = lambda client, cfg: {
        "status": "built",
        "notification": {"title": "t", "message": "m", "data": {"url": "u"}},
    }
    return app


def test_the_push_goes_to_every_configured_phone(tmp_path):
    app = _push_app(tmp_path, ["notify/mobile_app_your_phone",
                               "notify/mobile_app_second_phone"])
    app.on_build("e", {}, {})
    assert [p[0] for p in app.pushes] == [
        "notify/mobile_app_your_phone",
        "notify/mobile_app_second_phone",
    ]
    assert all(p[1]["message"] == "m" for p in app.pushes)


def test_one_unreachable_phone_does_not_cost_the_other_the_push(tmp_path):
    # One phone being off must not mean nobody hears about the cart.
    app = _push_app(tmp_path, ["notify/broken", "notify/mobile_app_your_phone"])
    sent = []

    def call(svc, **kw):
        if svc == "notify/broken":
            raise RuntimeError("device unavailable")
        sent.append(svc)

    app.call_service = call
    app.on_build("e", {}, {})
    assert sent == ["notify/mobile_app_your_phone"]


def test_a_single_target_string_still_works(tmp_path):
    # Backwards compatible with the old notify_target scalar.
    app = _push_app(tmp_path, "notify/mobile_app_your_phone")
    app.on_build("e", {}, {})
    assert [p[0] for p in app.pushes] == ["notify/mobile_app_your_phone"]


def test_a_dry_run_pushes_to_nobody(tmp_path):
    app = _push_app(tmp_path, ["notify/a", "notify/b"])
    app.on_build("e", {"dry_run": True}, {})
    assert app.pushes == []


def _announce_app(tmp_path, echoes, counts=(7, 1, 0)):
    import walmart_cart_app
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    app.notify_targets = ["notify/mobile_app_your_phone"]
    app.announce_targets = echoes
    walmart_cart_app.build_cart = lambda client, cfg: {
        "status": "built",
        "notification": {"title": "t", "message": "m", "data": {"url": "u"}},
        "counts": {"items_carted": counts[0], "pending": counts[1],
                   "unresolved": counts[2]},
    }
    return app


def test_the_announcement_goes_to_every_configured_echo(tmp_path):
    app = _announce_app(tmp_path, ["notify.kitchen_announce", "notify.office_announce"])
    app.on_build("e", {}, {})
    spoken = [p for p in app.pushes if p[0] == "notify/send_message"]
    assert [p[1]["entity_id"] for p in spoken] == [
        "notify.kitchen_announce", "notify.office_announce"
    ]
    assert "7 item" in spoken[0][1]["message"]


def test_the_announcement_never_speaks_a_url(tmp_path):
    app = _announce_app(tmp_path, ["notify.kitchen_announce"])
    app.on_build("e", {}, {})
    spoken = next(p for p in app.pushes if p[0] == "notify/send_message")
    assert "http" not in spoken[1]["message"]


def test_one_unreachable_echo_does_not_stop_the_others(tmp_path):
    app = _announce_app(tmp_path, ["notify.broken_announce", "notify.ok_announce"])
    reached = []

    def call(svc, **kw):
        if kw.get("entity_id") == "notify.broken_announce":
            raise RuntimeError("echo offline")
        reached.append(kw.get("entity_id") or svc)

    app.call_service = call
    app.on_build("e", {}, {})
    assert "notify.ok_announce" in reached


def test_no_echoes_configured_means_no_announcement_and_no_error(tmp_path):
    app = _announce_app(tmp_path, [])
    app.on_build("e", {}, {})
    assert all(p[0] != "notify/send_message" for p in app.pushes)


def test_a_dry_run_announces_nothing(tmp_path):
    app = _announce_app(tmp_path, ["notify.kitchen_announce"])
    app.on_build("e", {"dry_run": True}, {})
    assert app.pushes == []


def _sms_app(tmp_path, recipients, cart_url="https://affil.walmart.com/cart/buynow?items=1,2"):
    import walmart_cart_app
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    app.notify_targets = []
    app.announce_targets = []
    app.sms_service = "notify/sms"
    app.sms_recipients = recipients
    walmart_cart_app.build_cart = lambda client, cfg: {
        "status": "built",
        "notification": {"title": "t", "message": "m", "data": {}},
        "cart_url": cart_url,
        "counts": {"items_carted": 7, "pending": 1, "unresolved": 0},
    }
    return app


def test_sms_is_sent_once_carrying_every_recipient(tmp_path):
    # One call carries them all rather than one call per number.
    #
    # The key is passed as 'recipients', NOT 'target'. Measured on the live
    # box: AppDaemon treats 'target' as a reserved kwarg and hoists it out of
    # service_data into the websocket envelope, where Home Assistant expects a
    # mapping of entity_id/device_id/area_id. A list of phone numbers there is
    # rejected with "invalid_format: expected a mapping at 'target'", and the
    # message is lost in transit after being composed perfectly. An HA script
    # maps recipients back onto the notify target, where it belongs.
    app = _sms_app(tmp_path, ["+15551112222", "+15553334444"])
    app.on_build("e", {}, {})
    sms = [p for p in app.pushes if p[0] == app.sms_service]
    assert len(sms) == 1
    assert sms[0][1]["recipients"] == ["+15551112222", "+15553334444"]


def test_sms_never_passes_a_kwarg_named_target(tmp_path):
    """Regression guard for the reserved-kwarg collision.

    This is the whole bug in one assertion. Anything named 'target' is
    intercepted by AppDaemon before Home Assistant sees it.
    """
    app = _sms_app(tmp_path, ["+15551112222"])
    app.on_build("e", {}, {})
    sent = next(p for p in app.pushes if p[0] == app.sms_service)[1]
    assert "target" not in sent, (
        "AppDaemon hoists 'target' into the websocket envelope and HA rejects "
        "a list there; pass 'recipients' and let a script map it"
    )


def test_sms_carries_the_link_and_no_title(tmp_path):
    app = _sms_app(tmp_path, ["+15551112222"])
    app.on_build("e", {}, {})
    sent = next(p for p in app.pushes if p[0] == app.sms_service)[1]
    assert "affil.walmart.com" in sent["message"]
    assert "title" not in sent, "an SMS notify platform does not support title"


def test_no_recipients_means_no_sms_and_no_error(tmp_path):
    app = _sms_app(tmp_path, [])
    app.on_build("e", {}, {})
    assert all(p[0] != app.sms_service for p in app.pushes)


def test_an_sms_failure_does_not_lose_the_other_channels(tmp_path):
    app = _sms_app(tmp_path, ["+15551112222"])
    app.notify_targets = ["notify/mobile_app_your_phone"]
    reached = []

    def call(svc, **kw):
        if svc.endswith("walmart_send_sms") or svc == "notify/sms":
            raise RuntimeError("sms 400")
        reached.append(svc)

    app.call_service = call
    app.on_build("e", {}, {})
    assert reached == ["notify/mobile_app_your_phone"]


def test_a_dry_run_sends_no_sms(tmp_path):
    app = _sms_app(tmp_path, ["+15551112222"])
    app.on_build("e", {"dry_run": True}, {})
    assert app.pushes == []


def test_pending_state_is_a_string_so_zero_is_not_dropped(tmp_path):
    """AppDaemon omits a falsy state, so an integer 0 produced an HTTP 400.

    Observed on the real box: 'ERROR HASS: [400] HTTP POST ... {"attributes":
    {...}}' with no state key at all, because len(pending) was 0.
    """
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    seen = []
    app.set_state = lambda entity, **kw: seen.append((entity, kw))
    app._publish_pending()
    entity, kw = seen[0]
    assert entity == "sensor.walmart_pending"
    assert kw["state"] == "0", f"state was {kw['state']!r}, must be a string"
    assert isinstance(kw["state"], str)


def test_announcements_go_through_send_message_with_an_entity_id(tmp_path):
    """Echo announce targets are notify ENTITIES, not notify services.

    Measured on the live box: calling notify/kitchen_echo_announce fails
    with "domain 'notify' exists ... but does not contain service
    'kitchen_echo_announce'". HA's newer notify platform exposes these as
    entities, invoked via notify.send_message with an entity_id.
    """
    app = _announce_app(tmp_path, ["notify.kitchen_echo_announce",
                                   "notify.den_echo_announce"])
    app.on_build("e", {}, {})
    spoken = [p for p in app.pushes if p[0] == "notify/send_message"]
    assert len(spoken) == 2
    assert [p[1]["entity_id"] for p in spoken] == [
        "notify.kitchen_echo_announce",
        "notify.den_echo_announce",
    ]
    assert "7 item" in spoken[0][1]["message"]


def test_announcement_never_calls_a_bare_notify_service(tmp_path):
    app = _announce_app(tmp_path, ["notify.kitchen_echo_announce"])
    app.on_build("e", {}, {})
    assert all(
        p[0] != "notify/kitchen_echo_announce" for p in app.pushes
    ), "called the entity as if it were a service"


def test_a_scheduled_run_can_suppress_the_announcement(tmp_path):
    """announce: false silences the Echoes without silencing anything else.

    The Friday 07:00 automation fires before the household is awake, and the
    Echoes do not have Do Not Disturb set. The cart
    still needs building at that hour so the link is waiting on the phone,
    so this suppresses only the spoken channel.
    """
    app = _announce_app(tmp_path, ["notify.kitchen_announce"])
    app.sms_recipients = ["+15551112222"]
    app.sms_service = "script/walmart_send_sms"
    app.on_build("e", {"announce": False}, {})

    assert not [p for p in app.pushes if p[0] == "notify/send_message"], (
        "scheduled run must not speak on the Echoes"
    )
    # The quiet channels must be untouched.
    assert [p for p in app.pushes if p[0] == "notify/mobile_app_your_phone"]
    assert [p for p in app.pushes if p[0] == "script/walmart_send_sms"]


def test_announcements_happen_by_default(tmp_path):
    # Absent the flag, nothing changes: an on-demand run still speaks.
    app = _announce_app(tmp_path, ["notify.kitchen_announce"])
    app.on_build("e", {}, {})
    assert [p for p in app.pushes if p[0] == "notify/send_message"]


def test_announce_true_is_explicit_and_still_speaks(tmp_path):
    app = _announce_app(tmp_path, ["notify.kitchen_announce"])
    app.on_build("e", {"announce": True}, {})
    assert [p for p in app.pushes if p[0] == "notify/send_message"]


def test_a_missing_event_payload_still_announces(tmp_path):
    # listen_event can hand through None rather than {}; that must not become
    # a silent build, and must not raise.
    app = _announce_app(tmp_path, ["notify.kitchen_announce"])
    app.on_build("e", None, {})
    assert [p for p in app.pushes if p[0] == "notify/send_message"]


def test_a_pick_does_not_build_the_cart(tmp_path):
    """Matching an item must not place an order or wake the house.

    on_pick used to fire a build, so a single tap carted everything matched,
    cleared those items off the list, and sent an SMS plus an Echo
    announcement. Two matches at 22:30 meant two announcements with the house
    asleep. Building is the Build cart button's job and nothing else's.
    """
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    fired = []
    app.fire_event = lambda *a, **k: fired.append((a, k))
    app._publish_pending = lambda: None
    app._export_ui_data = lambda: None

    app.on_pick("e", {"phrase": "pork chops", "item_id": "80000005"}, {})

    assert fired == [], f"a pick must fire nothing, fired {fired}"


def test_a_pick_writes_the_alias(tmp_path):
    from walmart_cart.catalog import Catalog
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    app.fire_event = lambda *a, **k: None
    app._publish_pending = lambda: None
    app._export_ui_data = lambda: None

    app.on_pick("e", {"phrase": "pork chops", "item_id": "80000005"}, {})

    assert Catalog.load(app.cfg.catalog_path).lookup_alias("pork chops") == "80000005"


def test_picking_a_searched_product_adds_it_to_the_index(tmp_path):
    """A SerpAPI candidate is not in the local index, which is purchase history.

    Without this the alias points at a SKU nothing knows the name of, so the
    row keeps reading "no match yet" after a successful pick and the product
    never appears in "what we buy". That is the case for every item the
    household has not bought before, which is exactly when review is needed.
    """
    import json
    from walmart_cart.catalog import Catalog
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    app.fire_event = lambda *a, **k: None
    app._publish_pending = lambda: None
    app._export_ui_data = lambda: None

    raw = json.loads(open(app.cfg.catalog_path, encoding="utf-8").read())
    raw["pending"] = [{
        "phrase": "pork chops",
        "note": "serpapi search",
        "candidates": [{
            "item_id": "999000111",
            "title": "Pork Loin Chops, Boneless, Family Pack, 6 count",
            "url": "https://www.walmart.com/ip/999000111",
            "source": "serpapi",
        }],
    }]
    open(app.cfg.catalog_path, "w", encoding="utf-8").write(json.dumps(raw))

    app.on_pick("e", {"phrase": "pork chops", "item_id": "999000111"}, {})

    cat = Catalog.load(app.cfg.catalog_path)
    assert cat.lookup_alias("pork chops") == "999000111"
    entry = cat.item("999000111")
    assert entry is not None, "the picked product was never added to the index"
    assert entry["display_name"] == "Pork Loin Chops, Boneless, Family Pack, 6 count"


def test_picking_a_known_product_leaves_its_index_entry_alone(tmp_path):
    """Never overwrite real purchase history with a search result's title."""
    import json
    from walmart_cart.catalog import Catalog
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    app.fire_event = lambda *a, **k: None
    app._publish_pending = lambda: None
    app._export_ui_data = lambda: None

    raw = json.loads(open(app.cfg.catalog_path, encoding="utf-8").read())
    known_id = next(iter(raw["index"]))
    before = dict(raw["index"][known_id])
    raw["pending"] = [{
        "phrase": "something new",
        "candidates": [{"item_id": known_id, "title": "WRONG TITLE FROM SEARCH"}],
    }]
    open(app.cfg.catalog_path, "w", encoding="utf-8").write(json.dumps(raw))

    app.on_pick("e", {"phrase": "something new", "item_id": known_id}, {})

    assert Catalog.load(app.cfg.catalog_path).item(known_id) == before


def test_pending_drops_phrases_that_now_resolve(tmp_path):
    """The sensor is the last build's leftovers and goes stale between builds.

    Two ways a pending phrase stops needing review without a build running:
    someone picks a product, and, since product names resolve, an item tapped
    in "what we buy" matches on its own. The list showed one unmatched item
    while the Admin page showed two, because Admin reads this sensor.
    """
    import json
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    raw = json.loads(open(app.cfg.catalog_path, encoding="utf-8").read())
    known_id = next(iter(raw["index"]))
    raw["aliases"]["settled phrase"] = known_id
    raw["skip_phrases"] = ["hamburger meat"]
    raw["pending"] = [
        {"phrase": "settled phrase", "candidates": []},
        {"phrase": "hamburger meat", "candidates": []},
        {"phrase": "still unknown", "candidates": []},
    ]
    open(app.cfg.catalog_path, "w", encoding="utf-8").write(json.dumps(raw))

    seen = {}
    app.set_state = lambda ent, **kw: seen.update(kw)
    app._publish_pending()

    phrases = [p["phrase"] for p in seen["attributes"]["items"]]
    assert phrases == ["still unknown"], phrases
    assert seen["state"] == "1"


def test_pending_drops_phrases_no_longer_on_the_list(tmp_path):
    """Deleting an item is another way it stops needing review.

    Nothing tells the app an item was removed, so its pending entry outlived
    the item: the list showed only "Pork chops" while Admin still offered
    "eye makeup remover towelettes" to match. pending describes list items,
    so an entry with no item behind it is noise.
    """
    import json
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    raw = json.loads(open(app.cfg.catalog_path, encoding="utf-8").read())
    raw["pending"] = [
        {"phrase": "eye makeup remover towelettes", "candidates": []},
        {"phrase": "Pork chops", "candidates": []},
    ]
    open(app.cfg.catalog_path, "w", encoding="utf-8").write(json.dumps(raw))

    app._open_phrases = lambda: ["Pork chops"]
    seen = {}
    app.set_state = lambda ent, **kw: seen.update(kw)
    app._publish_pending()

    assert [p["phrase"] for p in seen["attributes"]["items"]] == ["Pork chops"]


def test_pending_survives_a_list_that_cannot_be_read(tmp_path):
    """A broken list read must not blank the review queue.

    Showing nothing to review would look like there is nothing to do, which
    is worse than showing one entry too many.
    """
    import json
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    raw = json.loads(open(app.cfg.catalog_path, encoding="utf-8").read())
    raw["pending"] = [{"phrase": "Pork chops", "candidates": []}]
    open(app.cfg.catalog_path, "w", encoding="utf-8").write(json.dumps(raw))

    app._open_phrases = lambda: None          # could not read it
    seen = {}
    app.set_state = lambda ent, **kw: seen.update(kw)
    app._publish_pending()

    assert [p["phrase"] for p in seen["attributes"]["items"]] == ["Pork chops"]


def test_searching_one_phrase_writes_candidates_into_pending(tmp_path):
    """SerpAPI only ran during a build, so a newly added phrase had nothing.

    Adding "chicken wings" to the list offered guesses from the local catalog
    and no way to go and look. The review sheet now has a Search Walmart
    button, which needs a search that runs for one phrase on demand.
    """
    import json
    from walmart_cart.scoring import Candidate
    from walmart_cart.catalog import Catalog
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    app.cfg = replace_cfg(app.cfg, serpapi_key="k")
    app._publish_pending = lambda: None
    app._export_ui_data = lambda: None
    app.searcher = lambda q, key, store, limit: [
        Candidate(item_id="111", title="Value Pantry Chicken Wings, 4 lb",
                  source="serpapi", url="https://www.walmart.com/ip/111",
                  thumbnail="https://i5.walmartimages.com/seo/w.jpeg"),
    ]

    app.on_search("e", {"phrase": "chicken wings"}, {})

    cat = Catalog.load(app.cfg.catalog_path)
    hit = [p for p in cat.pending if p["phrase"] == "chicken wings"]
    assert hit, f"nothing pending: {[p['phrase'] for p in cat.pending]}"
    cand = hit[0]["candidates"][0]
    assert cand["item_id"] == "111"
    assert cand["thumbnail"].endswith("w.jpeg"), "the picture must survive"


def test_searching_again_replaces_rather_than_duplicates(tmp_path):
    """Pressing the button twice must not stack two sets of candidates."""
    from walmart_cart.scoring import Candidate
    from walmart_cart.catalog import Catalog
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    app.cfg = replace_cfg(app.cfg, serpapi_key="k")
    app._publish_pending = lambda: None
    app._export_ui_data = lambda: None
    app.searcher = lambda q, key, store, limit: [
        Candidate(item_id="111", title="Wings", source="serpapi"),
    ]

    app.on_search("e", {"phrase": "chicken wings"}, {})
    app.on_search("e", {"phrase": "chicken wings"}, {})

    cat = Catalog.load(app.cfg.catalog_path)
    hits = [p for p in cat.pending if p["phrase"] == "chicken wings"]
    assert len(hits) == 1, f"{len(hits)} entries for one phrase"


def test_a_search_with_no_key_says_so_rather_than_failing_silently(tmp_path):
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    app.cfg = replace_cfg(app.cfg, serpapi_key="")
    app._publish_pending = lambda: None
    app._export_ui_data = lambda: None

    app.on_search("e", {"phrase": "chicken wings"}, {})

    assert any("serpapi" in " ".join(str(x) for x in call).lower()
               for call in app.logs), app.logs


def replace_cfg(cfg, **kw):
    from dataclasses import replace
    return replace(cfg, **kw)


def test_search_marks_its_entry_as_requested(tmp_path):
    """The flag is what the panel's re-match depends on, so it is written."""
    from conftest import FIXTURES
    from walmart_cart.scoring import Candidate

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    app.cfg = replace_cfg(app.cfg, serpapi_key="k")
    app._publish_pending = lambda: None
    app._export_ui_data = lambda: None
    app.searcher = lambda *a, **k: [
        Candidate(item_id="22222", title="Real Sea Salt", category="",
                  bought=0, source="serp", url="https://www.walmart.com/ip/22222")
    ]
    app.on_search(None, {"phrase": "Sea salt"}, None)

    from walmart_cart.catalog import Catalog
    entry = [p for p in Catalog.load(app.cfg.catalog_path).pending
             if p["phrase"] == "Sea salt"][0]
    assert entry.get("requested") is True


def test_an_explicit_search_surfaces_even_when_the_phrase_is_matched(tmp_path):
    """Re-matching is the whole point of "use a different product".

    pending normally drops a phrase the moment it resolves, so Admin does not
    offer work already done. That is right for the last build's leftovers and
    wrong for a search someone just asked for: "sea salt" was matched to the
    wrong product, and Search Walmart returned candidates the panel never
    saw, because the phrase already had an alias.
    """
    import json
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    raw = json.loads(open(app.cfg.catalog_path, encoding="utf-8").read())
    raw["aliases"]["sea salt"] = "11111"          # matched, wrongly
    raw["pending"] = [{
        "phrase": "Sea salt",
        "requested": True,
        "candidates": [{"item_id": "22222", "title": "Real Sea Salt"}],
    }]
    open(app.cfg.catalog_path, "w", encoding="utf-8").write(json.dumps(raw))

    app._open_phrases = lambda: ["Sea salt"]
    seen = {}
    app.set_state = lambda ent, **kw: seen.update(kw)
    app._publish_pending()

    assert [p["phrase"] for p in seen["attributes"]["items"]] == ["Sea salt"]


def test_a_resolved_leftover_is_still_dropped(tmp_path):
    """The flag must not become a way for stale entries to linger."""
    import json
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    raw = json.loads(open(app.cfg.catalog_path, encoding="utf-8").read())
    raw["aliases"]["sea salt"] = "11111"
    raw["pending"] = [{"phrase": "Sea salt", "candidates": []}]
    open(app.cfg.catalog_path, "w", encoding="utf-8").write(json.dumps(raw))

    app._open_phrases = lambda: ["Sea salt"]
    seen = {}
    app.set_state = lambda ent, **kw: seen.update(kw)
    app._publish_pending()

    assert [p["phrase"] for p in seen["attributes"]["items"]] == []


def test_a_requested_search_still_goes_when_the_item_leaves_the_list(tmp_path):
    """Requested does not outrank "no longer on the list"."""
    import json
    from conftest import FIXTURES

    app = _bare_app(tmp_path, FIXTURES / "catalog_small.json")
    raw = json.loads(open(app.cfg.catalog_path, encoding="utf-8").read())
    raw["pending"] = [{"phrase": "Sea salt", "requested": True,
                       "candidates": []}]
    open(app.cfg.catalog_path, "w", encoding="utf-8").write(json.dumps(raw))

    app._open_phrases = lambda: []                # deleted from the list
    seen = {}
    app.set_state = lambda ent, **kw: seen.update(kw)
    app._publish_pending()

    assert [p["phrase"] for p in seen["attributes"]["items"]] == []
