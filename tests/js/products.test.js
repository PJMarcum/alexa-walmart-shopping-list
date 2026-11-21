import { test } from "node:test";
import assert from "node:assert/strict";
import { filterProducts, productsBody } from "../../ha/www/kitchen/products.js";
import { escapeHtml, safeUrl, formatBought } from "../../ha/www/kitchen/html.js";

const ITEMS = [
  { id: "1", name: "Strongbag Flex Tall Kitchen Drawstring Trash Bags, 13 Gal",
    category: "Household Essentials", phrases: ["trash bags"], bought: 6,
    thumb: "https://i5.walmartimages.com/seo/a.jpeg",
    url: "https://www.walmart.com/ip/1" },
  { id: "2", name: "Value Pantry Tomato Paste, 6 oz", category: "Pantry",
    phrases: ["tomato paste"], bought: 2.5, thumb: null,
    url: "https://www.walmart.com/ip/2" },
  { id: "3", name: "Fresh Gala Apple, Each", category: "Fresh Produce",
    phrases: [], bought: null, thumb: null, url: null },
];

test("search matches what you SAY, not only the product name", () => {
  // The whole point of a curated board: nobody says "Strongbag Flex".
  const out = filterProducts(ITEMS, { query: "trash" });
  assert.deepEqual(out.map((i) => i.id), ["1"]);
});

test("search still matches the product name", () => {
  assert.deepEqual(
    filterProducts(ITEMS, { query: "gala" }).map((i) => i.id), ["3"]);
});

test("search is case insensitive, because a tablet keyboard capitalises", () => {
  assert.deepEqual(
    filterProducts(ITEMS, { query: "Tomato" }).map((i) => i.id), ["2"]);
});

test("a category narrows, and combines with the query", () => {
  assert.deepEqual(
    filterProducts(ITEMS, { category: "Pantry" }).map((i) => i.id), ["2"]);
  assert.deepEqual(
    filterProducts(ITEMS, { category: "Pantry", query: "apple" }), []);
});

test("no query and no category returns everything", () => {
  assert.equal(filterProducts(ITEMS, {}).length, 3);
  assert.equal(filterProducts(ITEMS).length, 3);
});

test("a null item list does not throw", () => {
  assert.deepEqual(filterProducts(null, { query: "x" }), []);
});

test("thumbnails are requested at display size, not full resolution", () => {
  // The Lovelace card used the stored URL, so 74 tiles pulled about 22MB.
  const html = productsBody({ items: ITEMS, categories: [], shown: 60 });
  assert.match(html, /odnWidth=240/);
  assert.match(html, /odnHeight=240/);
  assert.doesNotMatch(html, /src="https:\/\/i5\.walmartimages\.com\/seo\/a\.jpeg"/);
});

test("loading and no-results are different messages", () => {
  assert.match(productsBody({ items: null }), /Loading what we buy/);
  assert.match(
    productsBody({ items: ITEMS, query: "zzzz", shown: 60 }),
    /Nothing matches that/);
});

test("the show-more button appears only when something is hidden", () => {
  const some = productsBody({ items: ITEMS, shown: 2, pageSize: 60 });
  assert.match(some, /Show 1 more/);
  const all = productsBody({ items: ITEMS, shown: 60, pageSize: 60 });
  assert.doesNotMatch(all, /Show \d+ more/);
});

test("a product title cannot inject markup", () => {
  // Titles come from Walmart and SerpAPI; neither is ours.
  const nasty = [{ id: "x", name: '<img src=x onerror="alert(1)">',
                   category: "", phrases: [], bought: null, thumb: null,
                   url: null }];
  const html = productsBody({ items: nasty, shown: 60 });
  // The words survive as inert text; what matters is that the angle
  // brackets do not, so the browser never sees a tag to run.
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x/);
});

test("a javascript: url is dropped rather than rendered", () => {
  // The catalog is hand-editable JSON on disk.
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("http://www.walmart.com/ip/1"), "");
  assert.match(safeUrl("https://www.walmart.com/ip/1"), /^https:/);
  assert.equal(safeUrl(null), "");
});

test("a half count reads as a plus, not half a shopping trip", () => {
  assert.equal(formatBought(3), "3");
  assert.equal(formatBought(2.5), "2+");
});

test("escaping covers the characters that break an attribute", () => {
  assert.equal(escapeHtml("<b>"), "&lt;b&gt;");
  assert.match(escapeHtml('a"b'), /&quot;/);
  assert.match(escapeHtml("a'b"), /&#39;/);
});

// --- readable amounts ----------------------------------------------------
import { tidyAmounts } from "../../ha/www/kitchen/html.js";

test("float artifacts are rounded to two decimal places", () => {
  // Straight from the imports: AllRecipes publishes 2/3 like this.
  assert.equal(tidyAmounts("0.66666668653488 cup freshly grated Parmigiano"),
               "0.67 cup freshly grated Parmigiano");
  assert.equal(tidyAmounts("0.33333334326744 cup water"), "0.33 cup water");
});

test("real decimals are left exactly as published", () => {
  // These are how the measurement is properly written, not an artifact, so
  // only three or more decimal places are touched.
  for (const line of ["1.25 pounds Yukon Gold potatoes",
                      "1 (10.5 ounce) can condensed cream of mushroom soup",
                      "16.9 fl oz/500 ml",
                      "0.5 cup chicken stock",
                      "2.6 oz"]) {
    assert.equal(tidyAmounts(line), line);
  }
});

test("a whole number keeps its whole part", () => {
  assert.equal(tidyAmounts("1.3333333 cups flour"), "1.33 cups flour");
});

test("every long number in a line is handled, not just the first", () => {
  assert.equal(tidyAmounts("0.3333333 cup oil and 0.6666667 cup water"),
               "0.33 cup oil and 0.67 cup water");
});

test("text with no numbers is returned unchanged", () => {
  assert.equal(tidyAmounts("salt and ground black pepper to taste"),
               "salt and ground black pepper to taste");
  assert.equal(tidyAmounts(null), "");
});

// --- tapping a tile is a toggle -----------------------------------------
test("a product already on the list is badged, so the second tap is obvious", () => {
  // Without the badge the toggle is a coin flip: you cannot tell whether
  // your tap is about to add or remove.
  const items = [{ id: "1", name: "Sea Salt", phrases: [] },
                 { id: "2", name: "Olive Oil", phrases: [] }];
  const html = productsBody({ items, added: new Set(["1"]) });
  assert.match(html, /class="tile added"[^>]*data-id="1"/);
  assert.match(html, /on list/);
  // The one that is not on the list carries no badge.
  assert.doesNotMatch(html, /class="tile added"[^>]*data-id="2"/);
});

test("with nothing on the list no tile is badged", () => {
  const items = [{ id: "1", name: "Sea Salt", phrases: [] }];
  const html = productsBody({ items, added: new Set() });
  assert.doesNotMatch(html, /on list/);
});
