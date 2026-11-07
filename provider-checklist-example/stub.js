"use strict";

/**
 * A stand-in for the model, for compare.js and the tests. No API calls.
 *
 * It answers the three things arm C asks a model, the same way for v1 and v2, so a difference in the
 * verdict comes from the declarations and not from the model:
 *   when_case     always "immediate": the classifier is held fixed
 *   action_name   the phrase the seller used for the act, located in the seller's segment
 *   extraction    one of two extractors, per instruction:
 *                   faithful    quotes only what the seller stated as a value
 *                   over_eager  also quotes the seller's limits as if they were values ("8pm",
 *                               "public places") — the mistake a span check alone cannot catch
 *
 * The prompts of v1 and v2 differ, so the stub recognises the call by what the reply must contain,
 * which both prompts name: "when_case", "action_name", "item_id". v2 asks two more things:
 *   form          the comparable form a condition could take (a proposal for its declarer to confirm):
 *                 for the provider's lines, the forms in PROVIDER_FORMS; for a seller's condition, the
 *                 form instructions.json gives it
 *   conditions    the conditions the seller stated: the instruction's user_checklist, by their words
 */

const S = require("./instructions.json");

// What a model proposes for each of the provider's labelled lines, by how the line starts. These are
//   the forms a provider would confirm (arm.js confirms them, as a provider would once).
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
};

// What each extractor quotes from the seller's instruction. A field not listed is reported found:false.
const FAITHFUL = {
  "g1-01": { time: "2pm this Saturday", location: "Hongdae station lockers" },
  "g1-02": { time: "Saturday 14:00", location: "Hongdae station lockers" },
  "g1-03": { time: "Saturday afternoon at 2", location: "Hongdae station lockers" },
};
const OVER_EAGER = {
  ...FAITHFUL,
  "g2-01": { time: "8pm", location: "public places" },
  "g2-02": { location: "my place" },
  "g5-01": { time: "this Saturday between 1pm and 6pm", location: "a subway station" },
  "g5-02": { time: "this Saturday from 1pm to 6pm", location: "a station" },
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

// The model call. Recognises the call by the reply shape both prompts ask for.
function makeAsk(instructionId, extractor = "faithful") {
  return async function ask(model, system, user) {
    if (user.includes('"when_case"')) return { when_case: "immediate" };
    if (user.includes('"action_name"')) {
      const segs = segmentsIn(user);
      const quote = ACTION[instructionId];
      const seg = segs.find(s => s.trust === "user" && s.text.includes(quote));
      return seg ? { action_name: quote, segment_index: seg.index } : { action_name: null };
    }
    if (user.includes('Reply as {"form"')) {
      const wording = (user.match(/^Condition: (.*)$/m) ?? [])[1] ?? "";
      const by = (user.match(/^Declared by: (\w+)/m) ?? [])[1];
      return { form: by === "user" ? userFormFor(wording) : providerFormFor(wording) };
    }
    if (user.includes('Reply as {"conditions"')) {
      const segs = segmentsIn(user);
      const items = S.instructions.find(i => i.id === instructionId)?.user_checklist ?? [];
      return { conditions: items.flatMap(it => {
        const seg = segs.find(sg => sg.trust === "user" && sg.text.includes(it.stated_as));
        return seg ? [{ quote: it.stated_as, segment_index: seg.index, constrains: it.constrains ?? [] }] : [];
      }) };
    }
    if (user.includes('"item_id"')) {
      const segs = segmentsIn(user);
      return extractionFor(instructionId, segs, extractor);
    }
    throw new Error(`stub: unrecognised call\n${system.slice(0, 100)}`);
  };
}

module.exports = { makeAsk, extractionFor, ACTION, EXTRACTORS, PROVIDER_FORMS, providerFormFor, userFormFor };
