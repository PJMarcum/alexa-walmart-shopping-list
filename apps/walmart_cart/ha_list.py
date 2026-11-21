"""The only place the Home Assistant todo API is called.

Measured behavior this module exists to absorb:
  - Entity IDs carry an unstable HA area prefix, so the list is located by
    friendly_name.
  - Item reads are live; no reload is needed for an already-discovered list.
  - A newly created Alexa list needs one reload_config_entry to appear.
  - todo.remove_item returns 500. Consumption is update_item then
    remove_completed_items.
  - Intermittent 500s occur on first contact, so every write is verified by
    reading back rather than trusting the status code.
"""

import time

READ_ATTEMPTS = 3
RETRY_SLEEP = 2.0


class HaListError(Exception):
    pass


def find_list_entity(states, name_suffix: str = "walmart") -> str:
    suffix = name_suffix.lower()
    for state in states:
        entity_id = state.get("entity_id", "")
        if not entity_id.startswith("todo."):
            continue
        name = str(state.get("attributes", {}).get("friendly_name", "")).lower()
        if name.endswith(suffix):
            return entity_id
    raise HaListError(
        f"no todo entity whose friendly_name ends with {name_suffix!r}; "
        "if the Alexa list is new, reload the Alexa Devices config entry"
    )


def _extract_items(payload) -> list[dict]:
    """Pull the item list out of a get_items response.

    The response shape is not stable across callers. Measured: HA's REST API
    wraps it in "service_response", while AppDaemon's call_service returned a
    dict mixing counters with the entity key, so iterating every value and
    calling .get on it raised "'int' object has no attribute 'get'".

    Raises ValueError naming the keys it saw, because a shape this layer does
    not recognise is the kind of thing that must not be debugged blind.
    """
    if not isinstance(payload, dict):
        raise ValueError(
            f"unexpected get_items payload type {type(payload).__name__}"
        )

    def descend(node, depth):
        # Bounded: AppDaemon nests items under result -> response -> entity,
        # which is 3 levels, so 5 is slack rather than licence to wander.
        if depth > 5 or not isinstance(node, dict):
            return None
        found = node.get("items")
        if isinstance(found, list):
            return found
        for value in node.values():
            if isinstance(value, dict):
                deeper = descend(value, depth + 1)
                if deeper is not None:
                    return deeper
        return None

    items = descend(payload, 0)
    if items is not None:
        return list(items)
    raise ValueError(
        f"no 'items' found in get_items payload; keys were {sorted(payload)}"
    )


def _get_items(client, entity_id: str) -> list[dict]:
    last = None
    for attempt in range(READ_ATTEMPTS):
        try:
            payload = client.call_service(
                "todo", "get_items", {"entity_id": entity_id}, return_response=True
            )
        except Exception as exc:
            # Transport or service failure: worth retrying, since
            # intermittent 500s are measured behaviour here.
            last = exc
            if attempt < READ_ATTEMPTS - 1:
                time.sleep(RETRY_SLEEP)
            continue
        try:
            return _extract_items(payload)
        except ValueError as exc:
            # A shape we do not recognise will not fix itself on retry.
            raise HaListError(f"could not read {entity_id}: {exc}") from exc
    raise HaListError(f"could not read {entity_id}: {last}")


def read_open_items(client, entity_id: str) -> list[str]:
    # .get rather than a subscript: a row without a summary is malformed
    # upstream, and skipping it beats crashing the whole build.
    return [
        item["summary"]
        for item in _get_items(client, entity_id)
        if item.get("status") == "needs_action" and item.get("summary")
    ]


def consume(client, entity_id: str, summaries: list[str]) -> dict:
    if not summaries:
        return {"completed": [], "failed": [], "cleared": False}

    for summary in summaries:
        try:
            client.call_service(
                "todo",
                "update_item",
                {"entity_id": entity_id, "item": summary, "status": "completed"},
            )
        except Exception:
            pass  # verified by read-back below, not by the status code

    # The read-back is the exact intermittent-500 condition this module
    # exists to absorb, so it must not escape. If we cannot confirm the
    # writes, report every item as failed: that leaves them on the list for
    # next week, which is recoverable, where an escaping exception strands
    # them completed-but-uncleared with nobody notified.
    try:
        after = _get_items(client, entity_id)
    except HaListError:
        return {"completed": [], "failed": list(summaries), "cleared": False}

    status_by_name = {
        str(item.get("summary", "")).lower(): item.get("status") for item in after
    }
    completed, failed = [], []
    for summary in summaries:
        if status_by_name.get(summary.lower()) == "completed":
            completed.append(summary)
        else:
            failed.append(summary)

    cleared = False
    if completed:
        try:
            client.call_service(
                "todo", "remove_completed_items", {"entity_id": entity_id}
            )
            remaining = {
                str(i.get("summary", "")).lower() for i in _get_items(client, entity_id)
            }
            cleared = not any(c.lower() in remaining for c in completed)
        except Exception:
            cleared = False

    return {"completed": completed, "failed": failed, "cleared": cleared}
