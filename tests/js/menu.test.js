import { test } from "node:test";
import assert from "node:assert/strict";
import { weekDays, isoDate, entriesFor, dinnerFor, titleOf, menuBody }
  from "../../ha/www/kitchen/menu.js";
import { filterRecipes, formatMeta, recipesBody, recipeDetailBody }
  from "../../ha/www/kitchen/recipes.js";

// --- the week ------------------------------------------------------------
test("the week starts on SATURDAY, so Friday's order closes its own week", () => {
  // The groceries are ordered Friday morning. A Saturday start makes Friday
  // the last act of the old week rather than something floating in the middle
  // of the new one: plan Friday, order Friday, new week begins Saturday.
  const days = weekDays(new Date(2026, 9, 3));   // a Saturday
  assert.equal(days.length, 7);
  assert.equal(days[0].iso, "2026-10-03");   // Saturday
  assert.equal(days[6].iso, "2026-10-09");   // Friday
});

test("Friday belongs to the week that is ending, not the one beginning", () => {
  // This is the whole point of the Saturday boundary: the order is placed on
  // the last day of the week it was planned for.
  const days = weekDays(new Date(2026, 9, 2));   // Friday
  assert.equal(days[0].iso, "2026-09-26");
  assert.equal(days[6].iso, "2026-10-02");
  assert.equal(days[6].isToday, true);
});

test("Sunday looks BACK to Saturday, not forward", () => {
  // Sunday is getDay() 0, so naive arithmetic throws it into the wrong week
  // and the page shows days that have not happened.
  const days = weekDays(new Date(2026, 9, 4));   // Sunday
  assert.equal(days[0].iso, "2026-10-03");
  assert.equal(days[1].isToday, true);
});

test("Saturday is its own week start", () => {
  const days = weekDays(new Date(2026, 9, 3));   // Saturday
  assert.equal(days[0].iso, "2026-10-03");
  assert.equal(days[0].isToday, true);
});

test("exactly one day is today", () => {
  const days = weekDays(new Date(2026, 9, 3));
  assert.equal(days.filter((d) => d.isToday).length, 1);
});

test("the date is LOCAL, so late evening does not roll to tomorrow", () => {
  // toISOString() would report the 4th for 23:30 local in a western zone,
  // putting tonight's dinner on the wrong day exactly when it is being cooked.
  assert.equal(isoDate(new Date(2026, 9, 3, 23, 30)), "2026-10-03");
  assert.equal(isoDate(new Date(2026, 9, 3, 0, 15)), "2026-10-03");
});

// --- plan entries --------------------------------------------------------
const PLAN = [
  { mealplan_date: "2026-10-03", entry_type: "dinner",
    recipe: { name: "Homemade Chili", slug: "homemade-chili" } },
  { mealplan_date: "2026-10-03", entry_type: "side",
    recipe: { name: "Corn Ribs", slug: "corn-ribs" } },
  { mealplan_date: "2026-10-04", entry_type: "dinner",
    title: "Leftovers" },
];

test("entries are filtered to the day asked for", () => {
  assert.equal(entriesFor(PLAN, "2026-10-03").length, 2);
  assert.equal(entriesFor(PLAN, "2026-10-05").length, 0);
});

test("dinner leads the day, because it is the meal people ask about", () => {
  assert.equal(entriesFor(PLAN, "2026-10-03")[0].entry_type, "dinner");
});

test("tonight's dinner is found for the rail", () => {
  const d = dinnerFor(PLAN, "2026-10-03");
  assert.equal(d.title, "Homemade Chili");
  assert.equal(d.slug, "homemade-chili");
});

test("no dinner planned returns null rather than an empty-looking object", () => {
  assert.equal(dinnerFor(PLAN, "2026-10-09"), null);
  assert.equal(dinnerFor([], "2026-10-03"), null);
});

test("a free-text note renders as well as a recipe", () => {
  // Mealie lets you plan "Leftovers" without attaching a recipe.
  assert.equal(titleOf(PLAN[2]), "Leftovers");
  assert.equal(titleOf(PLAN[0]), "Homemade Chili");
  assert.equal(titleOf(null), "");
});

test("the week renders every day, planned or not", () => {
  const html = menuBody({ mealplan: PLAN, today: new Date(2026, 9, 3) });
  assert.match(html, /Homemade Chili/);
  assert.match(html, /Nothing planned/);          // the unplanned days
  // Anchored on the closing quote, or it also counts "dayhead".
  assert.equal((html.match(/class="day(?: today)?"/g) || []).length, 7);
});

