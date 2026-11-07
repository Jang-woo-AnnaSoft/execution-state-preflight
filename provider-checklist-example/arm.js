"use strict";

/**
 * Arm C for the provider-checklist example: the gate in front of the call, with every rule read
 * from a declaration. Same inputs as hooks-example/arm-gate.js (v1): the same user turn, the same
 * measurements, plus the two the provider's [Required] lines name (order_status, listing_owned_by_seller).
 *
 * The verdict and the execution sit in one place here, as in v1, so the results can be read
 * directly. Spec 3.5 separates them; see hooks-example/README.md.
 */

const { createPreflight } = require("../execution-state-preflight");
const { createHooks, createStorage, labelledLines } = require("./hooks");
const { providerFormFor } = require("./stub");
const { buildUserTurn } = require("./prompts");
const TOOL = require("./tool.json");

const OUTCOME = { execute: "call", ask_user: "ask", hold: "hold", system_lookup: "system_lookup",
                  definition_repair: "definition_repair", exhausted: "exhausted", deferred: "deferred" };

/**
 * @param ctx   a condition's context from instructions.json
 * @param date  a date mode from instructions.json, or null
 * @param ask   the model call (a stub in compare.js and the tests)
 */
// What the platform measures. buyer_contact, the order status and who owns the listing are the
//   platform's own facts; the clock year and zone are the parts of a date nobody says; a pickup request
//   the buyer sent through the app is a platform record. Whether the gate may USE each one is the
//   provider's call, in the confirmed form of a labelled line, not this file's: location is measured
//   here too, and the [Verify] line on it keeps it out.
//   The listing is the seller's own in every condition here (one listing, the seller's): how ownership is
//   checked is the platform's, not the specification's.
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

// The names this system can measure: what a proposed form may read.
const MEASUREMENTS = ["order_status", "listing_owned_by_seller", "buyer_contact", "time", "location"];

// The provider confirming each labelled line once, as it would at declaration (spec 3.3): the form the
//   stand-in model proposes (stub.js), approved into storage. forms: a map from a line's opening words
//   to the form to confirm instead, or null to leave that line unconfirmed. confirmForms false: none.
async function confirmProviderForms(storage, tool, forms = {}) {
  const preflight = createPreflight({ hooks: createHooks({ ask: async () => ({}), tool }), storage });
  for (const line of labelledLines(tool.description)) {
    if (/^notice$/i.test(line.label)) continue;
    const override = Object.entries(forms).find(([start]) => line.text.startsWith(start));
    const form = override ? override[1] : providerFormFor(line.text);
    if (!form) continue;
    await preflight.approveForm({ declared_by: "provider", tool: tool.name, label: line.label, wording: line.text },
                                { form, approved_by: "provider (test)" });
  }
}

async function runArm({ ctx, instructionText, userChecklist = [], userAnswers = {}, checklistAnswers = {}, date = null, ask,
                        runId = "run", tool = TOOL, confirmForms = true, forms = {}, confirmedTool = null, measured }) {
  const measuredData = measured ?? measuredFor(ctx, date);
  // One unit: its turns share a storage and a key. Since skeleton 1.18 an answer counts only for a
  //   question this unit was asked, so a run handed answers first runs the round that asked them.
  const storage = createStorage();
  // confirmedTool: the description the provider confirmed, when the run uses a different one (a line
  //   reworded after its form was confirmed).
  if (confirmForms) await confirmProviderForms(storage, confirmedTool ?? tool, forms);
  const answering = Object.keys(userAnswers).length + Object.keys(checklistAnswers).length > 0;
  //   An approval is asked for only once the values it is about are settled, so with approvals the
  //   round that asks them comes after the values are answered: asked, answered, asked to approve.
  if (answering) {
    const segs = buildUserTurn(ctx, instructionText, date).segments;
    await runOnce(segs, "-asked", { userAnswers: {}, checklistAnswers: {} });
    if (Object.keys(checklistAnswers).length) await runOnce(segs, "-approve", { userAnswers, checklistAnswers: {} });
  }

  const turn1 = await runOnce(buildUserTurn(ctx, instructionText, date).segments, "");
  if (date?.seller_answer && turn1.outcome === "ask") {
    const turn2 = await runOnce(buildUserTurn(ctx, instructionText, date, true).segments, "-t2");
    return { ...turn2, turns: 2, turn1: { outcome: turn1.outcome, blanks: turn1.blanks } };
  }
  return { ...turn1, turns: 1 };

  async function runOnce(segments, suffix, answers = { userAnswers, checklistAnswers }) {
    const hooks = createHooks({ ask, runId: runId + suffix, unitKey: runId, tool, measurements: MEASUREMENTS });
    const preflight = createPreflight({ hooks, storage });
    const state = await preflight.runPreflight({
      userId: "seller_1", instruction: segments, mcpTool: tool, preSetData: {},
      measured_data: measuredData, userChecklist, userAnswers: answers.userAnswers, checklistAnswers: answers.checklistAnswers,
      intent_attempt: 0, tool_attempt: 0,
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
      allowed_sources: f.allowed_sources ?? null, source_rule_ids: f.source_rule_ids ?? null,
      settled_at_execution: f.settled_at_execution ?? false, range_declared: f.range_declared ?? null,
      derived_from: f.derived_from ?? null, note: f.note ?? null,
      value: f.status === "known" ? f.value : undefined,
    })),
    // rule_hash: the version an approval must name (6.1); approval / approval_voided: what the seller's
    //   answer did (6.3). Left out, a reader cannot tell an approval that held from one that was voided.
    user_checklist: (state.user_checklist ?? []).map(i => ({ id: i.id, status: i.status, source: i.source ?? null, note: i.note ?? null,
      rule_hash: i.rule_hash ?? null, approval: i.approval ?? null, approval_voided: i.approval_voided ?? null })),
    provider_checklist: (state.provider_checklist ?? []).map(c => ({
      id: c.id, label: c.label, description: c.description ?? null, status: c.status ?? null, source: c.source ?? null, route: c.route ?? null, note: c.note ?? null,
      form_pending: Boolean(c.form_pending), form_approval: c.form_approval ?? null,
      rule_hash: c.rule_hash ?? null, approval: c.approval ?? null, approval_voided: c.approval_voided ?? null })),
    value_checks: (state.value_checks ?? []).map(c => ({ id: c.id, kind: c.kind, status: c.status })),
    checklist_digest: state.checklist_digest ?? null,
    disclosures: state.gate?.disclosures ?? [],
    unmet: (state.gate?.unmet ?? []).map(u => u.id),
    unsafe_defaults: preflight.unsafeDefaults,
  };
}

module.exports = { runArm, project, measuredFor, confirmProviderForms, MEASUREMENTS, TOOL };
