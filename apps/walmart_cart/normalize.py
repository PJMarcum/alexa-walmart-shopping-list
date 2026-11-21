"""Phrase and title normalization.

Every comparison in this system runs on normalized text, because Amazon
title-cases what it stores and Alexa transcribes loosely. Normalization is
applied identically to voice phrases and to catalog titles so the two can be
compared directly.
"""

import re
import unicodedata

ARTICLES = frozenset({"a", "an", "the", "some", "of", "and"})

# Curated, grows as misses are observed. Keys are the spoken form.
ABBREVIATIONS = {
    "doctor": "dr",
    "saint": "st",
    "mister": "mr",
    "ounce": "oz",
    "ounces": "oz",
    "pound": "lb",
    "pounds": "lb",
    "fluid": "fl",
}

_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "ʼ": "'", "`": "'"})
_POSSESSIVE = re.compile(r"'s\b|s'\b|'\b")
_NON_WORD = re.compile(r"[^a-z0-9]+")


def _depluralize(token: str) -> str:
    if len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    return token


def tokens(text: str) -> list[str]:
    if not text:
        return []
    # NFKD splits an accent off its letter, and the bare combining mark would
    # then act as a token boundary, so "jalapeno" could never match
    # "Jalapeno". Drop the marks instead of letting them split words.
    text = "".join(
        ch for ch in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(ch)
    )
    text = text.translate(_APOSTROPHES).lower()
    text = _POSSESSIVE.sub("", text)
    raw = [t for t in _NON_WORD.split(text) if t]
    out = []
    for token in raw:
        # A lone "s" is a possessive Alexa transcribed with a space, as in
        # "Dad s toothpaste". The spec requires all three possessive forms
        # to collapse to one alias key.
        if token == "s":
            continue
        token = ABBREVIATIONS.get(token, token)
        token = _depluralize(token)
        if token in ARTICLES:
            continue
        out.append(token)
    return out


def normalize(text: str) -> str:
    return " ".join(tokens(text))
