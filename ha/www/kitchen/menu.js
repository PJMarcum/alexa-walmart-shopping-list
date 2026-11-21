// ha/www/kitchen/menu.js
/**
 * The week's meals, from Mealie's meal plan.
 *
 * Why the service and not the calendar entities: the integration exposes
 * calendar.mealie_dinner and six siblings, but a calendar entity's STATE is
 * on/off for whether an event is running right now, and its attributes
 * describe the current or next event. Dinner at 18:00 is invisible at 09:00,
 * which is exactly when someone looks at the tablet. mealie.get_mealplan takes
 * a date range and answers the question actually being asked.
 */
import { escapeHtml } from "./html.js";

export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "side", "snack",
                           "dessert"];

/**
 * The courses the planner offers, and what to call them.
 *
 * Dinner is the whole meal; main is the course inside it. So the panel says
 * "Main" while Mealie goes on storing "dinner", because Mealie's entry_type
 * vocabulary is fixed and dinnerFor() picks the day's picture by looking for
 * exactly that value. Renaming the stored value would leave the rail with no
 * pictures at all.
 *
 * Three of Mealie's six. This household plans one evening meal that may be
 * several dishes; breakfast, lunch and snack would be clutter on a kitchen
 * wall.
 */
export const COURSES = [
  { value: "dinner", label: "Main" },
  { value: "side", label: "Side" },
  { value: "dessert", label: "Dessert" },
];

/** The household's name for a stored entry_type, or the type itself. */
export function courseLabel(entryType) {
  const key = String(entryType == null ? "" : entryType).toLowerCase();
  const hit = COURSES.find((c) => c.value === key);
  return hit ? hit.label : String(entryType == null ? "" : entryType);
}

// The week starts on SATURDAY, because the groceries are ordered on Friday.
//
// That makes Friday the last act of the old week rather than something
// floating in the middle of the new one: plan Friday, order Friday, new week
// begins Saturday. It also clears the ingredient ticks for free, since they
// are keyed to the week's start date and that key rolls over on its own at
// midnight with no scheduled job to misfire.
//
// Day numbers from getDay(): 0 Sunday through 6 Saturday.
const WEEK_STARTS_ON = 6;

/**
 * Seven days starting on the Saturday of the week containing `today`.
 *
 * offset: 0 is the week containing `today`, 1 is the next one, -1 the last.
 */
export function weekDays(today, offset = 0) {
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // How far back the most recent start day is. Saturday itself gives 0, and
  // Friday gives 6, which is what keeps the order at the END of its week.
  const back = (base.getDay() - WEEK_STARTS_ON + 7) % 7;
  const monday = new Date(base);
  monday.setDate(base.getDate() - back + offset * 7);
  const out = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    out.push({
      iso: isoDate(d),
      weekday: d.toLocaleDateString([], { weekday: "long" }),
      short: d.toLocaleDateString([], { month: "short", day: "numeric" }),
      // Against the REAL today, so stepping to another week highlights
      // nothing rather than highlighting the wrong tile.
      isToday: isoDate(d) === isoDate(base),
    });
  }
  return out;
}

/**
 * What to call a week, relative to the one containing today.
 *
 * "This week" is worth naming: without it, stepping away and forgetting is
 * easy, and a plan landing on the wrong week is invisible until someone cooks
 * the wrong thing. Shared with the planner sheet opened from a recipe, so the
 * two cannot drift into two phrasings for the same Saturday.
 */
export function weekLabel(offset = 0) {
  if (offset === 0) return "This week";
  if (offset === 1) return "Next week";
  if (offset === -1) return "Last week";
  return `${offset > 0 ? "+" : ""}${offset} weeks`;
}

/**
 * "Sunday, Oct 4" from a YYYY-MM-DD.
 *
 * Split and rebuilt rather than passed to new Date(iso): the string form is
 * parsed as UTC midnight, which in Central time is the previous evening, so
 * every date would read a day early.
 */
