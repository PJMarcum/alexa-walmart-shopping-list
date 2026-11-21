import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThumbUrl } from "../../ha/www/kitchen/images.js";

const RAW = "https://i5.walmartimages.com/seo/Thing_abc-123.jpeg";

test("appends sizing and background parameters", () => {
  const url = buildThumbUrl(RAW);
  assert.ok(url.startsWith(RAW + "?"));
  assert.match(url, /odnHeight=112/);
  assert.match(url, /odnWidth=112/);
  assert.match(url, /odnBg=FFFFFF/);
});

test("honours an explicit size and background", () => {
  // Deliberately NOT the default: an override that happens to equal the
  // default proves nothing about whether the override is read at all.
  const url = buildThumbUrl(RAW, { size: 56, bg: "123456" });
  assert.match(url, /odnHeight=56/);
  assert.match(url, /odnBg=123456/);
});

test("replaces existing query parameters rather than appending twice", () => {
  // Catalog rows scraped at different times carry different parameters.
  const url = buildThumbUrl(RAW + "?odnHeight=999&odnBg=000000");
  assert.equal((url.match(/odnHeight=/g) || []).length, 1);
  assert.match(url, /odnHeight=112/);
  assert.doesNotMatch(url, /000000/);
});

test("returns null for a missing url rather than a broken string", () => {
  assert.equal(buildThumbUrl(null), null);
  assert.equal(buildThumbUrl(""), null);
  assert.equal(buildThumbUrl(undefined), null);
});

// --- Mealie recipe images ------------------------------------------------
import { mealieImageUrl } from "../../ha/www/kitchen/images.js";

test("a recipe image points at the add-on's published port", () => {
  const url = mealieImageUrl("53cc988b", { origin: "http://homeassistant.local:9000" });
  assert.equal(url,
    "http://homeassistant.local:9000/api/media/recipes/53cc988b/images/tiny-original.webp");
});

test("the grid asks for the small one, because thirty load at once", () => {
  assert.match(mealieImageUrl("x", { origin: "http://h:9000" }), /tiny-original/);
  assert.match(mealieImageUrl("x", { size: "min", origin: "http://h:9000" }),
               /min-original/);
});

test("Mealie's own image token is used as the cache buster", () => {
  // It changes when the picture changes, so we do not need to invent one.
  assert.match(
    mealieImageUrl("x", { version: "fslr", origin: "http://h:9000" }),
    /\?version=fslr$/);
});

test("a recipe with no picture yields null, not a broken image", () => {
  assert.equal(mealieImageUrl(null, { origin: "http://h:9000" }), null);
  assert.equal(mealieImageUrl("", { origin: "http://h:9000" }), null);
});
