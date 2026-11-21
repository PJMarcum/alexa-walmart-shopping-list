import { test } from "node:test";
import assert from "node:assert/strict";
import { formatClock } from "../../ha/www/kitchen/clock.js";

// 2026-10-03T02:07:00Z is 21:07 in Chicago and 22:07 in New York, which is
// exactly the hour the kitchen tablet was wrong by.
const AT = new Date("2026-10-03T02:07:00Z");

test("the clock reads the house time zone, not the device", () => {
  const chicago = formatClock(AT, "America/Chicago");
  assert.match(chicago.time, /9:07/);
  assert.doesNotMatch(chicago.time, /10:07/);
});

test("a different zone gives a different hour, so the zone is really applied", () => {
  const chicago = formatClock(AT, "America/Chicago");
  const newYork = formatClock(AT, "America/New_York");
  assert.notEqual(chicago.time, newYork.time);
  assert.match(newYork.time, /10:07/);
});

test("the date line follows the zone across a midnight boundary", () => {
  // 03:30 UTC is still Oct 2 in Chicago but already Oct 3 in London.
  const at = new Date("2026-10-03T03:30:00Z");
  assert.match(formatClock(at, "America/Chicago").date, /Oct 2/);
  assert.match(formatClock(at, "Europe/London").date, /Oct 3/);
});

test("the meridiem comes back separately from the digits", () => {
  // The panel sets them at different sizes, so "9:07 AM" as one string is
  // not usable: the AM would be as large and as heavy as the time.
  const out = formatClock(AT, "America/Chicago");
  assert.equal(out.time, "9:07");
  assert.equal(out.meridiem, "PM");
  assert.doesNotMatch(out.time, /[AP]M/);
});

test("no zone falls back to the device rather than throwing", () => {
  const out = formatClock(AT, undefined);
  assert.ok(out.time.length > 0);
  assert.ok(out.date.length > 0);
});

test("an unknown zone falls back instead of breaking the panel", () => {
  // A RangeError here would stop the whole panel painting, which is a far
  // worse outcome than an hour's error on the clock.
  const out = formatClock(AT, "Mars/Olympus_Mons");
  assert.ok(out.time.length > 0);
  assert.ok(out.date.length > 0);
});
