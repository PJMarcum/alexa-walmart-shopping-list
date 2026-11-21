// ha/www/kitchen/panel.js
import { STYLES } from "./styles.js";
import { buildRows, catalogLookup, suggestProducts, unmatchedRows, normalise }
  from "./model.js";
import { buildThumbUrl } from "./images.js";
import { formatClock } from "./clock.js";
import { escapeHtml } from "./html.js";
import { productsBody } from "./products.js";
import { recipesBody, recipeDetailBody, filterRecipes } from "./recipes.js";
import { menuBody, isoDate, dinnerFor, weekDays, weekLabel, COURSES, dayTitle }
  from "./menu.js";
import { ingredientsBody } from "./ingredients.js";
import { mealieImageUrl } from "./images.js";
import { pickPayload, skipPayload, removePayload, addPayload,
  buildCartPayload, searchPayload, launchAppPayload, dispatch }
  from "./actions.js";

const LIST_ENTITY = "todo.you_example_com_walmart";
const CATALOG_URL = "/local/walmart/catalog.json";
// Matches the old Lovelace card, which this page replaces.
const PAGE_SIZE = 60;

// Waiting on a SerpAPI round trip that reports back through a sensor, not
// through the service call. 5 x 1.2s covers a slow search without leaving a
// locked sheet on the wall if the search never ran at all.
const SEARCH_TRIES = 5;
const SEARCH_WAIT_MS = 1200;
// Backing off after a pick: quick at first because the write is usually fast,
// then longer so a slow one is still caught. About 7s in total, which is well
// past anything measured and still short of looking hung.
const SETTLE_WAITS = [300, 500, 800, 1200, 1800, 2600];
// Every mealie service call needs the config entry id. It is looked up
// once at runtime rather than hard-coded, because removing and re-adding
// the integration mints a new one.
const MEALIE_SENSOR = "sensor.mealie_recipes";
const TICK_SENSOR = "sensor.kitchen_ingredients_checked";
// The kitchen tablet, and the apps the top-bar buttons start on it. A device
// id rather than a name because that is what fully_kiosk.start_application
// takes, and it survives the device being renamed. Find yours under
// Settings > Devices > (your Fully Kiosk tablet); the id is the last part of
// the page URL. See docs/configuration.md.
const TABLET_DEVICE = "YOUR_FULLY_KIOSK_DEVICE_ID";
const HULU_PACKAGE = "com.hulu.plus";
const CHATGPT_PACKAGE = "com.openai.chatgpt";
// Opening the Clock app is not enough: the point is a TIMER for whatever is
// cooking, and the package alone lands on Samsung's full screen desk clock.
// android.intent.action.SHOW_TIMERS opens the timer tab, but Home Assistant's
// Fully integration exposes no way to fire an intent (start_application takes
// a package, load_url was tried and does nothing with an intent: URL). So it
// goes through a script, which reaches Fully's REST API server side and keeps
// the tablet's admin password out of this file.
const TIMER_SCRIPT = "kitchen_tablet_timer";

// Unbounded for the clock, titles and numbers; Plus Jakarta Sans for the rest.
//
// The stylesheet lives in a shadow root, and a shadow root cannot define a
// @font-face that the document has not loaded: font faces resolve against the
// DOCUMENT, not the tree the rule sits in. So the link goes in document.head
// and the shadow DOM picks the families up from there.
//
// Guarded by id because Home Assistant detaches and reattaches the panel on
// every navigation, and an unguarded append would add a stylesheet each time.
// Both families have system fallbacks in the tokens, so a tablet that cannot
// reach Google renders in the fallback rather than breaking.
const FONT_LINK_ID = "kitchen-panel-fonts";
const FONT_HREF = "https://fonts.googleapis.com/css2"
  + "?family=Unbounded:wght@500;600"
  + "&family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap";

export function ensureFonts(doc = typeof document !== "undefined" ? document : null) {
  if (!doc || doc.getElementById(FONT_LINK_ID)) return false;
  const link = doc.createElement("link");
  link.id = FONT_LINK_ID;
  link.rel = "stylesheet";
  link.href = FONT_HREF;
  doc.head.appendChild(link);
  return true;
}

class WalmartKitchenPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._catalog = null;
    this._catalogFailed = false;
    this._rows = [];
    this._started = false;
    this._seenSensor = null;
    this._seenList = null;
    this._refreshing = false;
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
    // The clock ticks every 30 seconds, but the time zone arrives with the
    // first hass assignment, which is usually after the first tick. Without
    // this the panel shows the device's zone for up to half a minute.
    const tz = hass.config && hass.config.time_zone;
    if (tz !== this._tz) {
      this._tz = tz;
      this._tick();
    }
    // This setter runs on every Home Assistant state change, so only refresh
    // on the first assignment and when the pending sensor or the list changes.
    // A tick made on the other device must appear here.
    const ticks = hass.states[TICK_SENSOR] || null;
    if (ticks !== this._seenTicks) {
      this._seenTicks = ticks;
      if (this._page() === "ingredients") this._paintIngredients();
    }
    const sensor = hass.states["sensor.walmart_pending"] || null;
    const list = hass.states[LIST_ENTITY] || null;
    if (!this._started || sensor !== this._seenSensor ||
        list !== this._seenList) {
      this._started = true;
      this._seenSensor = sensor;
      this._seenList = list;
      this._refresh();
    }
  }

  connectedCallback() {
    ensureFonts();
    this._render();
    this._applyKiosk();
    // The timer belongs to attachment, not first paint: Home Assistant
    // detaches and reattaches the panel when you navigate away and back.
    if (!this._timer) {
      this._tick();
      this._timer = setInterval(() => this._tick(), 30000);
    }
  }

  // Builds the DOM exactly once, on the first call. Every later call is a
  // no-op, and every repaint writes into a subtree (#rows, #queue, the
  // build button, the clock) rather than the shadow root. Several features
  // depend on that: the delegated click listener below is attached once,
  // the clock interval keeps its elements, and text typed in the add field
  // survives a refresh. Do not move markup out of this guard.
  _render() {
    if (!this.shadowRoot.firstChild) {
      this.shadowRoot.innerHTML = `<style>${STYLES}</style>
        <div class="wrap">
          <div class="topbar">
            <div class="nav">
              <button class="chip" id="nav-list">Walmart</button>
              <button class="chip" id="nav-buy">What We Buy</button>
              <button class="chip" id="nav-recipes">Recipes</button>
              <button class="chip" id="nav-menu">Weekly Menu</button>
              <button class="chip" id="nav-ings">Ingredients</button>
              <!-- Leaves the panel entirely, but sits with the page chips
                   because that is where a hand looks for it.
                   A BUTTON, not a link: linking to hulu.com reached Android,
                   which handed it to Chrome, because Hulu's app claims deep
                   paths and not the bare homepage. This asks Home Assistant
                   to start the app by name instead. See launchAppPayload. -->
              <button class="chip extlink" id="go-hulu">hulu</button>
              <button class="chip extlink" id="go-chatgpt">chatgpt</button>
              <!-- Inline SVG rather than another file to serve: a clock face
                   is simple enough to draw, and it cannot 404. -->
              <button class="chip iconbtn" id="go-clock" title="Timer"
                      aria-label="Timer"><svg viewBox="0 0 24 24" width="26"
                      height="26" aria-hidden="true"><circle cx="12" cy="12"
                      r="11" fill="#2C2A26"></circle><path d="M12 6.2V12l4 2.4"
                      fill="none" stroke="#FDFBF7" stroke-width="2.1"
                      stroke-linecap="round" stroke-linejoin="round"
                      ></path></svg></button>
            </div>
            <div class="add"><input id="add" placeholder="Add item">
              <p class="inlinemsg" id="addmsg" hidden></p></div>
            <div class="clock">
              <div class="t"><span id="t"></span><span class="ampm"
                id="ampm"></span></div>
              <div class="d" id="d"></div></div>
          </div>
          <div id="view"></div>
        </div>`;
      // These controls live outside the repainted containers and are built
      // once, so they are wired directly.
      this.shadowRoot.getElementById("go-hulu").addEventListener("click",
        () => this._launchApp(HULU_PACKAGE));
      this.shadowRoot.getElementById("go-chatgpt").addEventListener("click",
        () => this._launchApp(CHATGPT_PACKAGE));
      this.shadowRoot.getElementById("go-clock").addEventListener("click",
        () => this._openTimer());
      this.shadowRoot.getElementById("nav-buy").addEventListener("click",
        () => this._go("/kitchen/products"));
      this.shadowRoot.getElementById("nav-list").addEventListener("click",
        () => this._go("/kitchen"));
      this.shadowRoot.getElementById("nav-recipes").addEventListener("click",
        () => this._go("/kitchen/recipes"));
      this.shadowRoot.getElementById("nav-menu").addEventListener("click",
        () => this._go("/kitchen/menu"));
      this.shadowRoot.getElementById("nav-ings").addEventListener("click",
        () => this._go("/kitchen/ingredients"));
      this.shadowRoot.getElementById("add").addEventListener("keydown",
        (ev) => { if (ev.key === "Enter") this._submitAdd(ev.target); });
      // One delegated listener on the stable shadow root. The row lists are
      // rebuilt wholesale on every refresh, so per-row listeners would be lost.
      this.shadowRoot.addEventListener("click", (ev) => {
        // Overlays wire their own listeners, so nothing below should see
        // their clicks. The plan sheet uses .chips .chip for Dinner/Side,
        // which the products category handler would otherwise swallow.
        if (ev.target.closest(".overlay")) return;
        // --- what we buy -------------------------------------------------
        const cat = ev.target.closest(".chips .chip");
        if (cat) {
          this._category = cat.dataset.cat || "";
          this._shown = PAGE_SIZE;
          this._paintProducts();
          return;
        }
        if (ev.target.closest(".more")) {
          this._shown = (this._shown || PAGE_SIZE) + PAGE_SIZE;
          this._paintProducts();
          return;
        }
        const tile = ev.target.closest(".tile");
        if (tile) {
          // The info link opens walmart.com and must not also add the item.
          if (!ev.target.closest("a")) this._toggleProduct(tile.dataset.id);
          return;
        }
        // --- recipes and the week ----------------------------------------
        const railRecipe = ev.target.closest("#rail-recipe");
        if (railRecipe) {
          this._openRecipe(railRecipe.dataset.slug);
          return;
        }
        const rcard = ev.target.closest(".rcard");
        if (rcard) {
          this._openRecipe(rcard.dataset.slug);
          return;
        }
        // Stepping weeks. The plan is already fetched a fortnight either
        // side of today, so a step repaints without another round trip.
        if (ev.target.closest("#week-prev")) {
          this._weekOffset = (this._weekOffset || 0) - 1;
          this._paintMenu();
          this._ingRecipes = null;
          return;
        }
        if (ev.target.closest("#week-next")) {
          this._weekOffset = (this._weekOffset || 0) + 1;
          this._paintMenu();
          this._ingRecipes = null;
          return;
        }
        if (ev.target.closest("#week-now")) {
          this._weekOffset = 0;
          this._paintMenu();
          this._ingRecipes = null;
          return;
        }
        const plan = ev.target.closest(".day .plan");
        if (plan) {
          this._openPlanner(plan.dataset.date);
          return;
        }
        const unplan = ev.target.closest(".unplan");
        if (unplan) {
          this._unplan(unplan.dataset.planid);
          return;
        }
        // Tapping a planned meal OPENS it. Adding is the day's Plan button
        // and removing is the row's own control, so each gesture does one
        // thing: it used to open the planner, which read as "add another".
        const meal = ev.target.closest(".mealrow");
        if (meal) {
          // A plan entry can be a free-text note with no recipe behind it,
          // and there is nothing to open for those.
          if (meal.dataset.slug) this._openRecipe(meal.dataset.slug);
          return;
        }
        if (ev.target.closest("#dryrun")) {
          this._dryRun();
          return;
        }
        if (ev.target.closest("#parse-week")) {
          this._parseWeek();
          return;
        }
        if (ev.target.closest("#tick-all")) {
          this._setAllTicks(true);
          return;
        }
        if (ev.target.closest("#tick-none")) {
          this._setAllTicks(false);
          return;
        }
        const tick = ev.target.closest(".ingrow .tick");
        if (tick) {
          const row = tick.closest(".ingrow");
          this._toggleIngredient(row && row.dataset.key);
          return;
        }
        const kebab = ev.target.closest(".kebab");
        if (kebab) {
          this._openMenu(kebab.dataset.uid, kebab);
          return;
        }
        // Any real control inside a row handles its own click. Opt a custom
        // control out with data-no-review.
        if (ev.target.closest("button, a, input, [data-no-review]")) return;
        const row = ev.target.closest(".row");
        if (row && row.dataset.uid) this._openReview(row.dataset.uid);
      });
    }
  }

  // Home Assistant routes everything under /kitchen to this panel and sets
  // a `route` property, but the panel is also reachable by a plain reload, so
  // the path is read directly and `route` only nudges a repaint.
  set route(value) {
    this._route = value;
    this._syncView();
  }

  _page() {
    const path = window.location.pathname || "";
    if (path.startsWith("/kitchen/products")) return "products";
    if (path.startsWith("/kitchen/recipes")) return "recipes";
    if (path.startsWith("/kitchen/menu")) return "menu";
    if (path.startsWith("/kitchen/ingredients")) return "ingredients";
    return "list";
  }

  _go(path) {
    history.pushState(null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed",
      { bubbles: true, composed: true }));
    this._syncView();
  }

  // Rebuilds the view only when the page actually changed. Rebuilding on every
  // state change would throw away a half-typed search and scroll position.
  _syncView() {
    const page = this._page();
    const host = this.shadowRoot && this.shadowRoot.getElementById("view");
    if (!host) return;
    for (const id of ["nav-list", "nav-buy", "nav-recipes",
                      "nav-menu", "nav-ings"]) {
      const chip = this.shadowRoot.getElementById(id);
      const owns = { "nav-list": "list", "nav-buy": "products",
                     "nav-recipes": "recipes",
                     "nav-menu": "menu", "nav-ings": "ingredients" }[id];
      if (chip) chip.classList.toggle("on", owns === page);
    }
    // The add box belongs to the list. On the products page it sits directly
    // above that page's own search box, which is two inputs doing different
    // things and looking identical.
    const add = this.shadowRoot.querySelector(".add");
    if (add) add.hidden = page !== "list";

    if (this._builtPage !== page) {
      this._builtPage = page;
      host.className = page === "list" ? "list" : "page";
      if (page === "list") {
        host.innerHTML = `
          <div class="card" id="list"><h2>Walmart List</h2>
            <p class="inlinemsg" id="listmsg" hidden></p>
            <div id="rows"></div></div>
          <div id="rail">
            <div class="card" id="tonight"><h2>Tonight</h2>
              <div id="tonightbody"></div></div>
            <div class="card" id="needs"><h2>Needs a Match</h2>
              <div id="queue"></div></div>
          </div>
          <div class="buildbar">
            <p class="inlinemsg" id="buildmsg" hidden></p>
            <p class="match" id="dryrun-msg" hidden></p>
            <button class="chip" id="dryrun" title="Looks up everything on the
                    list and searches for what it cannot place. Carts nothing,
                    clears nothing, tells nobody.">Dry run</button>
            <button class="build" id="build" disabled>Build cart</button>
          </div>`;
        this.shadowRoot.getElementById("build").addEventListener("click",
          () => this._buildCart());
        this._paintRows();
        this._paintRail();
        this._paintBuild();
      } else {
        host.innerHTML = "";
      }
    }
    if (page === "products") this._paintProducts();
    if (page === "recipes") { this._paintRecipes(); this._loadRecipes(); }
    if (page === "menu") { this._paintMenu(); this._loadMealplan(); }
    if (page === "ingredients") { this._paintIngredients(); this._loadIngredients(); }
    // The list page needs the plan too: its rail shows tonight's dinner.
    // Without this the rail would sit on "Loading the meal plan..."
    // forever unless someone happened to visit the week first.
    if (page === "list" && !this._mealplan) this._loadMealplan();
  }

  // Adds the PRODUCT NAME, which is what the person tapped and what they
  // will recognise on the list. It resolves because an exact product name
  // resolves to that product, in the panel and in the app alike.
  /**
   * Ids of products currently on the Walmart list.
   *
   * Derived from the list itself, not from a set of taps, so it is still
   * right after a reload and still right when the other tablet adds
   * something. Matched on the product NAME, which is exactly what tapping a
   * tile puts on the list: an alias match is deliberately not counted, so
   * tapping "Value Pantry Sea Salt" never silently removes a row someone
   * added by saying "salt".
   */
  _onListIds() {
    const items = (this._catalog && this._catalog.items) || [];
    const said = new Set((this._rows || []).map((r) => normalise(r.said)));
    const out = new Set();
    for (const item of items) {
      if (item && said.has(normalise(item.name || ""))) out.add(String(item.id));
    }
    return out;
  }

  /** Tap adds, tap again removes. The second tap is the undo for the first. */
  async _toggleProduct(id) {
    const items = (this._catalog && this._catalog.items) || [];
    const item = items.find((i) => String(i.id) === String(id));
    if (!item || !this._hass) return;
    const key = normalise(item.name || "");
    const onList = (this._rows || []).find((r) => normalise(r.said) === key);
    try {
      await dispatch(this._hass, onList
        ? removePayload(LIST_ENTITY, onList.uid)
        : addPayload(LIST_ENTITY, item.name));
    } catch (err) {
      console.warn("kitchen panel: could not change the list", err);
      return;
    }
    // Refresh BEFORE repainting: the badge now reads from the list, so
    // painting first would show the state we just changed away from.
    await this._refresh();
    this._paintProducts();
  }

  /** Open the Clock app on its timer tab, for whatever is cooking. */
  async _openTimer() {
    if (!this._hass) return;
    try {
      await this._hass.callService("script", TIMER_SCRIPT, {});
    } catch (err) {
      console.warn("kitchen panel: could not open the timer", err);
    }
  }

  /** Start an app on the tablet. Failure is silent to the wall, loud in the log. */
  async _launchApp(packageName) {
    if (!this._hass) return;
    try {
      await dispatch(this._hass, launchAppPayload(TABLET_DEVICE, packageName));
    } catch (err) {
      console.warn("kitchen panel: could not start " + packageName, err);
    }
  }

  async _dryRun() {
    if (!this._hass) return;
    const msg = this.shadowRoot.getElementById("dryrun-msg");
    // In the build bar this line starts hidden, so that an empty paragraph
    // does not hold open a gap beside Build cart. Writing to it reveals it.
    const say = (text) => {
      if (!msg) return;
      msg.textContent = text;
      msg.hidden = false;
    };
    say("Looking everything up. This takes a few seconds.");
    try {
      await this._hass.callService("script", "build_walmart_cart_dry_run", {});
      // The search runs server side, so give it time before repainting or the
      // page redraws before a candidate exists and looks like it did nothing.
      setTimeout(() => this._refresh(), 12000);
    } catch (err) {
      console.warn("kitchen panel: dry run failed", err);
      say("That did not run. Please try again.");
    }
  }

  // --- Mealie ------------------------------------------------------------
  //
  // Every mealie service takes a config_entry_id, which is discovered from the
  // entity registry rather than hard-coded: removing and re-adding the
  // integration mints a new one, and a stale id fails silently with an empty
  // response that looks exactly like "no recipes".
  async _mealieEntry() {
    if (this._mealieEntryId) return this._mealieEntryId;
    try {
      const reg = await this._hass.callWS({ type: "config/entity_registry/get",
                                            entity_id: MEALIE_SENSOR });
      this._mealieEntryId = reg && reg.config_entry_id;
    } catch (err) {
      console.warn("kitchen panel: could not find the Mealie integration", err);
      this._mealieEntryId = null;
    }
    return this._mealieEntryId;
  }

  async _mealie(service, data) {
    const entry = await this._mealieEntry();
    if (!entry) throw new Error("Mealie is not set up");
    // Ask for a response ONLY from services that declare one. delete_mealplan
    // declares response=None, and requesting one there makes Home Assistant
    // refuse the whole call.
    const wantsResponse = service.startsWith("get_");
    const res = await this._hass.callService(
      "mealie", service, { config_entry_id: entry, ...data },
      undefined, false, wantsResponse
    );
    return (wantsResponse && res && res.response) || {};
  }

  async _loadRecipes() {
    if (this._recipesLoading) return;
    this._recipesLoading = true;
    try {
      const out = await this._mealie("get_recipes", { result_limit: 200 });
      // The payload nests: { recipes: { items: [...] } }, not a plain list.
      this._recipes = (out.recipes && out.recipes.items) || [];
      this._recipesError = null;
    } catch (err) {
      console.warn("kitchen panel: could not load recipes", err);
      this._recipesError = "Recipes could not load.";
    }
    this._recipesLoading = false;
    if (this._page() === "recipes") this._paintRecipes();
  }

  _paintRecipes() {
    const host = this.shadowRoot.getElementById("view");
    if (!host) return;
    host.innerHTML = recipesBody({
      items: this._recipes || null,
      query: this._rquery || "",
      loading: !this._recipes && !this._recipesError,
      error: this._recipesError,
    });
    const search = host.querySelector("#rsearch");
    if (search) {
      search.addEventListener("input", (ev) => {
        this._rquery = ev.target.value;
        const at = ev.target.selectionStart;
        this._paintRecipes();
        const next = this.shadowRoot.querySelector("#rsearch");
        if (next) {
          next.focus();
          try { next.setSelectionRange(at, at); } catch (err) { /* ignore */ }
        }
      });
    }
  }

  async _openRecipe(slug) {
    if (!slug) return;
    const el = document.createElement("div");
    el.className = "overlay";
    el.innerHTML = `<div class="sheet recipe"><p class="empty">Loading...</p></div>`;
    el.addEventListener("click", (ev) => { if (ev.target === el) el.remove(); });
    this.shadowRoot.appendChild(el);
    try {
      const out = await this._mealie("get_recipe", { recipe_id: slug });
      el.innerHTML = recipeDetailBody(out.recipe);
    } catch (err) {
      console.warn("kitchen panel: could not load recipe", err);
      el.innerHTML = `<div class="sheet recipe"><p class="problem">
        That recipe could not be loaded.</p></div>`;
    }
    // Rebuilt innerHTML drops the listener above, so re-arm the tap-outside.
    el.addEventListener("click", (ev) => {
      if (ev.target === el) { el.remove(); return; }
      const plan = ev.target.closest(".planthis");
      if (plan) this._planFromRecipe(el, plan.dataset.uuid, plan.dataset.name);
    });
  }

  // The course chips, built from one list so the two planners cannot offer
  // different courses. The first is selected, which is why COURSES puts the
  // main first: it is what gets planned nearly every time.
  _courseChips() {
    return COURSES.map((c, i) => `
          <button class="chip${i === 0 ? " on" : ""}" data-mtype="${
            escapeHtml(c.value)}">${escapeHtml(c.label)}</button>`).join("");
  }

  // Planning straight from a recipe you are already reading.
  //
  // Without this, deciding you want something meant leaving the recipe, going
  // to Weekly Menu, finding the day, pressing Plan and searching for the same
  // recipe again. The decision is made here, so the action belongs here.
  _planFromRecipe(el, uuid, name) {
    if (!uuid) return;
    const sheet = el.querySelector(".sheet");
    if (!sheet) return;
    let mealType = COURSES[0].value;
    // Local to this sheet, NOT this._weekOffset. Reading a recipe and
    // deciding to cook it next Tuesday should not also scroll the Weekly
    // Menu page you were not looking at.
    let offset = 0;
    sheet.innerHTML = `
      <h3>${escapeHtml(name || "")}</h3>
      <div class="chips" id="plan-types">${this._courseChips()}</div>
      <p id="plan-msg">Which day?</p>
      <div class="weeknav">
        <button class="chip" id="plan-prev" title="The week before">&#8249;</button>
        <button class="chip on" id="plan-now"></button>
        <button class="chip" id="plan-next" title="The week after">&#8250;</button>
      </div>
      <div class="chips" id="plan-days"></div>`;
    // Only the days and the label are redrawn, so stepping weeks keeps the
    // Dinner or Side choice already made. Rebuilding the whole sheet reset it.
    const paintDays = () => {
      const days = weekDays(new Date(), offset);
      const now = sheet.querySelector("#plan-now");
      now.textContent = weekLabel(offset);
      now.classList.toggle("on", offset === 0);
      sheet.querySelector("#plan-days").innerHTML = days.map((d) => `
          <button class="chip${d.isToday ? " on" : ""}"
                  data-date="${escapeHtml(d.iso)}">${escapeHtml(d.weekday)}
            <span class="pmeta">${escapeHtml(d.short)}</span></button>`).join("");
    };
    paintDays();
    sheet.addEventListener("click", async (ev) => {
      const typeChip = ev.target.closest("#plan-types .chip");
      if (typeChip) {
        mealType = typeChip.dataset.mtype;
        sheet.querySelectorAll("#plan-types .chip").forEach((c) =>
          c.classList.toggle("on", c === typeChip));
        return;
      }
      if (ev.target.closest("#plan-prev")) { offset -= 1; paintDays(); return; }
      if (ev.target.closest("#plan-next")) { offset += 1; paintDays(); return; }
      if (ev.target.closest("#plan-now")) { offset = 0; paintDays(); return; }
      const day = ev.target.closest("#plan-days .chip");
      if (!day) return;
      const msg = sheet.querySelector("#plan-msg");
      msg.textContent = "Saving...";
      try {
        await this._mealie("set_mealplan", {
          date: day.dataset.date, entry_type: mealType, recipe_id: uuid,
        });
        el.remove();
        this._mealplan = null;
        this._ingRecipes = null;
        await this._loadMealplan();
      } catch (err) {
        console.warn("kitchen panel: could not plan from the recipe", err);
        msg.textContent = "That did not save. Please try again.";
        msg.className = "problem";
      }
    });
  }

  async _loadMealplan() {
    if (this._planLoading) return;
    this._planLoading = true;
    try {
      const today = new Date();
      // Wide enough that stepping through weeks never shows an empty week
      // that is not really empty. The plan is small data: only days with
      // something planned come back, so a wide window costs nothing.
      const from = new Date(today); from.setDate(today.getDate() - 56);
      const to = new Date(today); to.setDate(today.getDate() + 112);
      const out = await this._mealie("get_mealplan", {
        start_date: isoDate(from), end_date: isoDate(to),
      });
      this._mealplan = out.mealplan || [];
      this._planError = null;
    } catch (err) {
      console.warn("kitchen panel: could not load the meal plan", err);
      this._planError = "The week could not load.";
    }
    this._planLoading = false;
    if (this._page() === "menu") this._paintMenu();
    this._paintRail();
  }

  _paintMenu() {
    const host = this.shadowRoot.getElementById("view");
    if (!host) return;
    host.innerHTML = menuBody({
      mealplan: this._mealplan || [],
      today: new Date(),
      offset: this._weekOffset || 0,
      loading: !this._mealplan && !this._planError,
      error: this._planError,
    });
  }

  // Removing a planned meal. Without this a mis-tap was unfixable from the
  // kitchen: tapping a planned row opens the planner, and set_mealplan ADDS
  // rather than replaces, so a second tap gave the day two dinners.
  async _unplan(planId) {
    if (!planId) return;
    try {
      // A STRING. The service declares a text selector, and a number is
      // rejected with 400 Bad Request.
      await this._mealie("delete_mealplan", { mealplan_id: String(planId) });
    } catch (err) {
      console.warn("kitchen panel: could not remove the meal", err);
    }
    this._mealplan = null;
    this._ingRecipes = null;      // the week's ingredients changed with it
    await this._loadMealplan();
  }

  // Planning a day: pick from the recipes already loaded for the recipes tab.
  async _openPlanner(dateIso) {
    if (!this._recipes) await this._loadRecipes();
    const el = document.createElement("div");
    el.className = "overlay";
    const render = (items) => items.map((r) => {
      const img = mealieImageUrl(r.recipe_id, { version: r.image });
      return `
      <div class="cand" data-uuid="${escapeHtml(r.recipe_id || "")}"
           data-slug="${escapeHtml(r.slug || "")}">
        ${img
          ? `<img src="${escapeHtml(img)}" alt="" loading="lazy"
                  onerror="this.remove()">`
          : `<div class="warn">&#127869;</div>`}
        <div><div class="said">${escapeHtml(r.name || "")}</div>
        <div class="match">${escapeHtml(r.total_time || "")}</div></div>
      </div>`;
    }).join("");
    const all = this._recipes || [];
    // "Dinner" stays on this sheet: opened from a day, the meal being planned
    // is that day's dinner, and the chips below are the courses within it.
    el.innerHTML = `<div class="sheet">
        <h3>Dinner for ${escapeHtml(dayTitle(dateIso))}</h3>
        <div class="chips" id="plan-types">${this._courseChips()}</div>
        <input id="plan-search" type="search" autocomplete="off"
               placeholder="Search recipes">
        <p id="plan-msg">Tap a recipe to add it.</p>
        <div id="plan-list">${render(all) || `<p class="empty">No recipes yet.</p>`}</div>
      </div>`;
    let mealType = COURSES[0].value;
    // Thirty recipes is a lot to scroll past while standing at a counter.
    const search = el.querySelector("#plan-search");
    search.addEventListener("input", (ev) => {
      const hits = filterRecipes(all, ev.target.value);
      el.querySelector("#plan-list").innerHTML =
        render(hits) || `<p class="empty">Nothing matches that.</p>`;
    });
    el.addEventListener("click", async (ev) => {
      if (ev.target === el) { el.remove(); return; }
      const typeChip = ev.target.closest("#plan-types .chip");
      if (typeChip) {
        mealType = typeChip.dataset.mtype;
        el.querySelectorAll("#plan-types .chip").forEach((c) =>
          c.classList.toggle("on", c === typeChip));
        return;
      }
      const pick = ev.target.closest(".cand");
      if (!pick) return;
      const msg = el.querySelector("#plan-msg");
      msg.textContent = "Saving...";
      try {
        // The UUID, not the slug. mealie.set_mealplan answers a slug with
        // a 500; mealie.get_recipe accepts either, which is why opening a
        // recipe worked and planning one did not.
        // set_mealplan ADDS, it does not replace, which is what lets a day
        // hold a main and a side. Each entry gets its own id and its own
        // remove control.
        await this._mealie("set_mealplan", {
          date: dateIso, entry_type: mealType, recipe_id: pick.dataset.uuid,
        });
        el.remove();
        this._mealplan = null;
        this._ingRecipes = null;
        await this._loadMealplan();
      } catch (err) {
        console.warn("kitchen panel: could not plan", err);
        msg.textContent = "That did not save. Please try again.";
        msg.className = "problem";
      }
    });
    this.shadowRoot.appendChild(el);
  }

  // The week's ingredients, gathered from each PLANNED recipe.
  //
  // get_mealplan returns the plan with a summary of each recipe, but not its
  // ingredients, so each distinct recipe needs its own get_recipe. A planned
  // week is a handful of recipes, and they are fetched once and reused.
  async _loadIngredients() {
    if (this._ingLoading) return;
    this._ingLoading = true;
    try {
      if (!this._mealplan) await this._loadMealplan();
      const days = weekDays(new Date(), this._weekOffset || 0)
        .map((d) => d.iso);
      const slugs = [];
      for (const entry of this._mealplan || []) {
        const iso = String(entry.mealplan_date || entry.date || "").slice(0, 10);
        const slug = entry.recipe && entry.recipe.slug;
        // Only this week, and only entries that are a recipe: a free-text
        // note has no ingredients to gather.
        if (days.includes(iso) && slug && !slugs.includes(slug)) slugs.push(slug);
      }
      this._plannedCount = slugs.length;
      const out = [];
      for (const slug of slugs) {
        const res = await this._mealie("get_recipe", { recipe_id: slug });
        if (res.recipe) out.push(res.recipe);
      }
      this._ingRecipes = out;
      this._ingError = null;
    } catch (err) {
      console.warn("kitchen panel: could not gather ingredients", err);
      this._ingError = "This week's ingredients could not load.";
    }
    this._ingLoading = false;
    if (this._page() === "ingredients") this._paintIngredients();
  }

  // Parsing is done by AppDaemon, not here: the write needs a Mealie API
  // token, and anything in this file is served from /config/www without
  // authentication. The panel names the recipes; the token stays server side.
  async _parseWeek() {
    const slugs = (this._ingRecipes || [])
      .map((r) => r && r.slug).filter(Boolean);
    const msg = this.shadowRoot.getElementById("parse-msg");
    if (!slugs.length) {
      if (msg) msg.textContent = "Nothing is planned to parse.";
      return;
    }
    const btn = this.shadowRoot.getElementById("parse-week");
    if (btn) btn.disabled = true;
    if (msg) {
      msg.textContent =
        `Parsing ${slugs.length} recipe${slugs.length === 1 ? "" : "s"}...`;
    }
    try {
      await this._hass.callService("script", "mealie_parse_week",
                                   { slugs: slugs.join(",") });
      // The work happens in AppDaemon, so give it time before re-reading.
      setTimeout(async () => {
        this._ingRecipes = null;
        await this._loadIngredients();
        const done = this._hass.states["sensor.mealie_parse_result"];
        const after = this.shadowRoot.getElementById("parse-msg");
        if (after && done) {
          const a = done.attributes || {};
          after.textContent = a.problem
            ? `Parsed ${a.ingredients} across ${a.recipes}. ${a.problem}`
            : `Parsed ${a.ingredients} ingredients across ${a.recipes} ` +
              `recipes. ${a.low_confidence || 0} are worth checking.`;
        }
      }, 9000);
    } catch (err) {
      console.warn("kitchen panel: could not start parsing", err);
      if (msg) {
        msg.textContent = "That did not start. Is the Mealie parser set up?";
        msg.className = "problem";
      }
      if (btn) btn.disabled = false;
    }
  }

  // Ticking an ingredient off. Painted immediately rather than waiting for
  // the round trip, because a checkbox that lags feels broken; the sensor
  // update that follows repaints from the real state anyway.
  async _toggleIngredient(key) {
    if (!key || !this._hass) return;
    // Keyed to the week ON SCREEN, so a tick made while planning next week
    // belongs to next week.
    const week = weekDays(new Date(), this._weekOffset || 0)[0].iso;
    const row = this.shadowRoot.querySelector(
      `.ingrow[data-key="${CSS.escape(key)}"]`);
    if (row) row.classList.toggle("got");
    try {
      await this._hass.callService("script", "kitchen_ingredient_toggle",
                                   { key, week });
    } catch (err) {
      console.warn("kitchen panel: could not tick that off", err);
      if (row) row.classList.toggle("got");   // put it back
    }
  }

  // Check all / uncheck all. Sends the KEYS rather than a command, so the
  // stored set can never hold something the page does not show.
  async _setAllTicks(on) {
    if (!this._hass) return;
    const week = weekDays(new Date(), this._weekOffset || 0)[0].iso;
    const keys = on
      ? [...this.shadowRoot.querySelectorAll(".ingrow")]
          .map((r) => r.dataset.key).filter(Boolean)
      : [];
    try {
      await this._hass.callService("script", "kitchen_ingredients_set",
                                   { week, keys: keys.join(String.fromCharCode(10)) });
    } catch (err) {
      console.warn("kitchen panel: could not set the ticks", err);
    }
  }

  _paintIngredients() {
    const host = this.shadowRoot.getElementById("view");
    if (!host) return;
    // The ticks live in Home Assistant so the tablet and a desktop show the
    // same review. They belong to a week: a tick from last week would
    // silently suppress something genuinely needed again.
    const sensor = this._hass && this._hass.states[TICK_SENSOR];
    const attrs = (sensor && sensor.attributes) || {};
    const week = weekDays(new Date(), this._weekOffset || 0)[0].iso;
    host.innerHTML = ingredientsBody({
      recipes: this._ingRecipes || null,
      planned: this._plannedCount || 0,
      loading: !this._ingRecipes && !this._ingError,
      error: this._ingError,
      checked: attrs.week === week ? (attrs.checked || []) : [],
    });
  }

  _paintProducts() {
    const host = this.shadowRoot.getElementById("view");
    if (!host) return;
    const catalog = this._catalog || {};
    this._shown = this._shown || PAGE_SIZE;
    host.innerHTML = productsBody({
      items: Array.isArray(catalog.items) ? catalog.items : null,
      categories: catalog.categories || [],
      query: this._query || "",
      category: this._category || "",
      shown: this._shown,
      pageSize: PAGE_SIZE,
      added: this._onListIds(),
      error: this._catalogFailed
        ? "What we buy could not load. Pull down to retry."
        : null,
    });
    const search = host.querySelector("#psearch");
    if (search) {
      search.addEventListener("input", (ev) => {
        this._query = ev.target.value;
        this._shown = PAGE_SIZE;
        const at = ev.target.selectionStart;
        this._paintProducts();
        // Repainting replaces the input, so focus and caret have to be put
        // back or a second keystroke would be impossible on a tablet.
        const next = this.shadowRoot.querySelector("#psearch");
        if (next) {
          next.focus();
          try { next.setSelectionRange(at, at); } catch (err) { /* ignore */ }
        }
      });
    }
  }

  _say(id, text) {
    // The views are swapped in and out, so a message may be aimed at an
    // element that the page on screen does not contain.
    const el = this.shadowRoot.getElementById(id);
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
  }

  async _submitAdd(input) {
    const text = input.value.trim();
    if (!text) return;
    // Clear first so a second Enter cannot add the same thing twice.
    input.value = "";
    this._say("addmsg", "");
    try {
      await dispatch(this._hass, addPayload(LIST_ENTITY, text));
    } catch (err) {
      console.warn("kitchen panel: add failed", err);
      // Give the person back what they typed, unless they already started
      // typing something else.
      if (!input.value) input.value = text;
      this._say("addmsg", "That did not get added. Please try again.");
      return;
    }
    setTimeout(() => this._refresh(), 1500);
  }

  // Two taps on the same button: the first asks, the second builds. A mis-tap
  // by a guest or child only changes the label, and it reverts on its own.
  async _buildCart() {
    if (this._building) return;
    const btn = this.shadowRoot.getElementById("build");
    if (!this._confirming) {
      this._confirming = true;
      btn.textContent = "Tap again to confirm";
      this._confirmTimer = setTimeout(() => this._paintBuild(), 4000);
      return;
    }
    this._cancelConfirm();
    this._building = true;
    btn.disabled = true;
    this._say("buildmsg", "");
    try {
      await dispatch(this._hass, buildCartPayload());
      setTimeout(() => this._refresh(), 1500);
    } catch (err) {
      console.warn("kitchen panel: build failed", err);
      this._say("buildmsg", "The cart could not be started. Please try again.");
    } finally {
      this._building = false;
      this._paintBuild();
    }
  }

  _cancelConfirm() {
    clearTimeout(this._confirmTimer);
    this._confirmTimer = null;
    this._confirming = false;
  }

  _openMenu(uid, anchor) {
    const row = this._rows.find((r) => r.uid === uid);
    if (!row) return;
    // Skipping answers "stop offering me products for this phrase", which is
    // only a question while the phrase has no product. Once it is matched the
    // option is not just useless, it is a trap: tapping it would throw away a
    // good match and start suppressing the phrase.
    const matched = row.status === "matched";
    const items = [
      ["Use a different product", null, false],
      ["Not a product, stop asking", async () => {
        await dispatch(this._hass, skipPayload(row.said));
      }, matched],
      ["Remove from list", async () => {
        await dispatch(this._hass, removePayload(LIST_ENTITY, row.uid));
      }, false],
    ];
    const el = document.createElement("div");
    el.className = "overlay";
    el.innerHTML = `<div class="menusheet">
        ${items.map(([label, , off], i) =>
          `<button class="menuitem" data-i="${i}"${off ? " disabled" : ""}${
            off ? ' title="Already matched to a product"' : ""
          }>${escapeHtml(label)}</button>`
        ).join("")}
        <p class="problem" id="menu-msg" hidden></p>
      </div>`;
    const sheet = el.querySelector(".menusheet");
    el.addEventListener("click", async (ev) => {
      const btn = ev.target.closest(".menuitem");
      if (!btn) {
        if (ev.target === el) el.remove();
        return;
      }
      if (btn.disabled) return;
      const [, action] = items[Number(btn.dataset.i)];
      if (!action) {
        el.remove();
        this._openReview(uid);
        return;
      }
      btn.disabled = true;
      try {
        await action();
      } catch (err) {
        console.warn("kitchen panel: menu action failed", err);
        btn.disabled = false;
        const msg = el.querySelector("#menu-msg");
        msg.textContent = "That did not work. Please try again.";
        msg.hidden = false;
        return;
      }
      el.remove();
      setTimeout(() => this._refresh(), 1000);
    });
    this.shadowRoot.appendChild(el);
    // Below and right-aligned to the button, clamped inside the viewport.
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const a = anchor.getBoundingClientRect();
    const w = sheet.offsetWidth;
    const h = sheet.offsetHeight;
    const margin = 8;
    const left = Math.max(margin, Math.min(a.right - w, vw - w - margin));
    const top = Math.max(margin, Math.min(a.bottom + 4, vh - h - margin));
    sheet.style.left = `${left}px`;
    sheet.style.top = `${top}px`;
  }

  _openReview(uid) {
    const row = this._rows.find((r) => r.uid === uid);
    if (!row) return;
    const phrase = row.said;
    const { index } = catalogLookup(this._catalog);
    // Candidates only exist for phrases the backend could not resolve, so an
    // already-matched row has none of its own. Offer products from the
    // catalog instead: this sheet is also how you swap one size for another
    // and how you repoint a phrase whose product went out of stock.
    const own = (row.candidates || []).filter((c) => c && c.item_id);
    const fromCatalog = own.length === 0;
    const cands = fromCatalog ? suggestProducts(this._catalog, phrase) : own;
    const cardsHtml = cands.map((c) => {
      const entry = index[String(c.item_id)];
      // A candidate from the backend carries no picture, and its url is the
      // product page, not an image. The catalog is the only source of a
      // thumbnail, and every URL goes through buildThumbUrl.
      const img = c.thumbnail || (entry && entry.thumbnail) || null;
      const title = c.title || (entry && entry.display_name) || "";
      return `
      <div class="cand" data-item="${escapeHtml(c.item_id)}">
        ${img
          ? `<img src="${escapeHtml(buildThumbUrl(img, { size: 72 }))}" alt="">`
          : `<div class="warn">&#9888;</div>`}
        <div><div class="said">${escapeHtml(title)}</div>
        <div class="match">${c.bought ? `bought ${escapeHtml(c.bought)} times` : ""}</div></div>
      </div>`;
    }).join("");
    const el = document.createElement("div");
    el.className = "overlay";
    el.innerHTML = `<div class="sheet">
        <h3>${escapeHtml(phrase)}</h3>
        <p id="sheet-msg">${
          fromCatalog ? "Pick the product this should be."
            : "Tap the product you meant."
        }</p>
        ${cardsHtml || `<div class="empty">${
          fromCatalog
            ? "No matching recently purchased items found. Try Searching Walmart."
            : "No suggestions yet."
        }</div>`}
        <div class="sheetfoot">
          <button class="chip" id="sheet-search">Search Walmart</button>
        </div>
      </div>`;
    const sheet = el.querySelector(".sheet");
    // A status line and a failure line are both this one paragraph, so the
    // tone travels with the text. Reporting "Asking Walmart..." in the red
    // problem style reads as though the search had already failed.
    const say = (text, tone = "problem") => {
      const msg = el.querySelector("#sheet-msg");
      msg.textContent = text;
      msg.className = tone;
    };
    // Every pick writes an alias and starts a cart build, which cannot be
    // undone, so the guard belongs to the whole sheet. Locking only the
    // tapped tile let two quick taps on two tiles start two builds.
    let busy = false;
    el.addEventListener("click", async (ev) => {
      if (ev.target.closest("#sheet-search")) {
        if (busy) return;
        busy = true;
        sheet.classList.add("busy");
        const found = await this._searchWalmart(phrase, say);
        busy = false;
        sheet.classList.remove("busy");
        // Redrawn rather than patched in place: the new candidates need
        // their pictures sized and their tiles wired, which is what
        // _openReview already does.
        if (found) {
          el.remove();
          this._openReview(uid);
        }
        return;
      }
      const pick = ev.target.closest(".cand");
      if (!pick) {
        if (!busy && ev.target === el) el.remove();
        return;
      }
      if (busy) return;
      let payload;
      try {
        payload = pickPayload(phrase, pick.dataset.item);
      } catch (err) {
        console.warn("kitchen panel: pick rejected", err);
        say("That one could not be chosen. Please try another.");
        return;
      }
      busy = true;
      sheet.classList.add("busy");
      pick.classList.add("busy");
      try {
        await dispatch(this._hass, payload);
      } catch (err) {
        console.warn("kitchen panel: pick failed", err);
        busy = false;
        sheet.classList.remove("busy");
        pick.classList.remove("busy");
        say("That did not save. Please try again.");
        return;
      }
      el.remove();
      // The pick WRITES to the catalog: it adds the alias, and for a searched
      // product it adds an index entry too. _loadCatalog only fetches when
      // _catalog is null, so without this the panel keeps matching against
      // the copy it fetched when the page opened, and the row goes on saying
      // "no match yet" after a pick that saved perfectly well. Observed with
      // "chicken wings": alias written at 19:41, row still unmatched.
      this._catalog = null;
      this._settleMatch(uid);
    });
    this.shadowRoot.appendChild(el);
  }

  /**
   * Refresh until a picked row actually shows its product.
   *
   * A pick is saved by AppDaemon, which then rewrites the todo item and
   * republishes sensor.walmart_pending. The panel used to do ONE refresh
   * 1.5s later, which is a race it often lost: land before the write and the
   * row goes on reading "no match yet" until the next 30 second tick, so a
   * pick that saved perfectly well looks like matching is broken.
   *
   * The catalog is dropped on EVERY attempt rather than once, because a fetch
   * that happens before the write would cache the copy that still lacks the
   * new alias, and every later attempt would then re-read that stale copy.
   *
   * Gives up quietly after about seven seconds. The row is correct in the
   * data by then whatever the panel shows, and the next tick will paint it.
   */
  async _settleMatch(uid) {
    for (const wait of SETTLE_WAITS) {
      await new Promise((done) => setTimeout(done, wait));
      this._catalog = null;
      await this._refresh();
      const row = this._rows.find((r) => r.uid === uid);
      // Gone from the list is settled too: a pick can resolve the phrase and
      // drop it from the pending queue in the same step.
      if (!row || row.productName) return true;
    }
    return false;
  }

  /**
   * Query Walmart for one phrase and wait for the answer to land.
   *
   * Returns true when real candidates arrived. The round trip is a SerpAPI
   * call made by AppDaemon, so the answer does not come back through the
   * service call: the app writes it to sensor.walmart_pending, which is what
   * _refresh reads. Hence polling rather than awaiting a result.
   *
   * Bounded at SEARCH_TRIES because "Walmart has nothing for that" and
   * "the search never ran" look identical from here, and a spinner that
   * never stops is the worse of the two to leave on a kitchen wall.
   */
  async _searchWalmart(phrase, say) {
    say("Asking Walmart...", "match");
    try {
      await dispatch(this._hass, searchPayload(phrase));
    } catch (err) {
      console.warn("kitchen panel: search failed", err);
      say("Walmart could not be reached. Please try again.");
      return false;
    }
    for (let i = 0; i < SEARCH_TRIES; i += 1) {
      await new Promise((done) => setTimeout(done, SEARCH_WAIT_MS));
      // Same reason as the pick: a search can add products to the index.
      this._catalog = null;
      await this._refresh();
      const row = this._rows.find((r) => r.said === phrase);
      // Candidates, not status. A requested search now reaches the panel even
      // for a phrase that is already matched, which is what correcting a bad
      // match needs; treating "matched" as success returned on the very first
      // poll and closed the sheet before any result arrived.
      const found = ((row && row.candidates) || [])
        .filter((c) => c && c.item_id);
      if (found.length) return true;
    }
    say("Walmart had nothing for that. Try different words.");
    return false;
  }

  // Leaves _catalog null on failure so the next refresh tries again. Caching
  // an empty catalog meant one transient failure left every row reading "no
  // match yet" and Build cart disabled until someone reloaded the browser.
  async _loadCatalog() {
    if (this._catalog !== null) return;
    try {
      const r = await fetch(CATALOG_URL, { cache: "no-cache" });
      if (!r.ok) throw new Error(`catalog fetch returned ${r.status}`);
      this._catalog = await r.json();
      this._catalogFailed = false;
    } catch (err) {
      // The list must still render without the catalog.
      console.warn("kitchen panel: catalog unavailable", err);
      this._catalog = null;
      this._catalogFailed = true;
    }
  }

  async _refresh() {
    if (this._refreshing) {
      this._again = true;
      return;
    }
    this._refreshing = true;
    try {
      do {
        this._again = false;
        await this._loadCatalog();
        const res = await this._hass.callWS({
          type: "todo/item/list", entity_id: LIST_ENTITY,
        });
        const sensor = this._hass.states["sensor.walmart_pending"];
        const pending = (sensor && sensor.attributes.items) || [];
        this._rows = buildRows({
          items: (res && res.items) || [], catalog: this._catalog, pending,
        });
        this._syncView();
        this._paintRows();
        this._paintRail();
        this._paintBuild();
        this._say("listmsg", this._catalogFailed
          ? "Product matches could not load. Trying again in a moment."
          : "");
      } while (this._again);
    } catch (err) {
      // Painting nothing left a heading over empty space, which reads as
      // "nothing on the list" rather than "could not load".
      console.warn("kitchen panel: could not refresh the list", err);
      this._say("listmsg", "The list could not load. Trying again in a moment.");
      this._paintRows({ problem: true });
      this._paintRail();
      this._paintBuild();
    } finally {
      this._refreshing = false;
    }
  }

  // Updates only the #rows subtree in place. Never touch the shadow root
  // itself: that would destroy the clock and any text typed in the add field.
  _paintRows({ problem = false } = {}) {
    const host = this.shadowRoot.getElementById("rows");
    if (!host) return;   // a different page is on screen
    if (!this._rows.length) {
      host.innerHTML = problem
        ? `<div class="empty">The list is not available right now.</div>`
        : `<div class="empty">Nothing on the list.</div>`;
      return;
    }
    // A row that still needs a match is the only one asking anything of you,
    // so it gets the amber treatment. Skipped rows are settled, not pending,
    // and stay quiet.
    host.innerHTML = this._rows.map((r) => `
      <div class="row${!r.productName && r.status !== "skipped" ? " attn" : ""}"
           data-uid="${escapeHtml(r.uid)}">
        ${r.thumbUrl
          ? `<img class="thumb" src="${escapeHtml(r.thumbUrl)}" alt="">`
          : `<div class="warn">${r.status === "skipped" ? "&#9898;" : "&#9888;"}</div>`}
        <div>
          <div class="said">${escapeHtml(r.said)}</div>
          <div class="match">${
            r.productName ? escapeHtml(r.productName)
              : r.status === "skipped" ? "not a product" : "no match yet"
          }</div>
        </div>
        <button class="kebab" data-uid="${escapeHtml(r.uid)}">&#8942;</button>
      </div>`).join("");
  }

  // Updates only the #queue subtree and the rail heading, in place.
  // The rail is tonight's dinner now, not a second copy of the list.
  //
  // It used to repeat every unmatched row, which meant tapping a row and
  // tapping the rail did exactly the same thing. The unmatched rows are
  // already visible in the list with a warning glyph and are tappable there,
  // so the rail reports the COUNT and leaves the acting to the list.
  _paintRail() {
    const today = isoDate(new Date());
    const planning = this._mealplan === null || this._mealplan === undefined;
    // The DINNER, not a side: a day can hold several dishes and the picture
    // should be the main one. dinnerFor already filters to entry_type dinner.
    const dinner = this._mealplan ? dinnerFor(this._mealplan, today) : null;

    const tonight = this.shadowRoot.getElementById("tonightbody");
    if (tonight) {
      const img = dinner
        ? mealieImageUrl(dinner.recipeId, { size: "min", version: dinner.image })
        : null;
      tonight.innerHTML = planning
        ? `<div class="empty">Loading the meal plan...</div>`
        : dinner
        ? `${img
             ? `<img class="rhero" src="${escapeHtml(img)}" alt=""
                     onerror="this.remove()">`
             : ""}
           <div class="railmeal">${escapeHtml(dinner.title)}</div>
           ${dinner.slug
             ? `<button class="chip" id="rail-recipe"
                  data-slug="${escapeHtml(dinner.slug)}">Open the recipe</button>`
             : ""}`
        : `<div class="empty">Nothing planned for tonight.</div>
           <button class="chip plan"
                   data-date="${escapeHtml(today)}">Plan dinner</button>`;
    }

    const host = this.shadowRoot.getElementById("queue");
    if (!host) return;
    const q = unmatchedRows(this._rows);
    const heading = this.shadowRoot.querySelector("#needs h2");
    if (heading) {
      heading.textContent = q.length
        ? `Needs a Match (${q.length})` : "Needs a Match";
    }
    host.innerHTML = q.length
      ? q.map((r) => `
        <div class="row" data-uid="${escapeHtml(r.uid)}">
          <div class="warn">&#9888;</div>
          <div><div class="said">${escapeHtml(r.said)}</div>
            <div class="match">tap to fix</div></div>
          <span></span>
        </div>`).join("")
      : `<p class="empty">Everything on the list matched.</p>`;
  }

  _paintBuild() {
    this._cancelConfirm();
    const n = this._rows.filter((r) => r.status === "matched").length;
    const btn = this.shadowRoot.getElementById("build");
    if (!btn) return;
    btn.textContent = n
      ? `Build cart · ${n} ${n === 1 ? "item" : "items"}` : "Build cart";
    btn.disabled = n === 0 || this._building === true;
  }

  // Hides Home Assistant's sidebar, but only when the URL asks for it.
  //
  // The sidebar costs 255px of a 1280px tablet and offers a non-admin user
  // nothing this panel needs. It is not hidden unconditionally, because
  // dockedSidebar is stored against the USER, not the browser: hiding it
  // here would also hide it on your desktop the next time you opened this
  // page. The kiosk tablet signs in as its own account and its start URL
  // carries ?kiosk, so only that account is affected.
  //
  // hass-dock-sidebar is the frontend's own event, the same one the sidebar
  // dispatches when you collapse it by hand, so this is not reaching into
  // Home Assistant's internals.
  _applyKiosk() {
    if (!new URLSearchParams(window.location.search).has("kiosk")) return;
    this.dispatchEvent(new CustomEvent("hass-dock-sidebar", {
      detail: { dock: "always_hidden" }, bubbles: true, composed: true,
    }));
  }

  _tick() {
    const { time, meridiem, date } = formatClock(new Date(), this._tz);
    this.shadowRoot.getElementById("t").textContent = time;
    this.shadowRoot.getElementById("ampm").textContent = meridiem;
    this.shadowRoot.getElementById("d").textContent = date;
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
  }
}

// Home Assistant re-imports this module when the frontend reconnects after a
// core restart, so on any restart with the panel open define() runs a second
// time and throws "the name has already been used with this registry". The
// panel still worked - define is the last statement - but it filled the log
// from every open browser. Registering only once is the fix.
if (!customElements.get("walmart-kitchen-panel")) {
  customElements.define("walmart-kitchen-panel", WalmartKitchenPanel);
}
