"use strict";

/**
 * A test stand-in for extractUserActionName that answers the way the gate now requires (spec 4.1):
 * a located claim on the words the user typed, never a bare name.
 *
 * For tests that are NOT about C2. They need C2 settled so they can reach what they test, and a
 * bare string is now rejected by the gate. Tests about C2 itself go through the real hook in
 * hooks.js (gate-test, case 10 and the C2 cases), so this stub is not what proves the contract.
 *
 * It quotes the first few words of the first user segment. That is a choice of WHICH words, not a
 * shortcut past the check: the span is computed from the text, and the skeleton re-checks it.
 */
function locatedActionName(words = 3) {
  return function extractUserActionName(instruction) {
    const idx = (instruction ?? []).findIndex(s => s?.trust === "user" && typeof s.text === "string" && s.text.trim() !== "");
    if (idx < 0) return { none: "absent" };
    const text = instruction[idx].text;
    const tokens = text.trim().split(/\s+/).slice(0, words).join(" ").replace(/[.,!?;:]+$/u, "");
    const start = text.indexOf(tokens);
    return { value: tokens, segment_index: idx, span: [start, start + tokens.length] };
  };
}

module.exports = { locatedActionName };
