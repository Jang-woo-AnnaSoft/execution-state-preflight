"use strict";

/**
 * The ports the gate reads through, wired from a test case.
 *
 * The gate reads the tool's definition itself (readToolDefinition), measures when it needs a value, with
 * the values it has settled (measure), and reads the user's replies from the user's own words
 * (readReplies). A case in these tests is written as what the provider declared (the tool), what the
 * system holds (measured values) and what the user replied. This file fills the ports from the case, and
 * nothing else: what the gate does with them is the gate's.
 *
 *   withPorts(hooks, { tool, measured })
 *       readToolDefinition  returns the case's tool, for that tool's name only
 *       measure             reads `measured` ({ name: { valid, value } }), unless the case wires its own
 *   askRound(hooks, answers)
 *       the round that asks: a model proposes, for each value the user will approve, that value
 *       (proposeValue), so the question shows it
 *   answerRound(hooks, instruction, answers)
 *       the round after: the user's reply is appended as their own words, and readReplies reports where
 *       in it each question was answered. answers = { userAnswers: { slot: value | { none: "absent" } },
 *       checklistAnswers: { id: true | false | { answer } } }. A slot or item the gate did not ask about
 *       is reported all the same — the gate refuses it.
 */

const REPLY = "yes. no. none.";
const at = word => [REPLY.indexOf(word), REPLY.indexOf(word) + word.length];
const isNone = v => v && typeof v === "object" && v.none === "absent";

function withPorts(hooks, { tool, measured = {} } = {}) {
  return {
    ...hooks,
    readToolDefinition: hooks.readToolDefinition ?? (name => {
      if (!tool || tool.name !== name) throw new Error(`no definition for ${name}`);
      return tool;
    }),
    measure: hooks.measure ?? (name => (measured && name in measured ? measured[name] : undefined)),
  };
}

function askRound(hooks, { userAnswers = {} } = {}) {
  return {
    ...hooks,
    proposeValue: (field) => (field in userAnswers && !isNone(userAnswers[field]) ? { value: userAnswers[field] } : undefined),
  };
}

function answerRound(hooks, instruction, { userAnswers = {}, checklistAnswers = {} } = {}) {
  const replied = [...(instruction ?? []), { trust: "user", text: REPLY }];
  const segment_index = replied.length - 1;
  const readReplies = () => {
    const claims = [];
    for (const [slot, v] of Object.entries(userAnswers)) {
      claims.push(isNone(v)
        ? { target: `value:${slot}`, none: "absent", quote: "none", segment_index, span: at("none") }
        : { target: `value:${slot}`, answer: true, quote: "yes", segment_index, span: at("yes") });
    }
    for (const [id, a] of Object.entries(checklistAnswers)) {
      const answer = typeof a === "boolean" ? a : a?.answer;
      if (typeof answer !== "boolean") continue;
      const word = answer ? "yes" : "no";
      claims.push({ target: `approve:${id}`, answer, quote: word, segment_index, span: at(word) });
    }
    return claims.length ? claims : { none: "absent" };
  };
  return { hooks: { ...askRound(hooks, { userAnswers }), readReplies }, instruction: replied };
}

const hasAnswers = a => Object.keys(a?.userAnswers ?? {}).length + Object.keys(a?.checklistAnswers ?? {}).length > 0;

module.exports = { withPorts, askRound, answerRound, hasAnswers, REPLY };
