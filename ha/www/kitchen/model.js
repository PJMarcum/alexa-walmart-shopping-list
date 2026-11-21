// ha/www/kitchen/model.js
import { buildThumbUrl } from "./images.js";

// A direct port of apps/walmart_cart/normalize.py. It has to agree with the
// Python exactly, not approximately: the aliases and skip phrases on disk were
// written by the Python normaliser, so any divergence shows a matched row as
// "no match yet" and invites someone to overwrite an alias that already works.
// Keep ARTICLES, ABBREVIATIONS and the order of operations in step with that
// file.
const ARTICLES = new Set(["a", "an", "the", "some", "of", "and"]);

// Curated, grows as misses are observed. Keys are the spoken form.
const ABBREVIATIONS = new Map([
  ["doctor", "dr"],
  ["saint", "st"],
  ["mister", "mr"],
  ["ounce", "oz"],
  ["ounces", "oz"],
  ["pound", "lb"],
  ["pounds", "lb"],
  ["fluid", "fl"],
]);

const APOSTROPHES = /[’‘ʼ`]/g;
const POSSESSIVE = /'s\b|s'\b|'\b/g;
const NON_WORD = /[^a-z0-9]+/;

function depluralize(token) {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

export function normalise(phrase) {
  // NFKD splits an accent off its letter, and the bare combining mark would
  // then act as a token boundary, so "jalapeno" could never match
  // "Jalapeno". Drop the marks instead of letting them split words.
  let text = String(phrase || "").normalize("NFKD").replace(/\p{M}/gu, "");
  text = text.replace(APOSTROPHES, "'").toLowerCase();
  text = text.replace(POSSESSIVE, "");

  const out = [];
  for (let token of text.split(NON_WORD)) {
    if (!token) continue;
    // A lone "s" is a possessive Alexa transcribed with a space, as in
    // "Dad s toothpaste". All three possessive forms collapse to one key.
    if (token === "s") continue;
    if (ABBREVIATIONS.has(token)) token = ABBREVIATIONS.get(token);
    token = depluralize(token);
    if (ARTICLES.has(token)) continue;
    out.push(token);
  }
  return out.join(" ");
}

/**
 * Two catalog shapes reach this panel.
 *
 * The slim payload from apps/walmart_cart/ui_export.py is what Home Assistant
 * actually serves at /local/walmart/catalog.json. It is a flat `items` list,
 * one entry per product, each carrying the alias phrases that reach it, and
 * those phrases are already normalised by the Python normaliser.
 *
 * The full catalog keeps the on-disk shape (index, aliases, skip_phrases). It
 * is what the tests exercise and what may be served later, so both work.
 *
 * `items` is empty on the full shape, so product suggestions are only offered
 * when the slim payload is in hand.
 */
export function catalogLookup(catalog) {
  const empty = { index: {}, aliases: {}, byName: {}, skips: [], items: [] };
  if (!catalog) return empty;

  if (Array.isArray(catalog.items)) {
    const index = {};
    const aliases = {};
    // Tapping a tile in "what we buy" puts the PRODUCT NAME on the list,
    // not the phrase the alias is keyed on, so the name has to resolve
    // too or every tapped item reads "no match yet". The backend does the
    // same in Catalog._by_name, and the two must agree: a row that claims
    // a match here but does not resolve there would cart nothing on
    // Friday, which is worse than showing no match at all.
    const byName = {};
    for (const item of catalog.items) {
      if (!item || item.id === undefined || item.id === null) continue;
      const id = String(item.id);
      index[id] = {
        display_name: item.name || "",
        thumbnail: item.thumb || null,
      };
      for (const phrase of item.phrases || []) {
        if (phrase) aliases[String(phrase)] = id;
      }
      const nameKey = normalise(item.name || "");
      // First writer wins, matching the backend, so a duplicated name
      // resolves the same way on both sides.
      if (nameKey && !(nameKey in byName)) byName[nameKey] = id;
    }
    return {
      index,
      aliases,
      byName,
      skips: catalog.skip_phrases || [],
      items: catalog.items.filter((i) => i && i.id !== undefined && i.id !== null),
    };
  }

  return {
    index: catalog.index || {},
    aliases: catalog.aliases || {},
    byName: {},
    skips: catalog.skip_phrases || [],
    items: [],
  };
}

export function buildRows({ items, catalog, pending }) {
  const { index, aliases, byName, skips: rawSkips } = catalogLookup(catalog);
  // skip_phrases on disk are always normalized by catalog.py (lines 41, 80-87),
  // so comparing normalised key against them is safe.
  const skips = new Set(rawSkips);
  const byPhrase = new Map(
    (pending || []).map((p) => [normalise(p.phrase), p.candidates || []])
  );

  // A build marks carted items completed rather than removing them, and the
  // Alexa integration drops them only on its next poll. Nothing repaints the
  // panel at that point (the open count already read 0), so hide them here.
  return (items || []).filter((item) => item.status !== "completed").map((item) => {
    const said = item.summary;
    const key = normalise(said);
    // Alias first: it is the deliberate mapping. Product name second.
    const itemId = aliases[key] || byName[key];
    const product = itemId ? index[itemId] : null;

    let status = "unmatched";
    if (skips.has(key)) status = "skipped";
    else if (product) status = "matched";

    return {
      uid: item.uid,
      said,
      status,
      productName: status === "skipped" ? null : (product ? product.display_name : null),
      thumbUrl: status === "skipped" ? null : (product ? buildThumbUrl(product.thumbnail) : null),
      candidates: byPhrase.get(key) || [],
    };
  });
}

/**
 * Products to offer when a row has no candidates of its own.
 *
 * Candidates only ever exist for phrases the backend could not resolve, so an
 * already-matched row has none. "Use a different product" still has to show
 * something, because swapping a 2.6oz tube for a 4.8oz one and repointing a
 * phrase whose product went out of stock both run through that sheet.
 *
 * Anything sharing a word with the phrase comes first, most-bought first.
 * With no word in common, offer the household's usual products instead of an
 * empty sheet.
 */
export function suggestProducts(catalog, phrase, limit = 20) {
  const { items } = catalogLookup(catalog);
  if (!items.length) return [];

  const words = new Set(normalise(phrase).split(" ").filter(Boolean));
  // Score by HOW MANY words matched, not merely whether one did.
  //
  // Sorting purely by purchase frequency buried the right answer. For
  // "Everyday makeup remover cleansing towelettes, 80 count" the word
  // "count" appears in dozens of product names, so eggs, hot dog buns
  // and dog treats outranked the one product that matched five words,
  // and the correct item was not in the fifteen shown. Frequency is now
  // only the tie-break between equally good matches.
  const scored = words.size
    ? items
        .map((item) => {
          const haystack = new Set(
            normalise([item.name || ""].concat(item.phrases || []).join(" "))
              .split(" ")
              .filter(Boolean)
          );
          let score = 0;
          for (const word of words) if (haystack.has(word)) score += 1;
          return { item, score };
        })
        .filter((entry) => entry.score > 0)
    : [];

  // Nothing in common means NOTHING, not "here is the whole shop".
  //
  // This used to fall back to every item sorted by purchase frequency, on the
  // theory that some suggestion beats none. On the tablet it reads as the
  // matcher having given up and dumped the catalog: the top of the list is
  // milk and paper towels whatever you tapped, so you scroll a few hundred
  // tiles looking for a relevance that was never there. An empty result lets
  // the sheet say so plainly and point at Search Walmart, which is the thing
  // that can actually find a product we have never bought.
  const chosen = scored
    .sort((a, b) => b.score - a.score || (b.item.bought || 0) - (a.item.bought || 0))
    .map((entry) => entry.item)
    .slice(0, limit);

  // Shaped like a pending candidate so the review sheet renders both the same
  // way. `bought` is deliberately left off: the number here is a frequency
  // score, not a count of shopping trips, so showing it would mislead.
  return chosen.map((item) => ({
    item_id: String(item.id),
    title: item.name || "",
    thumbnail: item.thumb || null,
  }));
}

export function unmatchedRows(rows) {
  return (rows || []).filter((r) => r.status === "unmatched");
}
