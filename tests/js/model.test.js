// tests/js/model.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRows, catalogLookup, normalise, unmatchedRows } from "../../ha/www/kitchen/model.js";

const CATALOG = {
  index: {
    "800000007": {
      item_id: "800000007",
      display_name: "Brightline Oil Free Micellar Eye Makeup Remover Pads",
      thumbnail: "https://i5.walmartimages.com/seo/Brightline_x.jpeg",
    },
  },
  aliases: { "eye makeup remover pad": "800000007" },
  skip_phrases: ["hamburger meat"],
};

test("a matched phrase carries the product name and a sized thumbnail", () => {
  const rows = buildRows({
    items: [{ uid: "1", summary: "Eye makeup remover pads" }],
    catalog: CATALOG,
    pending: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].said, "Eye makeup remover pads");
  assert.equal(rows[0].status, "matched");
  assert.match(rows[0].productName, /^Brightline Oil Free/);
  assert.match(rows[0].thumbUrl, /odnBg=FFFFFF/);
});

test("completed items are not shown, open and status-less items are", () => {
  // A build marks carted items COMPLETED; the Alexa integration only drops
  // them on its next poll, and the open-item count has already stopped
  // changing, so nothing repaints the panel when they finally vanish.
  const rows = buildRows({
    items: [
      { uid: "a", summary: "Pork chops", status: "completed" },
      { uid: "b", summary: "Milk", status: "needs_action" },
      { uid: "c", summary: "Eggs" },
    ],
    catalog: CATALOG,
    pending: [],
  });
  assert.deepEqual(rows.map((r) => r.uid), ["b", "c"]);
});

test("an unmatched phrase has no product name and no thumbnail", () => {
  const rows = buildRows({
    items: [{ uid: "2", summary: "Pork chops" }],
    catalog: CATALOG,
    pending: [],
  });
  assert.equal(rows[0].status, "unmatched");
  assert.equal(rows[0].productName, null);
  assert.equal(rows[0].thumbUrl, null);
});

test("a skipped phrase is marked skipped, not unmatched", () => {
  const rows = buildRows({
    items: [{ uid: "3", summary: "Hamburger meat" }],
    catalog: CATALOG,
    pending: [],
  });
  assert.equal(rows[0].status, "skipped");
});

test("candidates from the pending sensor attach to their row", () => {
  const rows = buildRows({
    items: [{ uid: "4", summary: "Pork chops" }],
    catalog: CATALOG,
    pending: [{ phrase: "Pork chops", candidates: [{ item_id: "1", title: "A" }] }],
  });
  assert.equal(rows[0].candidates.length, 1);
  assert.equal(rows[0].candidates[0].title, "A");
});

