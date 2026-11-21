"""Phrase resolution, local paths.

Order matters: skip, then alias, then index, then the household-name rule.
Skip comes first so that a phrase the user has rejected cannot be revived by
a stale alias. The household rule comes last because an explicit alias for
"dad's toothpaste" should win over the rule's category-filtered guess.
"""

from dataclasses import dataclass, field

from .normalize import normalize, tokens
from .scoring import CATEGORY_HINTS, Candidate, rank

STATUS_RESOLVED = "resolved"
STATUS_PENDING = "pending"
STATUS_SKIPPED = "skipped"
STATUS_UNRESOLVED = "unresolved"

# Normalized, singular, possessive already stripped by normalize().
HOUSEHOLD_NAMES = frozenset({"mom", "dad", "sam"})


@dataclass
class Resolution:
    phrase: str
    status: str
    item_id: str | None = None
    candidates: list[Candidate] = field(default_factory=list)
    note: str = ""


def _names_in(phrase: str) -> set[str]:
    return set(tokens(phrase)) & HOUSEHOLD_NAMES


def resolve_local(phrase: str, catalog, limit: int = 5) -> Resolution:
    if not normalize(phrase):
        return Resolution(phrase, STATUS_UNRESOLVED, note="empty phrase")

    if catalog.is_skipped(phrase):
        return Resolution(phrase, STATUS_SKIPPED, note="user skipped this phrase")

    alias = catalog.lookup_alias(phrase)
    if alias:
        return Resolution(phrase, STATUS_RESOLVED, item_id=alias, note="alias")

    candidates = rank(phrase, catalog, limit=limit)
    names = _names_in(phrase)

    if names:
        # A named phrase will never match a Walmart product title, so a
        # search is guaranteed to waste a call and return noise. Show the
        # plausible local candidates instead, filtered by category hint when
        # one of the remaining tokens gives us one.
        if not candidates:
            rest = [t for t in tokens(phrase) if t not in names]
            hinted: set[str] = set()
            for token in rest:
                hinted |= CATEGORY_HINTS.get(token, frozenset())
            pool = [
                Candidate(
                    item_id=str(i["item_id"]),
                    title=i.get("display_name", ""),
                    category=i.get("category", ""),
                    bought=i.get("bought_count"),
                    source="index",
                    url=i.get("product_page_url"),
                    thumbnail=i.get("thumbnail"),
                )
                for i in catalog.index.values()
                if not hinted or i.get("category", "") in hinted
            ]
            if rest:
                pool = [
                    c
                    for c in pool
                    if any(t in set(tokens(c.title)) for t in rest)
                ]
            candidates = pool[:limit]
        return Resolution(
            phrase,
            STATUS_PENDING,
            candidates=candidates,
            note="household member phrase, needs a one-time mapping",
        )

    if candidates:
        return Resolution(
            phrase, STATUS_PENDING, candidates=candidates, note="local index match"
        )

    return Resolution(phrase, STATUS_UNRESOLVED, note="no local match")
