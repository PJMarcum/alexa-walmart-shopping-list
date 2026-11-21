/**
 * The only place service and event names appear.
 *
 * The AppDaemon app listens for EVENTS (walmart_build_cart,
 * walmart_pick_candidate, walmart_skip_phrase), not services. Only the
 * todo calls (add_item, remove_item) are real Home Assistant services.
 * That is why every payload carries a kind field, and why dispatch routes
 * on it to hass.callApi for events or hass.callService for services.
 *
 * A custom panel can pass arbitrary data in the call, so the real phrase
 * and item id travel with it. No Lovelace numbered-button workaround is
 * needed.
 */
export function pickPayload(phrase, itemId) {
  if (!phrase) throw new Error("pickPayload needs a phrase");
  if (!itemId) throw new Error("pickPayload needs an item id");
  return {
    kind: "event",
    event: "walmart_pick_candidate",
    data: { phrase, item_id: String(itemId) },
  };
}

/**
 * Ask Walmart about one phrase, now.
 *
 * The backend only queries SerpAPI while BUILDING a cart, so a phrase added
 * to the list afterwards is matched against the 449 products this household
 * has bought before and nothing else. "chicken wings" is in no past order,
 * so the review sheet had catalog guesses and no real candidates, and there
 * was no way to ask for better ones short of building the cart.
 */
export function searchPayload(phrase) {
  if (!phrase) throw new Error("searchPayload needs a phrase");
  return {
    kind: "event",
    event: "walmart_search_phrase",
    data: { phrase: String(phrase) },
  };
}

export function skipPayload(phrase) {
  if (!phrase) throw new Error("skipPayload needs a phrase");
  return { kind: "event", event: "walmart_skip_phrase", data: { phrase } };
}

export function removePayload(entityId, uid) {
  if (!uid) throw new Error("removePayload needs a uid");
  return {
    kind: "service",
    domain: "todo",
    service: "remove_item",
    data: { entity_id: entityId, item: uid },
  };
}

export function addPayload(entityId, text) {
  return {
    kind: "service",
    domain: "todo",
    service: "add_item",
    data: { entity_id: entityId, item: text },
  };
}

export function buildCartPayload() {
  // announce is deliberately omitted so it defaults to true, because a human
  // pressed a button and should hear the result. The scheduled 07:00 build
  // passes announce: false to avoid waking the house.
  return {
    kind: "event",
    event: "walmart_build_cart",
    data: { dry_run: false },
  };
}

/**
 * Launch an app on the kitchen tablet, by name.
 *
 * The Hulu button started life as a link to https://www.hulu.com/, on the
 * theory that Fully Kiosk would hand the URL to Android and Android would
 * hand it to the Hulu app. Fully did its part. Android gave it to CHROME,
 * because app links are claimed PER PATH: Hulu's app claims /watch/... and
 * /series/..., but nothing claims the bare homepage, so the link fell
 * through to the default browser.
 *
 * Naming the package takes Android's link handling out of the question.
 * Verified on the device: foregroundApp went de.ozerov.fully ->
 * com.hulu.plus.
 *
 * Note this acts on THE TABLET, wherever the panel is being viewed from. On
 * a kitchen panel that is the right behaviour; pressing it from a desk is an
 * odd thing to do and starts Hulu in the kitchen.
 */
export function launchAppPayload(deviceId, packageName) {
  if (!deviceId) throw new Error("launchAppPayload needs a device id");
  if (!packageName) throw new Error("launchAppPayload needs a package name");
  return {
    kind: "service",
    domain: "fully_kiosk",
    service: "start_application",
    data: { device_id: String(deviceId), application: String(packageName) },
  };
}

// Events are fired by a SCRIPT, never by POST /api/events.
//
// Home Assistant guards that endpoint with @require_admin
// (components/api/__init__.py, class APIEventView). The kitchen tablet
// signs in as a non-admin account, so every pick, skip and Build cart
// came back 401 and the panel reported "That did not save. Please try
// again." Calling a script is a normal service call, which a non-admin
// may make, and the script fires the event with Home Assistant's own
// authority.
//
// Making the tablet an admin would also have worked and is the wrong
// trade: it is a screen on a kitchen wall.
export const EVENT_SCRIPTS = {
  walmart_pick_candidate: "walmart_panel_pick",
  walmart_skip_phrase: "walmart_panel_skip",
  walmart_build_cart: "walmart_panel_build",
  walmart_search_phrase: "walmart_search_phrase",
};

export async function dispatch(hass, payload) {
  if (payload.kind === "event") {
    const script = EVENT_SCRIPTS[payload.event];
    if (!script) throw new Error("no script for event: " + payload.event);
    return hass.callService("script", script, payload.data);
  }
  if (payload.kind === "service") {
    return hass.callService(payload.domain, payload.service, payload.data);
  }
  throw new Error("unknown payload kind: " + payload.kind);
}
