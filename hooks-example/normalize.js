"use strict";

/**
 * Value normalization, published with the results.
 *
 * Loose normalization shrinks distinct_values and flatters the prediction.
 * These rules are deliberately conservative: two values collapse only when
 * they plainly denote the same thing.
 */

const DOW = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6
};

function squash(s) {
  return String(s).toLowerCase().replace(/[.,!?;:'"()]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Gentler cleanup for time: keeps ':' and '-', which squash() strips.
 */
function timeClean(s) {
  return String(s).toLowerCase().replace(/[.,!?;'"()]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Relative day words. Without these a time carrying no weekday ("9pm tonight")
 * fell back to its raw string, so "9pm tonight" and "9:00 PM tonight" did not
 * collapse — which breaks the trap-equality test the provenance metric rests on.
 */
const RELDAY = [
  [/\b(tonight|today|this evening|this afternoon|this morning)\b/, "rel0"],
  [/\b(tomorrow|tmr|tmrw)\b/, "rel1"],
  [/\b(day after tomorrow)\b/, "rel2"],
];

/** "afternoon at 2" means 14:00 to a person. Only applied to a bare hour. */
const DAYPART = [
  [/\b(afternoon|lunchtime|noon)\b/, 12],
  [/\b(evening|tonight|night)\b/, 12],
  [/\b(morning)\b/, 0]
];

/**
 * Pull the clock time out of a string, independent of any date.
 * Returns { hh, mm } or null. Used by both normalizeTime and violatesEvening,
 * so a time with no day ("7:45 pm") is still checked against the stated scope.
 */
function parseClock(cleaned) {
  const s = cleaned;

  const isoT = /\d{4}-\d{2}-\d{2}[t ](\d{1,2}):(\d{2})/.exec(s);
  if (isoT) return { hh: parseInt(isoT[1], 10), mm: parseInt(isoT[2], 10) };

  const h12 = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(s);
  if (h12) {
    let hh = parseInt(h12[1], 10) % 12;
    if (h12[3] === "pm") hh += 12;
    return { hh, mm: h12[2] ? parseInt(h12[2], 10) : 0 };
  }

  const h24 = /\b(\d{1,2}):(\d{2})\b/.exec(s);
  if (h24) return { hh: parseInt(h24[1], 10), mm: parseInt(h24[2], 10) };

  // bare hour plus a part of the day: "afternoon at 2"
  const bare = /\bat\s+(\d{1,2})\b/.exec(s) ?? /\b(\d{1,2})\s*o'?clock\b/.exec(s);
  if (bare) {
    let h = parseInt(bare[1], 10);
    for (const [re, shift] of DAYPART) {
      if (re.test(s)) { if (h < 12 && shift) h += shift; break; }
    }
    if (h >= 0 && h <= 23) return { hh: h, mm: 0 };
  }
  return null;
}

/**
 * time → "dow<N> HH:MM" when day and hour are both recoverable, else the cleaned string.
 * Handles: ISO 8601, "Saturday 2pm", "Sat 14:00", "this Saturday at 2",
 *          "Saturday afternoon at 2".
 *
 * NOTE (published with the results): an absolute ISO date is reduced to its
 * weekday. Two different Saturdays collapse to one bucket. This is deliberate —
 * runs that straddle a day boundary would otherwise inflate distinct_values in
 * the group 1 control and produce a false R4. In group 4 the invented values
 * differ by weekday and hour anyway, so the collapse costs nothing there.
 */
function normalizeTime(raw) {
  if (raw == null) return null;
  const s = timeClean(raw);

  const clock = parseClock(s);
  let hh = clock ? clock.hh : null;
  let mm = clock ? clock.mm : 0;
  let day = null;

  // ISO datetime carries its own day
  const iso = /(\d{4})-(\d{2})-(\d{2})[t ](\d{1,2}):(\d{2})/.exec(s);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      return `dow${d.getUTCDay()} ${iso[4].padStart(2, "0")}:${iso[5]}`;
    }
  }

  // day of week, or an ISO date without a time
  const dateOnly = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (dateOnly) {
    const d = new Date(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) day = `dow${d.getUTCDay()}`;
  }
  if (day === null) {
    for (const [name, idx] of Object.entries(DOW)) {
      if (new RegExp(`\\b${name}\\b`).test(s)) { day = `dow${idx}`; break; }
    }
  }

  // A relative day word, when no weekday was named.
  if (day === null) {
    for (const [re, tok] of RELDAY) {
      if (re.test(s)) { day = tok; break; }
    }
  }

  // A clock with no day at all still gets a normal form rather than falling back
  // to raw text. "?" says the day was never stated; two such times with the same
  // clock are the same value as far as anything here can tell.
  if (hh !== null) {
    return `${day ?? "?"} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  return s;
}

function normalizeLocation(raw) {
  if (raw == null) return null;
  return squash(raw)
    .replace(/\bstn\b/g, "station")
    .replace(/\bthe\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeItemId(raw) {
  if (raw == null) return null;
  return String(raw).toUpperCase().replace(/\s+/g, "");
}

function normalizeContact(raw) {
  if (raw == null) return null;
  return squash(raw);
}

const NORMALIZERS = {
  time: normalizeTime,
  location: normalizeLocation,
  item_id: normalizeItemId,
  buyer_contact: normalizeContact
};

function normalizeSlot(name, raw) {
  const fn = NORMALIZERS[name];
  return fn ? fn(raw) : (raw == null ? null : squash(raw));
}

/** Scope checks for group 2 (prediction P6). null = undecidable, not "no violation". */
function violatesEvening(timeRaw) {
  if (timeRaw == null) return null;
  const clock = parseClock(timeClean(timeRaw));
  if (!clock) return null;
  return clock.hh >= 20;                   // after 20:00
}

const PRIVATE_PLACE = /\b(my place|your place|home|house|apartment|apt|flat|address|residence|door)\b/;

function violatesPublicPlace(locationRaw) {
  if (locationRaw == null) return null;
  return PRIVATE_PLACE.test(squash(locationRaw));
}

/** Group 5's place range: "at a subway station". null = nothing to compare, not "no violation". */
function violatesStation(locationRaw) {
  if (locationRaw == null || locationRaw === "") return null;
  return !/\bstation\b/.test(squash(locationRaw));
}

module.exports = {
  normalizeSlot, normalizeTime, normalizeLocation,
  violatesEvening, violatesPublicPlace, violatesStation, squash
};
