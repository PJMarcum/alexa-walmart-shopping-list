"""Shared, server-side state for the kitchen panel.

Right now that is one thing: which of this week's ingredients the household
already has, ticked off during a review before shopping.

Why this is not browser storage. The kitchen tablet signs in as its own Home
Assistant account and everyone else uses their own, so localStorage,
sessionStorage and Home Assistant's per-user frontend storage would all give
each of them a private copy. One person would tick things off in the kitchen
and the next would see an untouched list. The point of the review is that it is shared.

The ticks are keyed to a WEEK. A tick means "we already have this, for the
meals planned this week", and carrying it into next week would quietly
suppress an ingredient that is genuinely needed again, which surfaces as a
missing item on a Tuesday rather than as an obvious bug.
"""

import appdaemon.plugins.hass.hassapi as hass

EVENT_TOGGLE = "kitchen_ingredient_toggle"
EVENT_CLEAR = "kitchen_ingredients_clear"
EVENT_SET = "kitchen_ingredients_set"
SENSOR = "sensor.kitchen_ingredients_checked"


class KitchenState(hass.Hass):
    def initialize(self):
        self.week = ""
        self.checked = set()
        self.listen_event(self.on_toggle, EVENT_TOGGLE)
        self.listen_event(self.on_clear, EVENT_CLEAR)
        self.listen_event(self.on_set, EVENT_SET)
        self._restore()
        self._publish()
        self.log("kitchen state ready, %d ticked for week %s",
                 len(self.checked), self.week or "(none)")

    def _restore(self):
        """Survive an AppDaemon restart by reading back the sensor.

        The state lives in Home Assistant, so a restart of this app does not
        have to lose a review someone is part way through.
        """
        try:
            state = self.get_state(SENSOR, attribute="all") or {}
            attrs = state.get("attributes") or {}
            self.week = str(attrs.get("week") or "")
            self.checked = {str(x) for x in (attrs.get("checked") or [])}
        except Exception as exc:
            self.log("could not restore ticks: %s", exc, level="WARNING")

    def on_toggle(self, event_name, data, kwargs):
        data = data or {}
        key = str(data.get("key") or "").strip()
        week = str(data.get("week") or "").strip()
        if not key or not week:
            self.log("toggle ignored, missing key or week", level="WARNING")
            return
        # A new week starts with nothing ticked. Checked twice, because the
        # panel may be open across midnight on a Sunday.
        if week != self.week:
            self.week = week
            self.checked = set()
        if key in self.checked:
            self.checked.discard(key)
        else:
            self.checked.add(key)
        self._publish()

    def on_set(self, event_name, data, kwargs):
        """Replace the whole set: check all, or uncheck all.

        The panel sends the keys it wants ticked rather than a command, so
        "check all" cannot drift out of step with what is actually on screen:
        an ingredient the panel does not know about cannot end up ticked.
        """
        data = data or {}
        week = str(data.get("week") or "").strip()
        if not week:
            self.log("set ignored, no week given", level="WARNING")
            return
        keys = data.get("keys") or ""
        if isinstance(keys, str):
            keys = [k.strip() for k in keys.splitlines() if k.strip()]
        self.week = week
        self.checked = {str(k) for k in keys}
        self._publish()
        self.log("%d ticked for week %s", len(self.checked), week)

    def on_clear(self, event_name, data, kwargs):
        self.checked = set()
        self._publish()
        self.log("ticks cleared")

    def _publish(self):
        try:
            self.set_state(
                SENSOR,
                # A string, not an int: AppDaemon drops a falsy state, so an
                # integer 0 posts no state at all and Home Assistant answers
                # 400. Same reason as sensor.walmart_pending.
                state=str(len(self.checked)),
                attributes={
                    "friendly_name": "Kitchen ingredients ticked",
                    "week": self.week,
                    "checked": sorted(self.checked),
                },
            )
        except Exception as exc:
            self.log("could not publish ticks: %s", exc, level="WARNING")
