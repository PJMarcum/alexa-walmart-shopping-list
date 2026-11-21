#!/usr/bin/env python3
"""Seed catalog aliases from phrase + Walmart product URL pairs.

Usage:
    python tools/seed_alias.py "dad's toothpaste=<walmart url>" ...
    python tools/seed_alias.py --catalog path/to/catalog.json "milk=<url>"
    python tools/seed_alias.py --file pairs.txt      # one "phrase=url" per line
    python tools/seed_alias.py --list                # show current aliases

Extracts us_item_id from the URL, reuses the catalog's display_name when the
SKU is already in the index, and adds a minimal index entry when it is not.
Also seeds the compound/two-word variant of the last token, because
normalization does not merge "bodywash" with "body wash".
"""

import argparse
import io
import json
import pathlib
import re
import sys
import unicodedata

# Default: walmart_catalog.json in the repo root (gitignored). Override with
# --catalog to edit a copy somewhere else.
DEFAULT_CATALOG = pathlib.Path(__file__).resolve().parent.parent / "walmart_catalog.json"

ARTICLES = frozenset({"a", "an", "the", "some", "of", "and"})
ABBREVIATIONS = {
    "doctor": "dr", "saint": "st", "mister": "mr", "ounce": "oz",
    "ounces": "oz", "pound": "lb", "pounds": "lb", "fluid": "fl",
}
_APOS = str.maketrans({"’": "'", "‘": "'", "ʼ": "'", "`": "'"})
_POSS = re.compile(r"'s\b|s'\b|'\b")
_NONW = re.compile(r"[^a-z0-9]+")
_ID = re.compile(r"/ip/(?:[^/?]*/)?(\d{6,})")


def normalize(text: str) -> str:
    if not text:
        return ""
    text = unicodedata.normalize("NFKD", text).translate(_APOS).lower()
    text = _POSS.sub("", text)
    out = []
    for token in (t for t in _NONW.split(text) if t):
        token = ABBREVIATIONS.get(token, token)
        if len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
            token = token[:-1]
        if token in ARTICLES:
            continue
        out.append(token)
    return " ".join(out)


def item_id_from(url: str) -> str:
    match = _ID.search(url)
    if not match:
        raise SystemExit(f"could not find a /ip/<id> item id in: {url[:90]}")
    return match.group(1)


def title_from(url: str) -> str:
    slug = re.search(r"/ip/([^/?]+)/\d{6,}", url)
    if not slug:
        return "Unknown product"
    return slug.group(1).replace("-", " ")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pairs", nargs="*", help='"phrase=url"')
    ap.add_argument("--file", help='file of "phrase=url" lines')
    ap.add_argument("--list", action="store_true", help="print current aliases")
    ap.add_argument("--catalog", default=str(DEFAULT_CATALOG), help="catalog file to edit")
    args = ap.parse_args()
    CATALOG = pathlib.Path(args.catalog)
    if not CATALOG.exists():
        raise SystemExit(f"no catalog at {CATALOG}; copy catalog.example.json there first")

    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    index = catalog["index"]
    aliases = catalog.setdefault("aliases", {})

    if args.list:
        for phrase in sorted(aliases):
            item = index.get(aliases[phrase], {})
            print("  %-26s -> %-12s %s" % (
                phrase, aliases[phrase], item.get("display_name", "?")[:56]))
        print("\n%d aliases, %d SKUs" % (len(aliases), len(index)))
        return 0

    raw = list(args.pairs)
    if args.file:
        raw += [
            line.strip()
            for line in io.open(args.file, encoding="utf-8")
            if line.strip() and not line.startswith("#")
        ]
    if not raw:
        ap.error("give at least one \"phrase=url\" pair, or --file, or --list")

    for entry in raw:
        if "=" not in entry:
            print("  skipped, no '=' separator:", entry[:60])
            continue
        phrase, url = entry.split("=", 1)
        phrase, url = phrase.strip(), url.strip()
        item_id = item_id_from(url)

        if item_id not in index:
            index[item_id] = {
                "item_id": item_id,
                "display_name": title_from(url),
                "category": "",
                "bought_count": None,
                "source": "manual_alias",
            }
            print("  + index entry %s  %s" % (item_id, title_from(url)[:50]))
        # Keep the canonical product URL. walmart.com/ip/<id> redirects
        # correctly, so this is for display, but the v1.1 catalog grid wants
        # a real link per tile.
        index[item_id].setdefault(
            "product_page_url", "https://www.walmart.com/ip/" + item_id
        )

        keys = {normalize(phrase)}
        # "bodywash" and "body wash" normalize differently; seed both.
        tokens = normalize(phrase).split()
        if tokens:
            last = tokens[-1]
            for a, b in (("bodywash", "body wash"), ("mouthwash", "mouth wash"),
                         ("toothpaste", "tooth paste")):
                if last == normalize(a):
                    keys.add(normalize(" ".join(tokens[:-1] + [b])))
                elif normalize(" ".join(tokens[-2:])) == normalize(b):
                    keys.add(normalize(" ".join(tokens[:-2] + [a])))

        for key in sorted(keys):
            aliases[key] = item_id
            print("  %-26s -> %-12s %s" % (
                key, item_id, index[item_id]["display_name"][:52]))

    CATALOG.write_text(
        json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8", newline="\n"
    )
    print("\n%d aliases, %d SKUs" % (len(aliases), len(index)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
