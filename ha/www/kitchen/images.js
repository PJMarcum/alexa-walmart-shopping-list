/**
 * Walmart's image CDN accepts odnHeight, odnWidth and odnBg.
 *
 * Measured 2026-10-02: a stored catalog thumbnail is 299,835 bytes, and the
 * same image at 112px with a background is 3,872. The catalog stores
 * full-resolution URLs, so a 74 tile grid pulls roughly 22 MB unless every
 * URL goes through here.
 *
 * odnBg renders the product on our card colour. It only fills TRANSPARENT
 * areas, so it does nothing for a product photographed as an opaque JPEG:
 * measured 2026-10-07, roughly half the list kept its own white background
 * whatever we asked for, which on a cream card gave a ragged mix of blended
 * and boxed thumbnails. The panel now puts every product on a white tile and
 * this matches it, so the two agree whether or not the CDN can help.
 */
export function buildThumbUrl(rawUrl, { size = 112, bg = "FFFFFF" } = {}) {
  if (!rawUrl) return null;
  const base = String(rawUrl).split("?")[0];
  const params = new URLSearchParams({
    odnHeight: String(size),
    odnWidth: String(size),
    odnBg: bg,
  });
  return `${base}?${params.toString()}`;
}

/**
 * A Mealie recipe image URL, or null when the recipe has no picture.
 *
 * Mealie serves these without authentication on the add-on's own port, which
 * is why the add-on has to publish 9000: Ingress is the gate, not Mealie. The
 * host is taken from the page rather than hard-coded, so this keeps working if
 * Home Assistant's address changes.
 *
 * Sizes, measured on a real recipe: tiny 75KB, min 137KB, original 209KB. The
 * grid uses tiny because thirty of them load at once.
 */
// The host port the Mealie add-on publishes. NOT 9000: Portainer already
// maps that to its own 9099, so Mealie cannot bind there and every image
// 404s with Portainer answering on the same port.
export const MEALIE_PORT = 9001;

export function mealieImageUrl(recipeId, { size = "tiny", version = null,
                                           origin = null } = {}) {
  if (!recipeId) return null;
  const names = { tiny: "tiny-original.webp", min: "min-original.webp",
                  original: "original.webp" };
  const file = names[size] || names.tiny;
  const base = origin
    || (typeof location !== "undefined"
        ? `${location.protocol}//${location.hostname}:${MEALIE_PORT}`
        : "");
  if (!base) return null;
  // `version` is Mealie's own image token. It changes when the picture does,
  // so it doubles as a cache buster without us inventing one.
  const q = version ? `?version=${encodeURIComponent(version)}` : "";
  return `${base}/api/media/recipes/${encodeURIComponent(recipeId)}/images/${file}${q}`;
}
