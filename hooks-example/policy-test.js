"use strict";

/**
 * What you may replace, and what breaks when you drop it — the pair to declaration-test.js.
 *
 *   node policy-test.js
 *
 * declaration-test.js answers "what do I have to declare". This one answers the question that comes
 * next and is easier to get wrong: how much of this skeleton do I actually have to run.
 *
 * THE STANDARD IS THE SPECIFICATION, NOT THIS FILE. The spec says what has to be true before an
 * irreversible call: values, conditions and intent declared, each confirmed from a declared source,
 * the verdict counted by code, the verdict recorded, the executor reading only the record. It does
 * not say those things have to look like this. Taken literally as a framework, this skeleton makes
 * a stiff, over-specified pipeline, and an adopting system that already has tool selection, a
 * conversation layer and a job-id scheme should not grow a second copy of any of them. What this
 * code is for is narrower: to show one working method for verifying a source and for stopping the
 * model from filling a blank.
 *
 * So every row below REPLACES something rather than discussing it. A replacement that still
 * satisfies the spec comes out the same way. A removal comes out as a specific, named failure, and
 * the failure is the argument — not a sentence saying the piece is important.
 *
 * The honest rows are the ones where the gate CANNOT tell. Those pass, and they are labelled, and
 * they are the places an adopter's own policy carries the weight instead of this code.
 */

const { createPreflight } = require("../execution-state-preflight");
const { locatedActionName } = require("./c2-stub");