// --- recipes -------------------------------------------------------------
const RECIPES = [
  { name: "Homemade Chili", slug: "homemade-chili", total_time: "4 hours",
    recipe_servings: 12, tags: [{ name: "Publisher-Tested" }],
    description: "A hearty beef chili" },
  { name: "Corn Ribs", slug: "corn-ribs", total_time: "30 minutes",
    recipe_servings: 4, tags: [], description: "" },
];

test("search covers the name", () => {
  assert.deepEqual(filterRecipes(RECIPES, "corn").map((r) => r.slug),
                   ["corn-ribs"]);
});

test("search also covers description and tags", () => {
  assert.deepEqual(filterRecipes(RECIPES, "hearty").map((r) => r.slug),
                   ["homemade-chili"]);
  assert.deepEqual(filterRecipes(RECIPES, "publisher").map((r) => r.slug),
                   ["homemade-chili"]);
});

test("an empty query returns everything", () => {
  assert.equal(filterRecipes(RECIPES, "").length, 2);
  assert.equal(filterRecipes(RECIPES).length, 2);
});

test("meta omits what the recipe does not publish", () => {
  // Potato Cheese Soup came in with total_time: none.
  assert.equal(formatMeta({ total_time: "30 minutes", recipe_servings: 4 }),
               "30 minutes · serves 4");
  assert.equal(formatMeta({ recipe_servings: 4 }), "serves 4");
  assert.equal(formatMeta({}), "");
});

test("the detail view puts ingredients before method", () => {
  const html = recipeDetailBody({
    name: "Corn Ribs",
    ingredients: [{ note: "4 ears fresh corn" }],
    instructions: [{ text: "Cut the corn." }],
  });
  assert.ok(html.indexOf("Ingredients") < html.indexOf("Method"),
    "ingredients must come first: it is what you re-read while cooking");
  assert.match(html, /4 ears fresh corn/);
  assert.match(html, /Cut the corn\./);
});

test("a recipe with nothing recorded says so rather than rendering blank", () => {
  const html = recipeDetailBody({ name: "Empty", ingredients: [], instructions: [] });
  assert.match(html, /No ingredients recorded/);
  assert.match(html, /No steps recorded/);
});

test("a recipe title cannot inject markup", () => {
  const html = recipeDetailBody({ name: '<script>x</script>', ingredients: [] });
  assert.doesNotMatch(html, /<script>/);
});

test("the list says loading and empty differently", () => {
  assert.match(recipesBody({ items: null, loading: true }), /Loading recipes/);
  assert.match(recipesBody({ items: [] }), /No recipes yet/);
  assert.match(recipesBody({ items: RECIPES, query: "zzz" }), /Nothing matches/);
});

test("a planned meal carries a remove control and its id", () => {
  // Without this a mis-tap was unfixable from the kitchen: tapping a planned
  // row opens the planner, and set_mealplan ADDS rather than replaces, so the
  // second tap gave the day two dinners.
  const html = menuBody({
    mealplan: [{ mealplan_date: "2026-10-03", entry_type: "dinner",
                 mealplan_id: 7, recipe: { name: "Homemade Chili" } }],
    today: new Date(2026, 9, 3),
  });
  assert.match(html, /class="unplan"[^>]*data-planid="7"/);
});

test("an entry with no id still renders rather than breaking the week", () => {
  const html = menuBody({
    mealplan: [{ mealplan_date: "2026-10-03", entry_type: "dinner",
                 title: "Leftovers" }],
    today: new Date(2026, 9, 3),
  });
  assert.match(html, /Leftovers/);
  assert.match(html, /data-planid=""/);
});

test("a planned meal carries its recipe slug, so tapping it can open it", () => {
  const html = menuBody({
    mealplan: [{ mealplan_date: "2026-10-03", entry_type: "dinner",
                 mealplan_id: 7,
                 recipe: { name: "Homemade Chili", slug: "homemade-chili" } }],
    today: new Date(2026, 9, 3),
  });
  assert.match(html, /data-slug="homemade-chili"/);
});

test("a note with no recipe carries an empty slug, so the tap does nothing", () => {
  const html = menuBody({
    mealplan: [{ mealplan_date: "2026-10-03", entry_type: "dinner",
                 mealplan_id: 8, title: "Leftovers" }],
    today: new Date(2026, 9, 3),
  });
  assert.match(html, /data-slug=""/);
});

