"use strict";

/**
 * Arm C for the provider-checklist example: the gate in front of the call, with every rule read from the
 * tool's definition. Same inputs as hooks-example/arm-gate.js (v1): the same user turn, the same
 * measurements, plus the two the provider's [Required] lines name (order_status, listing_owned_by_seller).
 *
 * The gate reads the definition through its port (here: this folder's tool.json, standing in for what the
 * MCP server serves), measures through its port (here: the condition's platform facts) and reads the
 * seller's replies from the seller's words. The provider's lines are translated by the stand-in model the
 * first time and kept in the run's storage; nobody approves them.
 *
 * The verdict and the execution sit in one place here, as in v1, so the results can be read
 * directly. Spec 3.5 separates them; see hooks-example/README.md.
 */

const { createPreflight } = require("../execution-state-preflight");
const { createHooks, createStorage } = require("./hooks");
const { buildUserTurn } = require("./prompts");
const TOOL = require("./tool.json");

const OUTCOME = { execute: "call", ask_user: "ask", hold: "hold", system_lookup: "system_lookup",
                  definition_repair: "definition_repair", exhausted: "exhausted", deferred: "deferred" };

// What the platform measures. buyer_contact, the order status and who owns the listing are the
//   platform's own facts about the listing; the clock year and zone are the parts of a date nobody says;
//   a pickup request the buyer sent through the app is a platform record. Whether the gate may USE each
//   one is the provider's call, in the form of a labelled line, not this file's: location is measured
//   here too, and the [Verify] line on it keeps it out.
//   The listing is the seller's own in every condition here (one listing, the seller's).
function measuredFor(ctx, date) {
  return {
    buyer_contact: { valid: true, value: ctx.buyer_contact },
    listing_owned_by_seller: { valid: true, value: ctx.listing_owned_by_seller ?? true },
    ...(ctx.order_status !== undefined ? { order_status: { valid: true, value: ctx.order_status } } : {}),
    ...Object.fromEntries(Object.entries(date?.measured ?? {}).map(([k, v]) => [k, { valid: true, value: v }])),
    ...(ctx.pickup_request ? {
      time: { valid: true, value: ctx.pickup_request.time },
      location: { valid: true, value: ctx.pickup_request.location },
    } : {}),
  };
}

// The names this system can measure: what a comparable form may read.
const MEASUREMENTS = ["order_status", "listing_owned_by_seller", "buyer_contact", "time", "location"];
// Facts about one listing: the platform can read them only once the gate has settled which listing.
const ABOUT_THE_LISTING = new Set(MEASUREMENTS);

// The measure port: the gate calls it with the values it has settled. A fact about the listing is read
//   for the listing the seller named (LST-2291 here); before that is settled, it cannot be read.
function measurePort(measured, seen = null) {
  return (name, settled) => {
    seen?.push({ name, item_id: settled?.values?.item_id ?? null });
    if (ABOUT_THE_LISTING.has(name) && settled?.values?.item_id !== "LST-2291") return { valid: false };
    return name in measured ? measured[name] : undefined;
  };
}

// The seller's replies, as the seller's words: each reply is a segment appended to the conversation, and
//   the reply reader reports, for every reply so far, what it answered. userAnswers: { slot: value |
//   { none: "absent" } } — the seller's yes to that value, shown in the question; checklistAnswers:
//   { id: true | false }.
const REPLY = "yes. no. none.";
const at = w => [REPLY.indexOf(w), REPLY.indexOf(w) + w.length];
function replyReader(log) {
  return () => {
    const claims = [];
    for (const { index, userAnswers = {}, checklistAnswers = {} } of log) {
      for (const [slot, v] of Object.entries(userAnswers)) {
        claims.push(v && typeof v === "object" && v.none === "absent"
          ? { target: `value:${slot}`, none: "absent", quote: "none", segment_index: index, span: at("none") }
          : { target: `value:${slot}`, answer: true, quote: "yes", segment_index: index, span: at("yes") });
      }
      for (const [id, a] of Object.entries(checklistAnswers)) {
        const w = a === true ? "yes" : "no";
        claims.push({ target: `approve:${id}`, answer: a === true, quote: w, segment_index: index, span: at(w) });
      }
    }
    return claims.length ? claims : { none: "absent" };
  };
}

/**
 * @param ctx   a condition's context from instructions.json
 * @param date  a date mode from instructions.json, or null
 * @param ask   the model call (a stub in compare.js and the tests)
 * @param userAnswers, checklistAnswers  the seller's replies: the run first asks, then the seller replies
 * @param forms  a map from a line's opening words to the form the model writes for it instead, or null for
 *               no form (tests)
 * @param storage, tool  a storage shared across runs (a translation is kept there), the definition read
 */
