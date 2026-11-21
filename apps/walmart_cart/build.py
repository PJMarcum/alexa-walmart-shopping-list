"""Pipeline orchestration. Sequencing only; every dependency is injected.

The governing rule: the list is never consumed unless a cart URL was
successfully produced. Pending items are never carted and never consumed,
so they roll into the next build.
"""

from dataclasses import dataclass

from . import cart_url, ha_list, notifier, runlog, serp
from .catalog import Catalog, CatalogError
from .resolver import (
    STATUS_PENDING,
    STATUS_RESOLVED,
    STATUS_SKIPPED,
    STATUS_UNRESOLVED,
    resolve_local,
)


@dataclass
class Config:
    catalog_path: str
    run_dir: str
    store_id: str
    serpapi_key: str | None = None
    list_name_suffix: str = "walmart"
    stray_list_suffix: str = "shopping list"
    candidate_limit: int = 5
    dry_run: bool = False


def _locate(client, cfg) -> str:
    states = client.get_states()
    try:
        return ha_list.find_list_entity(states, cfg.list_name_suffix)
    except ha_list.HaListError:
        # A newly created Alexa list needs one config-entry reload to appear.
        client.reload_config_entry(None)
        return ha_list.find_list_entity(client.get_states(), cfg.list_name_suffix)


def _count_strays(client, cfg) -> int:
    try:
        entity = ha_list.find_list_entity(client.get_states(), cfg.stray_list_suffix)
        return len(ha_list.read_open_items(client, entity))
    except Exception:
        return 0


ZERO_COUNTS = {
    "requests_carted": 0,
    "items_carted": 0,
    "pending": 0,
    "unresolved": 0,
    "skipped": 0,
    "strays": 0,
}


def _finish(cfg, record, notification, cart_url_value, resolutions):
    record.setdefault("status", "unknown")
    record["notification"] = notification
    path = runlog.write(cfg.run_dir, record)
    return {
        "status": record["status"],
        "notification": notification,
        # Counts must be returned, not just recorded. The push consumes the
        # pre-composed notification above, but the Echo announcement and the
        # SMS recompose from these raw numbers, so a missing key silently
        # made every announcement say the list was empty. A failure that
        # finishes before the pipeline counts anything gets real zeros
        # rather than an absent key, so those callers cannot KeyError.
        "counts": record.get("counts") or dict(ZERO_COUNTS),
        "cart_url": cart_url_value,
        "resolutions": resolutions,
        "run_path": path,
    }


def _unique_ids(resolutions) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for resolution in resolutions:
        if resolution.item_id and resolution.item_id not in seen:
            seen.add(resolution.item_id)
            ordered.append(resolution.item_id)
    return ordered


def build_cart(client, cfg: Config, searcher=None) -> dict:
    """Entry point. Guarantees a run record and a notification on every path.

    Nothing below may escape: an unhandled exception here means no push and
    no audit trail for an unattended Friday-morning run, which is how a
    silent failure looks identical to a quiet week.
    """
    searcher = searcher or serp.search
    record: dict = {"trigger": "event", "dry_run": cfg.dry_run}

    try:
        catalog = Catalog.load(cfg.catalog_path)
    except CatalogError as exc:
        record["status"] = "failed"
        record["error"] = str(exc)
        return _finish(cfg, record, notifier.compose_failure(str(exc)), None, [])

    resolutions: list = []
    try:
        return _pipeline(client, cfg, searcher, record, catalog, resolutions)
    except Exception as exc:
        reason = str(exc) or type(exc).__name__
        record["status"] = "failed"
        record["error"] = f"{type(exc).__name__}: {exc}"
        return _finish(
            cfg, record, notifier.compose_failure(reason), None, resolutions
        )


def _pipeline(client, cfg: Config, searcher, record, catalog, resolutions) -> dict:
    try:
        entity_id = _locate(client, cfg)
        phrases = ha_list.read_open_items(client, entity_id)
    except ha_list.HaListError as exc:
        record["status"] = "failed"
        record["error"] = str(exc)
        return _finish(cfg, record, notifier.compose_failure(str(exc)), None, [])

    record["entity_id"] = entity_id
    record["phrases"] = phrases
    strays = _count_strays(client, cfg)

    for phrase in phrases:
        resolution = resolve_local(phrase, catalog, limit=cfg.candidate_limit)
        if resolution.status == STATUS_UNRESOLVED and cfg.serpapi_key:
            try:
                found = searcher(
                    phrase, cfg.serpapi_key, cfg.store_id, cfg.candidate_limit
                )
                if found:
                    resolution.status = STATUS_PENDING
                    resolution.candidates = found
                    resolution.note = "serpapi search"
            except Exception as exc:
                resolution.note = f"search failed: {exc}"
        resolutions.append(resolution)

    carted = [r for r in resolutions if r.status == STATUS_RESOLVED]
    pending = [r for r in resolutions if r.status == STATUS_PENDING]
    unresolved = [r for r in resolutions if r.status == STATUS_UNRESOLVED]
    skipped = [r for r in resolutions if r.status == STATUS_SKIPPED]

    catalog.pending = [
        {
            "phrase": r.phrase,
            "note": r.note,
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
                for c in r.candidates
            ],
        }
        for r in pending
    ]
    catalog.save(cfg.catalog_path)

    carted_ids = _unique_ids(carted)
    record["counts"] = {
        "requests_carted": len(carted),
        "items_carted": len(carted_ids),
        "pending": len(pending),
        "unresolved": len(unresolved),
        "skipped": len(skipped),
        "strays": strays,
    }

    if not carted_ids:
        record["status"] = "nothing_to_build"
        if not (pending or unresolved):
            note = notifier.compose_nothing_to_build(strays)
            return _finish(cfg, record, note, None, resolutions)
        note = notifier.compose(
            None,
            [],
            [r.phrase for r in pending],
            [r.phrase for r in unresolved],
            strays,
        )
        note["data"].pop("url", None)
        note["data"]["actions"] = [
            a for a in note["data"].get("actions", []) if a["action"] != "OPEN_CART"
        ]
        return _finish(cfg, record, note, None, resolutions)

    url = cart_url.build(carted_ids)
    record["cart_url"] = url

    # Count unique items, not requests: two phrases for one SKU is one item
    # in the cart, and the push must not overstate what was added.
    notification = notifier.compose(
        url,
        carted_ids,
        [r.phrase for r in pending],
        [r.phrase for r in unresolved],
        strays,
    )

    if cfg.dry_run:
        record["status"] = "dry_run"
        return _finish(cfg, record, notification, url, resolutions)

    consumed = ha_list.consume(client, entity_id, [r.phrase for r in carted])
    record["consumed"] = consumed
    record["status"] = "built" if not consumed["failed"] else "built_consume_failed"
    return _finish(cfg, record, notification, url, resolutions)
