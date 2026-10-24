"use strict";

/**
 * Offline test of the value half of the checklists — one value, moved from seat to seat.
 *
 *   node value-source-test.js
 *
 * No API calls, no model. Spec 4.2 gives the provider's values as the input schema, and the user's
 * values have no list of their own: they arrive through the five sources of 5.2 and fill the
 * provider's slots. So there is nothing to test by declaring many values. There is one thing to
 * test, over and over: THE SAME VALUE IN A DIFFERENT SEAT.
 *
 * That is the structure of the file. One slot, `payee_account`, and one string, which never changes.
 * What changes is where it was sitting when the gate found it. Every case below asserts which source
 * answered, because that is the entire difference 2.4 is about: a looked-up value and an invented one
 * are the same string, and the record is readable only if it says where the string came from.
 *
 * Seven parts:
 *   1. the same value in each of the five seats, one at a time
 *   2. two seats at once — the order is a search order, not a ranking by trustworthiness
 *   3. pre_set_data's wrapper, which is the trap a migration falls into
 *   4. the prior_state round trip through storage, end to end
 *   5. only an executed record is a baseline
 *   6. the instruction-time record, which decides nothing and must not look as if it did
 *   7. which seats are permitted at all, and why a slot the system alone can answer is not asked
 *   8. what the slot itself records: the route its unknown took, and every seat that was consulted
 *   9. a report of nothing — { none: "absent" | "no_place" } — kept apart from no report at all
 *  10. NULL as a slot state, who may report it, and the two route ceilings
 *
 * Part 4 is why this file exists. storage.load is never called by the gate — the caller fetches the
 * prior record with preflight.getPriorExecutionState(key) and passes it in — so until now no test
 * had run that path at all, and an earlier bug in this folder's storage adapter (persist took the
 * record without the key) survived every suite for exactly that reason.
 */

const { createPreflight } = require("../execution-state-preflight");

