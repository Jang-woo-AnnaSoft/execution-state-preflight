"use strict";

/**
 * Arm C — the same model and the same prompt as arm A, with the gate in front
 * of the call.
 *
 * The model still proposes. What changes is that a proposed value does not
 * settle a slot: each slot is looked up through the five sources and the gate
 * counts what never settled.
 *
 * A run ends as:
 *   { outcome: "call", args }     execution_decision === "execute"
 *   { outcome: "ask",  blanks }   execution_decision === "ask_user"
 *   { outcome: "hold", reason }   execution_decision === "hold"
 *   { outcome: "deferred" }       execution_decision === "deferred"
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
 */
async function runGateArm({ adapter, model, tool, ctx, instructionText, runId, userId = "seller_1", ask }) {
  const turn = buildUserTurn(ctx, instructionText);

  // buyer_contact is the one slot the system can measure.
  const measuredData = {
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
    userChecklist: [],            // simplification 2, see hooks.js
    userAnswers: {},
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
    reason: state.reason,
    fields: (state.fields ?? []).map(f => ({
      name: f.name,
      status: f.status,
      source: f.source,
      // Carried so the record can be re-verified without this gate. The whole
      // claim is that the record answers "where did this come from", and a
      // source name with no location does not answer it.
      located_at: f.located_at ?? null,
      derived: f.derived ?? false,
      value: f.status === "known" ? f.value : undefined
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
  if (decision === "deferred") {
    return { outcome: "deferred", when_case: state.fixed?.c1_when_case ?? null, args: null, ...base };
  }
  return { outcome: "hold", args: null, ...base };
}

module.exports = { runGateArm };