export function dayTitle(iso) {
  const parts = String(iso == null ? "" : iso).split("-").map(Number);
  const [y, m, d] = parts;
  if (parts.length !== 3 || !y || !m || !d) {
    return String(iso == null ? "" : iso);
  }
  const date = new Date(y, m - 1, d);
  return `${date.toLocaleDateString([], { weekday: "long" })}, ${
    date.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

/** YYYY-MM-DD in LOCAL time. toISOString would shift the date near midnight. */
export function isoDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The plan entries falling on one date, dinner first because it is the one asked about. */
export function entriesFor(mealplan, iso) {
  const rank = (t) => {
    const i = MEAL_TYPES.indexOf(String(t || "").toLowerCase());
    return i === -1 ? MEAL_TYPES.length : i;
  };
  return (mealplan || [])
    .filter((e) => e && String(e.mealplan_date || e.date || "").slice(0, 10) === iso)
    .sort((a, b) => rank(b.entry_type) - rank(a.entry_type))
    .reverse();
}

/** Tonight's dinner, for the rail. Null when nothing is planned. */
export function dinnerFor(mealplan, iso) {
  const hit = (mealplan || []).find(
    (e) => e &&
      String(e.mealplan_date || e.date || "").slice(0, 10) === iso &&
      String(e.entry_type || "").toLowerCase() === "dinner"
  );
  if (!hit) return null;
  const r = hit.recipe || {};
  return {
    title: titleOf(hit),
    recipeId: r.recipe_id || null,
    slug: r.slug || null,
    // Mealie's image token, used as the cache buster on the picture URL.
    image: r.image || null,
  };
}

/** A plan entry is either a recipe or a free-text note, and both must render. */
export function titleOf(entry) {
  if (!entry) return "";
  if (entry.recipe && entry.recipe.name) return entry.recipe.name;
  if (entry.title) return entry.title;
  if (entry.note_title) return entry.note_title;
  return "";
}

function dayBlock(day, entries) {
  const rows = entries.length
    ? entries.map((e) => `
        <div class="mealrow" data-date="${escapeHtml(day.iso)}"
             data-type="${escapeHtml(e.entry_type || "dinner")}"
             data-slug="${escapeHtml((e.recipe && e.recipe.slug) || "")}"
             data-planid="${escapeHtml(e.mealplan_id == null ? "" : e.mealplan_id)}">
          <span class="mealtype">${escapeHtml(courseLabel(e.entry_type))}</span>
          <span class="said">${escapeHtml(titleOf(e))}</span>
          <button class="unplan" title="Remove from the plan"
                  data-planid="${escapeHtml(e.mealplan_id == null ? "" : e.mealplan_id)}"
                  >&times;</button>
        </div>`).join("")
    : `<p class="empty">Nothing planned</p>`;
  return `
    <div class="day${day.isToday ? " today" : ""}">
      <div class="dayhead">
        <h3>${escapeHtml(day.weekday)}</h3>
        <span class="pmeta">${escapeHtml(day.short)}</span>
        <button class="chip plan" data-date="${escapeHtml(day.iso)}">Plan</button>
      </div>
      ${rows}
    </div>`;
}

/** state: { mealplan, today, offset, loading, error } */
export function menuBody(state) {
  const { mealplan = [], today = new Date(), offset = 0, loading = false,
          error = null } = state || {};
  if (error) return `<div class="card pcard"><div class="problem">${
    escapeHtml(error)}</div></div>`;
  if (loading) return `<div class="card pcard"><p class="empty">
    Loading the week...</p></div>`;

  const days = weekDays(today, offset);
  const label = weekLabel(offset);
  return `
    <div class="card pcard">
      <div class="phead">
        <h2>Weekly Menu</h2>
        <div class="weeknav">
          <button class="chip" id="week-prev" title="The week before">&#8249;</button>
          <button class="chip${offset ? "" : " on"}" id="week-now">${
            escapeHtml(label)}</button>
          <button class="chip" id="week-next" title="The week after">&#8250;</button>
        </div>
        <span class="pmeta">${escapeHtml(days[0].short)} to ${
          escapeHtml(days[6].short)}</span>
      </div>
      <div class="week">
        ${days.map((d) => dayBlock(d, entriesFor(mealplan, d.iso))).join("")}
      </div>
    </div>`;
}
