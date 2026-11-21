// ha/www/kitchen/ingredients.js
/**
 * What this week's planned meals need.
 *
 * Deliberately NOT connected to the Walmart list. Turning "2 eggs" into a
 * specific SKU from a catalog of 449 purchased products is a different and
 * much harder problem than showing a list, and it is parked as v.Next.
 *
 * Consolidation degrades rather than fails. Mealie stores an ingredient as a
 * quantity, a unit and a food ONLY after its ingredient parser has run; until
 * then the whole line sits in `note` as text. So:
 *
 *   parsed, same unit      "onion" 1 + 2        -> 3 onion
 *   parsed, mixed units    "milk" 1 cup, 2 tbsp -> milk: 1 cup, 2 tablespoons
 *   not parsed             two raw strings      -> listed separately
 *
 * That means the page is useful today and gets tidier on its own as recipes
 * are parsed, with no further work here.
 */
import { escapeHtml, tidyAmounts } from "./html.js";

/**
 * The name of a food or unit, however Home Assistant chose to serialise it.
 *
 * The Mealie integration returns `food` as a plain string but `unit` as the
 * PYTHON REPR of a dict: "{'id': '19157...', 'name': 'tablespoon', ...}".
 * Reading .name off that gives undefined, which is why units disappeared from
 * this page the moment a recipe was parsed and "2 tablespoons olive oil"
 * became "2 olive oil".
 */
export function nameOf(value) {
  if (!value) return "";
  if (typeof value === "object") return String(value.name || "");
  const text = String(value);
  if (text.startsWith("{")) {
    const hit = text.match(/'name':\s*'([^']*)'/);
    return hit ? hit[1] : "";
  }
  return text;
}

/** A stable key for grouping: the food name, else the raw text. */
function keyOf(ing) {
  const food = ing && nameOf(ing.food);
  if (food) return `food:${String(food).trim().toLowerCase()}`;
  const note = (ing && (ing.note || ing.display)) || "";
  return `raw:${String(note).trim().toLowerCase()}`;
}

function unitOf(ing) {
  return nameOf(ing && ing.unit).trim().toLowerCase();
}

/** Drop a trailing .0 so 3 reads as "3" rather than "3.0". */
export function tidyQty(n) {
  if (!n && n !== 0) return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  return Number.isInteger(num) ? String(num) : String(Math.round(num * 100) / 100);
}

/**
 * recipes: [{ name, ingredients: [...] }]
 * Returns [{ label, amounts: [...], from: [recipe names], parsed: bool }]
 */
export function consolidate(recipes) {
  const groups = new Map();
  for (const recipe of recipes || []) {
    for (const ing of (recipe && recipe.ingredients) || []) {
      if (!ing) continue;
      const key = keyOf(ing);
      if (!groups.has(key)) {
        const foodName = nameOf(ing.food);
        groups.set(key, {
          key,
          label: foodName || (ing.note || ing.display || "").trim(),
          parsed: Boolean(foodName),
          units: new Map(),
          from: [],
          notes: [],
        });
      }
      const g = groups.get(key);
      const unit = unitOf(ing);
      const qty = Number(ing.quantity) || 0;
      // Quantities only add up within the same unit. A cup and a tablespoon
      // are the same food but not the same number.
      if (g.parsed && qty) {
        g.units.set(unit, (g.units.get(unit) || 0) + qty);
      }
      const from = (recipe && recipe.name) || "";
      if (from && !g.from.includes(from)) g.from.push(from);
      const note = (ing.note || "").trim();
      if (g.parsed && note && !g.notes.includes(note)) g.notes.push(note);
    }
  }

  return [...groups.values()]
    .map((g) => ({
      key: g.key,
      label: g.label,
      parsed: g.parsed,
      from: g.from,
      notes: g.notes,
      amounts: [...g.units.entries()]
        .map(([unit, qty]) => `${tidyQty(qty)}${unit ? " " + unit : ""}`.trim())
        .filter(Boolean),
    }))
    // Parsed entries first: they are the tidy ones, and seeing them grouped is
    // the argument for parsing the rest.
    .sort((a, b) => (b.parsed - a.parsed)
      || a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

/** state: { recipes, loading, error, planned } */
export function ingredientsBody(state) {
  const { recipes = null, loading = false, error = null, planned = 0,
          checked = [] } = state || {};
  if (error) {
    return `<div class="card pcard"><div class="problem">${
      escapeHtml(error)}</div></div>`;
  }
  if (loading || !recipes) {
    return `<div class="card pcard"><p class="empty">
      Gathering this week's ingredients...</p></div>`;
  }
  if (!planned) {
    return `<div class="card pcard">
      <div class="phead"><h2>Ingredients</h2></div>
      <p class="empty">Nothing is planned this week, so there is nothing to
      buy for it. Plan some meals on Weekly Menu.</p></div>`;
  }

  const rows = consolidate(recipes);
  const unparsed = rows.filter((r) => !r.parsed).length;

  // Which recipes wanted it is deliberately NOT shown. Once a week is
  // consolidated, "3 eggs" comes from three recipes and listing them turns a
  // shopping list back into a pile of recipes. The data is still carried on
  // each row in case a later view wants it.
  const list = rows.map((r) => {
    const got = checked.includes(r.key);
    return `
    <li class="ingrow${got ? " got" : ""}" data-key="${escapeHtml(r.key)}">
      <button class="tick" role="checkbox" aria-checked="${got}"
              title="${got ? "We do not have this" : "We already have this"}"
              >${got ? "&#10003;" : ""}</button>
      <span class="ingamt">${escapeHtml(r.amounts.join(", "))}</span>
      <span class="inglabel">${escapeHtml(tidyAmounts(r.label))}</span>
    </li>`;
  }).join("");

  return `
    <div class="card pcard">
      <div class="phead">
        <h2>Ingredients</h2>
        <span class="pmeta">${
          checked.length
            ? `${rows.length - checked.filter((k) =>
                 rows.some((r) => r.key === k)).length} to buy of ${rows.length}`
            : `${rows.length} from ${planned} meal${planned === 1 ? "" : "s"}`
        }</span>
      </div>
      <div class="tickbar">
        <button class="chip" id="tick-all">Check all</button>
        <button class="chip" id="tick-none">Uncheck all</button>
      </div>
      <ul class="inglist">${list}</ul>
      ${unparsed ? `
        <div class="parsebar">
          <p class="match">${unparsed} of these could not be combined, because
          those recipes have not had their ingredients parsed yet. Parsing
          reads each line into an amount, a unit and a food, which is what
          lets them add up.</p>
          <button class="chip" id="parse-week">Parse this week's ingredients</button>
          <p class="match" id="parse-msg"></p>
        </div>` : ""}
    </div>`;
}
