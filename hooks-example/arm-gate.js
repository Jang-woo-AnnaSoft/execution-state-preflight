"use strict";

/**
 * Arm C — the same model and the same prompt as arm A, with the gate in front
 * of the call.
 *
 * The model still proposes. What changes is that a proposed value does not
 * settle a slot: each slot is looked up through the five sources and the gate
 * counts what never settled.
 *
 * A run ends as one outcome per decision word, never folded together:
 *   { outcome: "call", args }               execution_decision === "execute"
 *   { outcome: "ask",  blanks }             execution_decision === "ask_user"
 *   { outcome: "hold", hold_kind, unmet }   execution_decision === "hold" — a check that FINISHED
 *                                           and prohibits (spec 4.5): unmet, incl. a required NULL,
 *                                           or payload_invalid
 *   { outcome: "system_lookup" }            the system owes an answer (4.5b). Not a question
 *   { outcome: "definition_repair", repair } a declaration or a hook has a gap (4.5c)
 *   { outcome: "exhausted" }                a route reached its ceiling (4.5)
 *   { outcome: "deferred" }                 execution_decision === "deferred"
 *   { outcome: "unrecognized" }             a decision word this arm does not know — loud, so a
 *                                           skeleton change cannot fall silently into "hold"
 *
 * The last three used to come back as "hold". That merged a finished check with a missing one —
 * exactly what 4.5 says loses where the work should go — and the analyzer counted them together.
 *
 * "deferred" means the when-case classifier decided the CALL should wait, which
 * in this experiment is a misclassification: every instruction here asks for the
 * arrangement to be made now, for a time inside the arrangement. It is reported
 * as its own outcome rather than folded into hold, because a cell that collects
 * them is measuring the classifier, not the gate, and must be thrown out.
 */

const { createPreflight } = require("../execution-state-preflight");
const { createHooks, createStorage } = require("./hooks");
const { buildUserTurn } = require("./prompts");

/**
 * @param ask  Optional injection point for the hooks' model call. Defaults to
 *             the real one. gate-test.js passes a stub so this exact function —
 *             not a copy of it — can be exercised without an API key.
 * @param measured  Optional, tests only: replaces the measurement, so a failed
 *             one can be exercised through this function.
 */
async function runGateArm({ adapter, model, tool, ctx, instructionText, runId, userId = "seller_1", ask, measured, userChecklist = [], userAnswers = {} }) {
  const turn = buildUserTurn(ctx, instructionText);

  // buyer_contact is the one slot the system can measure, and the only source it
  // permits (tool.js ALLOWED_SOURCES).
  const measuredData = measured ?? {
    buyer_contact: { valid: true, value: ctx.buyer_contact }
  };

  const storage = createStorage();
  const hooks = createHooks({ adapter, model, runId, measuredData, ...(ask ? { ask } : {}) });

  const preflight = createPreflight({ hooks, storage });

  const state = await preflight.runPreflight({
    userId,
    instruction: turn.segments,
    mcpTool: tool,
    preSetData: {},
    measured_data: measuredData,
    // The limits the seller stated, declared as items. See instructions.json.
    userChecklist,
    userAnswers,
    intent_attempt: 0,
    tool_attempt: 0
  });

  await preflight.recordExecutionState(state);

  const decision = state.execution_decision;
  const base = {
    decision,
    action_key: state.action_key,
    unknown_count: state.unknown_count,
    gate_kind: state.gate?.kind ?? "value_gate",
    // 4.5(b): slots the system owes an answer for. Not a question for the user.
    system_lookup: (state.gate?.system_lookup ?? []).map(s => s.name),
    // NOTE: this object is a whitelist, like recordExecutionState. A field the gate computes and this
    //   projection leaves out reaches neither the results file nor the analyzer.
    //   BREAKS: add a slot field to the skeleton without adding it here and it is silently dropped.
    reason: state.reason,
    fields: (state.fields ?? []).map(f => ({
      name: f.name,
      status: f.status,
      source: f.source,
      // Carried so the record can be re-verified without this gate. The whole
      // claim is that the record answers "where did this come from", and a
      // source name with no location does not answer it.
      located_at: f.located_at ?? null,
      // What the slot was permitted to consult. Without it the record cannot tell
      // a value from the only allowed source from one nobody meant to permit.
      allowed_sources: f.allowed_sources ?? null,
      // The 4.5 route an unknown took, written on the slot by the gate (6.3). null when settled.
      route: f.route ?? null,
      // Every source consulted and what it returned — absent, no_report, cannot_answer… (5.2). This
      //   is what separates "nobody looked" from "looked, nothing there" in a published run.
      lookup_trace: f.lookup_trace ?? [],
      derived: f.derived ?? false,
      // A NULL slot has no value; only a known one is projected.
      value: f.status === "known" ? f.value : undefined
    })),
    user_checklist: (state.user_checklist ?? []).map(i => ({
      id: i.id, status: i.status, source: i.source ?? null, note: i.note ?? null,
    })),
    unsafe_defaults: preflight.unsafeDefaults
  };

  if (decision === "execute") {
    return { outcome: "call", tool_name: tool.name, args: state.call_arguments ?? {}, ...base };
  }
  if (decision === "ask_user") {
    return {
      outcome: "ask",
      blanks: (state.gate?.unknown_fields ?? []).map(f => f.name),
      user_message: state.gate?.user_message ?? null,
      args: null,
      ...base
    };
  }
  if (decision === "hold") {
    // Checked, and it prohibits. Not a question. Either a declared limit or condition is unmet
    //   (including a required value every source reported NULL), or the object is illegal.
    const unmet = state.gate?.unmet ?? [];
    return { outcome: "hold", hold_kind: unmet.length ? "unmet" : (state.gate?.kind ?? "unknown"),
             args: null, unmet: unmet.map(u => u.id), ...base };
  }
  if (decision === "system_lookup") {
    return { outcome: "system_lookup", args: null, ...base };
  }
  if (decision === "definition_repair") {
    // Whoever owns the declaration or the hook, not the user (7.1). Which one is gate_kind.
    return { outcome: "definition_repair", args: null,
             repair: [
               ...(state.gate?.lookup_failed_fields ?? []).map(f => f.name),
               ...(state.gate?.definition_repair_fields ?? []).map(f => f.name),
               ...(state.gate?.definition_repair ?? []).map(c => c.id),
             ], ...base };
  }
  if (decision === "exhausted") {
    return { outcome: "exhausted", args: null, exhausted: state.gate?.exhausted ?? [], ...base };
  }
  if (decision === "deferred") {
    return { outcome: "deferred", when_case: state.fixed?.c1_when_case ?? null, args: null, ...base };
  }
  return { outcome: "unrecognized", args: null, ...base };
}

module.exports = { runGateArm };
