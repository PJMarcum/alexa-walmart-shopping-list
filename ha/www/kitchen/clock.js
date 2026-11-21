// ha/www/kitchen/clock.js
/**
 * The kitchen clock reads Home Assistant's configured time zone, never the
 * tablet's.
 *
 * A cheap Android tablet is a bad clock. It ships with whatever time zone the
 * setup wizard guessed, nobody checks it, and the kitchen has no other clock
 * to contradict it. Observed on the kitchen tablet: the panel read 10:07
 * PM while the house was at 9:07 PM, because the device was still on Eastern.
 *
 * hass.config.time_zone is the house's own answer and is already correct
 * everywhere else in Home Assistant, so the panel defers to it. A missing or
 * unknown zone falls back to the device rather than throwing, because a clock
 * that is an hour wrong is still better than a panel that will not render.
 */

/**
 * The meridiem is returned SEPARATELY from the digits.
 *
 * "9:43 AM" as one string forces the AM to the same size and weight as the
 * time, which is wrong: the digits are the thing you read across a kitchen,
 * and the AM is a footnote. Splitting them lets the panel set each one's
 * size, and formatToParts is how you find the boundary without assuming the
 * locale puts it last, or has one at all. A 24-hour locale yields no
 * dayPeriod part and an empty string, which renders as nothing.
 */
function splitTime(date, opts) {
  const fmt = new Intl.DateTimeFormat([], {
    hour: "numeric", minute: "2-digit", ...opts,
  });
  const parts = fmt.formatToParts(date);
  const meridiem = (parts.find((p) => p.type === "dayPeriod") || {}).value || "";
  const time = parts
    .filter((p) => p.type !== "dayPeriod")
    .map((p) => p.value)
    .join("")
    .trim();
  return { time, meridiem };
}

export function formatClock(date, timeZone) {
  const opts = timeZone ? { timeZone } : {};
  try {
    return {
      ...splitTime(date, opts),
      date: date.toLocaleDateString([], {
        weekday: "long", month: "short", day: "numeric", ...opts,
      }),
    };
  } catch (err) {
    // An unrecognised zone makes the formatter throw a RangeError. The
    // device clock is wrong, but it is a clock.
    return {
      ...splitTime(date, {}),
      date: date.toLocaleDateString([], {
        weekday: "long", month: "short", day: "numeric",
      }),
    };
  }
}
