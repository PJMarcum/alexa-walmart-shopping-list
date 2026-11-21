"""Walmart cart URL construction. The only place this URL is built.

The format is unofficial. If Walmart breaks it, the documented fallbacks are
the /cart?addToCartLineItems= variant or SnapCarted's free demo key, and
either swap happens inside this one function.
"""

BASE_URL = "https://affil.walmart.com/cart/buynow"


class CartUrlError(Exception):
    pass


def build(item_ids: list[str]) -> str:
    seen: set[str] = set()
    ordered: list[str] = []
    for raw in item_ids:
        value = str(raw).strip()
        if not value or value in seen:
            continue
        if not value.isdigit():
            raise CartUrlError(
                f"item id {value!r} is not numeric; the cart URL needs "
                "us_item_id, not product_id"
            )
        seen.add(value)
        ordered.append(value)
    if not ordered:
        raise CartUrlError("no items to put in the cart")
    return f"{BASE_URL}?items={','.join(ordered)}"
