"""AppDaemon wiring. No logic lives here.

Deliberately thin: it adapts AppDaemon's API to the plain client interface
that walmart_cart.ha_list expects, and forwards events. Everything testable
lives in the walmart_cart package, which imports nothing from AppDaemon.
"""

from dataclasses import replace

import appdaemon.plugins.hass.hassapi as hass

from walmart_cart.build import Config, build_cart
from walmart_cart import ha_list, serp
from walmart_cart.catalog import Catalog
from walmart_cart.notifier import compose_announcement, compose_sms
from walmart_cart.ui_export import write_payload

EVENT_BUILD = "walmart_build_cart"


def _without(pending, phrase):
    """pending minus the entry for this phrase, compared normalised.

    An exact string compare misses an entry recorded as "Eye makeup remover
    towelettes" when the panel sends back a differently capitalised copy of
    the same row, which left the matched item sitting on the Admin page.
    """
    from walmart_cart.normalize import normalize

    key = normalize(phrase)
    return [p for p in pending if normalize(p.get("phrase", "")) != key]
EVENT_PICK = "walmart_pick_candidate"
EVENT_SKIP = "walmart_skip_phrase"
EVENT_SEARCH = "walmart_search_phrase"

RELOAD_SETTLE_SECONDS = 12


class AdClient:
    """Adapts AppDaemon's service API to the interface ha_list expects."""

    def __init__(self, app):
        self.app = app

    def get_states(self):
        """Return the todo entities with their attributes.

        AppDaemon does NOT support get_state(attribute="all") without an
        entity; it raises "Querying a specific attribute is only possible for
        a single entity". The supported shapes are a domain query returning
        {entity_id: state_string}, and a per-entity query with
        attribute="all".

        Only the todo domain is fetched, because that is all ha_list filters
        on, and it is a handful of entities rather than the whole instance.
        """
        ids = self.app.get_state("todo") or {}
        out = []
        for entity_id in ids:
            # None comes back for an entity that went unavailable mid-read.
            full = self.app.get_state(entity_id, attribute="all")
            if not full:
                continue
            out.append(
                {
                    "entity_id": entity_id,
                    "attributes": full.get("attributes") or {},
                }
            )
        return out

    def call_service(self, domain, service, data, return_response=False):
        return self.app.call_service(
            f"{domain}/{service}", return_response=return_response, **data
        )

    def reload_config_entry(self, entity_id):
        # Any Alexa-backed entity reloads the whole config entry, which is
        # what makes a newly created Alexa list appear.
        target = entity_id or self.app.args.get(
            "reload_anchor_entity", "todo.you_example_com_grocery"
        )
        self.app.call_service("homeassistant/reload_config_entry", entity_id=target)
        self.app.sleep(RELOAD_SETTLE_SECONDS)


