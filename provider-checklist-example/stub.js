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
 * which both prompts name: "when_case", "action_name", "item_id".
 */

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

// The model call. Recognises the call by the reply shape both prompts ask for.
function makeAsk(instructionId, extractor = "faithful") {
  return async function ask(model, system, user) {
    if (user.includes('"when_case"')) return { when_case: "immediate" };
    if (user.includes('"action_name"')) {
      const segs = JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1));
      const quote = ACTION[instructionId];
      const seg = segs.find(s => s.trust === "user" && s.text.includes(quote));
      return seg ? { action_name: quote, segment_index: seg.index } : { action_name: null };
    }
    if (user.includes('"item_id"')) {
      const segs = JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1));
      return extractionFor(instructionId, segs, extractor);
    }
    throw new Error(`stub: unrecognised call\n${system.slice(0, 100)}`);
  };
}

module.exports = { makeAsk, extractionFor, ACTION, EXTRACTORS };