test("tonight's dinner carries what the picture needs", () => {
  // The rail shows the main dish, so it needs the recipe id and Mealie's
  // image token, not just a title.
  const d = dinnerFor([{
    mealplan_date: "2026-10-03", entry_type: "dinner",
    recipe: { name: "Homemade Chili", slug: "homemade-chili",
              recipe_id: "53cc988b", image: "fslr" },
  }], "2026-10-03");
  assert.equal(d.recipeId, "53cc988b");
  assert.equal(d.image, "fslr");
  assert.equal(d.slug, "homemade-chili");
});

test("a side is never chosen as tonight's dish", () => {
  // A day can hold a main and a side; the picture must be the main.
  const plan = [
    { mealplan_date: "2026-10-03", entry_type: "side",
      recipe: { name: "Corn Ribs", slug: "corn-ribs", recipe_id: "aaa" } },
    { mealplan_date: "2026-10-03", entry_type: "dinner",
      recipe: { name: "Homemade Chili", slug: "homemade-chili", recipe_id: "bbb" } },
  ];
  assert.equal(dinnerFor(plan, "2026-10-03").title, "Homemade Chili");
});

test("a day with only a side has no dinner to show", () => {
  const plan = [{ mealplan_date: "2026-10-03", entry_type: "side",
                  recipe: { name: "Corn Ribs", recipe_id: "aaa" } }];
  assert.equal(dinnerFor(plan, "2026-10-03"), null);
});

// --- stepping between weeks ----------------------------------------------
test("the week can be stepped forward and back", () => {
  // Planning looks forward, so any fixed start day eventually sits between
  // someone and the day they mean. Stepping is what dissolves that.
  const now = new Date(2026, 9, 3);
  assert.equal(weekDays(now, 0)[0].iso, "2026-10-03");
  assert.equal(weekDays(now, 1)[0].iso, "2026-10-10");
  assert.equal(weekDays(now, -1)[0].iso, "2026-09-26");
  assert.equal(weekDays(now, 2)[6].iso, "2026-10-23");
});

test("today is highlighted only in the week that contains it", () => {
  const now = new Date(2026, 9, 3);
  assert.equal(weekDays(now, 0).filter((d) => d.isToday).length, 1);
  assert.equal(weekDays(now, 1).filter((d) => d.isToday).length, 0);
  assert.equal(weekDays(now, -1).filter((d) => d.isToday).length, 0);
});

test("the header names the week so a plan cannot land unnoticed", () => {
  const now = new Date(2026, 9, 3);
  assert.match(menuBody({ mealplan: [], today: now, offset: 0 }), /This week/);
  assert.match(menuBody({ mealplan: [], today: now, offset: 1 }), /Next week/);
  assert.match(menuBody({ mealplan: [], today: now, offset: -1 }), /Last week/);
  assert.match(menuBody({ mealplan: [], today: now, offset: 3 }), /\+3 weeks/);
});

test("stepping shows that week's plan, not this week's", () => {
  const plan = [{ mealplan_date: "2026-10-12", entry_type: "dinner",
                  recipe: { name: "Next week dinner" } }];
  const now = new Date(2026, 9, 3);
  assert.doesNotMatch(menuBody({ mealplan: plan, today: now, offset: 0 }),
                      /Next week dinner/);
  assert.match(menuBody({ mealplan: plan, today: now, offset: 1 }),
               /Next week dinner/);
});

// --- the week label is shared with the planner sheet ---------------------
import { weekLabel } from "../../ha/www/kitchen/menu.js";

test("the week label names the near weeks and counts the far ones", () => {
  // Extracted from menuBody so the planner sheet opened from a recipe says
  // exactly what the Weekly Menu page says. Two phrasings for the same week
  // is how a meal lands on the wrong Saturday.
  assert.equal(weekLabel(0), "This week");
  assert.equal(weekLabel(1), "Next week");
  assert.equal(weekLabel(-1), "Last week");
  assert.equal(weekLabel(3), "+3 weeks");
  assert.equal(weekLabel(-2), "-2 weeks");
});

test("the Weekly Menu heading still uses that same label", () => {
  const now = new Date(2026, 9, 3);
  for (const offset of [0, 1, -1, 4]) {
    // includes(), not match(): "+4 weeks" is not a valid regular expression.
    assert.ok(menuBody({ mealplan: [], today: now, offset })
      .includes(weekLabel(offset)), `offset ${offset} missing its label`);
  }
});

