"""Candidate ranking against the local purchased-SKU index.

The index is the primary resolver, not a cache in front of search. Search
knows product names; only purchase history knows a household drinks Diet
Dr Fizz rather than regular.

The scorer aims for top-5 recall, not for being right in position 1, because
the user is always shown candidates and picks one. A head-noun heuristic was
considered and rejected: the signal that separates "Hearthside Giant White
Bread" from "Bread Basket ... Soup" is where the product noun sits, and
Walmart's comma placement is too inconsistent to locate it reliably (one real
title reads "Value Pantry , 2% Reduced Fat Milk, Half Gallon", with a comma
right after the brand).
"""

from dataclasses import dataclass, field

from .normalize import tokens

# Curated, and deliberately small. Add an entry only when a real miss is
# observed. Keys are normalized single tokens.
CATEGORY_HINTS: dict[str, frozenset[str]] = {
    "bread": frozenset({"Bakery & Bread"}),
    "milk": frozenset({"Dairy & Eggs"}),
    "egg": frozenset({"Dairy & Eggs"}),
    "cheese": frozenset({"Dairy & Eggs", "Deli"}),
    "cream": frozenset({"Dairy & Eggs"}),
    "toothpaste": frozenset({"Personal Care", "Beauty"}),
    "shampoo": frozenset({"Beauty", "Personal Care"}),
    "razor": frozenset({"Personal Care", "Beauty"}),
    "blade": frozenset({"Personal Care", "Beauty"}),
    "beer": frozenset({"Alcohol"}),
    "soda": frozenset({"Beverages"}),
    # Produce, because a bare fruit or vegetable name is the one case
    # where the word appears in the title of something else entirely:
    # "apples" ranked Grainfield Apple Cinnamon bars and Glowskin
    # shampoo above Fresh Gala Apple, because those are bought far
    # more often. No weighting of frequency against brevity fixes that
    # without breaking milk; the missing signal is that the word is the
    # PRODUCT here and a flavour there, which is what the category says.
    #
    # The category is "Fresh Produce", not "Produce".
    #
    # Deliberately omitted: "tomato", because a household that buys tomato
    # PASTE from Pantry and no fresh tomatoes would lose it, and a hint also narrows
    # the resolver's fallback pool to the hinted categories. "pepper" is
    # out for the same reason: bell peppers and black pepper.
    "apple": frozenset({"Fresh Produce"}),
    "banana": frozenset({"Fresh Produce"}),
    "grape": frozenset({"Fresh Produce"}),
    "strawberry": frozenset({"Fresh Produce"}),
    "blueberry": frozenset({"Fresh Produce"}),
    "pineapple": frozenset({"Fresh Produce"}),
    "avocado": frozenset({"Fresh Produce"}),
    "lemon": frozenset({"Fresh Produce"}),
    "lime": frozenset({"Fresh Produce"}),
    "onion": frozenset({"Fresh Produce"}),
    "lettuce": frozenset({"Fresh Produce"}),
    "spinach": frozenset({"Fresh Produce"}),
    "broccoli": frozenset({"Fresh Produce"}),
    "mushroom": frozenset({"Fresh Produce"}),
    "zucchini": frozenset({"Fresh Produce"}),
    "cilantro": frozenset({"Fresh Produce"}),
    "jalapeno": frozenset({"Fresh Produce"}),
}

W_CATEGORY = 100.0
W_FREQUENCY = 5.0
W_BREVITY = 10.0


@dataclass
class Candidate:
    item_id: str
    title: str
    category: str = ""
    bought: str | None = None
    source: str = "index"
    url: str | None = None
    # Carried from the search result. The review sheet is a choice between
    # five near-identical cuts of pork, which is guesswork without pictures.
    thumbnail: str | None = None
    score: float = field(default=0.0, compare=False)


def frequency(bought: str | None) -> float:
    if not bought:
        return 0.0
    text = str(bought)
    if text.endswith("+"):
        return float(text[:-1]) + 0.5
    try:
        return float(text)
    except ValueError:
        return 0.0


def _hinted_categories(query_tokens: list[str]) -> frozenset[str]:
    hits: set[str] = set()
    for token in query_tokens:
        hits |= CATEGORY_HINTS.get(token, frozenset())
    return frozenset(hits)


def rank(phrase: str, catalog, limit: int = 5) -> list[Candidate]:
    query = tokens(phrase)
    if not query:
        return []
    hinted = _hinted_categories(query)

    out: list[Candidate] = []
    for item in catalog.index.values():
        title = item.get("display_name", "")
        title_tokens = set(tokens(title))
        if not all(token in title_tokens for token in query):
            continue
        category = item.get("category", "")
        score = 0.0
        if hinted and category in hinted:
            score += W_CATEGORY
        score += W_FREQUENCY * frequency(item.get("bought_count"))
        # Shorter titles first: a plain product beats a compound one.
        score += W_BREVITY * (1.0 / (1 + len(title_tokens)))
        out.append(
            Candidate(
                item_id=str(item["item_id"]),
                title=title,
                category=category,
                bought=item.get("bought_count"),
                source="index",
                url=item.get("product_page_url"),
                # The index already holds a picture for everything the
                # household has bought. Dropping it meant the review sheet
                # showed nameless grey rows for exactly the products most
                # likely to be the right answer.
                thumbnail=item.get("thumbnail"),
                score=score,
            )
        )
    out.sort(key=lambda c: (-c.score, c.item_id))
    return out[:limit]
