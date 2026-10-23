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
function createHooks({ locate, measured, acceptPriorState, whenCase, allowed }) {
  return {
    classifyWhenCase: () => whenCase ?? "immediate",
    extractUserActionName: () => "pay the supplier",
    confirmToolNameMatchesIntent: (name, tool) =>
      ({ approved: true, reason: `single-tool test: '${name}' for '${tool?.name}'` }),

    // Seat 2. Returns a location, never a value of its own invention.
    extractFromInstruction: (fieldName) =>
      (locate && fieldName === SLOT) ? locate : undefined,
    // The span really does hold the value, so equality is honest here.
    spanSupportsValue: (value, atSpan) => value === atSpan,

    // Seat 4.
    measureFromEnvironment: (fieldName) =>
      (measured && fieldName in measured) ? { valid: true, value: measured[fieldName] } : undefined,

    // Seat 5 is refused by the skeleton's default policy. Wiring this hook to pass it through is
    //   how an adopter accepts inheritance — and 5.2 still says inheritance alone does not confirm
    //   the slot, which part 4 shows.
    ...(acceptPriorState ? { applyFieldPolicy: (record) => record } : {}),

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
                     acceptPriorState, whenCase, storage, allowed }) {
  const store = storage ?? createStorage();
  const preflight = createPreflight({
    hooks: createHooks({ locate, measured, acceptPriorState, whenCase, allowed }),
    storage: store,
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

    // Run 2, same key, value no longer in the instruction. It is found at prior_state and REFUSED
    //   by the default policy: 5.2 says inheritance alone does not confirm the slot.
    const { state: second } = await run({ prior, storage: store });
    check("run 2: inheritance alone does not settle it", slotOf(second).status, "unknown");
    check("run 2: so it comes back as a blank", second.execution_decision, "ask_user");
    check("run 2: and the blank is this slot", second.gate?.unknown_fields?.[0]?.name, SLOT);

    // An adopter that accepts inheritance wires applyFieldPolicy. source becomes prior_state and
    //   origin_source is INHERITED, so the first source is not erased.
    const { state: accepted } = await run({ prior, acceptPriorState: true, storage: store });
    check("accepted: source is prior_state", slotOf(accepted).source, "prior_state");
    check("accepted: origin_source survives", slotOf(accepted).origin_source, "instruction");
    check("accepted: the value is still the same string", slotOf(accepted).value, ACCOUNT);

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
    check("  it holds", sys.execution_decision, "hold");
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

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
