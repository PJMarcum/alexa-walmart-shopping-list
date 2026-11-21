import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidate, tidyQty, ingredientsBody }
  from "../../ha/www/kitchen/ingredients.js";

const parsed = (food, qty, unit, from) => ({
  food: { name: food }, quantity: qty, unit: unit ? { name: unit } : null,
});

test("the same food in the same unit adds up across days", () => {
  // Monday needs 2 eggs and Tuesday needs 1, so the week
  // needs 3.
  const out = consolidate([
    { name: "Monday dinner", ingredients: [parsed("egg", 2, "")] },
    { name: "Tuesday dinner", ingredients: [parsed("egg", 1, "")] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].label, "egg");
  assert.deepEqual(out[0].amounts, ["3"]);
  assert.deepEqual(out[0].from, ["Monday dinner", "Tuesday dinner"]);
});

test("the same food in DIFFERENT units is grouped but not summed", () => {
  // A cup and a tablespoon are the same food and not the same number.
  const out = consolidate([
    { name: "A", ingredients: [parsed("milk", 1, "cup")] },
    { name: "B", ingredients: [parsed("milk", 2, "tablespoon")] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].amounts.length, 2);
  assert.ok(out[0].amounts.includes("1 cup"));
  assert.ok(out[0].amounts.includes("2 tablespoon"));
});

test("unparsed lines are listed separately, because they cannot be compared", () => {
  // This is every recipe today: quantity 0, no food, the line in `note`.
  const out = consolidate([
    { name: "A", ingredients: [{ note: "2 eggs", quantity: 0 }] },
    { name: "B", ingredients: [{ note: "1 egg", quantity: 0 }] },
  ]);
  assert.equal(out.length, 2, "two different strings are two different things");
  assert.equal(out.every((r) => r.parsed === false), true);
});

test("an identical unparsed line from two recipes is still one row", () => {
  const out = consolidate([
    { name: "A", ingredients: [{ note: "salt to taste", quantity: 0 }] },
    { name: "B", ingredients: [{ note: "salt to taste", quantity: 0 }] },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].from, ["A", "B"]);
});

test("parsed rows come first, so the tidy ones lead", () => {
  const out = consolidate([
    { name: "A", ingredients: [
      { note: "zzz unparsed thing", quantity: 0 },
      parsed("apple", 1, ""),
    ] },
  ]);
  assert.equal(out[0].parsed, true);
  assert.equal(out[1].parsed, false);
});

test("quantities read as numbers a person would write", () => {
  assert.equal(tidyQty(3), "3");
  assert.equal(tidyQty(3.0), "3");
  assert.equal(tidyQty(1.25), "1.25");
  // 1/3 arrives from AllRecipes as a 32-bit float.
  assert.equal(tidyQty(0.33333334326744), "0.33");
  assert.equal(tidyQty(null), "");
});

test("nothing planned says so rather than showing an empty list", () => {
  const html = ingredientsBody({ recipes: [], planned: 0 });
  assert.match(html, /Nothing is planned this week/);
});

test("the page explains why some lines did not combine, and offers the fix", () => {
  const html = ingredientsBody({
    recipes: [{ name: "A", ingredients: [{ note: "2 eggs", quantity: 0 }] }],
    planned: 1,
  });
  assert.match(html, /not had their ingredients parsed/);
  assert.match(html, /id="parse-week"/);
});

test("a fully parsed week offers no parse button and does not nag", () => {
  const html = ingredientsBody({
    recipes: [{ name: "A", ingredients: [parsed("egg", 2, "")] }],
    planned: 1,
  });
  assert.doesNotMatch(html, /not had their ingredients parsed/);
  assert.doesNotMatch(html, /id="parse-week"/);
});

test("an ingredient name cannot inject markup", () => {
  const html = ingredientsBody({
    recipes: [{ name: "A", ingredients: [{ note: "<img src=x>", quantity: 0 }] }],
    planned: 1,
  });
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;img/);
});

test("the row does not name the recipes it came from", () => {
  // Consolidated, "3 eggs" comes from several recipes, and listing them turns
  // a shopping list back into a pile of recipes.
  const html = ingredientsBody({
    recipes: [
      { name: "Monday dinner", ingredients: [parsed("egg", 2, "")] },
      { name: "Chef Rita's Lasagna", ingredients: [parsed("egg", 1, "")] },
    ],
    planned: 2,
  });
  assert.match(html, />3</);                    // the amount
  assert.doesNotMatch(html, /Chef Rita's Lasagna/);
  assert.doesNotMatch(html, /Monday dinner/);
});

// --- Home Assistant's serialisation --------------------------------------
import { nameOf } from "../../ha/www/kitchen/ingredients.js";

const REPR = "{'id': '19157faf-aa98-404b-b7f1-fdc2c51b8622', 'name': " +
             "'tablespoon', 'pluralName': 'tablespoons', 'fraction': True}";

test("a unit serialised as a python dict repr still yields its name", () => {
  // The Mealie integration returns food as a string but unit as the repr of a
  // dict, so .name is undefined and units vanished once a recipe was parsed.
  assert.equal(nameOf(REPR), "tablespoon");
});

test("a real object and a plain string both work", () => {
  assert.equal(nameOf({ name: "cup" }), "cup");
  assert.equal(nameOf("onion"), "onion");
  assert.equal(nameOf(null), "");
});

test("the unit survives into the consolidated amount", () => {
  const out = consolidate([
    { name: "A", ingredients: [
      { food: "olive oil", unit: REPR, quantity: 2 }] },
  ]);
  assert.deepEqual(out[0].amounts, ["2 tablespoon"]);
  assert.equal(out[0].label, "olive oil");
});

test("two recipes using the same unit still add up", () => {
  const out = consolidate([
    { name: "A", ingredients: [{ food: "olive oil", unit: REPR, quantity: 2 }] },
    { name: "B", ingredients: [{ food: "olive oil", unit: REPR, quantity: 1 }] },
  ]);
  assert.deepEqual(out[0].amounts, ["3 tablespoon"]);
});

// --- ticking things off --------------------------------------------------
test("every row carries a stable key the tick can be stored against", () => {
  const html = ingredientsBody({
    recipes: [{ name: "A", ingredients: [parsed("egg", 2, "")] }],
    planned: 1,
  });
  assert.match(html, /data-key="food:egg"/);
  assert.match(html, /class="tick"/);
});

test("a ticked row is marked, and the heading counts what is left to buy", () => {
  const recipes = [{ name: "A", ingredients: [
    parsed("egg", 2, ""), parsed("milk", 1, "cup")] }];
  const html = ingredientsBody({ recipes, planned: 1, checked: ["food:egg"] });
  assert.match(html, /class="ingrow got"/);
  assert.match(html, /1 to buy of 2/);
});

test("the same key groups across recipes, so one tick covers the week", () => {
  // Eggs on Monday and Tuesday are one row, so ticking it off means the
  // household has enough for both.
  const out = consolidate([
    { name: "A", ingredients: [parsed("egg", 2, "")] },
    { name: "B", ingredients: [parsed("egg", 1, "")] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "food:egg");
});

test("an unparsed line still gets a key, so it can be ticked too", () => {
  const out = consolidate([
    { name: "A", ingredients: [{ note: "salt to taste", quantity: 0 }] },
  ]);
  assert.equal(out[0].key, "raw:salt to taste");
});