async function runArm({ ctx, instructionText, userChecklist = [], userAnswers = {}, checklistAnswers = {}, date = null, ask,
                        runId = "run", tool = TOOL, forms = {}, measured, storage = createStorage(), seen = null }) {
  const measure = measurePort(measured ?? measuredFor(ctx, date), seen);
  const log = [];
  let segments = buildUserTurn(ctx, instructionText, date).segments;
  const hasValues = Object.keys(userAnswers).length > 0, hasItems = Object.keys(checklistAnswers).length > 0;
  // The rounds, as they happen: asked; the values answered (and the approvals asked); the approvals answered.
  //   The question shows each value the seller then approves (proposeValue).
  if (hasValues || hasItems) {
    await runOnce("-asked");
    if (hasValues) {
      segments = [...segments, { trust: "user", text: REPLY }];
      log.push({ index: segments.length - 1, userAnswers });
      if (hasItems) await runOnce("-values");
    }
    if (hasItems) {
      segments = [...segments, { trust: "user", text: REPLY }];
      log.push({ index: segments.length - 1, checklistAnswers });
    }
  }
  const turn1 = await runOnce("");
  if (date?.seller_answer && turn1.outcome === "ask") {
    segments = [...buildUserTurn(ctx, instructionText, date, true).segments];
    const turn2 = await runOnce("-t2");
    return { ...turn2, turns: 2, turn1: { outcome: turn1.outcome, blanks: turn1.blanks } };
  }
  return { ...turn1, turns: 1 };

  async function runOnce(suffix) {
    const base = createHooks({ ask, model: "stub", runId: runId + suffix, unitKey: runId, measure,
      readToolDefinition: name => (name === tool.name ? tool : undefined), measurements: MEASUREMENTS });
    const hooks = {
      ...base,
      // The value the seller will approve, read from their words (a stand-in for the model's reading).
      proposeValue: async (field, instruction, schema) => (field in userAnswers
        ? { value: userAnswers[field] } : base.proposeValue(field, instruction, schema)),
      readReplies: replyReader(log),
      ...(Object.keys(forms).length ? { proposeComparableForm: async req => {
        const override = Object.entries(forms).find(([start]) => String(req.wording).startsWith(start));
        if (!override) return base.proposeComparableForm(req);
        return override[1] ? { ...override[1], by: "test" } : undefined;
      } } : {}),
    };
    const preflight = createPreflight({ hooks, storage });
    const state = await preflight.runPreflight({
      userId: "seller_1", instruction: segments, toolCall: { name: tool.name, arguments: { time: "the model's own guess" } },
      preSetData: {}, userChecklist, intent_attempt: 0, tool_attempt: 0,
    });
    await preflight.recordExecutionState(state);
    return project(state, preflight);
  }
}

// The arm's view of one verdict. A whitelist: a field left out here reaches no reader.
function project(state, preflight) {
  return {
    outcome: OUTCOME[state.execution_decision] ?? "unrecognized",
    decision: state.execution_decision,
    reason: state.reason,
    args: state.execution_decision === "execute" ? (state.call_arguments ?? {}) : null,
    blanks: (state.gate?.unknown_fields ?? []).map(f => f.name),
    questions: state.gate?.questions ?? [],
    question_block: state.gate?.question_block ?? [],
    fields: (state.fields ?? []).map(f => ({
      name: f.name, status: f.status, source: f.source ?? null, route: f.route ?? null,
      allowed_sources: f.allowed_sources ?? null, source_rule_ids: f.source_rule_ids ?? null,
      settled_at_execution: f.settled_at_execution ?? false, range_declared: f.range_declared ?? null,
      derived_from: f.derived_from ?? null, note: f.note ?? null, approval: f.approval ?? null,
      value: f.status === "known" ? f.value : undefined,
    })),
    // rule_hash: the version an approval must name (6.1); approval / approval_voided: what the seller's
    //   answer did (6.3). Left out, a reader cannot tell an approval that held from one that was voided.
    user_checklist: (state.user_checklist ?? []).map(i => ({ id: i.id, status: i.status, source: i.source ?? null, note: i.note ?? null,
      rule_hash: i.rule_hash ?? null, approval: i.approval ?? null, approval_voided: i.approval_voided ?? null })),
    // form_translation: the form each line was compared in, the words code wrote from it, and which model
    //   wrote it. form_untranslated: why a line had none.
    provider_checklist: (state.provider_checklist ?? []).map(c => ({
      id: c.id, label: c.label, description: c.description ?? null, status: c.status ?? null, source: c.source ?? null, route: c.route ?? null, note: c.note ?? null,
      compare: c.compare ?? null, form_translation: c.form_translation ?? null, form_untranslated: c.form_untranslated ?? null,
      rule_hash: c.rule_hash ?? null, approval: c.approval ?? null, approval_voided: c.approval_voided ?? null })),
    value_checks: (state.value_checks ?? []).map(c => ({ id: c.id, kind: c.kind, status: c.status, note: c.note ?? null })),
    checklist_digest: state.checklist_digest ?? null,
    tool_call: state.tool_call ?? null,
    tool_definition: state.tool_definition ?? null,
    measurements: state.measurements ?? null,
    disclosures: state.gate?.disclosures ?? [],
    unmet: (state.gate?.unmet ?? []).map(u => u.id),
    unsafe_defaults: preflight.unsafeDefaults,
  };
}

module.exports = { runArm, project, measuredFor, measurePort, MEASUREMENTS, TOOL, REPLY };
