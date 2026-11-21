"""Parse the ingredients of every recipe on this week's meal plan.

Mealie stores a scraped ingredient as one line of text. Its parser turns that
into a quantity, a unit and a food, which is what lets the panel's Ingredients
page add up "2 eggs" on Monday and "1 egg" on Tuesday. Mealie exposes the
parser per recipe in its own UI, which is fine for one and tedious for a
planned week.

Why this lives here rather than in the panel: the write needs a Mealie API
token, and the panel is served from /config/www, which Home Assistant serves
to anyone on the network without authentication. A token in panel.js would be
readable by anyone who can reach port 8123. The panel fires an event, a script
carries it, and the token stays in AppDaemon's secrets.yaml. That is the same
path the cart builder already uses.

Separate app from WalmartCart on purpose: a failure here must not be able to
stop the Friday cart from building.
"""

import json
import urllib.error
import urllib.request

import appdaemon.plugins.hass.hassapi as hass

EVENT_PARSE = "mealie_parse_week"
EVENT_DONE = "mealie_parse_done"

# "nlp" is Mealie's trained model. "brute" is a regex splitter that does worse
# on anything with a comma, which is most of a scraped ingredient line.
PARSER = "nlp"

# Below this, Mealie's own UI shows the row as doubtful. We still write it,
# matching what Mealie does, but the count is reported so the person who
# pressed the button knows how much to re-read.
LOW_CONFIDENCE = 0.75


def _confidence(result):
    """Mealie returns confidence as an OBJECT, not a number.

    IngredientConfidence carries average, comment, name, unit, quantity and
    food, scoring each part of the line separately. `average` is the one that
    answers "should a person re-read this". Treating the object as a float
    raised TypeError and aborted the whole recipe.
    """
    conf = (result or {}).get("confidence")
    if isinstance(conf, dict):
        value = conf.get("average")
    else:
        value = conf
    try:
        return float(value)
    except (TypeError, ValueError):
        # No score offered. Assume it is fine rather than flagging every line.
        return 1.0


class MealieParse(hass.Hass):
    def initialize(self):
        self.base = str(self.args["mealie_url"]).rstrip("/")
        self.token = self.args["mealie_token"]
        self.timeout = int(self.args.get("timeout", 30))
        self.listen_event(self.on_parse, EVENT_PARSE)
        self.log("mealie parser ready, talking to %s", self.base)

    # ---------------------------------------------------------------- http
    def _call(self, method, path, payload=None):
        url = f"{self.base}{path}"
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=self.timeout) as res:
            body = res.read()
        return json.loads(body) if body else None

    # --------------------------------------------------------------- parse
    def on_parse(self, event_name, data, kwargs):
        data = data or {}
        slugs = data.get("slugs") or []
        if isinstance(slugs, str):
            # A script passing a comma separated list is easier to write than
            # a YAML list in a service call.
            slugs = [s.strip() for s in slugs.split(",") if s.strip()]
        if not slugs:
            self.log("parse ignored, no slugs given", level="WARNING")
            self._done(0, 0, 0, "No recipes were given.")
            return

        recipes = done = changed = low = 0
        problems = []
        for slug in slugs:
            recipes += 1
            try:
                n, weak = self._parse_one(slug)
            except urllib.error.HTTPError as exc:
                problems.append(f"{slug}: HTTP {exc.code}")
                self.log("could not parse %s: HTTP %s", slug, exc.code,
                         level="WARNING")
                continue
            except Exception as exc:
                problems.append(f"{slug}: {exc}")
                self.log("could not parse %s: %s", slug, exc, level="WARNING")
                continue
            done += 1
            changed += n
            low += weak

        note = "; ".join(problems) if problems else ""
        self.log("parsed %d/%d recipes, %d ingredients, %d low confidence",
                 done, recipes, changed, low)
        self._done(done, changed, low, note)

    def _ensure(self, kind, obj, cache):
        """Returns an object Mealie will accept, creating it if it is new.

        The parser invents foods and units that do not exist yet: "olive oil"
        comes back with an id because it was seeded, but "lean ground beef"
        comes back with id=None. Writing one of those is what Mealie rejects
        with an opaque 500 ValueError, and it fails the WHOLE recipe, not just
        that line. Mealie's own interface solves this by offering to create
        the missing ones, which is what this does.
        """
        if not isinstance(obj, dict):
            return None
        if obj.get("id"):
            return obj
        name = (obj.get("name") or "").strip()
        if not name:
            return None
        key = name.lower()
        if key in cache:
            return cache[key]
        try:
            created = self._call("POST", f"/api/{kind}", {"name": name})
            cache[key] = created
            self.log("created %s: %s", kind[:-1], name)
            return created
        except Exception as exc:
            # Keep the quantity and unit rather than losing the whole recipe.
            self.log("could not create %s %r: %s", kind[:-1], name, exc,
                     level="WARNING")
            cache[key] = None
            return None

    def _parse_one(self, slug):
        recipe = self._call("GET", f"/api/recipes/{slug}")
        items = recipe.get("recipeIngredient") or []
        # The text to parse is the note, which is where a scraped line lands.
        lines = [(i.get("note") or i.get("display") or "").strip() for i in items]
        if not any(lines):
            return 0, 0

        parsed = self._call("POST", "/api/parser/ingredients",
                            {"parser": PARSER, "ingredients": lines})

        changed = low = 0
        foods, units = {}, {}
        for item, result in zip(items, parsed or []):
            ing = (result or {}).get("ingredient") or {}
            # Only ever ADD structure. referenceId and the original note are
            # left alone so nothing a person typed is lost.
            food = self._ensure("foods", ing.get("food"), foods)
            unit = self._ensure("units", ing.get("unit"), units)
            qty = ing.get("quantity")
            if food is None and unit is None and not qty:
                continue
            if food is not None:
                item["food"] = food
            if unit is not None:
                item["unit"] = unit
            if qty is not None:
                item["quantity"] = qty
            changed += 1
            if _confidence(result) < LOW_CONFIDENCE:
                low += 1

        if changed:
            self._call("PATCH", f"/api/recipes/{slug}",
                       {"recipeIngredient": items})
        return changed, low

    def _done(self, recipes, ingredients, low, note):
        """Report through a sensor as well as an event.

        The panel reloads on a timer after pressing the button, so it reads
        the sensor rather than having to catch the event at the right moment.
        """
        try:
            self.set_state(
                "sensor.mealie_parse_result",
                state=str(ingredients),
                attributes={
                    "friendly_name": "Mealie last parse",
                    "recipes": recipes,
                    "ingredients": ingredients,
                    "low_confidence": low,
                    "problem": note,
                },
            )
        except Exception as exc:
            self.log("could not publish parse result: %s", exc, level="WARNING")
        try:
            self.fire_event(EVENT_DONE, recipes=recipes,
                            ingredients=ingredients, low_confidence=low)
        except Exception as exc:
            self.log("could not fire %s: %s", EVENT_DONE, exc, level="WARNING")
