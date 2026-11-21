"""SerpAPI Walmart engine. The only place SerpAPI is called.

Free tier is 250 searches per month. Projected usage is well under that
because the local index handles the staples, so this module never needs to
be clever about budget: it fails loudly and the caller leaves the phrase on
the Alexa list for next week.
"""

import urllib.parse

from .scoring import Candidate

SEARCH_URL = "https://serpapi.com/search"
ACCOUNT_URL = "https://serpapi.com/account"


class SerpError(Exception):
    pass


def _default_fetch(url: str) -> dict:
    import requests

    response = requests.get(url, timeout=45)
    response.raise_for_status()
    return response.json()


def _get(url: str, fetch) -> dict:
    try:
        payload = (fetch or _default_fetch)(url)
    except SerpError:
        raise
    except Exception as exc:
        raise SerpError(f"SerpAPI request failed: {exc}") from exc
    if isinstance(payload, dict) and payload.get("error"):
        raise SerpError(str(payload["error"]))
    return payload


def account(api_key: str, fetch=None) -> dict:
    url = f"{ACCOUNT_URL}?{urllib.parse.urlencode({'api_key': api_key})}"
    return _get(url, fetch)


def search(
    query: str,
    api_key: str,
    store_id: str | None = None,
    limit: int = 5,
    fetch=None,
) -> list[Candidate]:
    params = {"engine": "walmart", "query": query, "api_key": api_key}
    if store_id:
        params["store_id"] = store_id
    url = f"{SEARCH_URL}?{urllib.parse.urlencode(params)}"
    payload = _get(url, fetch)

    out: list[Candidate] = []
    for row in payload.get("organic_results") or []:
        item_id = row.get("us_item_id")
        if not item_id:
            continue
        out.append(
            Candidate(
                item_id=str(item_id),
                title=row.get("title", ""),
                category="",
                bought=None,
                source="serpapi",
                url=row.get("product_page_url"),
                thumbnail=row.get("thumbnail"),
                score=0.0,
            )
        )
        if len(out) >= limit:
            break
    return out