// the catalog is fetched separately and may be unavailable; the list must still render
test("a missing catalog renders every row as unmatched, not blank", () => {
  const rows = buildRows({
    items: [{ uid: "5", summary: "Eye makeup remover pads" }],
    catalog: null,
    pending: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "unmatched");
  assert.equal(rows[0].said, "Eye makeup remover pads");
});

// alias lookup must tolerate a corrupt catalog that lacks the target product
test("an alias pointing at a missing index entry degrades to unmatched", () => {
  const broken = { index: {}, aliases: { "milk": "999" }, skip_phrases: [] };
  const rows = buildRows({
    items: [{ uid: "6", summary: "Milk" }],
    catalog: broken,
    pending: [],
  });
  assert.equal(rows[0].status, "unmatched");
  assert.equal(rows[0].thumbUrl, null);
});

test("normalise matches the python rules this panel relies on", () => {
  assert.equal(normalise("Eye Makeup Remover Pads"), "eye makeup remover pad");
  assert.equal(normalise("  the  Milk "), "milk");
});

// skip takes precedence over alias; skipped rows must not show product data
test("a phrase in both aliases and skip_phrases is marked skipped with no product data", () => {
  const catalog = {
    index: { "123": { item_id: "123", display_name: "Test Product", thumbnail: "https://example.com/img.jpg" } },
    aliases: { "milk": "123" },
    skip_phrases: ["milk"],
  };
  const rows = buildRows({
    items: [{ uid: "7", summary: "Milk" }],
    catalog,
    pending: [],
  });
  assert.equal(rows[0].status, "skipped");
  assert.equal(rows[0].productName, null);
  assert.equal(rows[0].thumbUrl, null);
});

// catalog may be missing its index key entirely; lookup must still succeed
test("catalog missing index key renders as unmatched, not thrown", () => {
  const noIndex = { aliases: { "milk": "999" }, skip_phrases: [] };
  const rows = buildRows({
    items: [{ uid: "8", summary: "Milk" }],
    catalog: noIndex,
    pending: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "unmatched");
});

// catalog may be missing its aliases key entirely; lookup must still succeed
test("catalog missing aliases key renders as unmatched, not thrown", () => {
  const noAliases = { index: { "123": { item_id: "123", display_name: "Test", thumbnail: "https://example.com/img.jpg" } }, skip_phrases: [] };
  const rows = buildRows({
    items: [{ uid: "9", summary: "Milk" }],
    catalog: noAliases,
    pending: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "unmatched");
});

// --- Review Focus 5 -------------------------------------------------------
test("a very long product name is preserved for the view to clamp", () => {
  const long = "A".repeat(180);
  const catalog = {
    index: { "1": { item_id: "1", display_name: long, thumbnail: null } },
    aliases: { "milk": "1" },
    skip_phrases: [],
  };
  const rows = buildRows({
    items: [{ uid: "1", summary: "Milk" }], catalog, pending: [],
  });
  // The model must not truncate; clamping is the stylesheet's job, so that
  // the full name is still available to the review dialog.
  assert.equal(rows[0].productName.length, 180);
});

test("the rail lists only unmatched rows, never skipped ones", () => {
  const rows = [
    { said: "a", status: "matched" },
    { said: "b", status: "unmatched" },
    { said: "c", status: "skipped" },
  ];
  assert.deepEqual(unmatchedRows(rows).map((r) => r.said), ["b"]);
});

test("the rail keeps every unmatched row on a long list", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    said: `item ${i}`, status: i % 3 === 0 ? "skipped" : "unmatched",
  }));
  assert.equal(unmatchedRows(rows).length, 20);
  assert.deepEqual(unmatchedRows(undefined), []);
});

// --- Review Focus 3 -------------------------------------------------------
test("a missing pending sensor yields rows with empty candidates", () => {
  const rows = buildRows({
    items: [{ uid: "1", summary: "Pork chops" }],
    catalog: { index: {}, aliases: {}, skip_phrases: [] },
    pending: undefined,
  });
  assert.deepEqual(rows[0].candidates, []);
  assert.equal(rows[0].status, "unmatched");
});

// --- Whole-branch review ---------------------------------------------------
// Every fixture above is the full on-disk catalog shape. The file Home
// Assistant actually serves is the slim ui_export payload, which has no
// index, aliases or skip_phrases key at all, so the fixtures could not catch
// the panel reading a shape that does not exist. These load a sample of it.
import { readFileSync } from "node:fs";
import { suggestProducts } from "../../ha/www/kitchen/model.js";

const LIVE = JSON.parse(
  readFileSync(new URL("../fixtures/ui_catalog_sample.json", import.meta.url), "utf-8")
);

test("the slim catalog sample matches spoken phrases", () => {
  // Phrases as Alexa writes them onto the list.
  const said = ["Paper towels", "Sour cream", "Dad's toothpaste", "Milk",
    "Trash bags", "Cola"];
  const rows = buildRows({
    items: said.map((s, i) => ({ uid: String(i), summary: s })),
    catalog: LIVE,
    pending: [],
  });
  const matched = rows.filter((r) => r.status === "matched");
  assert.equal(matched.length, said.length,
    `only ${matched.length} of ${said.length} matched: ` +
    JSON.stringify(rows.map((r) => [r.said, r.status])));
  // A matched row must carry a usable name and a sized thumbnail, which is
  // what the slim payload's name and thumb fields have to be mapped onto.
  for (const row of matched) {
    assert.ok(row.productName && row.productName.length > 3, row.said);
    assert.match(row.thumbUrl, /^https:\/\/i5\.walmartimages\.com\/.*odnWidth=112/);
  }
});

