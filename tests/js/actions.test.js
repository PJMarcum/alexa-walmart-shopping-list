// tests/js/actions.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickPayload, skipPayload, removePayload, addPayload, buildCartPayload, dispatch,
} from "../../ha/www/kitchen/actions.js";

test("picking fires the event with the real phrase and item id", () => {
  // A custom panel CAN pass arbitrary data, which is why the numbered-button
  // workaround from the Lovelace version is not needed here.
  const p = pickPayload("Pork chops", "80000005");
  assert.equal(p.kind, "event");
  assert.equal(p.event, "walmart_pick_candidate");
  assert.deepEqual(p.data, { phrase: "Pork chops", item_id: "80000005" });
});

test("picking refuses an empty item id rather than writing a broken alias", () => {
  assert.throws(() => pickPayload("Pork chops", ""), /item id/i);
  assert.throws(() => pickPayload("", "123"), /phrase/i);
});

// Removal payload must target uid, not text, because the Alexa list permits
// duplicate text and acting on text would hit the wrong row.
test("removal targets the uid, so duplicate text removes only one row", () => {
  const a = removePayload("todo.x", "uid-a");
  const b = removePayload("todo.x", "uid-b");
  assert.equal(a.data.item, "uid-a");
  assert.equal(b.data.item, "uid-b");
  assert.notEqual(a.data.item, b.data.item);
});

test("removal refuses an empty uid", () => {
  assert.throws(() => removePayload("todo.x", ""), /uid/i);
});

test("adding an item goes to the configured list", () => {
  const p = addPayload("todo.x", "Pork chops");
  assert.equal(p.kind, "service");
  assert.equal(p.domain, "todo");
  assert.equal(p.service, "add_item");
  assert.deepEqual(p.data, { entity_id: "todo.x", item: "Pork chops" });
});

test("build cart fires the same event the Friday automation uses", () => {
  const p = buildCartPayload();
  assert.equal(p.kind, "event");
  assert.equal(p.event, "walmart_build_cart");
  assert.equal(p.data.dry_run, false);
  // announce is deliberately omitted so it defaults to true, because a human
  // pressed a button and should hear the result.
  assert.equal("announce" in p.data, false);
});

test("dispatch routes events through a script, not the admin-only REST API", async () => {
  const calls = [];
  const hass = {
    callApi: (...a) => { calls.push(["api", ...a]); },
    callService: (...a) => { calls.push(["svc", ...a]); },
  };
  const p = pickPayload("Pork chops", "80000005");
  await dispatch(hass, p);
  // POST /api/events is @require_admin, and the kitchen tablet is not an
  // admin. Going through script.walmart_panel_pick is what makes picking
  // work for the person actually standing in the kitchen.
  assert.deepEqual(calls, [["svc", "script", "walmart_panel_pick",
    { phrase: "Pork chops", item_id: "80000005" }]]);
  assert.ok(!calls.some((c) => c[0] === "api"), "must not touch callApi");
});

test("dispatch routes services through hass.callService", async () => {
  const calls = [];
  const hass = {
    callApi: (...a) => { calls.push(["api", ...a]); },
    callService: (...a) => { calls.push(["svc", ...a]); },
  };
  const p = addPayload("todo.x", "Pork chops");
  await dispatch(hass, p);
  assert.deepEqual(calls, [["svc", "todo", "add_item", { entity_id: "todo.x", item: "Pork chops" }]]);
});

test("dispatch throws on unknown payload kind", async () => {
  const hass = {
    callApi: () => { throw new Error("should not call callApi"); },
    callService: () => { throw new Error("should not call callService"); },
  };
  const badPayload = { kind: "nonsense", data: {} };
  await assert.rejects(
    () => dispatch(hass, badPayload),
    /unknown payload kind/i
  );
});

// --- searching Walmart from the review sheet ----------------------------
import { searchPayload } from "../../ha/www/kitchen/actions.js";
import { EVENT_SCRIPTS } from "../../ha/www/kitchen/actions.js";

test("searching carries the phrase the list actually said", () => {
  // "chicken wings" matched nothing in the 449-product catalog, and the
  // backend only runs SerpAPI during a build, so the phrase sat unresolved
  // with no candidates to pick from. This is the way to ask for some.
  const p = searchPayload("chicken wings");
  assert.equal(p.kind, "event");
  assert.equal(p.event, "walmart_search_phrase");
  assert.deepEqual(p.data, { phrase: "chicken wings" });
});

test("searching refuses an empty phrase rather than querying for nothing", () => {
  assert.throws(() => searchPayload(""), /phrase/i);
  assert.throws(() => searchPayload(null), /phrase/i);
});

test("the search event goes through a script, like every other event", async () => {
  // POST /api/events is @require_admin and the tablet is not an admin.
  assert.equal(EVENT_SCRIPTS.walmart_search_phrase, "walmart_search_phrase");
  const calls = [];
  const hass = { callService: (d, s, data) => { calls.push([d, s, data]); } };
  await dispatch(hass, searchPayload("chicken wings"));
  assert.deepEqual(calls, [
    ["script", "walmart_search_phrase", { phrase: "chicken wings" }],
  ]);
});

// --- launching an app on the tablet --------------------------------------
import { launchAppPayload } from "../../ha/www/kitchen/actions.js";

test("launching Hulu names the app, rather than hoping a URL routes to it", () => {
  // A link to https://www.hulu.com/ reached Android, which handed it to
  // CHROME: Hulu's app claims deep paths like /watch/... but not the bare
  // homepage, so nothing claimed the link we were sending. Naming the
  // package removes Android's link handling from the question entirely.
  const p = launchAppPayload("dev123", "com.hulu.plus");
  assert.equal(p.kind, "service");
  assert.equal(p.domain, "fully_kiosk");
  assert.equal(p.service, "start_application");
  assert.deepEqual(p.data, { device_id: "dev123", application: "com.hulu.plus" });
});

test("it refuses to fire without both a device and a package", () => {
  assert.throws(() => launchAppPayload("", "com.hulu.plus"), /device/i);
  assert.throws(() => launchAppPayload("dev123", ""), /package/i);
});

test("it routes as a plain service call", async () => {
  const calls = [];
  const hass = { callService: (d, s, data) => { calls.push([d, s, data]); } };
  await dispatch(hass, launchAppPayload("dev123", "com.hulu.plus"));
  assert.deepEqual(calls, [["fully_kiosk", "start_application",
    { device_id: "dev123", application: "com.hulu.plus" }]]);
});

test("the same launcher serves any app, so ChatGPT needs no new plumbing", () => {
  const p = launchAppPayload("dev123", "com.openai.chatgpt");
  assert.equal(p.service, "start_application");
  assert.deepEqual(p.data,
    { device_id: "dev123", application: "com.openai.chatgpt" });
});
