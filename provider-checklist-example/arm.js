"use strict";

/**
 * Arm C for the provider-checklist example: the gate in front of the call, with every rule read
 * from a declaration. Same inputs as hooks-example/arm-gate.js (v1): the same user turn, the same
 * measurements, plus one the provider's [Required] line names (order_status).
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

/**
 * @param ctx   a condition's context from instructions.json
 * @param date  a date mode from instructions.json, or null
 * @param ask   the model call (a stub in compare.js and the tests)
 */
// What the platform measures. buyer_contact and the order status are the platform's own facts; the
//   clock year and zone are the parts of a date nobody says; a pickup request the buyer sent through
//   the app is a platform record. Whether the gate may USE each one is the schema's call, not this
//   file's: location is measured here too, and x-allowed-sources keeps it out.
function measuredFor(ctx, date) {
  return {
    buyer_contact: { valid: true, value: ctx.buyer_contact },
    ...(ctx.order_status !== undefined ? { order_status: { valid: true, value: ctx.order_status } } : {}),
    ...Object.fromEntries(Object.entries(date?.measured ?? {}).map(([k, v]) => [k, { valid: true, value: v }])),
    ...(ctx.pickup_request ? {
      time: { valid: true, value: ctx.pickup_request.time },
      location: { valid: true, value: ctx.pickup_request.location },
    } : {}),
  };
}

async function runArm({ ctx, instructionText, userChecklist = [], userAnswers = {}, checklistAnswers = {}, date = null, ask,
                        runId = "run", tool = TOOL, confirmed, measured }) {
  const measuredData = measured ?? measuredFor(ctx, date);

  const turn1 = await runOnce(buildUserTurn(ctx, instructionText, date).segments, "");
  if (date?.seller_answer && turn1.outcome === "ask") {
    const turn2 = await runOnce(buildUserTurn(ctx, instructionText, date, true).segments, "-t2");
    return { ...turn2, turns: 2, turn1: { outcome: turn1.outcome, blanks: turn1.blanks } };
  }
  return { ...turn1, turns: 1 };

  async function runOnce(segments, suffix) {
    const hooks = createHooks({ ask, runId: runId + suffix, tool, ...(confirmed ? { confirmed } : {}) });
    const preflight = createPreflight({ hooks, storage: createStorage() });
    const state = await preflight.runPreflight({
      userId: "seller_1", instruction: segments, mcpTool: tool, preSetData: {},
      measured_data: measuredData, userChecklist, userAnswers, checklistAnswers, intent_attempt: 0, tool_attempt: 0,
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
    fields: (state.fields ?? []).map(f => ({
      name: f.name, status: f.status, source: f.source ?? null, route: f.route ?? null,
      allowed_sources: f.allowed_sources ?? null,
      settled_at_execution: f.settled_at_execution ?? false, range_declared: f.range_declared ?? null,
      derived_from: f.derived_from ?? null, note: f.note ?? null,
      value: f.status === "known" ? f.value : undefined,
    })),
    user_checklist: (state.user_checklist ?? []).map(i => ({ id: i.id, status: i.status, source: i.source ?? null, note: i.note ?? null })),
    provider_checklist: (state.provider_checklist ?? []).map(c => ({
      id: c.id, label: c.label, status: c.status ?? null, source: c.source ?? null, route: c.route ?? null, note: c.note ?? null })),
    disclosures: state.gate?.disclosures ?? [],
    unmet: (state.gate?.unmet ?? []).map(u => u.id),
    unsafe_defaults: preflight.unsafeDefaults,
  };
}

module.exports = { runArm, project, measuredFor, TOOL };