test("the slim payload is detected by its items array", () => {
  const slim = {
    count: 1,
    items: [{ id: 123, name: "Value Pantry Paper Towels", thumb: "https://i5.walmartimages.com/x.jpeg", phrases: ["paper towel"] }],
  };
  const rows = buildRows({
    items: [{ uid: "1", summary: "Paper towels" }], catalog: slim, pending: [],
  });
  assert.equal(rows[0].status, "matched");
  assert.equal(rows[0].productName, "Value Pantry Paper Towels");
  assert.match(rows[0].thumbUrl, /odnBg=FFFFFF/);
});

test("the slim payload carries skip phrases through", () => {
  const slim = { items: [], skip_phrases: ["hamburger meat"] };
  const rows = buildRows({
    items: [{ uid: "1", summary: "Hamburger meat" }], catalog: slim, pending: [],
  });
  assert.equal(rows[0].status, "skipped");
});

test("a slim item with no id or no phrases is skipped, not thrown", () => {
  const slim = { items: [{ name: "No id" }, { id: "5", name: "No phrases" }, null] };
  const rows = buildRows({
    items: [{ uid: "1", summary: "No id" }], catalog: slim, pending: [],
  });
  assert.equal(rows[0].status, "unmatched");
});

// --- normaliser parity with apps/walmart_cart/normalize.py -----------------
// Each expected value was produced by running the Python normaliser on the
// same input. A divergence shows a working alias as "no match yet".
test("normalise agrees with the python normaliser on possessives", () => {
  assert.equal(normalise("Dad's toothpaste"), "dad toothpaste");
  assert.equal(normalise("Dad s toothpaste"), "dad toothpaste");
});

test("normalise applies the python abbreviations", () => {
  assert.equal(normalise("16 ounce cups"), "16 oz cup");
  assert.equal(normalise("doctor fizz"), "dr fizz");
});

test("normalise drops the wider python stopword set", () => {
  assert.equal(normalise("some bread and butter"), "bread butter");
});

test("normalise drops accents without splitting the word", () => {
  assert.equal(normalise("Jalapeño"), "jalapeno");
});

test("the catalog key for a possessive phrase is reachable", () => {
  // The sample holds "dad toothpaste". Proves the parity fix is
  // what makes that row match.
  const { aliases } = catalogLookup(LIVE);
  assert.ok(aliases["dad toothpaste"], "sample catalog lost its possessive key");
  assert.equal(normalise("Dad's toothpaste"), "dad toothpaste");
});

// --- suggestions for an already-matched row ---------------------------------
test("the closest match leads, with frequency only breaking ties", () => {
  const slim = {
    items: [
      { id: "1", name: "Brightsmile Toothpaste 2.6 oz", thumb: "https://i5.walmartimages.com/a.jpeg", phrases: ["dad toothpaste"], bought: 2 },
      { id: "2", name: "Brightsmile Toothpaste 4.8 oz", thumb: "https://i5.walmartimages.com/b.jpeg", phrases: [], bought: 9 },
      { id: "3", name: "Sour Cream", thumb: "", phrases: ["sour cream"], bought: 50 },
    ],
  };
  const out = suggestProducts(slim, "Dad's toothpaste");
  // Item 1 carries the alias "dad toothpaste", so it matches BOTH words
  // and is literally Dad's toothpaste. Item 2 matches only
  // "toothpaste" and used to lead purely by being bought more often.
  // That is the ordering that buried the right answer on the tablet.
  assert.deepEqual(out.map((c) => c.item_id), ["1", "2"]);
  assert.equal(out[0].title, "Brightsmile Toothpaste 2.6 oz");
  assert.equal(out[0].thumbnail, "https://i5.walmartimages.com/a.jpeg");
  // A frequency score is not a count of shopping trips, so it is not shown.
  assert.equal(out[0].bought, undefined);
});

test("a phrase with nothing in common suggests nothing at all", () => {
  const slim = {
    items: [
      { id: "1", name: "Sour Cream", phrases: [], bought: 1 },
      { id: "2", name: "Milk", phrases: [], bought: 7 },
    ],
  };
  const out = suggestProducts(slim, "zzzqqq", 20);
  // Deliberately empty rather than the whole catalog by purchase frequency.
  // Dumping every item reads as the matcher having given up, and the useful
  // next step for a product we have never bought is Search Walmart.
  assert.deepEqual(out, []);
});

