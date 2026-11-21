"""Home Assistant config is config, but a few things in it are load-bearing.

This file used to guard the Lovelace review view, where the rule was that
Lovelace does not render Jinja in a tap_action's service data, so a templated
phrase arrived as literal text and wrote a junk alias on every press. That
view is retired: the panel passes real values, so the workaround and the rule
it needed both went with it.

What is pinned now is the arrangement that replaced it.
"""

import pathlib
import yaml

HA = pathlib.Path(__file__).parent.parent / "ha"


def _scripts():
    return yaml.safe_load((HA / "scripts.yaml").read_text(encoding="utf-8"))


def test_the_panel_scripts_exist_and_fire_the_right_events():
    """The panel reaches the app only through these three.

    Home Assistant guards POST /api/events with @require_admin and the kitchen
    tablet is deliberately not an admin, so a missing script here is not a
    cosmetic failure: every pick, skip and Build cart stops working, with the
    panel reporting "That did not save. Please try again."
    """
    scripts = _scripts()
    expected = {
        "walmart_panel_pick": "walmart_pick_candidate",
        "walmart_panel_skip": "walmart_skip_phrase",
        "walmart_panel_build": "walmart_build_cart",
    }
    for name, event in expected.items():
        assert name in scripts, f"missing script.{name}"
        fired = [step.get("event") for step in scripts[name]["sequence"]
                 if isinstance(step, dict) and "event" in step]
        assert fired == [event], f"{name} fires {fired}, expected [{event}]"


def test_the_build_script_passes_real_booleans_not_templates():
    """A template renders to the STRING "False", and bool("False") is True.

    The app does bool(data.get("dry_run")), so a templated value would turn a
    real build into a silent dry run: the button would appear to work and
    cart nothing.
    """
    build = _scripts()["walmart_panel_build"]
    data = build["sequence"][0]["event_data"]
    assert data["dry_run"] is False, f"dry_run is {data['dry_run']!r}"
    assert data["announce"] is True, f"announce is {data['announce']!r}"


def test_the_pick_script_guards_against_an_empty_item_id():
    """An alias to an empty item id resolves to nothing, forever.

    Worse, it still reads as a match on the list, so the row looks handled
    and carts nothing.
    """
    seq = _scripts()["walmart_panel_pick"]["sequence"]
    guards = [s for s in seq if isinstance(s, dict) and s.get("condition")]
    assert guards, "walmart_panel_pick fires with no guard at all"
    assert any("item_id" in str(g.get("value_template", "")) for g in guards)


def test_nothing_depends_on_the_retired_pick_helper():
    """input_text.walmart_pick was a Lovelace crutch and is gone.

    A Lovelace button cannot pass a templated value, so the only way to fix a
    phrase that was not the FIRST pending one was to type "phrase|item_id"
    into a text helper. The panel passes whatever it likes, so the helper was
    removed from configuration.yaml; a script still reading it would now read
    an entity that does not exist.
    """
    body = yaml.dump(_scripts())
    assert "input_text.walmart_pick" not in body


def test_the_lovelace_dashboard_is_really_gone():
    """Parity was reached, so the dashboard and its card were retired.

    Leaving the files behind invites someone to wire them up again, and the
    card's custom element is no longer registered anywhere.
    """
    for name in ("kitchen.yaml", "lovelace_review.yaml", "lovelace_catalog.yaml"):
        assert not (HA / name).exists(), f"{name} should have been removed"
    assert not (HA / "www" / "walmart-catalog-card.js").exists()


def test_the_panel_points_at_a_versioned_directory():
    """/local/ is served with a 31 day cache and no revalidation.

    panel.js imports its siblings relatively, so only a new DIRECTORY busts
    the whole module graph. An unversioned module_url means an edit silently
    never reaches the tablet.
    """
    panel = yaml.safe_load((HA / "panel_custom.yaml").read_text(encoding="utf-8"))
    url = panel["panel_custom"][0]["module_url"]
    assert url.startswith("/local/kitchen/v"), url
    assert url.endswith("/panel.js"), url
