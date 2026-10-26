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
async function runGateArm({ adapter, model, tool, ctx, instructionText, runId, userId = "seller_1", ask, measured, userChecklist = [], userAnswers = {}, date = null }) {
  // buyer_contact is always measured, and measurement is the only source it permits
  // (tool.js ALLOWED_SOURCES). With a date mode, the platform's clock year and the
  // account's time zone are measured too — the parts of a date nobody says. In group 5's
  // offer conditions, the buyer's pickup request is a platform record and is measured as well.
  const measuredData = measured ?? {
    buyer_contact: { valid: true, value: ctx.buyer_contact },
    ...Object.fromEntries(Object.entries(date?.measured ?? {}).map(([k, v]) => [k, { valid: true, value: v }])),
    // A pickup request the buyer made through the platform (group 5). The platform recorded it, so it
    //   is a measurement of what the buyer proposed — not something the model read in a message.
    //   Whether the seller accepts it is not decided here: the seller's range (user_checklist) is.
    ...(ctx.pickup_request ? {
      time: { valid: true, value: ctx.pickup_request.time },
      location: { valid: true, value: ctx.pickup_request.location },
    } : {}),
  };

  // Every model call the hooks make lands here — arm C calls the model three times a run, and
  //   none of it was on the record before: not the cost, and not why a call failed.
  const meter = { calls: [] };
  const turn1 = await runOnce(buildUserTurn(ctx, instructionText, date).segments);
  // "answered": the seller answers a question in their own words, once. Only if the gate asked.
  //   The gate's question is a list of blanks, not prose (spec 4.6: how to ask is the model's job,
  //   what to ask is the code's), so the answer goes in as the next thing the seller typed.
  if (date?.seller_answer && turn1.outcome === "ask") {
    const turn2 = await runOnce(buildUserTurn(ctx, instructionText, date, true).segments, "-t2");
    return { ...turn2, turns: 2, turn1: summarizeTurn(turn1), ...harness(meter) };
  }
  return { ...turn1, turns: 1, ...harness(meter) };

  async function runOnce(segments, suffix = "") {
    const storage = createStorage();
    const hooks = createHooks({ adapter, model, runId: runId + suffix, measuredData, meter, ...(ask ? { ask } : {}) });
    const preflight = createPreflight({ hooks, storage });

    const state = await preflight.runPreflight({
      userId,
      instruction: segments,
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
    return project(state, preflight, tool);
  }
}

// The arm's view of one gate verdict. A whitelist, like recordExecutionState.
function project(state, preflight, tool) {
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
      // Every other input a derived value rests on (the date the seller said, the measured year and
      //   time zone). Without it a derived time reads as if the instruction alone stated it.
      derived_from: f.derived_from ?? null,
      // Why a slot that was found is still unknown — a format refusal, a derivation that did not
      //   hold. Left out, a published run showed "found" and "unknown" side by side with no reason.
      note: f.note ?? null,
      // A NULL slot has no value; only a known one is projected.
      value: f.status === "known" ? f.value : undefined
    })),
    user_checklist: (state.user_checklist ?? []).map(i => ({
      id: i.id, status: i.status, source: i.source ?? null, note: i.note ?? null,
    })),
    unsafe_defaults: preflight.unsafeDefaults,
    // The skeleton's per-slot lookup failures, with the hook's exception text. Harness diagnostics.
    lookup_failures: state.gate?._diag?.lookup_failures ?? []
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

// Harness diagnostics across every turn: our own hooks' calls and failures — not the gate's verdict,
//   and never shown to a user. Carried so a broken-hook cell can be explained from the results file.
function harness(meter) {
  return { hook_calls: meter.calls, usage: sumUsage(meter.calls) };
}

// What turn 1 was, kept on a two-turn run so the analyzer can tell a first-turn ask from the end.
function summarizeTurn(t) {
  return { outcome: t.outcome, gate_kind: t.gate_kind, blanks: t.blanks ?? null, reason: t.reason,
           fields: t.fields };
}

// Token totals across the arm's calls, in the provider's own field names, so arm C's cost sits
//   beside arms A and B's single-call usage. null when no call reported usage (stubs).
function sumUsage(calls) {
  const out = {};
  for (const c of calls) for (const [k, v] of Object.entries(c.usage ?? {})) {
    if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { runGateArm };
