"use strict";

/**
 * What the provider has to declare — each declaration put in, then taken out.
 *
 *   node declaration-test.js
 *
 * No API calls, no model, and no MCP server. Wiring a real server up to see what a declaration does
 * is the slow way to find out, and in a test environment it is mostly not available. Everything the
 * provider declares is just an object handed to the gate, so this file declares it directly, and
 * then declares it wrongly, or not at all, and prints what changed.
 *
 * WHY THIS FILE IS SHAPED AS A LIST. The other suites here are organized by machinery: one for the
 * value sources, one for the conditions. That is the wrong shape for the person who has to adopt
 * this, because it does not answer their actual question — what do I have to declare, and what
 * happens if I don't. Spec 2.8 names this as a failure of its own: rules spread across prompts,
 * wrapper branches and undocumented habit, where nobody can list what is in force or say why any of
 * it is the way it is. A test suite in that shape repeats the problem it describes.
 *
 * So every row below is a PAIR. The declaration is present, and then it is absent, and the two
 * outcomes sit next to each other with one line saying why the difference matters. Read the output
 * top to bottom and it is the inventory: the things a provider decides, and the cost of each.
 *
 * The control rows — the ones where nothing is declared and the call goes through — are the point,
 * not filler. A gate that blocks everything proves nothing. What has to be visible is that the
 * difference came from the declaration and not from the model.
 *
 * Two halves, matching spec 4.2: the provider's VALUES are the input schema, and the provider's
 * CONDITIONS are a declaration of their own. The user's half is in value-source-test.js (one value
 * moved between the five sources) and gate-test.js case 7. A closing summary prints the whole
 * inventory with where each line is covered.
 */

const { createPreflight } = require("../execution-state-preflight");
const { withPorts } = require("./ports");
const { locatedActionName } = require("./c2-stub");

let failures = 0;
const SEEN = new Set();

