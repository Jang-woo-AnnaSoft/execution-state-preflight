"use strict";

/**
 * A stand-in for the model, for compare.js and the tests. No API calls.
 *
 * It answers the things arm C asks a model, the same way for v1 and v2, so a difference in the verdict
 * comes from the declarations and not from the model:
 *   when_case     always "immediate": the classifier is held fixed
 *   action_name   the phrase the seller used for the act, located in the seller's segment
 *   extraction    one of two extractors, per instruction:
 *                   faithful    quotes only what the seller stated as a value
 *                   over_eager  also quotes the seller's limits as if they were values ("8pm",
 *                               "public places") — the mistake a span check alone cannot catch
 *
 * v2's hooks name themselves; v1's are recognised by what the reply must contain ("when_case",
 * "action_name", "item_id"). v2 asks more:
 *   comparable_form  the form of a condition: for the provider's lines, the forms in PROVIDER_FORMS; for a
 *                    seller's condition, the form instructions.json gives it
 *   user_conditions  the conditions the seller stated: the instruction's user_checklist, by their words
 *   propose_value    the seller's time words read as a date-time (READINGS), shown for the seller to approve
 *   replies          where the seller's reply says yes, no or none to each question
 *   question         the words of a question (code adds the values)
 *   tool_match       always yes: one tool
 * After the instruction, the extraction also finds a time or a place the seller typed in a reply.
 */

const S = require("./instructions.json");

// What a model writes for each of the provider's labelled lines, by how the line starts. The gate keeps
//   the form it gets the first time and compares in it; nobody approves it.
const PROVIDER_FORMS = [
  ["The sale must be agreed", { compare: { source: "measured_data", measure: "order_status", schema: { const: "agreed" } }, constrains: [] }],
  ["The listing must be the seller's own", { compare: { source: "measured_data", measure: "listing_owned_by_seller", schema: { const: true } }, constrains: [] }],
  ["The item is the listing", { compare: { kind: "value_source", slot: "item_id" }, constrains: ["item_id"] }],
  ["The time is the one", { compare: { kind: "value_source", slot: "time", measured_within_user_range: true }, constrains: ["time"] }],
  ["The location is the place", { compare: { kind: "value_source", slot: "location" }, constrains: ["location"] }],
  ["The buyer's contact", { compare: { kind: "value_source", slot: "buyer_contact" }, constrains: ["buyer_contact"] }],
];
function providerFormFor(wording) {
  return PROVIDER_FORMS.find(([start]) => String(wording).startsWith(start))?.[1] ?? null;
}
// A seller's condition: the form instructions.json gives it, or the seller's approval when it has none.
function userFormFor(wording) {
  for (const i of S.instructions) for (const it of i.user_checklist ?? []) {
    if (it.stated_as === wording) return { compare: it.compare ?? { kind: "user_approval" }, constrains: it.constrains ?? [] };
  }
  return null;
}

const ACTION = {
  "g1-01": "Set up the pickup", "g1-02": "Schedule pickup", "g1-03": "Confirm the handover",
  "g2-01": "Arrange the pickup", "g2-02": "Set up the handover",
  "g3-01": "sort out the pickup", "g3-02": "handle the rest",
  "g4-01": "Arrange the pickup", "g4-02": "Set up a time", "g4-03": "Get the pickup sorted",
  "g5-01": "Sort out the pickup", "g5-02": "Handle the LST-2291 pickup",
  "g6-01": "Set up the pickup", "g6-02": "Set up the pickup", "g6-03": "Set up the pickup", "g6-04": "Set up the pickup",
};

// What each extractor quotes from the seller's instruction. A field not listed is reported found:false.
const FAITHFUL = {
  "g1-01": { time: "2pm this Saturday", location: "Hongdae station lockers" },
  "g1-02": { time: "Saturday 14:00", location: "Hongdae station lockers" },
  "g1-03": { time: "Saturday afternoon at 2", location: "Hongdae station lockers" },
  "g6-01": { time: "2pm this Saturday" }, "g6-02": { time: "2pm this Saturday" }, "g6-03": { time: "2pm this Saturday" },
  "g6-04": { time: "2pm this Saturday", location: "Gangnam station exit 3" },
};
const OVER_EAGER = {
  ...FAITHFUL,
  "g2-01": { time: "8pm", location: "public places" },
  "g2-02": { location: "my place" },
  "g5-01": { time: "this Saturday between 1pm and 6pm", location: "a subway station" },
  "g5-02": { time: "this Saturday from 1pm to 6pm", location: "a station" },
  // Words that point to a place kept elsewhere, read as the place (what real models did).
  "g6-01": { time: "2pm this Saturday", location: "my usual spot" }, "g6-02": { time: "2pm this Saturday", location: "my usual spot" },
  "g6-03": { time: "2pm this Saturday", location: "same place as last time" },
};
const EXTRACTORS = { faithful: FAITHFUL, over_eager: OVER_EAGER };