test("suggestions cap at the limit and tolerate the full catalog shape", () => {
  const out = suggestProducts(LIVE, "milk", 3);
  assert.ok(out.length > 0 && out.length <= 3);
  assert.deepEqual(suggestProducts(CATALOG, "milk"), []);
  assert.deepEqual(suggestProducts(null, "milk"), []);
});

// --- what "what we buy" actually puts on the list -----------------------
const TAPPED_CATALOG = {
  items: [
    { id: "80000006", name: "Value Pantry Tomato Paste, 6 oz",
      phrases: ["tomato paste"], thumb: "https://i5.walmartimages.com/a.jpg",
      bought: 3 },
    { id: "80000000015",
      name: "Everyday Makeup Remover Cleansing Towelettes, 80 Count",
      phrases: ["cleansing towelette"], thumb: null, bought: null },
  ],
  skip_phrases: [],
};

test("a product name on the list resolves, because that is what a tile adds", () => {
  // The catalog card sends item.name, so nine items tapped from the grid read
  // "no match yet" and would have carted nothing.
  const rows = buildRows({
    items: [{ uid: "1", summary: "Value Pantry Tomato Paste, 6 oz" }],
    catalog: TAPPED_CATALOG,
    pending: [],
  });
  assert.equal(rows[0].status, "matched");
  assert.equal(rows[0].productName, "Value Pantry Tomato Paste, 6 oz");
});

test("the phrase still resolves, so voice adds are unaffected", () => {
  const rows = buildRows({
    items: [{ uid: "1", summary: "tomato paste" }],
    catalog: TAPPED_CATALOG,
    pending: [],
  });
  assert.equal(rows[0].status, "matched");
});

test("an unknown phrase is still unmatched", () => {
  const rows = buildRows({
    items: [{ uid: "1", summary: "paper plates" }],
    catalog: TAPPED_CATALOG,
    pending: [],
  });
  assert.equal(rows[0].status, "unmatched");
});

// --- suggestion ranking -------------------------------------------------
test("the best-matching product outranks a popular one that shares one word", () => {
  // The real failure: "80 count" contributed the word "count", which appears
  // in dozens of names, and sorting by purchase frequency put eggs and hot
  // dog buns above the one product that matched five words.
  const catalog = {
    items: [
      { id: "eggs", name: "Value Pantry Large White Eggs, 12 Count",
        phrases: ["eggs"], bought: 40 },
      { id: "buns", name: "Value Pantry Hot Dog Buns, White, 11 oz, 8 Count",
        phrases: ["hot dog buns"], bought: 30 },
      { id: "everyday",
        name: "Everyday Makeup Remover Cleansing Towelettes, 80 Count",
        phrases: ["cleansing towelette"], bought: null },
    ],
    skip_phrases: [],
  };
  const out = suggestProducts(
    catalog, "Everyday makeup remover cleansing towelettes, 80 count");
  assert.equal(out[0].item_id, "everyday",
    "the item matching five words must come first, not the popular one " +
    "matching only \"count\"");
});

test("frequency still breaks ties between equally good matches", () => {
  const catalog = {
    items: [
      { id: "rare", name: "Tomato Paste", phrases: [], bought: 1 },
      { id: "often", name: "Tomato Paste", phrases: [], bought: 25 },
    ],
    skip_phrases: [],
  };
  const out = suggestProducts(catalog, "tomato paste");
  assert.equal(out[0].item_id, "often");
});

test("a phrase matching nothing offers nothing rather than everything", () => {
  const catalog = {
    items: [{ id: "a", name: "Bananas", phrases: ["bananas"], bought: 9 }],
    skip_phrases: [],
  };
  const out = suggestProducts(catalog, "zzzz nonexistent");
  // This used to assert the opposite, on the theory that an empty sheet
  // leaves you stuck. It does not: the sheet now says no recently purchased
  // item matched and points at Search Walmart, which is the only thing that
  // can find a product the house has never bought. Offering bananas for
  // "melatonin" was not a suggestion, it was noise with a tap target.
  assert.deepEqual(out, []);
});