function row(label, got, want, why) {
  const ok = String(got) === String(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? " " : "✗"} ${label.padEnd(38)} ${String(got).padEnd(20)}${why ? `← ${why}` : ""}`);
  if (!ok) console.log(`      want=${want}`);
}
function heading(t) { console.log(`\n${t}`); SEEN.add(t); }

// ── One scenario throughout: pay a supplier. Only the declarations change. ────────
const AMOUNT = 4200;
const ACCOUNT = "DE89-3704";

// The type a property declares, checked on one value: what the adopting system's validator does here.
const typeError = (v, s) =>
  (s?.type === "number" && typeof v !== "number") ? `expected number, got ${typeof v}`
  : (s?.type === "string" && typeof v !== "string") ? `expected string, got ${typeof v}` : null;

// Hooks that settle whatever the schema asks for, so nothing but the declaration decides the outcome.
//   The validators are wired (the comparison engine is the adopting system's, 6.3); row 5 takes them
//   out to show what the skeleton does without one.
function hooks({ measured, conditions, verify, validators = "wired" }) {
  const m = measured ?? { amount: AMOUNT, payee_account: ACCOUNT };
  return {
    classifyWhenCase: () => "immediate",
    extractUserActionName: locatedActionName(),   // a located claim (4.1); see c2-stub.js
    confirmToolNameMatchesIntent: (n, t) => ({ approved: true, reason: `single tool: '${n}' / '${t?.name}'` }),
    extractFromInstruction: () => undefined,
    measure: (f) => (f in m ? { valid: true, value: m[f] } : undefined),
    buildActionKey: () => "u:pay",
    ...(conditions !== undefined ? { getProviderConditions: () => conditions } : {}),
    ...(verify ? { verifyProviderCondition: verify } : {}),
    ...(validators === "wired" ? {
      validateFieldSchema: (v, s) => typeError(v, s),
      validatePayload: (args, schema) => {
        const missing = (schema?.required ?? []).filter(k => !(k in (args ?? {})));
        if (missing.length) return `required argument missing: ${missing.join(", ")}`;
        for (const [k, v] of Object.entries(args ?? {})) { const e = typeError(v, schema?.properties?.[k]); if (e) return `${k}: ${e}`; }
        return null;
      },
    } : {}),
  };
}

async function run({ schema, description, ...rest }) {
  const tool = { name: "send_payment", description: description ?? "Send a payment.", inputSchema: schema };
  const preflight = createPreflight({
    hooks: withPorts(hooks(rest), { tool }),
    storage: { async persist() {}, async load() { return null; } },
  });
  return preflight.runPreflightAndRecord({
    userId: "u",
    instruction: [{ trust: "user", text: "Pay the supplier." }],
    toolCall: { name: tool.name },
    userChecklist: [],
  });
}

const FULL = {
  type: "object",
  properties: { amount: { type: "number" }, payee_account: { type: "string" } },
  required: ["amount", "payee_account"],
};
const cond = (id, label, extra = {}) =>
  ({ id, label, description: `${id} (${label})`, ...extra });
const CHECKED = { status: "checked", source: "measured_data", note: "compared, does not prohibit" };
const UNMET = { status: "unmet", source: "measured_data", note: "limit exceeded" };

(async () => {
  console.log("DECLARATIONS A PROVIDER MAKES, AND WHAT HAPPENS WITHOUT THEM");
  console.log("left: what was declared   middle: what the gate did   right: why it matters");

  // ══ THE PROVIDER'S VALUES — the input schema (spec 4.2) ════════════════════════
  heading("1. Is there a schema at all?");
  {
    const a = await run({ schema: undefined });
    row("no inputSchema", a.gate?.kind, "schema_unsupported",
      "not received is not the same as 'takes no arguments'");
    row("  its decision", a.execution_decision, "definition_repair",
      "fail closed on a tool we cannot read — a gap in its declaration, not a prohibition");

    const b = await run({ schema: { type: "object", properties: {}, required: [] } });
    row("required: [] declared", b.execution_decision, "execute",
      "unconditional pass — correct ONLY because it was declared");
  }

  heading("2. Which arguments are required?");
  {
    const a = await run({ schema: { type: "object", properties: { amount: {} } } });
    row("no required key", a.execution_decision, "execute",
      "omit it and nothing is required: JSON Schema's own meaning");

    const b = await run({ schema: FULL });
    row("required: [amount, account]", b.execution_decision, "execute", "both measured");

    const c = await run({ schema: FULL, measured: { amount: AMOUNT } });
    row("  same, account unmeasured", c.execution_decision, "ask_user", "the blank is named, not guessed");
    row("  which blank", c.gate?.unknown_fields?.[0]?.name, "payee_account");

    const d = await run({
      schema: { type: "object", properties: { amount: {}, memo: {} }, required: ["amount"] },
      measured: { amount: AMOUNT, memo: "inv 1002" },
    });
    row("memo in properties only", Object.keys(d.call_arguments ?? {}).sort().join(","), "amount,memo",
      "optional: sent when known, never counted");
    row("  and it does not block", d.execution_decision, "execute");
  }

  heading("3. Are the arguments alternatives? (oneOf)");
  {
    const S = { type: "object", properties: { payee_account: {}, payee_id: {} },
                oneOf: [{ required: ["payee_account"] }, { required: ["payee_id"] }] };
    const a = await run({ schema: S, measured: { payee_account: ACCOUNT } });
    row("one branch grounded", a.execution_decision, "execute", "the grounded branch is the required set");

    const b = await run({ schema: S, measured: {} });
    row("neither grounded", b.gate?.kind, "branch_unresolved", "which branch is not the model's to pick");

    const c = await run({ schema: S, measured: { payee_account: ACCOUNT, payee_id: "SUP-7" } });
    row("both grounded", c.gate?.kind, "branch_conflict", "ambiguity is reported, not resolved");
  }

  heading("4. Can the schema be read deterministically?");
  {
    const a = await run({ schema: { type: "object", properties: { amount: {} }, allOf: [{ required: ["amount"] }] } });
    row("allOf present", a.gate?.kind, "schema_unsupported",
      "a keyword the gate cannot read is refused, not approximated");
    row("  its decision", a.execution_decision, "definition_repair");
  }

  heading("5. Is the FORMAT enforced? (the adopting system wires the validator)");
  {
    const bad = { amount: "four thousand", payee_account: ACCOUNT };
    const a = await run({ schema: FULL, measured: bad, validators: "unwired" });
    row("type: number declared, no validator", a.execution_decision, "definition_repair",
      "a check that could not be made is not a pass (6.3)");
    row("  its own check, unverified",
      (a.value_checks ?? []).find(c => c.id === "amount:format")?.status, "unverified",
      "each value's format is a slot of its own");
    row("  nothing was sent", a.execution_decision === "execute", "false",
      "before 1.16 the string reached a number argument");

    const b = await run({ schema: FULL, measured: bad });
    row("same, validator wired", b.execution_decision, "ask_user");
    row("  the check rejected it",
      (b.value_checks ?? []).find(c => c.id === "amount:format")?.status, "rejected");
    row("  the slot goes back to unknown",
      (b.fields ?? []).find(f => f.name === "amount")?.status, "unknown",
      "a format violation is a defect, not a value yet to arrive");
  }

  // ══ THE PROVIDER'S CONDITIONS (spec 4.2, 4.2.1) ════════════════════════════════
  heading("6. Is the condition declared at all? (the control)");
  {
    const a = await run({
      schema: FULL,
      description: "Send a payment. An approval only counts if the approver's limit covers the amount.",
    });
    row("written in the description only", a.execution_decision, "execute",
      "prose reaches the model as context and nothing compares it");
    row("  it IS recorded", /approver's limit/.test(a.advisory_notes ?? ""), "true",
      "recorded is not enforced — this is the gap the label closes");

    const l = await run({
      schema: FULL,
      description: "Send a payment.\n[Required] An approval only counts if the approver's limit covers the amount.",
    });
    row("the same sentence as a labelled line", l.execution_decision, "definition_repair",
      "now a condition (4.2.1): read by the default, not yet in a confirmed form");
    row("  it is in the checklist", l.provider_checklist?.[0]?.status, "unverified",
      "unverified, never absent — back to whoever declared it");

    const b = await run({
      schema: FULL,
      conditions: [cond("c_limit", "Required", { constrains: ["amount"] })],
      verify: () => UNMET,
    });
    row("declared as [Required]", b.execution_decision, "hold", "same sentence, now compared");
    row("  recorded as unmet", b.gate?.unmet?.[0]?.declared_by, "provider");
  }

  heading("7. Which of the three is it?");
  {
    const C = { constrains: ["amount"] };
    const a = await run({ schema: FULL, conditions: [cond("c", "Required", C)], verify: () => CHECKED });
    row("[Required], met", a.execution_decision, "execute", "clearing it removes a reason to block");

    const b = await run({ schema: FULL, conditions: [cond("c", "Required", C)], verify: () => UNMET });
    row("[Required], unmet", b.execution_decision, "hold", "a prohibition, and the user is not asked");

    const c = await run({ schema: FULL, conditions: [cond("c", "Verify")],
      verify: () => ({ status: "unverified", source: null }) });
    row("[Verify], not approved", c.execution_decision, "ask_user", "the user's approval is the means");

    const d = await run({ schema: FULL, conditions: [cond("c", "Notice")] });
    row("[Notice]", d.execution_decision, "execute", "nothing to satisfy — handed to the executor");
    row("  handed over", d.gate?.disclosures?.[0]?.required_before_execution, "true");
  }

  heading("8. Where may it be confirmed from?");
  {
    const C = { constrains: ["amount"] };
    const a = await run({ schema: FULL, conditions: [cond("c", "Required", C)],
      verify: () => ({ status: "checked", source: "instruction", note: "the CFO approved on a call" }) });
    row("[Required] cleared from instruction", a.execution_decision, "definition_repair",
      "four of the five sources are the user speaking");
    row("  refused and routed", a.provider_checklist?.[0]?.route, "definition_repair",
      "spec 8.4: a request does not move the comparison");

    const b = await run({ schema: FULL, conditions: [cond("c", "Required", C)],
      verify: () => ({ status: "checked", source: "measured_data" }) });
    row("same, from measured_data", b.execution_decision, "execute", "the one system source");

    const c = await run({ schema: FULL, conditions: [cond("c", "Required", C)],
      verify: () => ({ status: "checked", source: null }) });
    row("checked with no source named", c.execution_decision, "definition_repair",
      "'I checked' is a claim; 5.1 settles a state by where it was looked up");
  }

  heading("9. Is the declaration itself well formed?");
  {
    const a = await run({ schema: FULL, conditions: [cond("c", "Mandatory", { constrains: ["amount"] })],
      verify: () => CHECKED });
    row("a label that is not one of the three", a.execution_decision, "definition_repair",
      "a typo must not silently delete a condition");

    const b = await run({ schema: FULL, conditions: [cond("c", "Required", { constrains: ["amuont"] })],
      verify: () => CHECKED });
    row("constrains names nothing", b.execution_decision, "definition_repair",
      "otherwise it compares against a value it was never about");

    const c = await run({ schema: FULL, conditions: [cond("c", "Required")], verify: () => CHECKED });
    row("no constrains at all", c.execution_decision, "execute",
      "compared immediately — declare it for a condition about a value");

    const d = await run({
      schema: FULL,
      conditions: [cond("c", "Required", { constrains: ["payee_account"] })],
      measured: { amount: AMOUNT },
      verify: () => CHECKED,
    });
    row("constrains an unsettled slot", d.provider_checklist?.[0]?.status, "pending_on_slot",
      "not compared yet, and not counted either");
    row("  the question is about the slot", d.gate?.unknown_fields?.[0]?.name, "payee_account");
  }

  heading("10. Is the condition source reachable?");
  {
    const a = await run({ schema: FULL, conditions: undefined });
    row("getProviderConditions unwired", a.execution_decision, "execute",
      "the default reads the labelled lines, and this description has none");

    const preflight = createPreflight({
      hooks: withPorts({ ...hooks({}), getProviderConditions: () => { throw new Error("registry down"); } },
        { tool: { name: "send_payment", description: "d", inputSchema: FULL } }),
      storage: { async persist() {}, async load() { return null; } },
    });
    const b = await preflight.runPreflightAndRecord({
      userId: "u", instruction: [{ trust: "user", text: "Pay the supplier." }],
      toolCall: { name: "send_payment" }, userChecklist: [],
    });
    row("it throws", b.execution_decision, "definition_repair", "a crashed fetch is not a tool with no conditions");
  }

  // ══ The inventory ══════════════════════════════════════════════════════════════
  console.log(`
THE WHOLE INVENTORY — what gets declared, by whom, and where it is covered

  FIXED (the skeleton's own three questions; no one declares these)
    C1 timing · C2 what the user called it · C3 does the tool match    gate-test.js

  PROVIDER — values (the input schema)
    the schema exists · required · optional properties · oneOf
    unreadable keywords · types, if format validation is wired         this file, 1-5

  PROVIDER — conditions (declared, not prose)
    declared or not · which of the three labels · allowed source
    a well-formed declaration · a reachable source                     this file, 6-10

  USER — values (no list of their own: the five sources fill the provider's slots)
    which of the five a slot may use is declared per slot, and an unknown's route
    follows from it — a slot that does not permit user_answer is not asked        value-source-test.js, 7
  USER — conditions (the same three labels)                            gate-test.js case 7

  THE ADOPTING SYSTEM'S, on purpose
    validateFieldSchema / validatePayload — the comparison engine belongs to the adopting
      system. Unwired, each check reads as unverified and the run goes to definition
      repair (row 5): fail-closed since 1.16, where it used to pass silently.
    C3 refusal and tool reselection — spec 8.1 keeps tool choice as a residual risk.`);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
