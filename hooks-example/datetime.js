"use strict";

/**
 * Turns what a seller says about time into the datetime the tool requires — deterministically,
 * and with every input named.
 *
 * A person says "2pm this Saturday" and, somewhere in the conversation, "It's Wednesday,
 * October 28" or "This Saturday is October 31st". A person never says the year or the time
 * zone. The tool needs `2026-10-31T14:00:00+09:00`. So the value is DERIVED from three kinds of
 * input, and the gate's record has to name all of them (spec 2.7):
 *
 *   the span            "2pm this Saturday"            instruction, the slot's own location
 *   a date statement    "October 28" / "October 31st"  instruction, another place the user said it
 *   year, time zone     2026, +09:00                    measured_data — the system clock and the
 *                                                       account region, never the user
 *
 * If any of them is missing, there is no value: resolve() returns null and the slot stays as the
 * user wrote it, which the format check then refuses. Nothing here guesses a month, a year or a
 * zone. No model is called — a model turning words into a date is generation, not derivation.
 *
 * Covers the phrasings this experiment uses, not English. Add a pattern, add a test.
 */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
                "august", "september", "october", "november", "december"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const MONTH_RE = new RegExp(
  `\\b(${MONTHS.join("|")}|${MONTHS.map(m => m.slice(0, 3)).join("|")})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i");

function weekdayIn(text) {
  const m = String(text).toLowerCase().match(new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`));
  return m ? WEEKDAYS.indexOf(m[1]) : null;
}

/** Hour and minute from the phrasings used here. null if the text does not state a time. */
function timeOfDay(text) {
  const t = String(text).toLowerCase();
  let m = t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) return { h: +m[1], min: +m[2] };
  m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let h = +m[1] % 12;
    if (m[3] === "pm") h += 12;
    return { h, min: m[2] ? +m[2] : 0 };
  }
  m = t.match(/\b(afternoon|evening)\b.*?\bat\s+(\d{1,2})\b/);
  if (m) return { h: (+m[2] % 12) + 12, min: 0 };
  return null;
}

/**
 * The most recent date statement in what the user typed: month and day, the weekday if one is
 * named in the same segment, and where it is. Trusted segments only — a date in the buyer's
 * message is the buyer's, and the gate would refuse it as an input anyway.
 */
function dateStatement(segments) {
  for (let i = (segments ?? []).length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg?.trust !== "user" || typeof seg.text !== "string") continue;
    const m = seg.text.match(MONTH_RE);
    if (!m) continue;
    const key = m[1].toLowerCase().slice(0, 3);
    return {
      month: MONTHS.findIndex(x => x.startsWith(key)) + 1,
      day: +m[2],
      weekday: weekdayIn(seg.text),
      // "It's Wednesday, October 28" says what TODAY is. "This Saturday is October 31st" says what
      //   one named day is, and nothing about today. Mixing the two put "tonight" on the 31st.
      is_today: /\b(today|it'?s|it is)\b/i.test(seg.text),
      segment_index: i,
      span: [m.index, m.index + m[0].length],
    };
  }
  return null;
}

const pad = n => String(n).padStart(2, "0");

/**
 * @param phrase    the text at the slot's span, e.g. "2pm this Saturday"
 * @param segments  the instruction, as InstructionSegment[]
 * @param measured  { year, tz } as the system measured them, or nulls
 * @returns { iso, derived_from } or null
 */
function resolve(phrase, segments, measured) {
  const tod = timeOfDay(phrase);
  const stmt = dateStatement(segments);
  const year = measured?.year, tz = measured?.tz;
  if (!tod || !stmt || !Number.isInteger(year) || typeof tz !== "string") return null;

  const anchor = new Date(Date.UTC(year, stmt.month - 1, stmt.day));
  if (anchor.getUTCMonth() !== stmt.month - 1) return null;              // October 32nd
  // A named weekday that the calendar contradicts is not a date we can use.
  if (stmt.weekday !== null && anchor.getUTCDay() !== stmt.weekday) return null;

  const p = String(phrase).toLowerCase();
  const want = weekdayIn(p);
  let date;
  if (want !== null && stmt.weekday === want && !stmt.is_today) {
    date = anchor;                                       // "This Saturday is October 31st"
  } else if (want !== null && stmt.is_today) {
    // "this Saturday" from Wednesday the 28th is the 31st; from Saturday the 31st it is the 31st.
    const ahead = (want - anchor.getUTCDay() + 7) % 7;
    date = new Date(anchor.getTime() + ahead * 86400000);
  } else if (/\btomorrow\b/.test(p) && stmt.is_today) {
    date = new Date(anchor.getTime() + 86400000);
  } else if (/\b(today|tonight)\b/.test(p) && stmt.is_today) {
    date = anchor;
  } else {
    return null;           // a time with no day, or a day the statements do not pin down
  }

  const iso = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
              `T${pad(tod.h)}:${pad(tod.min)}:00${tz}`;
  return {
    iso,
    derived_from: [
      { source: "instruction", segment_index: stmt.segment_index, span: stmt.span },
      { source: "measured_data", name: "clock_year", value: year },
      { source: "measured_data", name: "timezone", value: tz },
    ],
  };
}

/** ISO 8601 date-time WITH an offset. A local time with no zone is not a moment. */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;

module.exports = { resolve, timeOfDay, dateStatement, ISO_DATETIME };
