"""Rotate the kitchen tablet's screensaver picture.

Fully Kiosk's screensaver renders ONE image from `screensaverWallpaperURL`.
It does not render a web page, which is why a slideshow HTML file showed as
a black screen. The Fire tablet got variety from Unsplash's random endpoint
plus a `${timestamp}` cache buster, and that endpoint is now retired (503).

So the variety has to come from the other end: the URL stays fixed and the
PICTURE behind it changes. This copies a different Mealie recipe image to
`/config/www/kitchen/current.webp` every few minutes, and Fully's
`?sig=${timestamp}` stops the browser serving a cached copy.

Why Mealie's own photos rather than stock food images: they are already on
this box, they are food this household actually cooks, and there is no
external service to quietly die the way Unsplash did.
"""

import json
import os
import random
import shutil
import tempfile
import urllib.request

import appdaemon.plugins.hass.hassapi as hass

# Where Home Assistant serves /local from, and the file Fully points at.
TARGET = "/homeassistant/www/kitchen/current.webp"
LIST_FILE = "/homeassistant/www/kitchen/food.json"

# Comfortably shorter than the four minutes a picture is meant to hold, so a
# screensaver session that outlasts one interval still changes picture.
ROTATE_SECONDS = 180


class FoodScreensaver(hass.Hass):
    def initialize(self):
        self.images = []
        self.last = None
        self.run_every(self.rotate, "now", ROTATE_SECONDS)
        # Refresh the recipe list hourly so newly imported recipes appear
        # without anyone regenerating anything.
        self.run_every(self.reload_list, "now+30", 3600)
        self.log("food screensaver ready, writing to %s", TARGET)

    # ------------------------------------------------------------- the list
    def reload_list(self, kwargs=None):
        """Read the picture list from food.json beside the served images.

        A plain file rather than Mealie's API: AppDaemon's call_service did
        not hand back the recipe payload, and a file needs no token, no
        config entry id and no network. Regenerating that one file is the
        only thing needed to change the pictures.
        """
        try:
            with open(LIST_FILE, encoding="utf-8") as fh:
                urls = [u for u in json.load(fh) if isinstance(u, str) and u]
            if urls:
                self.images = urls
                self.log("screensaver has %d pictures", len(urls))
            else:
                self.log("%s is empty", LIST_FILE, level="WARNING")
        except Exception as exc:
            # Keep whatever list we already have; a failed refresh must not
            # blank the screensaver.
            self.log("could not read %s: %s", LIST_FILE, exc, level="WARNING")

    # ------------------------------------------------------------ the swap
    def rotate(self, kwargs=None):
        if not self.images:
            self.reload_list()
            if not self.images:
                return
        # Avoid repeating the picture that is already up, when there is a
        # choice. With one picture there is nothing to avoid.
        pool = [u for u in self.images if u != self.last] or self.images
        url = random.choice(pool)
        try:
            with urllib.request.urlopen(url, timeout=20) as res:
                data = res.read()
            if not data:
                return
            # Written to a temp file and moved into place, so Fully can never
            # fetch a half written image and show a torn picture.
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(TARGET),
                                       suffix=".tmp")
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            os.chmod(tmp, 0o644)
            shutil.move(tmp, TARGET)
            self.last = url
        except Exception as exc:
            self.log("could not fetch %s: %s", url, exc, level="WARNING")
