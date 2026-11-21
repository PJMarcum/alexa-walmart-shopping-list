// ha/www/kitchen/html.js
/**
 * Escaping helpers shared by every view.
 *
 * These were private to panel.js and to walmart-catalog-card.js, one copy
 * each. The products and admin views need them too, and three copies of an
 * escaping routine is three chances for one of them to drift.
 *
 * Everything here renders into innerHTML, so these are the only thing
 * standing between a product title and script execution. Product titles come
 * from Walmart and from SerpAPI, neither of which this household controls.
 */

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

/**
 * An href safe to drop into markup, or "" when it is not.
 *
 * Only https survives. A catalog entry is JSON on disk that a person may
 * hand-edit, so "javascript:..." in a product_page_url is a real shape for
 * this to take, and an escaped attribute alone would not stop it.
 */
export function safeUrl(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw, "https://www.walmart.com");
    return parsed.protocol === "https:" ? escapeHtml(parsed.href) : "";
  } catch (err) {
    return "";
  }
}

/** "3" for 3, "2+" for 2.5: a half is a frequency score, not half a trip. */
export function formatBought(count) {
  return Number.isInteger(count)
    ? String(count)
    : String(count).replace(/\.5$/, "+");
}

/**
 * Keeps numbers in ingredient text to two decimal places.
 *
 * AllRecipes publishes 1/3 as 0.33333334326744 and 2/3 as 0.66666668653488,
 * a 32-bit float round-trip. Mealie stores the line verbatim, so it reaches
 * the tablet with fourteen digits and is unreadable at a counter.
 *
 * ONLY numbers with three or more decimal places are touched, which is what
 * separates an artifact from a real measurement: "1.25 pounds", "10.5 ounce"
 * and "16.9 fl oz" are how those are properly written and survive untouched.
 */
export function tidyAmounts(text) {
  return String(text == null ? "" : text).replace(
    /\d*\.\d{3,}/g,
    (match) => {
      const value = Number(match);
      if (!Number.isFinite(value)) return match;
      return String(Math.round(value * 100) / 100);
    }
  );
}
