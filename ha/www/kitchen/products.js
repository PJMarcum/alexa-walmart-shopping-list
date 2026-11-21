// ha/www/kitchen/products.js
/**
 * "What we buy": the browsable grid of everything the household actually buys.
 *
 * Ported from walmart-catalog-card.js, which was a Lovelace custom card on a
 * separate dashboard. Moving it here retires that dashboard and, with it, the
 * numbered-button workarounds, the input_text helper, the Lovelace resource
 * registration and the cache-versioning dance that came with it.
 *
 * One change from the card, deliberate: thumbnails go through buildThumbUrl.
 * The card used the stored full-resolution URL, so rendering 74 postage
 * stamps pulled roughly 22MB of JPEG. At display size that is about 4KB each.
 */
import { escapeHtml, safeUrl, formatBought } from "./html.js";
import { buildThumbUrl } from "./images.js";

// Tiles are minmax(130px, 1fr). 240 keeps them crisp on a 2x tablet without
// asking for anything like the stored resolution.
const THUMB = 240;

/**
 * The items a query and category select.
 *
 * Searching matches the product name OR any phrase the household says for it,
 * because on a curated board what you SAY is the better handle: "trash bags"
 * should find the Strongbag Flex whether or not that word is in the title.
 */
export function filterProducts(items, { query = "", category = "" } = {}) {
  const q = String(query).trim().toLowerCase();
  return (items || []).filter((item) => {
    if (!item) return false;
    if (category && item.category !== category) return false;
    if (!q) return true;
    if (String(item.name || "").toLowerCase().includes(q)) return true;
    return (item.phrases || []).some((phrase) =>
      String(phrase).toLowerCase().includes(q)
    );
  });
}

// `added` means the product is ON THE LIST right now, read back from the
// list itself, not "was tapped during this visit". That is what makes the
// second tap a reliable undo rather than a guess.
function tile(item, added) {
  const bought = item.bought ? `${formatBought(item.bought)}x` : "";
  const thumb = buildThumbUrl(item.thumb, { size: THUMB });
  const href = safeUrl(item.url);
  return `
    <div class="tile${added ? " added" : ""}" data-id="${escapeHtml(item.id)}">
      ${added ? `<span class="badge">on list</span>` : ""}
      ${thumb
        ? `<img class="ptumb" loading="lazy" src="${escapeHtml(thumb)}"
                alt="${escapeHtml(item.name || "")}">`
        : `<div class="ptumb"></div>`}
      <div class="pname">${escapeHtml(item.name || "")}</div>
      ${(item.phrases || []).length
        ? `<div class="phrases" title="Say any of these to Alexa">${item.phrases
            .map((p) => `<span class="phrase">${escapeHtml(p)}</span>`)
            .join("")}</div>`
        : ""}
      <div class="foot">
        <span>${escapeHtml(bought)}</span>
        ${href
          ? `<a class="plink" href="${href}" target="_blank" rel="noopener"
                title="Open on walmart.com">info</a>`
          : ""}
      </div>
    </div>`;
}

/**
 * The whole products body as markup.
 *
 * state: { items, categories, query, category, shown, pageSize, added, error }
 * `items` is null while the catalog is still loading, which is why "loading"
 * and "nothing matches that" are different messages: one is a wait, the other
 * is an answer.
 */
export function productsBody(state) {
  const {
    items, categories = [], query = "", category = "",
    shown = 60, pageSize = 60, added = new Set(), error = null,
  } = state || {};

  const loading = items === null || items === undefined;
  const visible = loading ? [] : filterProducts(items, { query, category });
  const page = visible.slice(0, shown);
  const remaining = visible.length - page.length;

  const chips = [""].concat(categories).map((cat) => `
    <button class="chip${category === cat ? " on" : ""}"
            data-cat="${escapeHtml(cat)}"
            aria-pressed="${category === cat}">${
              escapeHtml(cat || "All")}</button>`).join("");

  let body;
  if (error) {
    body = `<div class="problem">${escapeHtml(error)}</div>`;
  } else if (loading) {
    body = `<div class="empty">Loading what we buy...</div>`;
  } else if (!page.length) {
    body = `<div class="empty">Nothing matches that.</div>`;
  } else {
    body = `<div class="pgrid">${page
      .map((item) => tile(item, added.has(String(item.id))))
      .join("")}</div>
      ${remaining > 0
        ? `<button class="more">Show ${Math.min(pageSize, remaining)} more</button>`
        : ""}`;
  }

  return `
    <div class="card pcard">
      <div class="phead">
        <h2>What We Buy</h2>
        <span class="pmeta">${
          loading ? "loading" : `${visible.length} of ${items.length}`
        }</span>
      </div>
      <input id="psearch" type="search" autocomplete="off"
             placeholder="Search a product or what you say"
             value="${escapeHtml(query)}">
      <div class="chips">${chips}</div>
      ${body}
    </div>`;
}