// --- courses: what the household calls them vs what Mealie stores --------
import { COURSES, courseLabel } from "../../ha/www/kitchen/menu.js";

test("the planner offers Main, Side and Dessert, in that order", () => {
  // "Dinner" was wrong: dinner is the whole meal, main is the course in it.
  assert.deepEqual(COURSES.map((c) => c.label), ["Main", "Side", "Dessert"]);
});

test("Main is STORED as Mealie's dinner, because the rail keys on that", () => {
  // Mealie's entry_type vocabulary is fixed, and dinnerFor() picks the day's
  // picture by entry_type === "dinner". Storing "main" would leave every day
  // on the rail with no picture.
  assert.deepEqual(COURSES.map((c) => c.value), ["dinner", "side", "dessert"]);
});

test("a stored entry_type is shown under the household's name for it", () => {
  assert.equal(courseLabel("dinner"), "Main");
  assert.equal(courseLabel("side"), "Side");
  assert.equal(courseLabel("dessert"), "Dessert");
});

test("a type the planner never writes is still shown, not swallowed", () => {
  // Mealie has six types and something planned in Mealie itself, or before
  // this panel existed, must not render as a blank row.
  assert.equal(courseLabel("breakfast"), "breakfast");
  assert.equal(courseLabel(""), "");
  assert.equal(courseLabel(null), "");
});

test("the Weekly Menu lists a planned main as Main, not as dinner", () => {
  const now = new Date(2026, 9, 3);
  const plan = [{ mealplan_date: "2026-10-03", entry_type: "dinner",
                  recipe: { name: "Homemade Chili" } }];
  const html = menuBody({ mealplan: plan, today: now, offset: 0 });
  assert.match(html, /class="mealtype">Main</);
  assert.doesNotMatch(html, /class="mealtype">dinner</);
});

test("a dessert never becomes the day's picture on the rail", () => {
  // Three courses can share a day now, and the rail shows one picture.
  const plan = [{ mealplan_date: "2026-10-03", entry_type: "dessert",
                  recipe: { name: "Peach Cobbler" } }];
  assert.equal(dinnerFor(plan, "2026-10-03"), null);
});

// --- naming the day a dinner is being planned for ------------------------
import { dayTitle } from "../../ha/www/kitchen/menu.js";

test("a day reads as a weekday and a date, not as an ISO string", () => {
  // The day planner's heading was the bare "2026-10-04", which is the one
  // thing on the sheet you already know and the hardest way to read it.
  assert.equal(dayTitle("2026-10-04"), "Sunday, Oct 4");
  assert.equal(dayTitle("2026-12-25"), "Friday, Dec 25");
});

test("the date is parsed in local time, so it never lands a day early", () => {
  // new Date("2026-10-04") is UTC midnight, which is Oct 3 in Central time.
  // Every day on this panel is a local date.
  assert.match(dayTitle("2026-10-04"), /Oct 4/);
  assert.match(dayTitle("2026-01-01"), /Jan 1/);
});

test("something that is not a date is shown as-is rather than as Invalid Date", () => {
  assert.equal(dayTitle(""), "");
  assert.equal(dayTitle(null), "");
  assert.equal(dayTitle("not-a-date"), "not-a-date");
});

// --- leaving the panel on purpose ---------------------------------------

test("the Recipes page offers AllRecipes, as a real link not a button", () => {
  // It has to be an anchor with a plain https href. Fully Kiosk decides what
  // to do with a URL by matching the URL, so anything clever here (a click
  // handler, a javascript: href) would never reach its rules at all.
  const html = recipesBody({ items: [], query: "" });
  assert.match(html, /<a[^>]+href="https:\/\/www\.allrecipes\.com\/"/);
  assert.match(html, /AllRecipes/);
});

test("the AllRecipes link cannot be used to reach the opener", () => {
  // rel=noopener: the target page must not get a handle on this one.
  const html = recipesBody({ items: [], query: "" });
  const tag = html.match(/<a[^>]+allrecipes[^>]*>/)[0];
  assert.match(tag, /rel="noopener"/);
});

test("it is offered even while the recipe list is still loading", () => {
  // Going to look for a new recipe does not depend on the old ones arriving.
  assert.match(recipesBody({ loading: true }), /allrecipes\.com/);
});

test("but not when the page is showing an error", () => {
  // The error card replaces the whole body; a stray link would sit oddly.
  assert.doesNotMatch(recipesBody({ error: "Mealie is unreachable" }),
                      /allrecipes\.com/);
});
