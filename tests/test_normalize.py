import pytest
from walmart_cart.normalize import normalize, tokens


def test_lowercases_and_strips_whitespace():
    assert normalize("  Paper Towels  ") == "paper towel"


def test_amazon_title_casing_round_trips():
    # Amazon stores "Probe1" when given "probe1"; both must normalize alike.
    assert normalize("Hamburger Meat") == normalize("hamburger meat")


def test_curly_apostrophe_matches_ascii_apostrophe():
    # Seen in real Walmart titles: "Rosa's" uses U+2019.
    assert normalize("Rosa’s Petite Diced Tomatoes") == normalize(
        "Rosa's Petite Diced Tomatoes"
    )


def test_strips_possessive_but_keeps_the_name():
    assert normalize("Dad's toothpaste") == "dad toothpaste"
    assert normalize("Dads toothpaste") == "dad toothpaste"


def test_expands_abbreviations():
    # Measured: "doctor fizz" scored zero local hits against "Dr Fizz".
    assert normalize("Doctor Fizz") == "dr fizz"


def test_depluralizes():
    # Measured: "razor blades" scored zero hits against "Razor Blade Refill".
    assert normalize("razor blades") == "razor blade"
    assert normalize("pickles") == "pickle"


def test_does_not_depluralize_double_s():
    assert normalize("glass") == "glass"


def test_drops_articles_and_filler():
    assert normalize("a gallon of the milk") == "gallon milk"


def test_drops_punctuation_and_collapses_spaces():
    assert normalize("Value Pantry , 2% Reduced Fat Milk, Half Gallon") == (
        "value pantry 2 reduced fat milk half gallon"
    )


def test_tokens_returns_a_list():
    assert tokens("Razor Blades") == ["razor", "blade"]


def test_empty_input_is_empty_output():
    assert normalize("") == ""
    assert tokens("   ") == []


def test_space_separated_possessive_collapses_too():
    # Spec names "Dad's", "dads" and "Dad s" as needing one alias key.
    # Alexa transcribes the third form, and it was missing the alias.
    assert normalize("Dad s toothpaste") == "dad toothpaste"


def test_interior_accents_normalize_to_ascii():
    # NFKD splits the tilde off, and the combining mark was being treated as
    # a token boundary, so "jalapeno" could never match "Jalapeno".
    assert normalize("jalape\u00f1o") == normalize("jalapeno")
    assert normalize("Jalape\u00f1os") == "jalapeno"


def test_trailing_accent_still_works():
    assert normalize("caf\u00e9") == normalize("cafe")
