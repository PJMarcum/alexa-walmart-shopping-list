import pytest
from walmart_cart.notifier import compose, compose_failure, compose_nothing_to_build

URL = "https://affil.walmart.com/cart/buynow?items=1,2"


def test_happy_path_names_counts_and_carries_the_url():
    out = compose(URL, resolved=["a", "b"], pending=[], unresolved=[])
    assert "2" in out["message"]
    assert out["data"]["url"] == URL


def test_no_em_or_en_dashes_anywhere_in_user_facing_copy():
    # Global constraint.
    out = compose(URL, resolved=["a"], pending=["b"], unresolved=["c"], strays=2)
    blob = out["title"] + out["message"]
    assert "—" not in blob
    assert "–" not in blob


def test_mentions_pending_items():
    out = compose(URL, resolved=["a"], pending=["rye bread"], unresolved=[])
    assert "1" in out["message"]
    assert "review" in out["message"].lower()


def test_mentions_unresolved_items_by_name():
    out = compose(URL, resolved=["a"], pending=[], unresolved=["pickles"])
    assert "pickles" in out["message"]


def test_mentions_strays_on_the_other_list():
    out = compose(URL, resolved=["a"], pending=[], unresolved=[], strays=3)
    assert "3" in out["message"]
    assert "Shopping List" in out["message"]


def test_includes_both_deep_link_actions():
    out = compose(URL, resolved=["a"], pending=["b"], unresolved=[])
    actions = {a["action"] for a in out["data"]["actions"]}
    assert "OPEN_CART" in actions
    assert "REVIEW_MATCHES" in actions


def test_nothing_to_build_has_no_cart_url():
    # Review Focus 5.
    out = compose_nothing_to_build()
    assert "url" not in out["data"]
    assert "nothing" in out["message"].lower()


def test_failure_message_states_the_reason_and_changes_nothing():
    out = compose_failure("could not read the Alexa list")
    assert "could not read the Alexa list" in out["message"]
    assert "url" not in out["data"]


def test_title_does_not_claim_ready_when_there_is_no_cart():
    # Found in live dry-run testing: with everything pending, the push read
    # "Walmart cart ready. 0 in the cart." which tells the reader a cart is
    # waiting when none exists.
    out = compose(None, resolved=[], pending=["milk", "pickles"], unresolved=[])
    assert "ready" not in out["title"].lower()
    assert "review" in out["message"].lower()


def test_title_still_says_ready_when_something_is_in_the_cart():
    out = compose(URL, resolved=["80000001"], pending=["milk"], unresolved=[])
    assert out["title"] == "Walmart cart ready"


def test_announcement_is_short_and_speakable():
    from walmart_cart.notifier import compose_announcement

    said = compose_announcement(7, pending=1, unresolved=0)
    assert "7" in said
    assert len(said) < 140, "an Echo announcement should be one breath"
    # No URL: an Echo cannot read a link usefully.
    assert "http" not in said


def test_announcement_mentions_review_only_when_something_is_pending():
    from walmart_cart.notifier import compose_announcement

    assert "review" in compose_announcement(5, pending=2, unresolved=0).lower()
    assert "review" not in compose_announcement(5, pending=0, unresolved=0).lower()


def test_announcement_when_nothing_was_carted_does_not_claim_a_cart():
    from walmart_cart.notifier import compose_announcement

    said = compose_announcement(0, pending=3, unresolved=0)
    assert "ready" not in said.lower()
    assert "3" in said


def test_announcement_has_no_em_or_en_dashes():
    from walmart_cart.notifier import compose_announcement

    said = compose_announcement(4, pending=1, unresolved=1)
    assert "\u2014" not in said and "\u2013" not in said


URL110 = "https://affil.walmart.com/cart/buynow?items=80000017,800000016,80000018,80000019,8000000013,800000014,80000002"


def test_sms_puts_the_link_in_the_body():
    from walmart_cart.notifier import compose_sms

    said = compose_sms(URL110, carted=7, pending=0, unresolved=0)
    # SMS has no tap action, so the URL has to be text in the message.
    assert URL110 in said
    assert "7" in said


def test_sms_prose_overhead_stays_minimal():
    from walmart_cart.notifier import compose_sms

    # A full 40-item cart URL is ~400 characters, so multi-segment SMS is
    # accepted by decision: the link is the payload and truncating it would
    # be worse than paying for 3 segments. What this pins is that the PROSE
    # stays tiny, so a small cart still fits one segment and a large one
    # never costs an extra segment for wording.
    said = compose_sms(URL110, carted=7, pending=2, unresolved=3)
    assert len(said) - len(URL110) <= 35, f"prose is {len(said) - len(URL110)} chars"
    assert len(said) <= 160, "a 7-item cart should still be a single segment"


def test_sms_with_nothing_carted_sends_no_link():
    from walmart_cart.notifier import compose_sms

    said = compose_sms(None, carted=0, pending=2, unresolved=0)
    assert "http" not in said
    assert "2" in said


def test_sms_when_there_is_nothing_at_all_is_still_a_sentence():
    from walmart_cart.notifier import compose_sms

    said = compose_sms(None, carted=0, pending=0, unresolved=0)
    assert said
    assert "http" not in said


def test_sms_has_no_em_or_en_dashes():
    from walmart_cart.notifier import compose_sms

    said = compose_sms(URL110, carted=3, pending=1, unresolved=0)
    assert "\u2014" not in said and "\u2013" not in said


def test_sms_is_plain_ascii_so_no_carrier_mangles_it():
    from walmart_cart.notifier import compose_sms

    said = compose_sms(URL110, carted=3, pending=1, unresolved=0)
    said.encode("ascii")  # raises if not


def test_review_action_points_at_the_panel_not_a_dead_lovelace_view():
    """The tap target has to be a path that exists.

    REVIEW_PATH shipped as "/lovelace/walmart", a view that exists in no
    dashboard on the box: the Overview dashboard holds only default_view,
    location_info and master-bedroom, and nothing anywhere mentions walmart.
    Every "Review matches" button therefore opened a blank view, which is
    the one notification the household gets on build day. Review lives in
    the custom panel now, so the only correct target is its url_path.
    """
    from walmart_cart.notifier import REVIEW_PATH, compose

    assert REVIEW_PATH == "/kitchen"

    payload = compose(None, resolved=[], pending=["pork chops"], unresolved=[])
    actions = payload["data"]["actions"]
    # Selected by name, not position: OPEN_CART comes first, so indexing
    # into the list pins the order rather than the behaviour.
    review = next(a for a in actions if a["action"] == "REVIEW_MATCHES")
    assert review["uri"] == "/kitchen"
    assert "lovelace" not in review["uri"]
