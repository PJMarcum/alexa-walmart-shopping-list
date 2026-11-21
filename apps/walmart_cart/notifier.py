"""Push payload composition for notify.mobile_app_your_phone.

No em dashes or en dashes in any string here: this is user-facing copy.
Counts rather than names are reported for duplicates, because Alexa's
"added by <person>" attribution never reaches Home Assistant.
"""

TITLE_READY = "Walmart cart ready"
TITLE_REVIEW = "Walmart list needs review"
TITLE_NOTHING = "Walmart cart"
TITLE_FAILED = "Walmart cart failed"

# The custom panel's url_path, not a dashboard view. The original
# "/lovelace/walmart" named a view that exists in no dashboard on the
# box, so every "Review matches" button opened a blank page.
REVIEW_PATH = "/kitchen"


def _strays_sentence(strays: int) -> str:
    if not strays:
        return ""
    noun = "item is" if strays == 1 else "items are"
    return f" {strays} {noun} sitting on your default Shopping List."


def compose(cart_url, resolved, pending, unresolved, strays: int = 0) -> dict:
    # Nothing carted means there is no cart to open, so the title must not
    # promise one. Found in live testing, where an all-pending build pushed
    # "Walmart cart ready. 0 in the cart."
    parts = [f"{len(resolved)} in the cart."] if resolved else []
    if pending:
        noun = "match" if len(pending) == 1 else "matches"
        parts.append(f"{len(pending)} new {noun} to review.")
    if unresolved:
        parts.append("Not found: " + ", ".join(unresolved) + ".")
    message = " ".join(parts) + _strays_sentence(strays)
    return {
        "title": TITLE_READY if resolved else TITLE_REVIEW,
        "message": message,
        "data": {
            "url": cart_url,
            "actions": [
                {"action": "OPEN_CART", "title": "Open cart", "uri": cart_url},
                {
                    "action": "REVIEW_MATCHES",
                    "title": "Review matches",
                    "uri": REVIEW_PATH,
                },
            ],
        },
    }


def compose_nothing_to_build(strays: int = 0) -> dict:
    return {
        "title": TITLE_NOTHING,
        "message": "Nothing to build, your Walmart list is empty."
        + _strays_sentence(strays),
        "data": {},
    }


def compose_failure(reason: str) -> dict:
    return {
        "title": TITLE_FAILED,
        "message": f"{reason}. Nothing was changed, your list is intact.",
        "data": {},
    }


def compose_announcement(carted: int, pending: int = 0, unresolved: int = 0) -> str:
    """One spoken line for an Echo announcement.

    No URL: an Echo cannot read a link usefully, so the announcement's whole
    job is to send someone to their phone, where the tappable link already is.
    Kept to one breath, because a long announcement gets talked over.
    """
    if carted:
        said = f"Your Walmart cart is ready with {carted} item"
        said += "s." if carted != 1 else "."
    elif pending:
        noun = "match" if pending == 1 else "matches"
        said = f"Your Walmart list has {pending} new {noun} to review."
        return said
    else:
        return "Nothing to build, your Walmart list is empty."

    if pending:
        noun = "match" if pending == 1 else "matches"
        said += f" {pending} new {noun} to review."
    return said


def compose_sms(cart_url, carted: int, pending: int = 0, unresolved: int = 0) -> str:
    """One SMS. The link goes in the body, because SMS has no tap action.

    Kept under 160 characters so it bills as a single segment and no carrier
    has to reassemble it. The cart URL alone is around 110 characters, which
    leaves very little room, so the prose is deliberately terse and the
    pending and unresolved counts are dropped rather than truncating the link.
    Plain ASCII only: a smart quote can come through mangled.
    """
    if not cart_url:
        if pending:
            noun = "match" if pending == 1 else "matches"
            return f"Walmart list: {pending} new {noun} to review in Home Assistant."
        return "Walmart list is empty, nothing to build."

    noun = "item" if carted == 1 else "items"
    return f"Walmart cart ready, {carted} {noun}: {cart_url}"