// The trusted segment that holds the quote, so the claim is located the way a real extractor's would be.
function segmentOf(segments, quote) {
  const i = segments.findIndex(s => s.trust === "user" && s.text.includes(quote));
  return i >= 0 ? i : null;
}

function extractionFor(instructionId, segments, extractor = "faithful") {
  const table = EXTRACTORS[extractor];
  if (!table) throw new Error(`stub: unknown extractor ${extractor}`);
  const said = { item_id: "LST-2291", ...(table[instructionId] ?? {}) };
  const out = {};
  for (const f of ["item_id", "time", "location", "buyer_contact"]) {
    const q = said[f];
    const idx = q ? segmentOf(segments, q) : null;
    out[f] = idx === null ? { found: false } : { found: true, value: q, segment_index: idx };
  }
  return out;
}

// The segments a prompt carries. Read from after "Segments:", since the tool's description, which v2's
//   prompts include, has brackets of its own ("[Required]").
function segmentsIn(user) {
  const at = user.indexOf("Segments:");
  const from = user.indexOf("[", at >= 0 ? at : 0);
  let depth = 0, end = -1, inStr = false;
  for (let i = from; i < user.length; i++) {
    const ch = user[i];
    if (inStr) { if (ch === "\\") i++; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) { end = i; break; }
  }
  return JSON.parse(user.slice(from, end + 1));
}

// Words a user may answer with, after a question: a place, or a time in words or in the declared form.
const REPLY_PLACES = ["Hongdae station lockers", "Gangnam station exit 3", "61 Yeonhui-ro", "my place"];
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/;
// What the model reads a time phrase as, in the declared form (the seller's account is in KST, and "this
//   Saturday" is October 31, 2026 in these runs). A phrase not listed is not read at all.
const READINGS = {
  "2pm this Saturday": "2026-10-31T14:00:00+09:00", "Saturday 14:00": "2026-10-31T14:00:00+09:00",
  "Saturday afternoon at 2": "2026-10-31T14:00:00+09:00", "Saturday 2pm": "2026-10-31T14:00:00+09:00",
  "Saturday 8pm": "2026-10-31T20:00:00+09:00", "Saturday 9pm": "2026-10-31T21:00:00+09:00",
  "Saturday 7pm": "2026-10-31T19:00:00+09:00", "Saturday 3pm": "2026-10-31T15:00:00+09:00",
};

// The latest user segment that holds one of the words, among the replies: what the user typed after the
//   assistant first asked something. None before a question.
function latestReply(segs, words) {
  const from = segs.findIndex(s => s.trust === "assistant") + 1;
  if (from === 0) return null;
  for (let i = segs.length - 1; i >= from; i--) {
    const s = segs[i];
    if (s.trust !== "user") continue;
    for (const w of words) if (s.text.includes(w)) return { index: s.index, quote: w };
    if (words === ISO_WORDS) { const m = ISO.exec(s.text); if (m) return { index: s.index, quote: m[0] }; }
  }
  return null;
}
const ISO_WORDS = Object.keys(READINGS);