class WalmartCart(hass.Hass):
    def initialize(self):
        self.cfg = Config(
            catalog_path=self.args["catalog_path"],
            run_dir=self.args["run_dir"],
            store_id=str(self.args.get("store_id", "1234")),
            serpapi_key=self.args.get("serpapi_key"),
        )
        # One or many phones. A list so a household member being unreachable
        # cannot cost everyone else the notification.
        targets = self.args.get(
            "notify_targets",
            self.args.get("notify_target", "notify/mobile_app_your_phone"),
        )
        self.notify_targets = targets
        # Echoes that announce the cart is ready. The announcement carries no
        # link, so its only job is to send someone to their phone. Empty
        # disables it.
        self.announce_targets = self.args.get("announce_targets", []) or []
        # SMS is its own channel, not another notify_target: an SMS notify platform takes
        # recipients as 'target' at call time, supports no title, and needs
        # the cart URL inside the message body because an SMS has no tap
        # action. Empty recipients disables it.
        # A SCRIPT, not the notify service directly. AppDaemon reserves the
        # kwarg 'target' and hoists it out of service_data into the websocket
        # envelope, where HA expects a mapping of entity_id/device_id/area_id.
        # A legacy notify platform wants 'target' INSIDE service_data as an
        # ordinary parameter, so the two meanings collide and the call is
        # rejected with "invalid_format: expected a mapping at 'target'".
        # The script takes 'recipients', a name AppDaemon has no opinion
        # about, and maps it onto the notify target where it belongs.
        self.sms_service = self.args.get("sms_service", "script/walmart_send_sms")
        self.sms_recipients = self.args.get("sms_recipients", []) or []
        # Where the catalog card fetches its data. HA serves /config/www at
        # /local, so this path becomes /local/walmart/catalog.json.
        self.ui_data_path = self.args.get(
            "ui_data_path", "/config/www/walmart/catalog.json"
        )
        # The board starts curated: only products with a hand-mapped phrase.
        self.ui_aliased_only = bool(self.args.get("ui_aliased_only", True))
        self.client = AdClient(self)
        self.listen_event(self.on_build, EVENT_BUILD)
        self.listen_event(self.on_pick, EVENT_PICK)
        self.listen_event(self.on_skip, EVENT_SKIP)
        self.listen_event(self.on_search, EVENT_SEARCH)
        self._publish_pending()
        self._export_ui_data()
        self.log("walmart_cart ready; listening for %s", EVENT_BUILD)

    def on_build(self, event_name, data, kwargs):
        # listen_event can hand through None rather than a mapping, and a
        # null payload must not become an AttributeError that loses the whole
        # build.
        data = data or {}
        # A per-event copy, never self.cfg: AppDaemon dispatches callbacks on
        # a worker pool, so a real build arriving while a dry run was still
        # in flight would otherwise flip the dry run to dry_run=False and let
        # it consume the Alexa list.
        cfg = replace(self.cfg, dry_run=bool(data.get("dry_run", False)))
        result = build_cart(self.client, cfg)
        self.log("build finished: %s", result["status"])

        # Push before publishing pending state. _publish_pending re-reads the
        # catalog, so on a corrupt catalog it raises, and doing it first would
        # swallow the very failure notification that explains why.
        if not cfg.dry_run:
            self._push(result["notification"])
            # The Echoes are the only channel that can wake a sleeping house,
            # so a trigger can silence them without silencing the phone. The
            # Friday 07:00 automation passes announce: false; an on-demand
            # run says nothing and therefore still speaks, because someone
            # who asked for a build wants to hear the answer.
            if data.get("announce", True):
                self._announce(result.get("counts") or {})
            self._sms(result.get("cart_url"), result.get("counts") or {})
        self._publish_pending()
        self._export_ui_data()

    def on_pick(self, event_name, data, kwargs):
        phrase, item_id = data.get("phrase"), data.get("item_id")
        if not phrase or not item_id:
            self.log("pick ignored, missing phrase or item_id", level="WARNING")
            return
        catalog = Catalog.load(self.cfg.catalog_path)
        item_id = str(item_id)

        # Adopt a searched product into the index before writing the alias.
        #
        # The index is purchase history, so a SerpAPI candidate is not in it.
        # Without this the alias points at a SKU nothing knows the name of:
        # the row keeps reading "no match yet" after a successful pick, and
        # the product never appears in "what we buy". That is every item the
        # household has not bought before, which is exactly when someone is
        # standing at the tablet reviewing.
        #
        # Only ever ADDS. A known SKU keeps its real purchase history rather
        # than being overwritten with a search result's title.
        if catalog.item(item_id) is None:
            picked = self._candidate(catalog, phrase, item_id)
            if picked:
                catalog.index[item_id] = {
                    "item_id": item_id,
                    "display_name": picked.get("title") or "",
                    "category": picked.get("category") or "",
                    "product_page_url": picked.get("url")
                    or f"https://www.walmart.com/ip/{item_id}",
                    "thumbnail": picked.get("thumbnail"),
                    "bought_count": None,
                    "source": "picked",
                }
                self.log("index entry added for %s", item_id)

        catalog.add_alias(phrase, item_id)
        catalog.pending = _without(catalog.pending, phrase)
        catalog.save(self.cfg.catalog_path)
        self.log("alias added: %s -> %s", phrase, item_id)
        self._publish_pending()
        self._export_ui_data()
        # Deliberately no build. A pick used to fire one, so a single tap
        # carted everything matched, cleared it off the list, and sent an SMS
        # and an Echo announcement. Two matches late at night meant two
        # announcements in a sleeping house. Building belongs to the Build
        # cart button, which asks for a second tap first.

    @staticmethod
    def _candidate(catalog, phrase, item_id):
        """The pending candidate a pick refers to, if it is still there."""
        from walmart_cart.normalize import normalize

        key = normalize(phrase)
        for entry in catalog.pending:
            if normalize(entry.get("phrase", "")) != key:
                continue
            for cand in entry.get("candidates") or []:
                if str(cand.get("item_id")) == item_id:
                    return cand
        return None

    def on_search(self, event_name, data, kwargs):
        """Look one phrase up at Walmart, now, rather than at the next build.

        SerpAPI only ran during a build, so a phrase added afterwards had
        nothing to offer but guesses from the local catalog. "Chicken wings"
        is the case that showed it: the household has never bought them, so
        the catalog had nothing like it and there was no way to go and look.

        The result is written into pending, which is where the panel's review
        sheet already reads its candidates from. Nothing new to display.
        """
        data = data or {}
        phrase = (data.get("phrase") or "").strip()
        if not phrase:
            self.log("search ignored, no phrase", level="WARNING")
            return
        if not self.cfg.serpapi_key:
            self.log("cannot search for %r: no serpapi key configured",
                     phrase, level="WARNING")
            return

        searcher = getattr(self, "searcher", None) or serp.search
        try:
            found = searcher(phrase, self.cfg.serpapi_key, self.cfg.store_id,
                             self.cfg.candidate_limit)
        except Exception as exc:
            self.log("search failed for %r: %s", phrase, exc, level="WARNING")
            return

        catalog = Catalog.load(self.cfg.catalog_path)
        # Replace rather than append: pressing the button twice must not stack
        # two sets of candidates for the same phrase.
        catalog.pending = _without(catalog.pending, phrase)
        catalog.pending.append({
            "phrase": phrase,
            "note": "searched from the panel",
            # Someone asked for this search, just now. _publish_pending drops
            # a phrase the moment it resolves, which is right for the last
            # build's leftovers and wrong here: correcting a BAD match means
            # searching a phrase that already has an alias, and without this
            # flag the candidates are filtered out and the panel shows
            # nothing. "Sea salt", matched wrongly, then unfixable.
            "requested": True,
            "candidates": [
                {
                    "item_id": c.item_id,
                    "title": c.title,
                    "category": c.category,
                    "bought": c.bought,
                    "source": c.source,
                    "url": c.url,
                    "thumbnail": c.thumbnail,
                }
                for c in (found or [])
            ],
        })
        catalog.save(self.cfg.catalog_path)
        self.log("searched %r, %d candidate(s)", phrase, len(found or []))
        self._publish_pending()
        self._export_ui_data()

    def on_skip(self, event_name, data, kwargs):
        phrase = data.get("phrase")
        if not phrase:
            self.log("skip ignored, missing phrase", level="WARNING")
            return
        catalog = Catalog.load(self.cfg.catalog_path)
        catalog.add_skip(phrase)
        catalog.pending = _without(catalog.pending, phrase)
        catalog.save(self.cfg.catalog_path)
        self.log("phrase skipped: %s", phrase)
        self._publish_pending()
        self._export_ui_data()

    def _push(self, note):
        """Send to every configured phone, independently.

        Each target is attempted on its own: one phone being off or its token
        stale must not mean nobody hears about the cart.
        """
        targets = self.notify_targets
        if isinstance(targets, str):
            targets = [targets]
        for target in targets:
            try:
                self.call_service(
                    target,
                    title=note["title"],
                    message=note["message"],
                    data=note["data"],
                )
            except Exception as exc:
                self.log("could not notify %s: %s", target, exc, level="WARNING")

    def _announce(self, counts):
        """Speak one line on each configured Echo. Best effort.

        Deliberately separate from the push rather than derived from it: the
        push carries a URL and an Echo cannot read a link usefully, so the
        spoken text is composed for speech instead of reused.
        """
        if not self.announce_targets:
            return
        said = compose_announcement(
            counts.get("items_carted", 0),
            counts.get("pending", 0),
            counts.get("unresolved", 0),
        )
        for target in self.announce_targets:
            try:
                # These are notify ENTITIES, not notify services. Calling
                # notify/<name> fails with "does not contain service <name>";
                # HA's newer notify platform wants send_message plus an
                # entity_id. The mobile_app_* push targets are still real
                # services, which is why those two paths differ.
                self.call_service(
                    "notify/send_message", entity_id=target, message=said
                )
            except Exception as exc:
                self.log("could not announce on %s: %s", target, exc, level="WARNING")

    def _sms(self, cart_url, counts):
        """One SMS to every recipient. Best effort, like the other channels.

        A full 40-item cart URL runs to roughly 400 characters, so this is
        knowingly a multi-segment message. That was chosen over shortening or
        omitting the link: the link is the entire payload, and a truncated one
        would be a broken message that looked delivered.
        """
        if not self.sms_recipients:
            return
        said = compose_sms(
            cart_url,
            counts.get("items_carted", 0),
            counts.get("pending", 0),
            counts.get("unresolved", 0),
        )
        try:
            # 'recipients', never 'target'. See the note in initialize().
            self.call_service(
                self.sms_service, message=said,
                recipients=list(self.sms_recipients),
            )
        except Exception as exc:
            self.log("could not send SMS: %s", exc, level="WARNING")

    def _export_ui_data(self):
        """Regenerate the catalog card's static JSON.

        Best effort, like _publish_pending: the card is a convenience and must
        never be the reason an alias write or a notification is lost.
        """
        try:
            write_payload(
                self.cfg.catalog_path,
                self.ui_data_path,
                aliased_only=self.ui_aliased_only,
            )
        except Exception as exc:
            self.log("could not export catalog UI data: %s", exc, level="WARNING")

    def _open_phrases(self):
        """Phrases currently on the Walmart list, or None if unreadable.

        None rather than an empty list on failure, and the caller skips the
        list filter entirely when it sees None. An empty list would read as
        "nothing is on the list", emptying the review queue and making it
        look like there is nothing to do.
        """
        try:
            entity = ha_list.find_list_entity(
                self.client.get_states(), self.cfg.list_name_suffix
            )
            return ha_list.read_open_items(self.client, entity)
        except Exception as exc:
            self.log("could not read the list for pending: %s", exc,
                     level="WARNING")
            return None

    def _publish_pending(self):
        # Best effort. This is a display convenience, and it must never be
        # the reason a notification or an alias write is lost.
        try:
            catalog = Catalog.load(self.cfg.catalog_path)
            # pending is the LAST BUILD's leftovers and goes stale between
            # builds. A phrase stops needing review the moment it resolves,
            # whether someone picked a product or the phrase is a product
            # name that now matches on its own. Reporting those anyway made
            # Admin show two items while the list showed one.
            # An entry survives only if it still describes something the
            # household is waiting on: still on the list, still unresolved,
            # not deliberately skipped.
            from walmart_cart.normalize import normalize

            open_now = self._open_phrases()
            on_list = (
                None if open_now is None else {normalize(p) for p in open_now}
            )
            live = [
                entry
                for entry in catalog.pending
                if (
                    entry.get("requested")
                    or (
                        not catalog.lookup_alias(entry.get("phrase", ""))
                        and not catalog.is_skipped(entry.get("phrase", ""))
                    )
                )
                and (
                    on_list is None
                    or normalize(entry.get("phrase", "")) in on_list
                )
            ]
            self.set_state(
                "sensor.walmart_pending",
                # A string, not an int: AppDaemon drops a falsy state, so an
                # integer 0 posted no state field at all and HA answered 400.
                state=str(len(live)),
                attributes={
                    "friendly_name": "Walmart pending matches",
                    "items": live,
                },
            )
        except Exception as exc:
            self.log("could not publish pending state: %s", exc, level="WARNING")
