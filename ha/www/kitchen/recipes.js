// ha/www/kitchen/recipes.js
/**
 * Recipes.
 *
 * Deliberately typographic rather than a wall of photographs. Mealie's images
 * sit behind Ingress at /api/media/recipes/..., and Ingress serves only
 * requests carrying Home Assistant's own session, which an <img> in this panel
 * does not have. A direct request returns 403. Rather than expose Mealie on
 * the LAN to get thumbnails, the detail view is built for the job it actually
 * has: being readable from across a counter with your hands full.
 */
import { escapeHtml, safeUrl, tidyAmounts } from "./html.js";
import { mealieImageUrl } from "./images.js";

/** Name, description and tags, so "chicken" finds the chicken ones. */
export function filterRecipes(items, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return items || [];
  return (items || []).filter((r) => {
    if (!r) return false;
    const hay = [
      r.name || "",
      r.description || "",
      ...(r.tags || []).map((t) => (t && t.name) || ""),
      ...(r.categories || []).map((c) => (c && c.name) || ""),
    ].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

/** "1 hour 25 minutes" as given, or "" so the caller can omit the line. */
export function formatMeta(recipe) {
  const bits = [];
  if (recipe.total_time) bits.push(String(recipe.total_time));
  if (recipe.recipe_servings) {
    const n = Number(recipe.recipe_servings);
    if (n) bits.push(`serves ${Number.isInteger(n) ? n : n.toFixed(0)}`);
  }
  return bits.join(" · ");
}

function card(recipe) {
  const meta = formatMeta(recipe);
  const img = mealieImageUrl(recipe.recipe_id, { version: recipe.image });
  const tags = (recipe.tags || []).slice(0, 3)
    .map((t) => `<span class="phrase">${escapeHtml((t && t.name) || "")}</span>`)
    .join("");
  return `
    <div class="rcard" data-slug="${escapeHtml(recipe.slug || "")}">
      ${img
        ? `<img class="rthumb" loading="lazy" src="${escapeHtml(img)}"
                alt="" onerror="this.remove()">`
        : ""}
      <div class="rname">${escapeHtml(recipe.name || "")}</div>
      ${meta ? `<div class="match">${escapeHtml(meta)}</div>` : ""}
      ${tags ? `<div class="phrases">${tags}</div>` : ""}
    </div>`;
}

/** state: { items, query, loading, error } */
/**
 * Why the AllRecipes link is a plain anchor with a literal https href.
 *
 * On the kitchen tablet, Fully Kiosk decides what to do with a URL by
 * MATCHING THE URL: its whitelist decides whether the page may load at all,
 * and its "links to open in other apps" list decides whether Android gets
 * the URL instead. A click handler calling window.open, or anything built at
 * runtime, never presents a URL for those rules to match. So the markup is
 * deliberately boring.
 *
 * The arrow marks it as leaving the panel, which is the one thing the five
 * nav chips never do.
 */
export function recipesBody(state) {
  const { items = null, query = "", loading = false, error = null } = state || {};
  if (error) {
    return `<div class="card pcard"><div class="problem">${
      escapeHtml(error)}</div></div>`;
  }
  const list = loading || !items ? [] : filterRecipes(items, query);
  let body;
  if (loading || !items) {
    body = `<p class="empty">Loading recipes...</p>`;
  } else if (!list.length) {
    body = `<p class="empty">${
      query ? "Nothing matches that." : "No recipes yet."}</p>`;
  } else {
    body = `<div class="rgrid">${list.map(card).join("")}</div>`;
  }
  return `
    <div class="card pcard">
      <div class="phead">
        <h2>Recipes</h2>
        <span class="pmeta">${
          loading || !items ? "loading" : `${list.length} of ${items.length}`
        }</span>
      </div>
      <div class="searchrow">
        <input id="rsearch" type="search" autocomplete="off"
               placeholder="Search recipes" value="${escapeHtml(query)}">
        <a class="chip extlink" href="https://www.allrecipes.com/"
           rel="noopener">AllRecipes</a>
      </div>
      ${body}
    </div>`;
}

/**
 * One recipe, laid out for cooking: ingredients first, then steps.
 *
 * Ingredients come before method because that is the order a person needs
 * them, and because the ingredient list is what you re-read while the pan is
 * on. Steps are numbered and spaced for reading at arm's length.
 */
export function recipeDetailBody(recipe) {
  if (!recipe) return `<p class="empty">That recipe could not be loaded.</p>`;
  const meta = formatMeta(recipe);
  const ings = (recipe.ingredients || recipe.recipe_ingredient || []).map((i) => {
    const text = typeof i === "string"
      ? i
      : (i.display || i.note || "");
    return `<li>${escapeHtml(tidyAmounts(text))}</li>`;
  }).join("");
  const steps = (recipe.instructions || recipe.recipe_instructions || [])
    .map((s) => {
      const text = typeof s === "string" ? s : (s.text || "");
      return `<li>${escapeHtml(text)}</li>`;
    }).join("");
  const src = safeUrl(recipe.original_url);
  return `
    <div class="sheet recipe">
      ${mealieImageUrl(recipe.recipe_id, { size: "min", version: recipe.image })
        ? `<img class="rhero" src="${escapeHtml(
             mealieImageUrl(recipe.recipe_id, { size: "min", version: recipe.image })
           )}" alt="" onerror="this.remove()">`
        : ""}
      <h3>${escapeHtml(recipe.name || "")}</h3>
      ${meta ? `<p class="match">${escapeHtml(meta)}</p>` : ""}
      ${recipe.recipe_id
        ? `<button class="chip planthis"
             data-uuid="${escapeHtml(recipe.recipe_id)}"
             data-name="${escapeHtml(recipe.name || "")}">Plan this</button>`
        : ""}
      ${recipe.description
        ? `<p class="rdesc">${escapeHtml(recipe.description)}</p>` : ""}
      <h4>Ingredients</h4>
      ${ings ? `<ul class="ings">${ings}</ul>`
             : `<p class="empty">No ingredients recorded.</p>`}
      <h4>Method</h4>
      ${steps ? `<ol class="steps">${steps}</ol>`
              : `<p class="empty">No steps recorded.</p>`}
      ${src ? `<p class="match"><a class="plink" href="${src}" target="_blank"
          rel="noopener">Source</a></p>` : ""}
    </div>`;
}
