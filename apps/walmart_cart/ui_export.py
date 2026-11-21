"""Export a slim catalog payload for the Lovelace catalog card.

Why a static file rather than Home Assistant entities: the catalog holds over
400 rows that never change between builds. Putting them in HA's state machine
would bloat the recorder database and every state dump for no benefit. The
card fetches this file from /local/ instead, and HA never knows it exists.

Only the fields a tile needs are exported, so the payload stays small enough
to fetch on every card render.
"""

import datetime
import json
import os
import pathlib
import tempfile

from .catalog import Catalog
from .scoring import frequency


def build_payload(catalog_path, aliased_only: bool = False) -> dict:
    """Build the card payload.

    `aliased_only` restricts the board to hand-mapped products. Those are the
    curated set: their names are verified and they carry household phrases,
    where the rest of the scraped index still has the known category
    contamination. Flip it off to show the whole index.
    """
    catalog = Catalog.load(catalog_path)
    aliased = set(catalog.aliases.values())

    phrases: dict[str, list[str]] = {}
    for phrase, item_id in catalog.aliases.items():
        phrases.setdefault(str(item_id), []).append(phrase)

    items = []
    for raw in catalog.index.values():
        item_id = str(raw["item_id"])
        if aliased_only and item_id not in aliased:
            continue
        entry = {
            "id": item_id,
            "name": raw.get("display_name", ""),
            "category": raw.get("category", ""),
            "bought": frequency(raw.get("bought_count")),
            "thumb": raw.get("thumbnail") or "",
            "url": raw.get("product_page_url")
            or f"https://www.walmart.com/ip/{item_id}",
            # What to say to Alexa for this product. On a curated board these
            # are the point, not a detail.
            "phrases": sorted(phrases.get(item_id, [])),
        }
        if item_id in aliased:
            entry["aliased"] = True
        items.append(entry)

    # Most-bought first. Never-purchased items score 0 and sort last, but are
    # kept: a one-time purchase is still something the household might want.
    items.sort(key=lambda i: (-i["bought"], i["name"].lower()))

    return {
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(
            timespec="seconds"
        ),
        "store_id": catalog.store_id,
        "aliased_only": aliased_only,
        "count": len(items),
        "total_skus": len(catalog.index),
        "categories": sorted({i["category"] for i in items if i["category"]}),
        # Phrases the household told us are not products. Without these the
        # panel cannot tell a skipped row from one that never matched, so
        # "Not a product, stop asking" looks like it did nothing.
        "skip_phrases": sorted(catalog.skip_phrases),
        "items": items,
    }


def write_payload(catalog_path, out_path, aliased_only: bool = False) -> str:
    out_path = pathlib.Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        build_payload(catalog_path, aliased_only=aliased_only), ensure_ascii=False
    )

    fd, tmp = tempfile.mkstemp(dir=str(out_path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(payload)
        # mkstemp creates 0600, which Home Assistant's web server cannot
        # read, so the card would fetch a 403 and render blank. Observed on
        # the real box as -rw------- root:root in /homeassistant/www/walmart/.
        os.chmod(tmp, 0o644)
        os.replace(tmp, out_path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return str(out_path)