let failures = 0;
function row(label, got, want, why) {
  const ok = String(got) === String(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? " " : "✗"} ${label.padEnd(40)} ${String(got).padEnd(16)}${why ? `← ${why}` : ""}`);
  if (!ok) console.log(`      want=${want}`);
}
function heading(t) { console.log(`\n${t}`); }

const STORAGE = () => ({ async persist() {}, async load() { return null; } });

// Two tools with a slot of the same name, for the key-scope row.
const PAY = { name: "send_payment", description: "Send a payment.",
  inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] } };
const REFUND = { name: "issue_refund", description: "Issue a refund.",
  inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] } };

// A pickup tool, for the span row.
const PICKUP = { name: "schedule_pickup", description: "Schedule a pickup.",
  inputSchema: { type: "object", properties: { time: { type: "string" } }, required: ["time"] } };
const LIMIT_TEXT = "Pick up tomorrow. Nothing after 8pm.";
const LIMIT_SPAN = [LIMIT_TEXT.indexOf("8pm"), LIMIT_TEXT.indexOf("8pm") + 3];

// The six required hooks, answered as cheaply as the domain allows. This IS the reduction in
// spec 1.2: an immediate-only domain answers the timing question once, with a constant.
function minimalHooks(over = {}) {
  return {
    classifyWhenCase: () => "immediate",
    extractUserActionName: locatedActionName(),   // a located claim (4.1); see c2-stub.js
    confirmToolNameMatchesIntent: (n, t) => ({ approved: true, reason: `single tool: ${t?.name}` }),
    extractFromInstruction: () => undefined,
    measureFromEnvironment: () => undefined,
    buildActionKey: (uid, fixed) => `${uid}:${fixed?.c3_provider_action_name}`,
    ...over,
  };
}

async function run(hooks, { tool, instruction, prior } = {}) {
  const preflight = createPreflight({ hooks, storage: STORAGE() });
  const state = await preflight.runPreflightAndRecord({
    userId: "u_1042",
    instruction: instruction ?? [{ trust: "user", text: "Pay the supplier." }],
    mcpTool: tool ?? PAY,
    measured_data: {},
    priorExecutionState: prior ?? null,
    userChecklist: [],
  });
  return { state, preflight };
}
const slot = (state, name) => (state.fields ?? []).find(f => f.name === name) ?? {};

(async () => {
  console.log("WHAT YOU MAY REPLACE, AND WHAT BREAKS WHEN YOU DROP IT");
  console.log("the specification is the standard; this skeleton is one way of meeting it");

  // ══ 1. The six required hooks ══════════════════════════════════════════════════
  heading("1. Can the fixed checklist be left to the existing agent?");
  {
    let refused = null;
    try {
      createPreflight({
        hooks: { extractFromInstruction: () => undefined, measureFromEnvironment: () => undefined,
                 buildActionKey: () => "k" },
        storage: STORAGE(),
      });
    } catch (e) { refused = e.message; }
    row("wire only the three data hooks", refused ? "refused" : "built", "refused",
      "not a configuration — createPreflight will not build");
    row("  which three it names",
      /classifyWhenCase.*extractUserActionName.*confirmToolNameMatchesIntent/.test(refused ?? ""), "true",
      "4.1: the fixed checklist settles the execution unit the gate runs once per");

    // The reduction spec 1.2 actually grants: answer the question once, with a constant.
    const { state } = await run(minimalHooks({ measureFromEnvironment: () => ({ valid: true, value: 4200 }) }));
    row("answer them with constants instead", state.execution_decision, "execute",
      "1.2: immediate-only domain, single tool — the question is answered, not deleted");
    row("  and the answer is on the record", state.fixed?.c1_when_case, "immediate",
      "a constant is a declaration; a missing hook is a gap");
  }

  heading("2. What does the tool hook still buy once it is a constant?");
  {
    // 8.1 says tool selection is not verified by code, and in most systems the matching judgment
    // belongs in the prompt. What does NOT move to the prompt is the ceiling and the record.
    const { state } = await run(minimalHooks({
      confirmToolNameMatchesIntent: () => ({ approved: false, reason: "the user asked for something else" }),
      measureFromEnvironment: () => ({ valid: true, value: 4200 }),
    }));
    row("the tool is refused", state.execution_decision, "ask_user", "re-selection, with a count");
    row("  the attempt is recorded", /attempt=0\/\d/.test(state.reason ?? ""), "true",
      "4.5: without a ceiling, an unanswerable item is re-asked forever");
    row("  and the reason is carried", /something else/.test(state.reason ?? ""), "true",
      "a prompt that silently retries leaves none of this");
  }

  // ══ 2. The pair you cannot split ═══════════════════════════════════════════════
  heading("3. extractFromInstruction without spanSupportsValue");
  {
    // The extractor claims the pickup time is "8pm" and points at the words "8pm" — which occur in
    // "Nothing after 8pm". The default comparator does equality, and the strings are equal.
    const claimSpan = { value: "8pm", segment_index: 0, span: LIMIT_SPAN };
    const hooks = minimalHooks({
      extractFromInstruction: (f) => (f === "time" ? claimSpan : undefined),
    });
    const { state: launder } = await run(hooks, { tool: PICKUP, instruction: [{ trust: "user", text: LIMIT_TEXT }] });
    row("default comparator (equality)", slot(launder, "time").status, "known",
      "the instruction FORBIDS 8pm and the gate took it as the stated time");
    row("  the source it claims", slot(launder, "time").source, "instruction",
      "5.2: a value proposed by the model is a claim about a LOCATION");
    row("  and it executes", launder.execution_decision, "execute",
      "this is the laundering path, reintroduced by dropping one hook");

    // A comparator that asks the contract's actual question — does the span state the value FOR
    // THIS SLOT — refuses it.
    const { state: checked } = await run(
      minimalHooks({
        extractFromInstruction: (f) => (f === "time" ? claimSpan : undefined),
        spanSupportsValue: (value, atSpan, field) => {
          const before = LIMIT_TEXT.slice(0, LIMIT_TEXT.indexOf(atSpan)).toLowerCase();
          const limiting = /(nothing|no|not|never|before|after|by)\s*$/.test(before.trim() + " ");
          return { supported: !limiting };
        },
      }),
      { tool: PICKUP, instruction: [{ trust: "user", text: LIMIT_TEXT }] });
    row("a comparator that reads the role", slot(checked, "time").status, "unknown",
      "the span bounds the value; it does not state it");
    row("  so it is asked", checked.execution_decision, "ask_user", "the blank is visible again");
  }

  // ══ 3. Where the gate cannot tell ══════════════════════════════════════════════
  heading("4. measureFromEnvironment replaced by a model call (the gate CANNOT tell)");
  {
    // 5.2: "the lookup must be a live measurement." The skeleton's own note says it plainly — if
    // this hook is LLM-based it is not a measurement — and then cannot check it.
    const { state } = await run(minimalHooks({
      measureFromEnvironment: () => ({ valid: true, value: 4200 }),   // stands in for a model call
    }));
    row("a hook that invents a value", state.execution_decision, "execute",
      "PASSES — and it is supposed to, because the gate has no way to see inside a hook");
    row("  the record says measured", slot(state, "amount").source, "measured_data",
      "8.2: this skeleton does not define how hooks are implemented");
    // Nothing on the record distinguishes a live read from an invented one, which is the whole
    //   of 2.4 turned on the hook rather than the model. Keeping this source honest is policy.
    row("  nothing marks how it was observed",
      "means_of_observation" in slot(state, "amount") ? "recorded" : "absent", "absent",
      "so a deterministic system query here is your policy, not the gate's check");
  }

  heading("5. buildActionKey — the scope is NOT a safety mechanism in the gate");
  {
    // Advice like "design the key so different actions do not share one" is correct advice. But the
    // gate never looks the record up: priorExecutionState is handed IN by the caller, and the gate
    // checks only that it says executed, then matches by field name. So a narrow key does not stop
    // the wrong record from being accepted.
    const hooks = minimalHooks({
      measureFromEnvironment: (f) => (f === "amount" ? { valid: true, value: 18400 } : undefined),
      applyFieldPolicy: (r) => r,                      // the adopter accepts inheritance
    });
    const { state: paid } = await run(hooks, { tool: PAY });
    const executed = { ...paid, execution_decision: "executed" };

    const narrow = minimalHooks({
      measureFromEnvironment: () => undefined,         // the refund's amount is NOT measured
      applyFieldPolicy: (r) => r,
    });
    const { state: refund } = await run(narrow, { tool: REFUND, prior: executed });
    // This used to settle: with a pass-through policy the payment's amount arrived in the refund as
    //   KNOWN. The gate now refuses inheritance itself (5.2), whatever the policy hook does.
    row("a narrow key, wrong record handed in", slot(refund, "amount").status, "unknown",
      "a pass-through policy no longer lets the payment's amount settle the refund");
    row("  it is only a candidate", slot(refund, "amount").prior_candidate?.value, "18400",
      "the gate checks 'executed', never 'is this the same action' — so the user is shown it to confirm");
    row("  and the candidate names where it came from", slot(refund, "amount").prior_candidate?.action_key,
      "u_1042:send_payment", "the question can say 'from your payment' — the user, not the gate, decides");
    // The handed-in record names the action it came from, and the gate does not read that field.
    //   So the key decides storage buckets; the caller decides what to hand in.
    row("  the record even names the other action", executed.action_key, "u_1042:send_payment",
      "present on the record, unread by the gate");

    // With the default policy, the same. The guard is in the gate now, not in the default.
    const { state: refused } = await run(
      minimalHooks({ measureFromEnvironment: () => undefined }), { tool: REFUND, prior: executed });
    row("default applyFieldPolicy instead", slot(refused, "amount").status, "unknown",
      "5.2: inheritance alone does not confirm — refuse it and the leak closes");
  }

  // ══ 4. The conditions, left out ════════════════════════════════════════════════
  heading("6. Leaving the condition hooks unwired");
  {
    const preflight = createPreflight({ hooks: minimalHooks({
      measureFromEnvironment: () => ({ valid: true, value: 18400 }),
    }), storage: STORAGE() });
    const flagged = preflight.unsafeDefaults ?? [];
    row("verifyProviderCondition unwired", flagged.includes("verifyProviderCondition"), "true",
      "declared on unsafeDefaults, which lands in every record");
    row("verifyUserChecklistItem unwired", flagged.includes("verifyUserChecklistItem"), "true");

    const state = await preflight.runPreflightAndRecord({
      userId: "u_1042", instruction: [{ trust: "user", text: "Pay the supplier." }],
      mcpTool: PAY, measured_data: {},
      userChecklist: [{ id: "u_limit", description: "nothing over 10,000", constrains: ["amount"] }],
    });
    row("a declared user limit", state.user_checklist?.[0]?.status, "unverified",
      "declared and never compared — so it does not pass either");
    row("  and it blocks rather than passing", state.execution_decision, "ask_user",
      "a rule the gate cannot check stays unknown (6.3) — weak, not fail-open");
  }

  // ══ 5. The one thing that is not replaceable ═══════════════════════════════════
  heading("7. The record");
  {
    const { state, preflight } = await run(minimalHooks({
      measureFromEnvironment: () => ({ valid: true, value: 4200 }),
    }));
    row("the gate's output is a record", typeof state.gate, "object",
      "3.5: there must be no execution path that does not go through it");
    row("  with the slot's source on it", slot(state, "amount").source, "measured_data",
      "2.7: an execution record without provenance cannot be re-checked");
    row("  and a decision separate from it", state.execution_decision, "execute",
      "the executing party reads this; it does not re-derive it");

    // A record nothing produced. No gate ran, no slot was looked up, no source exists — and
    //   executeIfReady calls the tool, because it reads the decision it was handed.
    const forged = { execution_decision: "execute", call_arguments: { amount: 999999 },
                     fields: [], gate: null, action_key: "forged", phase: "at_trigger" };
    let called = null;
    await preflight.executeIfReady(forged, PAY, async (name, args) => { called = args; return { ok: true }; });
    row("a record nothing produced", JSON.stringify(called), '{"amount":999999}',
      "8.2: separation exposes an execution with NO verdict, not one on a forged verdict");
    row("  so integrity is yours at the boundary",
      state.gate === null ? "absent" : "present", "present",
      "sign the record if the verdict and the executor cross a trust boundary");
  }

  console.log(`
WHAT THE SPECIFICATION REQUIRES  ·  HOW THIS SKELETON DOES IT  ·  WHAT IS YOURS

  values, conditions and intent are declared outside the model
      here: three checklists + the input schema
      yours: where they live and who edits them (7.2 — the rule's owner, in plain language)

  every settled value names a source that can be re-checked
      here: the five-source cascade, with located_at on an instruction value
      yours: the lookups themselves. Reuse what you have — but a model call is not a measurement

  a value the model proposes is a claim about a LOCATION, checked against that location
      here: extractFromInstruction + spanSupportsValue, as a pair
      yours: the comparator. Not whether there is one — see row 3

  the verdict is counted by code, and is deterministic
      here: unknown_count over the slot set
      yours: nothing. This is the part that does not move

  the verdict ends in a record, and the executor reads only the record
      here: recordExecutionState, and executeIfReady as a DEMONSTRATION of the wrong thing
      yours: the executor. Load by key and phase, decide separately, write your own record

  asking is a route, not the only one
      here: ask_user / system_lookup / definition_repair, chosen by the slot's declared sources
      yours: the asking itself (4.6). Your existing conversation layer does this better

  NOT THE SPECIFICATION — this skeleton's own departures
      executeIfReady exists at all (3.5 says the executor is outside)
      no NULL state, so a confirmed absence and an unfinished lookup look alike
      the fixed checklist as exactly these three hooks — 4.1 says what must be settled, not how`);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