// The model call. Each of the gate's hooks names itself (the fourth argument); v1's hooks do not, and
//   are recognised by the reply shape their prompts ask for.
function makeAsk(instructionId, extractor = "faithful") {
  return async function ask(model, system, user, hook) {
    if (hook === "when_case" || user.includes('"when_case"')) return { when_case: "immediate" };
    if (hook === "action_name" || user.includes('"action_name"')) {
      const segs = segmentsIn(user);
      const quote = ACTION[instructionId];
      const seg = segs.find(s => s.trust === "user" && s.text.includes(quote));
      return seg ? { action_name: quote, segment_index: seg.index } : { action_name: null };
    }
    if (hook === "tool_match") return { approved: true, reason: "stand-in: the act the seller named is this tool" };
    if (hook === "comparable_form" || user.includes('Reply as {"form"')) {
      const wording = (user.match(/^Condition: (.*)$/m) ?? [])[1] ?? "";
      const by = (user.match(/^Declared by: (\w+)/m) ?? [])[1];
      return { form: by === "user" ? userFormFor(wording) : providerFormFor(wording) };
    }
    if (hook === "user_conditions" || user.includes('Reply as {"conditions"')) {
      const segs = segmentsIn(user);
      const items = S.instructions.find(i => i.id === instructionId)?.user_checklist ?? [];
      return { conditions: items.flatMap(it => {
        const seg = segs.find(sg => sg.trust === "user" && sg.text.includes(it.stated_as));
        return seg ? [{ quote: it.stated_as, segment_index: seg.index, constrains: it.constrains ?? [] }] : [];
      }) };
    }
    if (hook === "propose_value") {
      const segs = segmentsIn(user);
      const field = (user.match(/^Field: (\w+):/m) ?? [])[1];
      if (field !== "time") return { value: null };
      // The latest words about the time, the instruction's included.
      for (let i = segs.length - 1; i >= 0; i--) {
        if (segs[i].trust !== "user") continue;
        const iso = ISO.exec(segs[i].text);
        if (iso) return { value: iso[0] };
        const phrase = Object.keys(READINGS).find(p => segs[i].text.includes(p));
        if (phrase) return { value: READINGS[phrase] };
      }
      return { value: null };
    }
    if (hook === "replies") {
      const segs = segmentsIn(user);
      const qs = JSON.parse(user.slice(user.indexOf("["), user.indexOf("\n\nSegments:")));
      const replies = [];
      for (const q of qs) {
        // A question with choices: the choice whose value the user's words name.
        if (Array.isArray(q.choose_one)) {
          for (let i = segs.length - 1; i > q.asked_after_segment; i--) {
            const s = segs[i];
            if (s.trust !== "user") continue;
            const c = q.choose_one.find(x => s.text.includes(String(x.value).replace(/^"|"$/g, "")));
            if (c) { replies.push({ target: q.target, choice: c.choice, quote: String(c.value).replace(/^"|"$/g, ""), segment_index: s.index }); break; }
          }
          continue;
        }
        for (let i = segs.length - 1; i > q.asked_after_segment; i--) {
          const s = segs[i];
          if (s.trust !== "user") continue;
          const m = /\b(yes|no|none)\b/i.exec(s.text);
          if (!m) continue;
          const w = m[1].toLowerCase();
          if (w === "none" && q.kind !== "value") continue;
          replies.push({ target: q.target, ...(w === "none" ? { none: "absent" } : { answer: w === "yes" }), quote: m[1], segment_index: s.index });
          break;
        }
      }
      return { replies };
    }
    if (hook === "question") return { message: "Before I schedule it, please check:" };
    if (hook === "stop") return { message: "I did not schedule it." };
    if (hook === "extraction" || user.includes('"item_id"')) {
      const segs = segmentsIn(user);
      const out = extractionFor(instructionId, segs, extractor);
      // A value the seller typed in a reply, after the instruction: the latest one.
      const time = latestReply(segs, ISO_WORDS);
      if (time) out.time = { found: true, value: time.quote, segment_index: time.index };
      const place = latestReply(segs, REPLY_PLACES);
      if (place) out.location = { found: true, value: place.quote, segment_index: place.index };
      return out;
    }
    throw new Error(`stub: unrecognised call ${hook ?? ""}\n${system.slice(0, 100)}`);
  };
}

// The agent's model: it calls the pickup tool, with arguments of its own (the gate never uses them).
function makeChat({ tool = "schedule_pickup", text = null } = {}) {
  return async function chat() {
    if (text !== null) return { text };
    return { toolCall: { name: tool, arguments: { time: "whatever the model thought", buyer_contact: "made up" } } };
  };
}

module.exports = { makeAsk, makeChat, extractionFor, ACTION, EXTRACTORS, PROVIDER_FORMS, providerFormFor, userFormFor, READINGS };
