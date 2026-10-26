"use strict";

/**
 * Offline test of the provider checklist — the gated half of spec 4.2.
 *
 *   node provider-conditions-test.js
 *
 * No API calls, no model. What is under test is the SKELETON's contract for
 * provider-declared conditions, so the verification hook is a dispatcher that
 * returns whatever each case needs. That is deliberate: a realistic hook would
 * test the hook, and what has to be pinned down here is what the gate does with
 * each return value — above all the returns it must refuse.
 *
 * Three properties are being checked.
 *
 *   DIRECTION (spec 5.1, 4.2.1). A provider condition can only block. Satisfying
 *     one promotes nothing: no slot becomes known, no user item becomes verified,
 *     nothing enters call_arguments. So an upstream edit that rewrites a condition
 *     as always-true cannot become a fail-open switch — the worst it does is
 *     remove a reason to block.
 *
 *   ROUTING (spec 4.2.1, 4.5). The label decides where an unresolved condition
 *     goes, and nothing here is a judgment call. [Verify] can be answered by the
 *     user, so it asks. [Required] cannot, so it is a gap in the declaration or
 *     the lookup path and goes to definition_repair. [Notice] is attached to a
 *     constraint rather than a condition and is not a gate at all.
 *
 *   FAIL-CLOSED DECLARATION. An unrecognized label, a crashed fetch, and an
 *     unwired verification hook all hold. A declaration the gate cannot read is
 *     never treated as a tool that declared nothing — that silent deletion is the
 *     single failure this list exists to prevent.
 *
 * The case that matters most is 3. [Required] means "confirmed only from the
 * declared system source; user approval does not satisfy it" (4.2.1), and 8.4
 * turns entirely on a user's request not being an allowed source. Here the hook
 * returns "checked" with source user_answer — the shape of "the CFO approved on a
 * call, so the limit doesn't apply" — and the gate must refuse it. If this rule
 * lived only in hook discipline it would not be a rule the gate holds.
 */

const { createPreflight } = require("../execution-state-preflight");
const { locatedActionName } = require("./c2-stub");

