"""Catalog persistence.

The catalog is the only durable state in the system and the only thing here
that cannot be rebuilt from an external source: the index came from a scrape,
but the aliases are months of accumulated corrections. Loading therefore
refuses to improvise. A missing or malformed file aborts the run rather than
yielding an empty catalog that the next save would write over the real one.
"""

import json
import os
import pathlib
import tempfile
import threading

from .normalize import normalize

REQUIRED_KEYS = ("store_id", "index", "aliases", "skip_phrases")

# AppDaemon dispatches callbacks on a worker pool, and on_pick deliberately
# fires a build, so a pick and a build are designed to overlap. save() is a
# read-modify-write, and this serializes it within the process.
_SAVE_LOCK = threading.Lock()


class CatalogError(Exception):
    pass


class Catalog:
    def __init__(self, raw: dict):
        self._raw = raw
        self.store_id = str(raw["store_id"])
        self.index = raw["index"]
        # Normalized on load, not just on add_alias: the catalog is
        # hand-editable, and an alias written as "Doctor Fizz" must match the
        # normalized phrase "dr fizz". Without this a hand-written alias
        # silently never fires, which looks like the alias feature is broken.
        self.aliases = {normalize(k): str(v) for k, v in raw["aliases"].items()}
        self.pending = list(raw.get("pending", []))
        self.skip_phrases = {normalize(p) for p in raw["skip_phrases"]}
        # Product names resolve too, because the catalog card adds the
        # PRODUCT NAME to the list when you tap a tile, not the phrase the
        # alias is keyed on. Nine items tapped from the grid came back "no
        # match yet" and would have carted nothing. Built once here rather
        # than scanned per lookup: the index runs to hundreds of entries
        # and resolve runs once per list item.
        self._by_name = {}
        for item_id, entry in self.index.items():
            key = normalize((entry or {}).get("display_name") or "")
            # First writer wins, so a duplicated name is at least stable
            # across runs rather than depending on dict ordering.
            if key and key not in self._by_name:
                self._by_name[key] = str(item_id)

    @classmethod
    def load(cls, path) -> "Catalog":
        path = pathlib.Path(path)
        if not path.exists():
            raise CatalogError(f"catalog not found at {path}")
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise CatalogError(f"catalog at {path} could not be parsed: {exc}") from exc
        missing = [k for k in REQUIRED_KEYS if k not in raw]
        if missing:
            raise CatalogError(f"catalog at {path} is missing keys: {missing}")
        return cls(raw)

    def save(self, path) -> None:
        """Merge this view's changes into whatever is on disk, then replace.

        A blind overwrite loses a concurrent writer's work: a build holds the
        catalog across SerpAPI calls and retry sleeps, and a tablet pick in
        that window would be erased. Aliases, skip phrases and index entries
        are merged additively; `pending` is last-writer-wins, because a build
        recomputes it wholesale and the next build will recompute it again.
        """
        path = pathlib.Path(path)
        with _SAVE_LOCK:
            try:
                on_disk = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                on_disk = {}

            index = dict(on_disk.get("index") or {})
            index.update(self.index)
            aliases = {
                normalize(k): str(v)
                for k, v in (on_disk.get("aliases") or {}).items()
            }
            aliases.update(self.aliases)
            skips = {normalize(p) for p in (on_disk.get("skip_phrases") or [])}
            skips |= self.skip_phrases

            merged = dict(self._raw)
            merged["index"] = index
            merged["aliases"] = aliases
            merged["pending"] = self.pending
            merged["skip_phrases"] = sorted(skips)

            self._raw = merged
            self.index = index
            self.aliases = aliases
            self.skip_phrases = skips

            payload = json.dumps(merged, indent=2, ensure_ascii=False)
            fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
                    fh.write(payload)
                os.replace(tmp, path)
            except BaseException:
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise

    def item(self, item_id: str) -> dict | None:
        return self.index.get(str(item_id))

    def lookup_alias(self, phrase: str) -> str | None:
        key = normalize(phrase)
        # An alias is a deliberate mapping someone made and always wins.
        # The product name is the fallback, never the override.
        return self.aliases.get(key) or self._by_name.get(key)

    def add_alias(self, phrase: str, item_id: str) -> None:
        self.aliases[normalize(phrase)] = str(item_id)

    def is_skipped(self, phrase: str) -> bool:
        return normalize(phrase) in self.skip_phrases

    def add_skip(self, phrase: str) -> None:
        self.skip_phrases.add(normalize(phrase))