let failures = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(50)} got=${got}${ok ? "" : `  want=${want}`}`);
}

// The one value. It is the same string in every seat below; only its seat changes.
const ACCOUNT = "DE89-3704-0044-0532";
const SLOT = "payee_account";

const TOOL = {
  name: "send_payment",
  description: "Send a payment. Funds leave immediately.",
  inputSchema: {
    type: "object",
    properties: { [SLOT]: { type: "string" } },
    required: [SLOT],
  },
};

// A trusted instruction segment holding the value literally, with a real span.
function instructionHolding(value) {
  const text = `Pay the supplier at ${value} today.`;
  return {
    segments: [{ trust: "user", text }],
    locate: { value, segment_index: 0, span: [text.indexOf(value), text.indexOf(value) + value.length] },
  };
}
const PLAIN_INSTRUCTION = [{ trust: "user", text: "Pay the supplier today." }];

// One declared condition, so the instruction-time record has something to carry unevaluated.
const PROVIDER_CONDITIONS = [
  { id: "cond_account_known_payee", label: "Required",
    description: "the payee account must belong to a registered supplier",
    constrains: [SLOT] },
];

// ── Storage. THE EXAMPLE'S OWN ADAPTER, wrapped only to count the calls. ─────────
// Not a local reimplementation. hooks.js is the file an adopter copies, and its adapter was broken
// for a while — persist took the record without the key, so every write landed under one bucket and
// load always returned null, leaving prior_state permanently dead. Every suite stayed green, because
// each test brought an adapter of its own and none of them read a record back.
//   So this wraps hooks.createStorage rather than replacing it. If its signature drifts again, part 4
//   fails here instead of passing against a copy that happens to be correct.
const { createStorage: exampleStorage } = require("./hooks");

function createStorage() {
  const inner = exampleStorage();
  let loads = 0;
  return {
    persist: (key, record) => inner.persist(key, record),
    load: (key) => { loads += 1; return inner.load(key); },
    _loads: () => loads,
    _dump: () => inner.dump(),
  };
}

// ── Hooks. Each seat is wired by what is passed in, not by branching in the hooks. ─
function createHooks({ locate, measured, acceptPriorState, whenCase, allowed, measure, policy, extract }) {
  return {
    classifyWhenCase: () => whenCase ?? "immediate",
    extractUserActionName: () => "pay the supplier",
    confirmToolNameMatchesIntent: (name, tool) =>
      ({ approved: true, reason: `single-tool test: '${name}' for '${tool?.name}'` }),

    // Seat 2. Returns a location, never a value of its own invention.
    extractFromInstruction: extract ?? ((fieldName) =>
      (locate && fieldName === SLOT) ? locate : undefined),
    // The span really does hold the value, so equality is honest here.
    spanSupportsValue: (value, atSpan) => value === atSpan,

    // Seat 4.
    measureFromEnvironment: measure ?? ((fieldName) =>
      (measured && fieldName in measured) ? { valid: true, value: measured[fieldName] } : undefined),

    // Seat 5 never settles: the gate turns a value there into a candidate for the user (5.2). Wiring
    //   this hook to pass it through used to be how an adopter "accepted inheritance". Part 4 shows
    //   that it no longer can.
    ...(acceptPriorState ? { applyFieldPolicy: (record) => record } : {}),
    // Part 8: a policy hook of the adopter's own, to show it cannot rewrite the gate's facts.
    ...(policy ? { applyFieldPolicy: policy } : {}),

    // Declared conditions, so part 6 can check that they are carried UNEVALUATED at instruction
    //   time. 4.5: what the user answers is settled at instruction time, everything else is checked
    //   again at the trigger, and a condition is system state.
    getProviderConditions: () => PROVIDER_CONDITIONS,
    verifyProviderCondition: (c) => ({ status: "checked", source: "measured_data", note: "ok" }),

    buildActionKey: () => "u_1042:send_payment",   // the SAME key across runs, for part 4

    // Part 7. Which seats are permitted at all.
    ...(allowed ? { getAllowedSources: allowed } : {}),
  };
}

async function run({ locate, instruction, preSetData, measured, userAnswers, prior,
                     acceptPriorState, whenCase, storage, allowed, measure, policy, extract,
                     ask_attempt, lookup_attempt, intent_attempt, limits }) {
  const store = storage ?? createStorage();
  const preflight = createPreflight({
    hooks: createHooks({ locate, measured, acceptPriorState, whenCase, allowed, measure, policy, extract }),
    storage: store,
    ...(limits ? { limits } : {}),
  });
  const state = await preflight.runPreflightAndRecord({
    userId: "u_1042",
    instruction: instruction ?? PLAIN_INSTRUCTION,
    mcpTool: TOOL,
    preSetData: preSetData ?? {},
    measured_data: {},
    priorExecutionState: prior ?? null,
    userChecklist: [],
    userAnswers: userAnswers ?? {},
    ask_attempt, lookup_attempt, intent_attempt,
  });
  return { state, preflight, store };
}

const slotOf = state => (state.fields ?? []).find(f => f.name === SLOT) ?? {};

(async () => {
  // ── 1. The same value in each of the five seats, one at a time. ────────────────
  console.log("--- part 1: one value, five seats ---");
  {
    const ins = instructionHolding(ACCOUNT);
    const seats = [
      ["user_answer",   { userAnswers: { [SLOT]: ACCOUNT } },                     "user_answer",  "known"],
      ["instruction",   { instruction: ins.segments, locate: ins.locate },        "instruction",  "known"],
      ["pre_set_data",  { preSetData: { [SLOT]: { value: ACCOUNT, trust: "user" } } }, "pre_set_data", "known"],
      ["measured_data", { measured: { [SLOT]: ACCOUNT } },                        "measured_data", "known"],
      // Seat 5 is found, then refused by the default field policy (5.2: inheritance alone does not
      //   confirm). So the SAME value in this seat does not settle the slot.
      ["prior_state",   { prior: { execution_decision: "executed",
                                   fields: [{ name: SLOT, value: ACCOUNT, status: "known",
                                              source: "instruction", origin_source: "instruction" }] } },
                                                                                  "null",         "unknown"],
      ["nowhere",       {},                                                       "null",         "unknown"],
    ];
    for (const [seat, opts, wantSource, wantStatus] of seats) {
      const { state } = await run(opts);
      const f = slotOf(state);
      check(`${seat}: status`, f.status, wantStatus);
      check(`${seat}: source`, f.source, wantSource);
      if (wantStatus === "known") check(`${seat}: the value is unchanged`, f.value, ACCOUNT);
    }
    // The point of the part: five different records, one string.
    check("the value never varied across the seats", ACCOUNT, "DE89-3704-0044-0532");
  }

  // ── 2. Two seats at once. A search order, not a trust ranking. ─────────────────
  // The earlier seat answers and the lookup stops there, so the later seat is never consulted.
  // That is not a judgment that it is more trustworthy — 5.2 says no per-source weights are computed.
  console.log("\n--- part 2: two seats at once ---");
  {
    const ins = instructionHolding(ACCOUNT);
    const { state: a } = await run({
      userAnswers: { [SLOT]: ACCOUNT },
      measured: { [SLOT]: "SOMETHING-ELSE" },
    });
    check("user_answer over measured_data: source", slotOf(a).source, "user_answer");
    check("user_answer over measured_data: value", slotOf(a).value, ACCOUNT);

    const { state: b } = await run({
      instruction: ins.segments, locate: ins.locate,
      preSetData: { [SLOT]: { value: "SOMETHING-ELSE", trust: "user" } },
    });
    check("instruction over pre_set_data: source", slotOf(b).source, "instruction");
    check("instruction over pre_set_data: value", slotOf(b).value, ACCOUNT);
    // The instruction seat records WHERE, not just that it was the instruction, so a third party
    //   can re-check it without taking the gate's word (4.2 / 2.4).
    check("and it records where in the text", JSON.stringify(slotOf(b).located_at?.span),
      JSON.stringify(ins.locate.span));
  }

  // ── 3. pre_set_data's wrapper. The trap a migration falls into. ────────────────
  // 5.2 accepts pre_set_data only as { value, trust: "user" }. A bare value is rejected, and the
  // symptom is every field stuck at unknown with nothing saying why.
  console.log("\n--- part 3: pre_set_data without the wrapper ---");
  {
    const { state: bare } = await run({ preSetData: { [SLOT]: ACCOUNT } });
    check("a bare value does not settle the slot", slotOf(bare).status, "unknown");
    check("and no source is claimed", slotOf(bare).source, "null");

    const { state: untrusted } = await run({
      preSetData: { [SLOT]: { value: ACCOUNT, trust: "inferred" } },
    });
    check("trust other than \"user\" is rejected", slotOf(untrusted).status, "unknown");

    const { state: ok } = await run({
      preSetData: { [SLOT]: { value: ACCOUNT, trust: "user" } },
    });
    check("the wrapper settles it", slotOf(ok).source, "pre_set_data");
  }

  // ── 4. The prior_state round trip, end to end. ────────────────────────────────
  // The gate never calls storage.load. The CALLER fetches the prior record and passes it in, so
  // this is the path no suite had exercised — and the one where this folder's storage adapter was
  // silently broken for a while, because nothing ever read a record back.
  console.log("\n--- part 4: storage round trip ---");
  {
    const store = createStorage();
    const ins = instructionHolding(ACCOUNT);

    // Run 1: settle the value from the instruction and execute, so a baseline exists.
    const { state: first, preflight } = await run({
      instruction: ins.segments, locate: ins.locate, storage: store,
    });
    check("run 1 executes", first.execution_decision, "execute");
    check("run 1 source", slotOf(first).source, "instruction");

    const key = first.action_key;
    const executed = await preflight.recordExecutionState({ ...first, execution_decision: "executed" });
    check("an executed record was persisted", executed.execution_decision, "executed");
    check("under the action_key", key, "u_1042:send_payment");

    // The two steps no test had taken: load it back, then hand it in.
    const loadedBefore = store._loads();
    const prior = await preflight.getPriorExecutionState(key);
    check("storage.load was actually called", store._loads() > loadedBefore, "true");
    check("and it returned the executed record", prior?.execution_decision, "executed");
    check("carrying the value", (prior?.fields ?? []).find(f => f.name === SLOT)?.value, ACCOUNT);

    // Run 2, same key, value no longer in the instruction. It is found at prior_state and does NOT
    //   settle: 5.2 says inheritance alone does not confirm the slot. It becomes the candidate the
    //   question carries.
    const { state: second } = await run({ prior, storage: store });
    check("run 2: inheritance alone does not settle it", slotOf(second).status, "unknown");
    check("run 2: so it comes back as a blank", second.execution_decision, "ask_user");
    check("run 2: and the blank is this slot", second.gate?.unknown_fields?.[0]?.name, SLOT);
    check("run 2: the question carries the candidate", second.gate?.unknown_fields?.[0]?.candidate?.value, ACCOUNT);
    check("run 2: traced as a candidate, not found", (slotOf(second).lookup_trace ?? []).at(-1)?.result, "candidate");

    // A policy that passes everything through used to be how an adopter accepted inheritance. It no
    //   longer settles anything: the gate refuses a policy that promotes. The first source is still
    //   not erased — origin_source rides on the candidate.
    const { state: accepted } = await run({ prior, acceptPriorState: true, storage: store });
    check("pass-through policy: still unknown", slotOf(accepted).status, "unknown");
    check("pass-through policy: no source", slotOf(accepted).source, "null");
    check("pass-through policy: origin rides on the candidate", slotOf(accepted).prior_candidate?.origin_source, "instruction");

    // The route 5.2 actually prescribes: the user confirms it, and it is confirmed as user_answer.
    const { state: confirmed } = await run({
      prior, userAnswers: { [SLOT]: ACCOUNT }, storage: store,
    });
    check("after the user confirms it: source", slotOf(confirmed).source, "user_answer");
    check("after the user confirms it: executes", confirmed.execution_decision, "execute");
  }

  // ── 5. Only an executed record is a baseline. ─────────────────────────────────
  // The port's contract, not the skeleton's check: the skeleton reads whatever it is handed and
  // only tests execution_decision === "executed" at the prior_state source. An adapter that hands
  // back a hold record would have it ignored there — but nothing stops a caller passing one in
  // directly, which is 8.2's forged-record limit.
  console.log("\n--- part 5: an unexecuted record is not a baseline ---");
  {
    const held = { execution_decision: "hold",
      fields: [{ name: SLOT, value: ACCOUNT, status: "known",
                 source: "instruction", origin_source: "instruction" }] };
    const { state } = await run({ prior: held, acceptPriorState: true });
    check("a hold record does not seed the slot", slotOf(state).status, "unknown");
    check("and claims no source", slotOf(state).source, "null");

    const store = createStorage();
    await store.persist("k", { execution_decision: "hold", fields: [] });
    check("the adapter filters it on load too", await store.load("k"), "null");
  }


  // ── 6. The instruction-time record decides nothing, and must not look as if it did. ──
  console.log("\n--- part 6: the at_instruction record ---");
  {
    const ins = instructionHolding(ACCOUNT);
    const { state } = await run({
      instruction: ins.segments, locate: ins.locate, whenCase: "scheduled",
    });
    check("deferred, not executed", state.execution_decision, "deferred");
    check("the gate does not stand yet", state.gate, "null");
    // Counts are null rather than 0. Zero would read as "checked, nothing outstanding".
    check("checklist count is null, not 0", state.unverified_checklist_count, "null");
    check("provider count is null, not 0", state.unverified_provider_count, "null");
    check("no call is assembled", state.call_arguments, "null");
    // The declared conditions are carried, and carried UNEVALUATED. A condition is system state,
    //   and 4.5 checks system state again at the trigger — settling one here would freeze a
    //   measurement taken before the wait.
    check("the conditions are carried", (state.provider_checklist ?? []).length, 1);
    check("by id", state.provider_checklist?.[0]?.id, "cond_account_known_payee");
    check("and not evaluated", state.provider_checklist?.[0]?.status, "undefined");
    check("no route decided either", state.provider_checklist?.[0]?.route, "undefined");
    // The value settled at instruction time is still recorded, with its source, for comparison
    //   against the re-check at trigger time.
    check("the value is recorded with its source", slotOf(state).source, "instruction");
  }

  // ── 7. Which seats are permitted at all. ─────────────────────────────────────
  // Every part above asks which seat answered. This one asks which seats were allowed to.
  // 4.5: the route for an unknown follows from the slot's declared sources, so a slot the
  // system alone can answer must not come back as a question — 4.5(b) says the user is not
  // asked again. The fixed checklist has worked this way from the start: C2 has an ordered
  // two-source list in resolveFixedChecklist. The difference is that C2 is the same slot on
  // every call, so its sources sit in the gate, while these vary per tool and are declared.
  console.log("\n--- part 7: which seats are permitted ---");
  {
    const ins = instructionHolding(ACCOUNT);

    // Declaring nothing means all five, which is what this skeleton did before the hook existed.
    const { state: open } = await run({ instruction: ins.segments, locate: ins.locate });
    check("no declaration: instruction still answers", slotOf(open).source, "instruction");
    check("  and all five are recorded as permitted",
      (slotOf(open).allowed_sources ?? []).length, 5);

    // Narrow the slot to a system source. The instruction holds the value and is NOT consulted.
    const { state: sys } = await run({
      instruction: ins.segments, locate: ins.locate,
      allowed: () => ["measured_data"],
    });
    check("measured_data only: instruction not consulted", slotOf(sys).status, "unknown");
    check("  routed to the system, not the user", sys.gate?.kind, "system_lookup");
    check("  decision names the route, not hold", sys.execution_decision, "system_lookup");
    check("  nothing is asked of the user", (sys.gate?.unknown_fields ?? []).length, 0);
    check("  the slot is named for the lookup", sys.gate?.system_lookup?.[0]?.name, SLOT);
    check("  with what was permitted", (sys.gate?.system_lookup?.[0]?.allowed_sources ?? []).join(","),
      "measured_data");

    // The same narrow slot, now measured. It settles from the one allowed seat.
    const { state: got } = await run({
      instruction: ins.segments, locate: ins.locate,
      measured: { [SLOT]: ACCOUNT },
      allowed: () => ["measured_data"],
    });
    check("measured: settles from the allowed seat", slotOf(got).source, "measured_data");
    check("  and executes", got.execution_decision, "execute");

    // A declaration the gate cannot read is not an empty permission set. Defaulting to empty
    //   would kill every source and leave a slot with no route and no blank.
    const { state: junk } = await run({
      instruction: ins.segments, locate: ins.locate,
      allowed: () => ["typo_source"],
    });
    check("an unreadable declaration falls back to all five", slotOf(junk).source, "instruction");
  }

  // ── 8. What the slot itself records. ─────────────────────────────────────────
  // 6.3: the route an unknown took is written ON THE SLOT, not only in the gate's lists. 5.2: a
  // seat that was checked stays on the record, and no report is not a report of nothing. Both are
  // the gate's own facts, so a policy hook cannot rewrite them.
  console.log("\n--- part 8: route and lookup trace on the slot ---");
  {
    const trace = s => (slotOf(s).lookup_trace ?? []).map(t => `${t.source}:${t.result}`).join(",");

    // Nothing anywhere, all five permitted. Every seat consulted, every one silent.
    const { state: empty, store } = await run({});
    check("all five silent: route", slotOf(empty).route, "ask_user");
    check("  every seat is on the record, as no_report", trace(empty),
      "user_answer:no_report,instruction:no_report,pre_set_data:no_report,measured_data:no_report,prior_state:no_report");
    check("  the gate's list agrees with the slot", empty.gate?.unknown_fields?.[0]?.name, SLOT);
    // The record is a whitelist (recordExecutionState). A slot field it drops is computed and lost.
    const persisted = Object.values(store._dump()).flat().pop();
    const pslot = (persisted?.fields ?? []).find(f => f.name === SLOT) ?? {};
    check("  route survives into the stored record", pslot.route, "ask_user");
    check("  so does the trace", (pslot.lookup_trace ?? []).length, 5);

    // Measured only, not measured. One seat consulted; the instruction is not even listed.
    const ins = instructionHolding(ACCOUNT);
    const { state: sys } = await run({ instruction: ins.segments, locate: ins.locate,
                                       allowed: () => ["measured_data"] });
    check("measured only, silent: route", slotOf(sys).route, "system_lookup");
    check("  only the permitted seat is listed", trace(sys), "measured_data:no_report");

    // The source answers that it cannot answer. Not confirmed — and not "nothing" either (5.1).
    const { state: cant } = await run({ allowed: () => ["measured_data"],
                                        measure: () => ({ valid: false }) });
    check("valid:false is recorded as cannot_answer", trace(cant), "measured_data:cannot_answer");
    check("  the slot stays unknown", slotOf(cant).status, "unknown");
    check("  and is not NULL — no such state yet", slotOf(cant).status === "null", false);

    // A pre-set value without the trust wrapper came back and was refused — a different fact.
    const { state: raw } = await run({ preSetData: { [SLOT]: ACCOUNT },
                                       allowed: () => ["pre_set_data"] });
    check("an unwrapped pre-set value is rejected, not silent", trace(raw), "pre_set_data:rejected");

    // The measurement hook throws. 4.5(c): definition repair, on the slot and in the decision.
    const { state: boom } = await run({ allowed: () => ["measured_data"],
                                        measure: () => { throw new Error("sensor down"); } });
    check("a hook that threw: route", slotOf(boom).route, "definition_repair");
    check("  traced as failed", trace(boom), "measured_data:failed");
    check("  decision", boom.execution_decision, "definition_repair");

    // Found on the first seat: the chain stops there, so nothing after it is listed.
    const { state: found } = await run({ userAnswers: { [SLOT]: ACCOUNT } });
    check("found: the chain stops at the first hit", trace(found), "user_answer:found");
    check("  a known slot has no route", slotOf(found).route, "null");

    // A policy hook that builds a fresh record from scratch. It may demote; it may not erase what
    //   was consulted or decide who resolves the blank.
    const { state: pol } = await run({ userAnswers: { [SLOT]: ACCOUNT },
      policy: (r) => ({ name: r.name, value: undefined, status: "unknown", source: null,
                        route: "ask_user", lookup_trace: [] }) });
    check("a fresh record from policy keeps the gate's trace", trace(pol), "user_answer:found");
    check("  and the route is the gate's, not the hook's", slotOf(pol).route, "ask_user");
    const { state: pol2 } = await run({ allowed: () => ["measured_data"],
      policy: (r) => ({ ...r, route: "ask_user" }) });
    check("  a hook naming ask_user on a system-only slot is overruled", slotOf(pol2).route, "system_lookup");

    // Instruction time. A system-only slot must not reach the user here either. Before this, the
    //   at_instruction branch split on lookup_failed alone and asked about it.
    //   And it does not block the scheduling: 4.5 fixes only what was confirmed by asking at
    //   instruction time; system state is measured again at the trigger (10).
    const { state: later } = await run({ allowed: () => ["measured_data"], whenCase: "scheduled" });
    check("at_instruction, system-only slot: deferred to the trigger", later.execution_decision, "deferred");
    check("  nothing asked of the user", (later.gate?.unknown_fields ?? []).length, 0);
    check("  the slot keeps its route for the trigger", slotOf(later).route, "system_lookup");
  }

  // ── 9. A report of nothing. ───────────────────────────────────────────────────
  // 5.2: no report and a report of nothing are different — the first means the source was not
  // checked. 6.2: "not there" and "nowhere to look" are both normal outputs, and both differ from
  // writing nothing. The shape is an explicit object, never JS null, so `??` cannot merge it away.
  console.log("\n--- part 9: a report of nothing ---");
  {
    const trace = s => (slotOf(s).lookup_trace ?? []).map(t => `${t.source}:${t.result}`).join(",");
    const only = (src) => () => [src];

    const { state: a } = await run({ allowed: only("instruction"), extract: () => ({ none: "absent" }) });
    check("instruction reports absent", trace(a), "instruction:absent");
    check("  no value is taken from it", slotOf(a).value, "undefined");
    // The only permitted source said absent and no route is left: NULL (5.1). From the first round.
    check("  the one permitted source said absent: NULL", slotOf(a).status, "null");

    const { state: np } = await run({ allowed: only("instruction"), extract: () => ({ none: "no_place" }) });
    check("instruction reports no_place", trace(np), "instruction:no_place");

    const { state: m } = await run({ allowed: only("measured_data"), measure: () => ({ none: "absent" }) });
    check("measurement reports absent", trace(m), "measured_data:absent");

    // The three empty answers a measurement can give, side by side. Each is a different fact.
    const three = [];
    for (const r of [undefined, { valid: false }, { none: "absent" }]) {
      const { state } = await run({ allowed: only("measured_data"), measure: () => r });
      three.push(slotOf(state).lookup_trace?.[0]?.result);
    }
    check("no report / cannot answer / absent stay apart", three.join(","), "no_report,cannot_answer,absent");

    // A report of nothing does not end the chain. The next permitted source still runs and settles.
    const { state: next } = await run({ extract: () => ({ none: "absent" }),
                                        measured: { [SLOT]: ACCOUNT } });
    check("absent, then the next source still runs", trace(next),
      "user_answer:no_report,instruction:absent,pre_set_data:no_report,measured_data:found");
    check("  and settles the slot", slotOf(next).source, "measured_data");

    // Ambiguous reports are refused, not read as nothing — and never as a value.
    const { state: typo } = await run({ allowed: only("instruction"), extract: () => ({ none: "gone" }) });
    check("an unknown kind of none is rejected", trace(typo), "instruction:rejected");
    const { state: both } = await run({ allowed: only("measured_data"),
                                        measure: () => ({ none: "absent", valid: true, value: ACCOUNT }) });
    check("none alongside a value is rejected", trace(both), "measured_data:rejected");
    check("  and the value is not taken", slotOf(both).status, "unknown");

    // JS null is NOT the report. It is the merge this shape exists to avoid, so it is refused.
    const { state: jsnull } = await run({ allowed: only("measured_data"), measure: () => null });
    check("JS null is not a report of nothing", trace(jsnull), "measured_data:rejected");
    // It also used to throw outside safeHook and take the whole run to the backstop.
    check("  and it no longer crashes the run", jsnull.execution_decision, "system_lookup");
    const { state: jsnullI } = await run({ allowed: only("instruction"), extract: () => null });
    check("the same from the extractor", trace(jsnullI), "instruction:rejected");

    // Every declared check said absent: NULL (5.1), and a required NULL is unmet (6.3).
    check("measured only, absent: NULL", slotOf(m).status, "null");
    check("  a required NULL holds", m.execution_decision, "hold");
  }

  // ── 10. NULL as a slot state, who may report it, and the ceilings. ────────────
  console.log("\n--- part 10: NULL, its reporters, and the route ceilings ---");
  {
    const trace = s => (slotOf(s).lookup_trace ?? []).map(t => `${t.source}:${t.result}`).join(",");
    const only = (...src) => () => src;
    const ABSENT = { none: "absent" };

    // D1. The user may say "there is none". On a slot only the user can answer, that is NULL —
    //   reported by the one who checked (5.1) — and a required NULL holds (6.3).
    const { state: said } = await run({ allowed: only("user_answer"), userAnswers: { [SLOT]: ABSENT } });
    check("D1 user says none: traced", trace(said), "user_answer:absent");
    check("  the slot is NULL", slotOf(said).status, "null");
    check("  required NULL is unmet: hold", said.execution_decision, "hold");
    check("  recorded as unmet, of kind required_null", said.gate?.unmet?.[0]?.kind, "required_null");
    check("  the NULL slot is not in the arguments", SLOT in (said.call_arguments ?? {}), false);
    check("  and it is not counted as unknown", said.unknown_count, 0);
    // With all five permitted, the user's "none" closes the ask route but not the others. The
    //   measurement gave no report, so the system still owes an answer — not NULL, and not asked again.
    const { state: saidAll } = await run({ userAnswers: { [SLOT]: ABSENT } });
    check("D1 with all five: not NULL while a source is silent", slotOf(saidAll).status, "unknown");
    check("  the user is not asked again", slotOf(saidAll).route, "system_lookup");

    // D3. The caller may report its own maps empty. An absent KEY is still no report.
    const { state: pre } = await run({ allowed: only("pre_set_data"), preSetData: { [SLOT]: ABSENT } });
    check("D3 pre_set_data reported absent", trace(pre), "pre_set_data:absent");
    check("  so the slot can be NULL", slotOf(pre).status, "null");
    const { state: preKey } = await run({ allowed: only("pre_set_data") });
    check("  an absent key is no report", trace(preKey), "pre_set_data:no_report");
    check("  and leaves a gap only the caller can close", slotOf(preKey).route, "definition_repair");
    const { state: pri } = await run({ allowed: only("prior_state"), prior: ABSENT });
    check("D3 prior_state reported absent by the caller", trace(pri), "prior_state:absent");
    const { state: priHeld } = await run({ allowed: only("prior_state"),
      prior: { execution_decision: "hold", fields: [] } });
    check("  a record that was not executed is refused", trace(priHeld), "prior_state:rejected");
    const { state: priEmpty } = await run({ allowed: only("prior_state"),
      prior: { execution_decision: "executed", action_key: "k", fields: [] } });
    check("  an executed record without the value: absent", trace(priEmpty), "prior_state:absent");
    // A user or a caller does not report "no place to check" — that is the declaration's to say.
    const { state: userNp } = await run({ allowed: only("user_answer"), userAnswers: { [SLOT]: { none: "no_place" } } });
    check("  no_place from a map source is refused", trace(userNp), "user_answer:rejected");

    // D2. A source with no place to check is a gap in the declaration (5.1, 4.5c).
    const { state: np } = await run({ allowed: only("instruction", "measured_data"),
      extract: () => ({ none: "no_place" }), measure: () => ABSENT });
    check("D2 no_place: route definition_repair", slotOf(np).route, "definition_repair");
    check("  not NULL, though the other source said absent", slotOf(np).status, "unknown");
    check("  decision", np.execution_decision, "definition_repair");
    check("  named for its owner, with what is open", (np.gate?.definition_repair_fields?.[0]?.open ?? []).join(","),
      "instruction:no_place");
    // And it outranks a route still open to the user: asking cannot supply a place that does not exist.
    const { state: npAsk } = await run({ extract: () => ({ none: "no_place" }) });
    check("  no_place with the user still askable: still definition_repair", slotOf(npAsk).route, "definition_repair");
    check("  so the user is not asked", (npAsk.gate?.unknown_fields ?? []).length, 0);

    // An instruction-only slot whose extractor gives no report cannot be re-answered by the user or
    //   re-measured. That is the extractor's gap now, not a system lookup.
    const { state: silent } = await run({ allowed: only("instruction") });
    check("instruction-only, no report: definition_repair", slotOf(silent).route, "definition_repair");

    // A policy may demote, never promote.
    const { state: promo } = await run({ policy: (r) => ({ ...r, status: "known", value: ACCOUNT, source: "user_answer" }) });
    check("a policy that promotes is refused", slotOf(promo).status, "unknown");
    check("  and says why", /never promote/.test(slotOf(promo).note ?? ""), "true");
    const { state: move } = await run({ userAnswers: { [SLOT]: ACCOUNT },
      policy: (r) => ({ ...r, source: "measured_data" }) });
    check("a policy that changes the source is refused", slotOf(move).status, "unknown");

    // Ceilings (4.5). One count per route per action, carried by the caller.
    const { state: ask0 } = await run({});
    check("ask under ceiling: ask_user", ask0.execution_decision, "ask_user");
    check("  next_ask_attempt counts up", ask0.gate?.next_ask_attempt, 1);
    const { state: ask2 } = await run({ ask_attempt: 2 });
    check("ask at ceiling: exhausted, not hold", ask2.execution_decision, "exhausted");
    check("  and not NULL — a ceiling is not a report", slotOf(ask2).status, "unknown");
    check("  names the route and the slot", `${ask2.gate?.exhausted?.[0]?.route}:${ask2.gate?.exhausted?.[0]?.names}`,
      `ask_user:${SLOT}`);
    check("  next_ask_attempt is null: do not re-enter", ask2.gate?.next_ask_attempt, "null");
    const { state: lk2 } = await run({ allowed: only("measured_data"), lookup_attempt: 2 });
    check("lookup at ceiling: exhausted", lk2.execution_decision, "exhausted");
    const { state: lk1 } = await run({ allowed: only("measured_data"), lookup_attempt: 1 });
    check("lookup under ceiling: system_lookup", lk1.execution_decision, "system_lookup");
    check("  next_lookup_attempt counts up", lk1.gate?.next_lookup_attempt, 2);
    // A slot past one ceiling falls to the next open route rather than stopping.
    const { state: both } = await run({ userAnswers: {}, lookup_attempt: 2, allowed: only("user_answer", "measured_data") });
    check("system past its ceiling, user still open: ask_user", both.execution_decision, "ask_user");
    // The adopting system sets the value (4.5).
    const { state: lim0 } = await run({ limits: { ask: 0 } });
    check("limits.ask = 0: exhausted on the first round", lim0.execution_decision, "exhausted");
    const { state: limBad } = await run({ limits: { ask: "lots" } });
    check("an unreadable limit falls back to the default, not to none", limBad.execution_decision, "ask_user");
    // Instruction time, same ceiling.
    const { state: laterEx } = await run({ whenCase: "scheduled", ask_attempt: 2 });
    check("at_instruction, ask at ceiling: exhausted", laterEx.execution_decision, "exhausted");
    // A required NULL at instruction time is judged at the trigger, where its sources are re-read.
    const { state: laterNull } = await run({ whenCase: "scheduled", allowed: only("measured_data"), measure: () => ABSENT });
    check("at_instruction, required NULL: deferred", laterNull.execution_decision, "deferred");

    // The early returns, same words. An intent ask at its ceiling is a route that ended.
    const { state: intentEx } = await run({ whenCase: "not_a_case", intent_attempt: 2 });
    check("intent ask at ceiling: exhausted, not hold", intentEx.execution_decision, "exhausted");
    check("  kind still names it", intentEx.gate?.kind, "intent_undetermined_exhausted");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