let failures = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(52)} got=${got}${ok ? "" : `  want=${want}`}`);
}

// ── The tool. Its schema says nothing about any condition. ────────────────────────
const SEND_WIRE = {
  name: "send_wire",
  description: "Send a wire transfer. Funds leave immediately.",
  inputSchema: {
    type: "object",
    properties: {
      amount: { type: "number" },
      recipient: { type: "string" },
    },
    required: ["amount", "recipient"],
  },
};

// Measured environment. Omitting a field leaves its slot UNKNOWN.
const MEASURED = { amount: 4200, recipient: "ACCT-77" };

// ── Hooks. Deterministic; no model takes part in any verdict. ─────────────────────
// Each condition carries `_return`, which is what verifyProviderCondition hands back
// for it. The gate's job is to accept, demote or route that value correctly.
function createHooks({ runId, conditions, conditionsThrow, measured }) {
  const hooks = {
    classifyWhenCase: () => "immediate",
    extractUserActionName: locatedActionName(),   // a located claim (4.1); see c2-stub.js
    confirmToolNameMatchesIntent: (name, tool) =>
      ({ approved: true, reason: `single-tool test: '${name}' for '${tool?.name}'` }),
    extractFromInstruction: () => undefined,
    measureFromEnvironment(fieldName) {
      const m = measured ?? MEASURED;
      return fieldName in m ? { valid: true, value: m[fieldName] } : undefined;
    },
    buildActionKey: (userId, fixed) => `${userId}:${fixed?.c3_provider_action_name}:${runId}`,

    getProviderConditions() {
      if (conditionsThrow) throw new Error("condition source unreachable");
      return conditions ?? [];
    },
    verifyProviderCondition(condition) {
      return condition?._return ?? { status: "unverified", source: null, note: "no rule for this id" };
    },
    // A user item, used only by the invariant case. Verified on its own terms.
    verifyUserChecklistItem(item) {
      return { ...item, status: "verified", source: "user_answer", note: "declared and confirmed" };
    },
  };
  // Case 12 runs the skeleton's own default for verifyProviderCondition.
  if (conditions === null) delete hooks.verifyProviderCondition;
  return hooks;
}

function createStorage() {
  const m = new Map();
  return {
    async persist(key, record) { const a = m.get(key) ?? []; a.push(record); m.set(key, a); },
    async load(key) { const a = m.get(key) ?? []; return a.length ? a[a.length - 1] : null; },
  };
}

async function run(runId, opts = {}) {
  const preflight = createPreflight({
    hooks: createHooks({ runId, ...opts }),
    storage: createStorage(),
  });
  return preflight.runPreflightAndRecord({
    userId: "u_test",
    instruction: [{ trust: "user", text: "send the wire" }],
    mcpTool: SEND_WIRE,
    measured_data: {},
    userChecklist: opts.userChecklist ?? [],
  });
}

const cond = (id, label, ret, extra = {}) =>
  ({ id, label, description: `${id} (${label})`, _return: ret, ...extra });

const CHECKED  = { status: "checked", source: "measured_data", note: "compared and it does not prohibit" };
const UNMET    = { status: "unmet",   source: "measured_data", note: "limit exceeded" };

function providerItem(rec, id) {
  return (rec.provider_checklist ?? []).find(c => c.id === id) ?? {};
}
function len(x) { return (x ?? []).length; }

(async () => {
  // ── 0. Control: no conditions declared. ─────────────────────────────────────────
  {
    const r = await run("c0", { conditions: [] });
    console.log("\n--- case 0: no conditions declared (control) ---");
    check("executes", r.execution_decision, "execute");
    check("provider list empty", len(r.provider_checklist), 0);
    check("unverified_provider_count", r.unverified_provider_count, 0);
  }

  // ── 1. [Required] compared from a declared system source, not prohibiting. ──────
  {
    const r = await run("c1", { conditions: [cond("c_limit", "Required", CHECKED)] });
    console.log("\n--- case 1: [Required] checked from measured_data ---");
    check("executes", r.execution_decision, "execute");
    check("status", providerItem(r, "c_limit").status, "checked");
    check("no route", providerItem(r, "c_limit").route, "null");
    check("not counted", r.unverified_provider_count, 0);
  }

  // ── 2. [Required] compared and prohibiting. Recorded, not asked about. ──────────
  {
    const r = await run("c2", { conditions: [cond("c_limit", "Required", UNMET)] });
    console.log("\n--- case 2: [Required] unmet ---");
    check("holds", r.execution_decision, "hold");
    check("gate.kind", r.gate?.kind, "unmet");
    check("status", providerItem(r, "c_limit").status, "unmet");
    check("declared_by on the unmet entry", r.gate?.unmet?.[0]?.declared_by, "provider");
    check("label carried on the unmet entry", r.gate?.unmet?.[0]?.label, "Required");
    check("nothing asked of the user", len(r.gate?.unknown_fields), 0);
    check("not routed to the user", len(r.gate?.unverified_provider), 0);
  }

  // ── 3. [Required] cleared from anything but a system source. MUST be refused. ──
  // Of the five sources in 5.2, four are the user speaking at different times. Naming only
  // user_answer here would leave instruction, pre_set_data and prior_state open — and
  // instruction is the vector 8.4 is about: the claim typed into the request itself.
  {
    console.log("\n--- case 3: [Required] checked from each non-system source ---");
    for (const src of ["user_answer", "instruction", "pre_set_data", "prior_state"]) {
      const sneaky = { status: "checked", source: src, note: "the CFO approved on a call" };
      const r = await run(`c3-${src}`, { conditions: [cond("c_limit", "Required", sneaky)] });
      const item = providerItem(r, "c_limit");
      check(`${src} refused`, item.status, "unverified");
      check(`${src} → definition_repair, not ask_user`, item.route, "definition_repair");
      check(`${src} → decision definition_repair`, r.execution_decision, "definition_repair");
      check(`${src} note names the rule`, /4\.2\.1/.test(item.note ?? ""), "true");
    }
    // The one source that does satisfy it, so the test is not passing by refusing everything.
    const ok = await run("c3-sys", { conditions: [cond("c_limit", "Required", CHECKED)] });
    check("measured_data accepted", providerItem(ok, "c_limit").status, "checked");
    check("and it executes", ok.execution_decision, "execute");
  }

  // ── 4. A status with no source is a claim, not a finding. Both outcomes. ──────
  {
    console.log("\n--- case 4: checked / unmet with no source ---");
    const noUnmet = { status: "unmet", source: null, note: "prohibited, allegedly" };
    const r = await run("c4a", { conditions: [cond("c_limit", "Required", noUnmet)] });
    check("sourceless unmet demoted", providerItem(r, "c_limit").status, "unverified");
    check("decision definition_repair, not hold", r.execution_decision, "definition_repair");
    check("not recorded as unmet", len(r.gate?.unmet), 0);

    // The same rule on the other outcome. Defend one and the other becomes the way through.
    const noChecked = { status: "checked", source: null, note: "checked, trust me" };
    const r2 = await run("c4b", { conditions: [cond("c_agreed", "Verify", noChecked)] });
    check("sourceless checked demoted", providerItem(r2, "c_agreed").status, "unverified");
    check("and [Verify] still asks", r2.execution_decision, "ask_user");
    check("note names 5.1", /5\.1/.test(providerItem(r2, "c_agreed").note ?? ""), "true");
  }

  // ── 5-6. [Verify] is answerable by the user, so it asks. ───────────────────────
  {
    const r = await run("c5", { conditions: [cond("c_agreed", "Verify", { status: "unverified", source: null })] });
    console.log("\n--- case 5: [Verify] not yet approved ---");
    check("asks the user", r.execution_decision, "ask_user");
    check("route", providerItem(r, "c_agreed").route, "ask_user");
    check("listed for the user", r.gate?.unverified_provider?.[0]?.id, "c_agreed");
    check("not a provider gap", len(r.gate?.definition_repair), 0);

    const r2 = await run("c6", { conditions: [cond("c_agreed", "Verify", CHECKED)] });
    console.log("\n--- case 6: [Verify] approved ---");
    check("executes", r2.execution_decision, "execute");
    check("not counted", r2.unverified_provider_count, 0);
  }

  // ── 7. [Notice] is a disclosure obligation, never a gate. ─────────────────────
  {
    const r = await run("c7", { conditions: [cond("c_visible", "Notice", null)] });
    console.log("\n--- case 7: [Notice] ---");
    check("does not block", r.execution_decision, "execute");
    check("status", providerItem(r, "c_visible").status, "disclosure_required");
    check("surfaced on the gate", r.gate?.disclosures?.[0]?.id, "c_visible");
    check("not counted", r.unverified_provider_count, 0);
    // A hand-off, not a check: the gate cannot see whether a sentence reached a human, so it
    // states the obligation and the executing party discharges it (3.5).
    check("handed over as an obligation", r.gate?.disclosures?.[0]?.required_before_execution, "true");
    check("carries its declarer", r.gate?.disclosures?.[0]?.declared_by, "provider");
  }

  // ── 8. An unrecognized label is not a condition to drop. ──────────────────────
  {
    const r = await run("c8", { conditions: [cond("c_typo", "Mandatory", CHECKED)] });
    console.log("\n--- case 8: unrecognized label ---");
    check("decision definition_repair, not hold", r.execution_decision, "definition_repair");
    check("the _return is never consulted", providerItem(r, "c_typo").status, "unverified");
    check("routed to definition_repair", providerItem(r, "c_typo").route, "definition_repair");
    check("note names the label", /Mandatory/.test(providerItem(r, "c_typo").note ?? ""), "true");
  }

  // ── 9. A crashed fetch is not a tool with no conditions. ──────────────────────
  {
    const r = await run("c9", { conditionsThrow: true });
    console.log("\n--- case 9: getProviderConditions throws ---");
    check("decision definition_repair, not hold", r.execution_decision, "definition_repair");
    check("one item recorded", len(r.provider_checklist), 1);
    check("routed to definition_repair", r.provider_checklist?.[0]?.route, "definition_repair");
    check("note names the failure", /unreachable/.test(r.provider_checklist?.[0]?.note ?? ""), "true");
  }

  // ── 10. A condition cannot be compared while its slot is unknown. ─────────────
  {
    const r = await run("c10", {
      conditions: [cond("c_dest", "Required", CHECKED, { constrains: ["recipient"] })],
      measured: { amount: 4200 },                    // recipient left unmeasured
    });
    const item = providerItem(r, "c_dest");
    console.log("\n--- case 10: condition constrains an UNKNOWN slot ---");
    check("asks for the slot", r.execution_decision, "ask_user");
    check("condition is pending, not unverified", item.status, "pending_on_slot");
    check("waiting_on names the slot", (item.waiting_on ?? []).join(","), "recipient");
    check("the condition is not counted", r.unverified_provider_count, 0);
    check("the blank asked about is the slot", r.gate?.unknown_fields?.[0]?.name, "recipient");
    check("no condition routed to the user", len(r.gate?.unverified_provider), 0);
  }

  // ── 10-b. constrains naming nothing is a broken declaration, not a pass. ──────
  // Without this check a one-character typo produces a CLEAN verdict: the name is not among the
  // unknown slots, so nothing is pending, and the hook compares against a value the condition was
  // never about. The provider wrote the declaration, so it goes back to the provider whatever the
  // label says — the user cannot answer for a field name in someone else's declaration.
  {
    const r = await run("c10b", {
      conditions: [cond("c_typo2", "Required", CHECKED, { constrains: ["amuont"] })],
    });
    const item = providerItem(r, "c_typo2");
    console.log("\n--- case 10-b: constrains names a slot that does not exist ---");
    check("the hook's \"checked\" is never reached", item.status, "unverified");
    check("routed to the provider", item.route, "definition_repair");
    check("decision definition_repair, not hold", r.execution_decision, "definition_repair");
    check("note names the bad target", /amuont/.test(item.note ?? ""), "true");
    check("[Verify] goes to the provider too", await (async () => {
      const r2 = await run("c10c", {
        conditions: [cond("c_typo3", "Verify", CHECKED, { constrains: ["amuont"] })],
      });
      return providerItem(r2, "c_typo3").route;
    })(), "definition_repair");
  }

  // ── 10-c. An unmet condition holds even with blanks outstanding. ──────────────
  // It was compared against SETTLED values — a condition whose target is unknown is
  // pending_on_slot, and one whose target names nothing is unverified — so filling the
  // remaining blanks cannot turn it met. Asking would send the user to fill in a form for
  // an execution that is already prohibited (4.5: a hold does not go back to asking).
  {
    const r = await run("c10d", {
      conditions: [cond("c_limit", "Required", UNMET, { constrains: ["amount"] })],
      measured: { amount: 4200 },                    // recipient left unmeasured
    });
    console.log("\n--- case 10-c: unmet with a blank still outstanding ---");
    check("holds, does not ask", r.execution_decision, "hold");
    check("gate.kind is set", r.gate?.kind, "unmet");
    check("the blank is still recorded", r.gate?.unknown_fields?.[0]?.name, "recipient");
    check("recorded as unmet", r.gate?.unmet?.[0]?.id, "c_limit");
  }

  // ── 10-d. A finished prohibition outranks an open route. ─────────────────────
  // One condition checked and prohibiting, another that cannot be read. The second is a route still
  // open (definition_repair); the first is a check that finished. No repair of the second can make
  // the first met, so the decision is hold — and the repair is still recorded for its owner (4.5).
  {
    const r = await run("c10e", {
      conditions: [
        cond("c_limit", "Required", UNMET, { constrains: ["amount"] }),
        cond("c_typo", "Mandatory", CHECKED, { constrains: ["amount"] }),
      ],
      measured: { amount: 4200, recipient: "acct_1" },
    });
    console.log("\n--- case 10-d: unmet alongside a condition that cannot be read ---");
    check("decision is hold", r.execution_decision, "hold");
    check("the reason names the unmet item", /^hold: unmet/.test(r.reason ?? ""), "true");
    check("the repair is still recorded", r.gate?.definition_repair?.[0]?.id, "c_typo");
  }

  // ── 11. INVARIANT: satisfying a provider condition promotes nothing. ──────────
  {
    const r = await run("c11", {
      conditions: [
        cond("c_ok", "Required", CHECKED),
        cond("c_seen", "Notice", null),
      ],
      userChecklist: [{ id: "u_item", description: "a user rule", constrains: [] }],
    });
    console.log("\n--- case 11: invariant — a checked condition promotes nothing ---");
    const argKeys = Object.keys(r.call_arguments ?? {}).sort().join(",");
    check("call_arguments holds only schema fields", argKeys, "amount,recipient");
    check("no condition id leaked into the call", /c_ok|c_seen/.test(argKeys), "false");
    check("conditions are not slots", len(r.fields), 2);
    check("slot names unchanged", r.fields.map(f => f.name).sort().join(","), "amount,recipient");
    check("user list untouched by the provider list", len(r.user_checklist), 1);
    check("the two lists are separate", r.user_checklist[0].id, "u_item");
    check("executes", r.execution_decision, "execute");
  }

  // ── 12. The skeleton's own default for the verification hook. ─────────────────
  {
    // conditions === null removes the hook, so the skeleton's default runs.
    const preflight = createPreflight({
      hooks: createHooks({ runId: "c12", conditions: null }),
      storage: createStorage(),
    });
    const flagged = (preflight.unsafeDefaults ?? []).includes("verifyProviderCondition");
    const r = await preflight.runPreflightAndRecord({
      userId: "u_test",
      instruction: [{ trust: "user", text: "send the wire" }],
      mcpTool: SEND_WIRE,
      measured_data: {},
      userChecklist: [],
    });
    console.log("\n--- case 12: verifyProviderCondition unwired ---");
    check("declared on unsafeDefaults", flagged, "true");
    // The default returns no conditions AND verifies nothing. With no conditions
    // declared there is nothing to hold on — which is the weakness, stated plainly.
    check("executes, because nothing was declared", r.execution_decision, "execute");
    check("the weakness is the empty list", len(r.provider_checklist), 0);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
