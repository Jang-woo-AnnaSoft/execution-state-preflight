/**
 * ============================================================================
 * [Execution State Preflight Architecture] — a verification skeleton that runs
 * before an MCP Tool call.
 *
 * Premise: Tool selection accuracy never reaches 100%.
 * This skeleton does not improve selection. It keeps a wrong one out of execution.
 *
 * Three checks run in order, and each one writes a verdict rather than executing or blocking:
 *   intent gate (Step 1-a)  — was the action settled at all
 *   tool gate   (Step 1-c)  — is this action really this tool
 *   value gate  (Step 5-6)  — are all slots and checklist items settled
 * Only two things here are deterministic: lookupField, which walks five sources and never
 * generates a value, and the value gate's count. The tool gate is judged from the tool's
 * description, which is prose — it is mitigation, not verification, and belongs on the
 * principle side. The Background, decision path, and principles are in the [APPENDIX].
 *
 * Apply it only to irreversible actions, and take only the parts that fit.
 * The intent and tool gates are often better placed in the prompt. Asking the user is handled
 * by built-in functionality in most agent frameworks now. Much of the rest exists to make the
 * structure explicit; what has to be code is `lookupField` and the shape of the record.
 * ============================================================================
 */

// 1. Data structures

/**
 * @typedef {Object} InstructionSegment
 * @property {string} text
 * @property {"user"|"untrusted"} trust  // user = typed by the user. Everything else is untrusted.
 * @property {string} [origin]           // Origin of an untrusted segment (e.g. "gmail:msg_881"). For records and questions.
 *
 * @typedef {Object} PreSetEntry
 * @property {*} value
 * @property {"user"|"untrusted"} trust  // "user" = a value settled through a decision path.
 *                                       //   Values inferred from conversation text do not belong here.
 * @property {string} [origin]           // Origin of the value. For records and questions.
 *   // preSetData[fieldName] = PreSetEntry.
 *   // POLICY: what counts as a "decision" is up to the adopting system. The skeleton only checks shape.
 *
 * @typedef {Object} FieldRecord
 * @property {string} name
 * @property {*} value
 * @property {"known"|"unknown"} status
 * @property {"instruction"|"pre_set_data"|"measured_data"|"prior_state"|"user_answer"|null} source
 * @property {"instruction"|"pre_set_data"|"measured_data"|"user_answer"|null} [origin_source]
 *   // The first source. prior_state can never appear here (it inherits).
 * @property {boolean} [pending_at_trigger]
 *   // Marks "unknown is correct now, will be settled at trigger time". Only applyFieldPolicy sets it.
 *   // It excuses a field only at the at_instruction gate. At at_trigger, unknown is unmet without exception.
 *   // NOTE: no staleness slot. prior_state is refused by default in applyFieldPolicy instead.
 * @property {boolean} [lookup_failed]  // The instruction or measurement hook threw. Set by lookupField only.
 *                                       //   See [LOOKUP HOOK FAILURE]
 * @property {string} [_diag_note]      // Hook exception text. Logs only — never copied into note
 * @property {string} [note]
 * @property {string} resolved_at
 *
 * @typedef {Object} UserChecklistItem
 * @property {string} id           // Required. The key that reattaches an ask_user answer — without it, hold.
 * @property {string} description
 * @property {"verified"|"unverified"} status
 * @property {"measured_data"|"user_answer"|null} [source]
 * @property {string} [verified_at]
 * @property {string} [note]
 *
 * @typedef {Object} GateResult
 * @property {"value_gate"|"tool_undetermined"|"tool_undetermined_exhausted"
 *           |"intent_undetermined"|"intent_undetermined_exhausted"
 *           |"schema_unsupported"|"branch_unresolved"|"branch_conflict"|"payload_invalid"
 *           |"action_key_failed"} [kind]
 *   // Omitted means value_gate (the original shape).
 *   // intent_undetermined*: C1/C2 could not be settled. Carries user_message, never unknown_fields
 *   //   (requiredFields is not even read yet at that point).
 *   // schema_unsupported: the slot list could not be materialized. hold.
 *   // branch_unresolved / branch_conflict: grounded state selects no branch / more than one.
 *   //   Carries user_message + branch_options, never unknown_fields (no slot list exists yet).
 *   // payload_invalid: every slot settled, complete object still fails inputSchema. hold.
 *   // action_key_failed: buildActionKey threw. hold, no lineage, lands under UNKEYED_RECORD_KEY.
 * @property {{name: string, note: string|null}[]} [unknown_fields]        // Absent on tool_undetermined / branch_* / schema_unsupported
 * @property {string[][]} [branch_options]   // branch_* only. The alternative required sets, for rendering
 * @property {string} [payload_violation]    // payload_invalid only. Reason text from validatePayload
 * @property {{id: string, description: string, note: string|null}[]} [unverified_checklist]
 * @property {string} [user_message]    // tool_undetermined / intent_undetermined*. Shown verbatim.
 * @property {string} [intent_fingerprint]       // intent_undetermined* only. Digest of the trusted instruction
 *   // text. Equal to the next call's = the user did not restate.
 * @property {number|null} [next_intent_attempt] // Send back as input.intent_attempt. null = do not re-enter.
 * @property {number|null} [next_tool_attempt]   // Same, as input.tool_attempt. Tool gate only.
 * @property {Object} [_diag]           // Logs only. Never expose (candidate_tool, hook exception text).
 *
 * @typedef {Object} FixedPreSet
 * @property {PreSetEntry} [c2_user_action_name]  // C2 fallback for THIS request. Separate input, not part
 *   // of preSetData: the pre_set_data step reads every key there, so a reserved key would collide with a same-named field.
 *   // Not the place for a standing C2→C3 mapping — see POLICY (learned mapping) on confirmToolNameMatchesIntent.
 *   // BREAKS: a c1_when_case entry here is ignored. C1 comes from the utterance only.
 *
 * @typedef {Object} ExecutionState
 * @property {string|null} action_key   // Baseline lineage key. null if it failed before fixed was settled.
 * @property {"at_instruction"|"at_trigger"|null} phase
 *   // Records from both moments accumulate under the same action_key. This is the key that separates them.
 * @property {Object|null} fixed        // C1(When/Case) / C2(User Action Name) / C3(Tool Name)
 *   // Plus c2_source: "instruction"|"pre_set_data"|null, and c3_match: { approved, reason }.
 *   // c3_match is the Tool judgment as decided on this run. Not inherited — fixed is rebuilt every run.
 * @property {FieldRecord[]|null} fields  // The materialized SLOTS — what blocks execution.
 *   // null if no decision was made — distinct from [] ("computed, came out empty")
 * @property {FieldRecord[]|null} [extra_fields]
 *   // Looked up through the same chain but outside the slot set: optional arguments, and values that
 *   // grounded a branch. Never counted by the gate; eligible for call_arguments when known.
 * @property {Object|null} [call_arguments]
 *   // The exact object executeIfReady sends, assembled from settled values only. null on deferred/hold.
 * @property {string} advisory_notes    // Provider description — recorded only, not part of the gate
 * @property {UserChecklistItem[]} user_checklist
 * @property {number|null} unknown_count  // Over fields (slots) only. extra_fields are never counted.
 *   // null if no decision was made — distinct from 0 (all known)
 * @property {number|null} unverified_checklist_count
 * @property {GateResult|null} gate     // The authoritative decision. Consumers read this, not reason.
 * @property {"execute"|"ask_user"|"hold"|"deferred"|"executed"|"failed"} execution_decision
 *   // deferred: the normal wait for non-immediate work (distinct from hold). Only "executed" counts as baseline.
 * @property {Object} [deferred_input]  // Present only on deferred records — the input for re-running at trigger time
 * @property {string} reason            // A derived rendering. gate is authoritative.
 * @property {string} timestamp
 */


// 1-1. Skeleton defenses — "hooks must not throw" is a contract, not a guarantee.
const WHEN_CASES = ["immediate", "scheduled", "conditional", "recurring"];
const UNKEYED_RECORD_KEY = "__preflight_unkeyed__";   // Storage key for records with no action_key
// Retention for this bucket is NOT the same as for keyed buckets. See [UNKEYED BUCKET POLICY] in recordExecutionState.

// User-facing text. Does not include the candidate Tool name.
// BREAKS: naming it turns the question into approval — users pick what they are shown.
// POLICY: with few Tools you may present a list. No default selection, no "recommended" marker.
// The ask is for the act, not the Tool.
//   BREAKS: "which tool" asks for a name the user need not know, and their answer cannot drive reselection.
const MSG_TOOL_UNDETERMINED =
  "I could not tell which action this maps to. Please describe what you want done, in your own words.";
const MSG_TOOL_EXHAUSTED =
  "I still could not match this to an action I can perform. Let us sort it out in conversation.";

// Re-ask ceilings. Two asks, then leave the skeleton and settle it in conversation.
// Counted separately: intent is recovered by restating, a Tool by reselecting upstream.
//   Shared, a Tool reselection would spend the intent budget.
// NOTE: the value_gate ceiling remains the adopting system's — see [Re-ask ceiling] in APPENDIX.
const INTENT_ATTEMPT_LIMIT = 2;
const TOOL_ATTEMPT_LIMIT = 2;

// Named after the act, never after the schema. Branch options travel in gate.branch_options for rendering.
const MSG_BRANCH_UNRESOLVED =
  "I could not tell which details to use for this. Please tell me which identifying information you have.";
const MSG_BRANCH_CONFLICT =
  "You gave me more than one way to identify this, and they do not go together. Please pick one.";

// C1 asks for the moment, C2 asks for the act. Neither names the candidates.
// BREAKS: listing the WHEN_CASES makes it a menu — "now or later?" is a click-through, not a restatement.
const MSG_INTENT_UNDETERMINED = {
  c1_when_case: "I could not tell when you want this done. Please say it again, including the timing.",
  c2_user_action_name: "I could not tell what you want done. Please say it again.",
  both: "I could not tell what you want done, or when. Please say it again.",
};

// Leaving message. The skeleton stops here; resolution moves to conversation outside this logic.
const MSG_INTENT_EXHAUSTED =
  "I still could not tell what you want done. Stopping here — let's sort it out in conversation.";

// POLICY (intent_attempt lifecycle) — stateless skeleton, so the caller enforces these:
//   1. Per REQUEST, judged by instruction change. Not elapsed time, not session (time is not an
//      invalidation basis anywhere in this file — see the user_answer step).
//   2. Carry-forward is the DEFAULT; reset needs an affirmative new-request signal.
//      A textual difference alone is not a signal: "do it" → "do it now" would reopen the loop.
//   3. next_intent_attempt === null → re-entry only from a NEW utterance. Never auto-retry.
//      Carry the counter unchanged through tool_reselected_by_user re-entry.
//      Re-calling at 0, or zeroing on tool re-entry, removes the ceiling entirely.

// Digest of the trusted portion of an instruction. One normalization for every caller.
// NOTE: identity only — "same utterance", never "same meaning". A different digest is not evidence of
//   a new request (rule 2).
function intentFingerprint(instruction) {
  const text = (Array.isArray(instruction) ? instruction : [])
    .filter(seg => seg?.trust === "user")
    .map(seg => String(seg?.text ?? ""))
    .join("\u0000")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = (((hash << 5) + hash) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}-${hash.toString(36)}`;
}

async function safeHook(fn, args, onFail) {
  try {
    return await fn(...args);
  } catch (e) {
    return onFail(e);
  }
}

function lookupFailures(fields) {
  return (fields ?? [])
    .filter(f => f?.lookup_failed === true)
    .map(f => ({ name: f.name, detail: f._diag_note ?? null }));
}

function unidentifiedChecklistIndexes(userChecklist) {
  return (userChecklist ?? [])
    .map((item, idx) => (typeof item?.id === "string" && item.id !== "" ? -1 : idx))
    .filter(idx => idx >= 0);
}

// 2. Settling C1/C2/C3
// CONTRACT: returns { fixed, issues }. A hook failure never throws — the slot becomes an issue.
//   BREAKS: return a bare `fixed` and every ambiguous utterance lands on the backstop — gate: null, no way back.
// NOTE: an unsettled slot is null, never coerced to a WHEN_CASE or placeholder. Asking is not defaulting —
//   that distinction is what keeps the "no fallback to immediate" rule intact.
function usableActionName(v) {
  return typeof v === "string" && v.trim() !== "";
}

// C2 fallback. Same acceptance conditions as pre_set_data: wrapper shape plus trust "user".
//   Stricter is defensible, looser is not — C2 feeds action_key, which sets prior_state's blast radius.
//   BREAKS: accept a raw string and one unwrapped value redefines what action this is.
function readC2Fallback(fixedPreSet) {
  const entry = fixedPreSet?.c2_user_action_name;
  if (!entry || typeof entry !== "object" || !("value" in entry) || entry.trust !== "user") return undefined;
  return usableActionName(entry.value) ? entry.value : undefined;
}

async function resolveFixedChecklist(h, instruction, mcpTool, fixedPreSet) {
  const issues = [];
  const fail = slot => e => {
    issues.push({ slot, code: "hook_error", detail: e?.message ?? String(e) });
    return undefined;
  };

  const c1 = await safeHook(h.classifyWhenCase, [instruction], fail("c1_when_case"));
  const c1Failed = issues.some(i => i.slot === "c1_when_case");
  // C1 enum check. Moved here from runPreflightInner so that "threw" and "returned garbage" share one path.
  if (!c1Failed && !WHEN_CASES.includes(c1)) {
    issues.push({ slot: "c1_when_case", code: "out_of_enum", detail: JSON.stringify(c1) });
  }
  const c1Ok = !issues.some(i => i.slot === "c1_when_case");

  // C2: utterance first, pre-set second. Same order as field values, different reason — there instruction
  //   wins as fresher intent; here the fallback must not OVERRIDE what was just said.
  //   BREAKS: check the fallback first and a stored name silently redirects a different request.
  // NOTE: length caps and whole-input echoes remain the hook's post-processing job. An echo is a non-empty
  //   string, passes usableActionName, and flows into action_key.
  const fromInstruction = await safeHook(h.extractUserActionName, [instruction], () => undefined);
  let c2 = null;
  let c2_source = null;
  if (usableActionName(fromInstruction)) {
    c2 = fromInstruction;
    c2_source = "instruction";
  } else {
    const fallback = readC2Fallback(fixedPreSet);
    if (fallback !== undefined) {
      c2 = fallback;
      c2_source = "pre_set_data";
    } else {
      issues.push({ slot: "c2_user_action_name", code: "unresolved", detail: "instruction and pre-set both empty" });
    }
  }
  // NOTE: a fallback that rescues a thrown hook records no exception text — the only trace is
  //   c2_source === "pre_set_data". Watch that ratio: a rising share means the extractor is degrading
  //   behind the fallback. Deliberate cost of not asking.

  return {
    fixed: {
      c1_when_case: c1Ok ? c1 : null,
      c2_user_action_name: c2,
      c3_provider_action_name: mcpTool?.name ?? null,
      // Consumed by buildActionKey and confirmToolNameMatchesIntent. Recorded either way.
      c2_source,
    },
    issues,
  };
}

// Pick the user-facing text without naming candidates.
function intentMessage(issues) {
  const c1 = issues.some(i => i.slot === "c1_when_case");
  const c2 = issues.some(i => i.slot === "c2_user_action_name");
  if (c1 && c2) return MSG_INTENT_UNDETERMINED.both;
  return c1 ? MSG_INTENT_UNDETERMINED.c1_when_case : MSG_INTENT_UNDETERMINED.c2_user_action_name;
}

// [REQUIRED-OP] Returns one of WHEN_CASES.
// BREAKS: falling back to immediate when undecidable causes irreversible execution.
function classifyWhenCase(instruction) {
  throw new Error("not implemented");
}

// [REQUIRED-OP] Extract what the user calls this Action.
// CONTRACT: from trust === "user" segments only. c2 → action_key → the prior_state lookup key.
// NOTE: block empty strings, excessive length, and whole-input echoes in post-processing.
function extractUserActionName(instruction) {
  throw new Error("not implemented");
}

// [REQUIRED-SAFETY] Match c2 against c3. Tool existence, availability, call permission, and schema freshness also belong here.
// CONTRACT: do not throw. Return { approved, reason }. Silence is not approval.
// CONTRACT: judge C3 against what C2 asks for, not how it is spelled. The user names the act in their own
//   vocabulary and need not know the C3 name; string similarity fails them. C2 is settled on arrival —
//   Step 1-a returns above Step 1-0.
//   BREAKS: derive C2 from the Tool and the check is circular — the Tool against itself.
// POLICY (c2_source): the fallback path asks the user nothing, so this gate is the only remaining check
//   on a fallback-sourced C2. Require an exact match when fixed.c2_source === "pre_set_data".
//   Mismatch yields ask_user, which routes back to the utterance — the right place to recover.
// POLICY (learned mapping): persist a C2→C3 mapping settled in conversation ("for this user, 'send' means
//   transfer_funds") and look it up here. The judgment becomes a lookup, and repeat requests clear this
//   gate on the first attempt instead of the third.
//   BREAKS: keeping it in fixedPreSet.c2_user_action_name fails twice. C2 and C3 then derive from one
//     decision, so the comparison is the Tool against itself and always approves. And the fallback ranks
//     below the utterance, so the next differently-worded request discards it.
function confirmToolNameMatchesIntent(userActionName, mcpTool) {
  throw new Error("not implemented");
}

// 3. Provider Checklist — enforceable (inputSchema.required) vs advisory (description)
//    POLICY: annotations are server self-reported, so they stay out of the gate. Including them is the adopting system's call.
// POLICY (provider-declared conditions): moving the rules now written in description into the gate carries
//   validateFieldSchema's directional constraint — a provider declaration may block, never open. Satisfying
//   one is not grounds for known or verified.
//   Choose how it blocks: answerable by the user → unknown in the value gate. Not answerable
//   ("insufficient balance") → hold; asking cannot resolve it and re-asking only repeats.
//   BREAKS: let it open and an upstream schema edit — an always-true condition — is a fail-open switch.
// NOTE: how mcpTool was obtained is outside this skeleton — the caller hands it in, and whether the
//   schema was fetched, cached, or never arrived is not visible here.
//   What IS visible is the shape: a missing inputSchema and required: [] are not the same object.
//   The first is an incomplete tool; the second is a tool that declares it takes no arguments.
//   BREAKS: collapse both to [] and "we never got the schema" becomes indistinguishable from
//     "this tool takes no arguments" — and an empty checklist is an unconditional pass.
// [SUPERSEDED] The flat-schema helper. runPreflight reads materializeSlots instead.
//   BREAKS: an override here is ignored by the gate. createPreflight refuses that combination.
function getRequiredFields(mcpTool) {
  // Only required is gated. properties flows into ctx.fieldSchemas and is used for format validation.
  // NOTE: this schema is provider self-reported. An empty required means zero fields and unconditional pass.
  //   That is correct ONLY when the emptiness was declared. See the null return below.
  // POLICY: trusted provider lists, schema fingerprint pinning, and rug pull detection belong to the adopting system.
  //   Do not blanket-hold — tools with no arguments (list-style) legitimately exist.
  if (!mcpTool?.inputSchema) return null;   // undetermined, not zero fields. Never iterate this as a list.
  return mcpTool.inputSchema.required ?? [];
}

// ────────────────────────────────────────────────────────────────
// [SLOT MATERIALIZATION]
// Root `required` is not the slot list under JSON Schema 2020-12. The list is materialized from
// schema + what is already grounded. Supported shapes only; anything else holds.
//   root `required`                       → those fields
//   root `oneOf` of pure `required` forms → branch selected from grounded names
// ────────────────────────────────────────────────────────────────

// Constructs that change what is mandatory. Unsupported means hold, not ignore.
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  "anyOf", "allOf", "if", "then", "else", "not", "$ref",
  "dependentRequired", "dependentSchemas", "patternProperties",
];

// Keywords that constrain nothing. Present in real schemas, so a branch carrying them is still usable.
const BRANCH_ANNOTATION_KEYWORDS = new Set(["title", "description", "$comment", "default", "examples"]);

// A branch is usable only if it constrains nothing but `required`. Annotations pass; anything that adds
//   a constraint (properties, additionalProperties, nested oneOf ...) holds, because materializeSlots
//   does not read it and validatePayload may be unwired.
function readRequiredOnlyBranch(branch) {
  if (!branch || typeof branch !== "object" || Array.isArray(branch)) return null;
  const keys = Object.keys(branch);
  if (!keys.includes("required")) return null;
  if (!keys.every(k => k === "required" || BRANCH_ANNOTATION_KEYWORDS.has(k))) return null;
  const req = branch.required;
  if (!Array.isArray(req) || req.length === 0) return null;
  if (!req.every(n => typeof n === "string" && n !== "")) return null;
  return req;
}

// CONTRACT: { status: "unsupported", detail } | { status: "flat"|"branched", base, branches }
function readSchemaShape(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object") return { status: "unsupported", detail: "inputSchema missing" };
  const offending = UNSUPPORTED_SCHEMA_KEYWORDS.filter(k => k in inputSchema);
  if (offending.length) return { status: "unsupported", detail: `unsupported keyword: ${offending.join(", ")}` };

  const base = Array.isArray(inputSchema.required) ? inputSchema.required.slice() : [];
  if (!("oneOf" in inputSchema)) return { status: "flat", base, branches: null };

  if (!Array.isArray(inputSchema.oneOf) || inputSchema.oneOf.length === 0) {
    return { status: "unsupported", detail: "oneOf is not a non-empty array" };
  }
  const branches = inputSchema.oneOf.map(readRequiredOnlyBranch);
  if (branches.some(b => b === null)) {
    return { status: "unsupported", detail: "oneOf branch is not a pure required form" };
  }
  return { status: "branched", base, branches };
}

// [REQUIRED-OP] Names the lookup chain may try. A superset of the slot list: branch selection needs
//   grounded values before the list exists, and optional arguments have to be recoverable.
// POLICY: cost lives here — one instruction/measurement lookup per candidate. Narrow it freely; never widen it past
//   what the schema declares.
function getCandidateSlots(mcpTool) {
  const schema = mcpTool?.inputSchema;
  const shape = readSchemaShape(schema);
  if (shape.status === "unsupported") return null;   // undetermined, not zero fields. Never iterate this as a list.
  const names = new Set([
    ...Object.keys(schema.properties ?? {}),
    ...shape.base,
    ...(shape.branches ?? []).flat(),
  ]);
  return [...names];
}

// [REQUIRED-SAFETY] The slot set that must be settled for this invocation.
// CONTRACT: do not throw.
//   { status: "resolved", required: string[], branch: number|null }
//   { status: "branch_unresolved", options: string[][] }                      ask
//   { status: "branch_conflict",   options: string[][], matched: number[] }   ask
//   { status: "unsupported", detail }                                         hold
// NOTE: groundedFieldNames carries only names that came back known from lookupField.
//   BREAKS: a model-proposed candidate in here decides which branch is mandatory.
function materializeSlots(mcpTool, groundedFieldNames) {
  const shape = readSchemaShape(mcpTool?.inputSchema);
  if (shape.status === "unsupported") return { status: "unsupported", detail: shape.detail };
  if (shape.status === "flat") return { status: "resolved", required: shape.base, branch: null };

  const grounded = new Set(groundedFieldNames ?? []);
  const options = shape.branches;
  const complete = [];
  const partial = [];
  options.forEach((req, idx) => {
    const hits = req.filter(n => grounded.has(n)).length;
    if (hits === req.length) complete.push(idx);
    else if (hits > 0) partial.push(idx);
  });

  // oneOf means exactly one.
  if (complete.length > 1) return { status: "branch_conflict", options, matched: complete };
  const pick = complete.length === 1 ? complete[0] : (partial.length === 1 ? partial[0] : null);
  // Nothing grounded, or several branches half-grounded. Do not pick one to produce a flat unknown list.
  if (pick === null) return { status: "branch_unresolved", options };

  const required = [...new Set([...shape.base, ...options[pick]])];
  return { status: "resolved", required, branch: pick };
}

// [REQUIRED-SAFETY] Slot resolved is not the same fact as schema valid. The default checks nothing —
//   wire AJV (2020-12) here.
// CONTRACT: null if the complete argument object satisfies inputSchema, a reason string if not. Do not throw.
function validatePayload(args, inputSchema, ctx) {
  return null;
}

function getAdvisoryNotes(mcpTool) {
  // Natural language is not enforceable, so it stays out of the gate. Records and LLM context only.
  // POLICY: whether to enforce is the adopting system's call.
  return mcpTool.description ?? "";
}

// 4. Per-field lookup chain
//    The five sources decide only whether a value EXISTS. Format validation comes after (applyFieldPolicy → validateFieldSchema).
//    BREAKS: reorder and a later intent loses to an earlier one; demoting user_answer ignores the answer just given.
async function resolveField(h, fieldName, ctx) {
  const resolved_at = h.now();
  const record = await lookupField(h, fieldName, ctx);
  // BREAKS: run applyFieldPolicy here and it can set pending_at_trigger — the at_instruction gate excuses
  //   the field, and a crashed extractor gets scheduled instead of asked about.
  if (record.lookup_failed === true) return { ...record, resolved_at };

  // Hook failure and shape violation both demote to unknown.
  const out = await safeHook(h.applyFieldPolicy, [record, ctx],
    e => ({ ...record, value: undefined, status: "unknown", source: null,
            note: `field policy hook failed: ${e?.message ?? String(e)}` }));
  const settled = (out && (out.status === "known" || out.status === "unknown"))
    ? out
    : { ...record, value: undefined, status: "unknown", source: null,
        note: "field policy hook did not return a valid FieldRecord" };

  // Only known is checked. unknown is already unmet.
  if (settled.status !== "known") return { ...settled, resolved_at };
  const schemaOut = await safeHook(h.validateFieldSchema, [settled.value, ctx.fieldSchemas?.[fieldName], ctx],
    e => `validation hook failed: ${e?.message ?? String(e)}`);
  const violation = typeof schemaOut === "string" ? schemaOut : null;
  if (!violation) return { ...settled, resolved_at };
  // A format violation is a defect, not a not-yet-arrived value. Clear the pending mark so it also blocks at instruction time.
  return { ...settled, resolved_at, value: undefined, status: "unknown", source: null,
           pending_at_trigger: false,
           note: `schema violation (source ${settled.source ?? "unknown"}): ${violation}` };
}

// ────────────────────────────────────────────────────────────────
// [CORE] Never generates a value. Looks up five sources in order. If all are empty, unknown.
// NOTE: an empty source leaves no trace in the record. (This is lookup, not validation.)
//     Demotion reasons from the validation stage are written to note by resolveField.
// [LOOKUP HOOK FAILURE] A throw is not an empty source. It settles the field unknown and ends the chain:
//     instruction undefined → pre_set_data runs  /  instruction throws → pre_set_data never runs
//     measured_data undefined → prior_state runs  /  measured_data throws → prior_state never runs
//     BREAKS: bare calls let a throw escape to the backstop — one field kills the run. Falling through
//       instead hands the slot to a later source, with no trace per the NOTE above.
// NOTE: a lookup_failed field currently lands in unknown_fields and becomes ask_user. Per the
//     specification this is a definition/implementation gap — no user answer fixes a hook that threw.
//     An adopting system should route these to hold and surface them to whoever owns the hook.
// ────────────────────────────────────────────────────────────────

const LOOKUP_HOOK_FAILED = Symbol("lookup_hook_failed");
const lookupFailed = source => e => ({ [LOOKUP_HOOK_FAILED]: true, source, detail: e?.message ?? String(e) });

// BREAKS: exception text in note reaches the user via gate.unknown_fields.
function lookupFailureRecord(fieldName, failure) {
  return {
    name: fieldName, value: undefined, status: "unknown", source: null, origin_source: null,
    lookup_failed: true,
    pending_at_trigger: false,
    note: `lookup hook failed (source: ${failure.source})`,
    _diag_note: failure.detail,
  };
}
async function lookupField(h, fieldName, ctx) {
  const { userAnswers, instruction, preSetData, priorExecutionState } = ctx;
  // For the first four sources, this decision is itself the origin.
  const fresh = rec => ({ ...rec, origin_source: rec.source });

  // Source 1 — user_answer (injected on re-run after ask_user)
  // NOTE: filling userAnswers happens outside the skeleton.
  // BREAKS: LLM parsing output here makes the first source model output.
  // NOTE: a user_answer has no expiry and outranks a later measurement.
  // POLICY: invalidate on a change to what the value derived from, not on elapsed time.
  if (userAnswers && fieldName in userAnswers) {
    return fresh({ name: fieldName, value: userAnswers[fieldName], status: "known", source: "user_answer" });
  }

  // Source 2 — instruction: known only from a trusted segment with a valid span.
  //   To use a value from an untrusted segment, ask and take it back as user_answer.
  //   If instruction is a string, this entire source dies (fail-closed).
  const fromInstruction = await safeHook(h.extractFromInstruction, [fieldName, instruction],
    lookupFailed("instruction"));
  if (fromInstruction?.[LOOKUP_HOOK_FAILED]) return lookupFailureRecord(fieldName, fromInstruction);
  if (fromInstruction !== undefined) {
    const seg = instruction?.[fromInstruction?.segment_index];
    // The skeleton checks only the span's shape and bounds. Comparing the span's content against value is the adopting system's job.
    const sp = fromInstruction?.span;
    const spanValid = Array.isArray(sp) && sp.length === 2 &&
      Number.isInteger(sp[0]) && Number.isInteger(sp[1]) &&
      sp[0] >= 0 && sp[0] < sp[1] && sp[1] <= (seg?.text?.length ?? -1);
    if (seg?.trust === "user" && spanValid) {
      return fresh({ name: fieldName, value: fromInstruction.value, status: "known", source: "instruction" });
    }
  }

  // Source 3 — pre_set_data: accepted only with trust "user". A raw value without the wrapper is rejected.
  //   NOTE: old-schema input looks like every field being stuck at unknown. Check here first when migrating.
  if (preSetData && fieldName in preSetData) {
    const entry = preSetData[fieldName];
    if (entry && typeof entry === "object" && "value" in entry && entry.trust === "user") {
      return fresh({ name: fieldName, value: entry.value, status: "known", source: "pre_set_data" });
    }
  }

  // Source 4 — measured_data: accepted only when valid.
  // NOTE: the means of observation is not recorded. If this hook is LLM-based, it is not a measurement.
  const fromMeasurement = await safeHook(h.measureFromEnvironment, [fieldName, ctx],
    lookupFailed("measured_data"));
  if (fromMeasurement?.[LOOKUP_HOOK_FAILED]) return lookupFailureRecord(fieldName, fromMeasurement);
  if (fromMeasurement !== undefined && fromMeasurement.valid) {
    return fresh({ name: fieldName, value: fromMeasurement.value, status: "known", source: "measured_data" });
  }

  // Source 5 — prior_state: inherited from a previous execution.
  //   NOTE: "executed" is the ONLY condition checked here — not age, not staleness. applyFieldPolicy runs
  //     after this and is where the inheritance is refused by default.
  //   source is overwritten with prior_state, but origin_source is inherited.
  //   BREAKS: overwrite origin_source and the first source is erased, opening a laundering path.
  //   NOTE: old-schema records have origin_source undefined. Handling belongs in applyFieldPolicy.
  const fromPriorState = priorExecutionState?.execution_decision === "executed"
    ? priorExecutionState.fields?.find(f => f.name === fieldName && f.status === "known")
    : undefined;
  if (fromPriorState) {
    return { name: fieldName, value: fromPriorState.value, status: "known", source: "prior_state",
             origin_source: fromPriorState.origin_source };
  }
  // All empty → unknown.
  return { name: fieldName, value: undefined, status: "unknown", source: null, origin_source: null };
}

// [REQUIRED-SAFETY] Blocks prior_state by default (inherited values read as fresh — staleness is undetectable
//   here), passes everything else through. Carry-forward is opt-in.
// CONTRACT: do not throw. To block: { ...record, value: undefined, status: "unknown", source: null }.
//   No falling back to a later source. Set pending_at_trigger: true for an at_instruction unknown that
//   settles at trigger time — the only thing the gate excuses, and the default never sets it.
function applyFieldPolicy(record, ctx) {
  if (record.source !== "prior_state") return record;
  return { ...record, value: undefined, status: "unknown", source: null };
}

// [REQUIRED-SAFETY] The default implementation checks nothing. Unwired, there is no format validation (including type).
// CONTRACT: null if it passes, a reason string if it violates. This is where AJV or similar goes.
function validateFieldSchema(value, schema, ctx) {
  return null;
}

// [REQUIRED-OP] CONTRACT: { valid, value } or undefined (no means of observation). valid:false must never become known.
// NOTE: the return shape is not validated. A raw value arrives with valid undefined and is silently skipped.
// NOTE: undefined moves on to prior_state; a throw settles the field unknown. Do not throw for "cannot observe".
function measureFromEnvironment(fieldName, ctx) {
  if (ctx.measured_data && fieldName in ctx.measured_data) return ctx.measured_data[fieldName];
  return undefined;
}

// [REQUIRED-OP] Extract a value from the instruction (LLM). Unimplemented means every field stays unknown.
// CONTRACT: instruction is an InstructionSegment[].
//   Found → { value, segment_index, span: [start, end] }  /  not found or extraction failed → undefined
//   NOTE: undefined moves on to pre_set_data; a throw settles the field unknown. Do not throw for "not found".
//   segment_index = the segment the value came from. span = the character range within that segment's text (half-open).
//   A missing or out-of-bounds span is rejected. The skeleton checks shape and bounds only.
//   BREAKS: misreport a trusted segment and the trust check is defeated.
// POLICY: the comparison method (literal match / compare after normalization) and whether derived values
//   ("tomorrow" → a date) count as known belong to the adopting system.
//   BREAKS: with derived values, span points at supporting text rather than proving the value.
function extractFromInstruction(fieldName, instruction) {
  return undefined;
}

// 4-1. User Checklist — same principle as fields. Not verified for non-immediate work (deferred): it would be stale at trigger time.

// [REQUIRED-SAFETY] CONTRACT: do not throw, return with status filled in. Undecidable or failed → unverified.
// The default implementation does not trust the incoming status. Only what the hook actively verified is verified.
// NOTE: fields come from a schema; these are written freely by the user, so some are unverifiable in
//   principle — no source settles them, and the value gate has no ceiling. Left unverified they re-ask
//   forever, and the cause reads as a broken hook rather than an item that was never checkable.
//   POLICY: same split as the provider conditions on getRequiredFields. Answerable → unverified.
//   Not answerable → leave this logic.
function verifyUserChecklistItem(item, ctx) {
  return { ...item, status: "unverified", source: null, note: "verification hook not implemented (default)" };
}

// 5. Running preflight

// backstop — the last layer for failures that per-hook demotion cannot catch. Returns a recordable state even when something blows up.
async function runPreflight(h, input) {
  try {
    return await runPreflightInner(h, input);
  } catch (e) {
    return {
      fixed: null, action_key: null, phase: null, fields: null, advisory_notes: "",
      user_checklist: input?.userChecklist ?? [],
      unknown_count: null, unverified_checklist_count: null,
      gate: null,
      execution_decision: "hold",
      // NOTE: the internal error message is carried verbatim. Filter what reaches the user in formatReason.
      reason: `preflight error: ${e?.message ?? String(e)}`,
      timestamp: h.now(),
    };
  }
}

async function runPreflightInner(h, { userId, instruction, mcpTool, preSetData, fixedPreSet, measured_data, priorExecutionState, agentPolicy, userChecklist, userAnswers, checklistAnswers, intent_attempt, tool_attempt }) {
  const checklist = userChecklist ?? [];

  // Asks already spent on the Fixed checklist. Absent or malformed = 0.
  // NOTE: caller-supplied and the skeleton DOES read it, unlike input.tool_reselected_by_user.
  //   Direction is why: a larger value only brings "hold" forward, never produces "execute". Not a bypass.
  //   POLICY: the caller must carry it. These records have no action_key and pile under
  //     UNKEYED_RECORD_KEY, so storage cannot supply the count either.
  const attempt = Number.isInteger(intent_attempt) && intent_attempt >= 0 ? intent_attempt : 0;
  // Same rules for the Tool gate. Counted separately — see TOOL_ATTEMPT_LIMIT.
  const toolAttempt = Number.isInteger(tool_attempt) && tool_attempt >= 0 ? tool_attempt : 0;

  // Step 0: checklist id check. ABOVE every gate that talks to the user — a pure configuration defect,
  //   independent of instruction and mcpTool. Asking first makes the user restate twice for a fault
  //   present since the first call.
  //   BREAKS: no id means no key to reattach the ask_user answer to.
  //   NOTE: action_key/phase are null here (runs before Fixed). The trade for failing early: no lineage.
  const unidentified = unidentifiedChecklistIndexes(checklist);
  if (unidentified.length > 0) {
    return {
      fixed: null, action_key: null, phase: null, fields: null, advisory_notes: "", user_checklist: checklist,
      unknown_count: null, unverified_checklist_count: null,
      gate: null,   // Not a question. There is nothing for the user to answer
      execution_decision: "hold",
      reason: `checklist item without id at index: ${unidentified.join(", ")}`,
      timestamp: h.now(),
    };
  }

  // Step 1: settle Fixed. Hook failures do not throw — they come back as issues.
  //   BREAKS: move this later and later returns record no action_key, severing the lineage.
  //   fixedPreSet is passed separately from preSetData on purpose — see the FixedPreSet typedef.
  const { fixed, issues: fixedIssues } = await resolveFixedChecklist(h, instruction, mcpTool, fixedPreSet);

  // Step 1-a: intent gate. C1 and C2 share one ceiling — same remedy (restate), so separate counters would
  //   allow INTENT_ATTEMPT_LIMIT asks per slot.
  // BREAKS: drop this and an out-of-enum C1 is swallowed as deferred by Step 1-1's `!== "immediate"`.
  if (fixedIssues.length > 0) {
    const exhausted = attempt >= INTENT_ATTEMPT_LIMIT;
    return {
      fixed,                    // Recorded with nulls in the unsettled slots. Never a substituted value
      action_key: null,         // buildActionKey needs C2 — no lineage. Lands under UNKEYED_RECORD_KEY
      phase: null,              // C1 undecided means phase is undecided. Not defaulted
      fields: null,
      advisory_notes: "",
      user_checklist: checklist,
      unknown_count: null,
      unverified_checklist_count: null,
      gate: {
        // A hold that carries a gate. Distinct from the backstop's gate: null, which has no way back.
        kind: exhausted ? "intent_undetermined_exhausted" : "intent_undetermined",
        user_message: exhausted ? MSG_INTENT_EXHAUSTED : intentMessage(fixedIssues),
        // Equal to the next call's → +1. Unequal is NOT permission to reset (rule 2).
        intent_fingerprint: intentFingerprint(instruction),
        // null encodes rule 3: no value to auto-retry with.
        next_intent_attempt: exhausted ? null : attempt + 1,
        _diag: { issues: fixedIssues, attempt, limit: INTENT_ATTEMPT_LIMIT },   // Logs only — carries hook error text
      },
      // ask_user re-entry: raise intent_attempt and call again with the new instruction. Not userAnswers —
      //   C1/C2 are not required fields and have no key to attach an answer to.
      // exhausted: leave the skeleton; resolve in conversation. Re-entry is a NEW request at attempt 0.
      //   POLICY: resetting the counter every turn restores the loop this ceiling exists to stop.
      execution_decision: exhausted ? "hold" : "ask_user",
      reason: `${exhausted ? "hold" : "ask_user"}: fixed undetermined (${fixedIssues.map(i => `${i.slot}:${i.code}`).join(", ")}) attempt=${attempt}/${INTENT_ATTEMPT_LIMIT}`,
      timestamp: h.now(),
    };
  }

  // NOTE: if the same instruction is classified "scheduled" again on the trigger re-run, it waits forever.
  //   Carrying trigger context in the input so it lands on immediate is the adopting system's job.
  const phase = fixed.c1_when_case === "immediate" ? "at_trigger" : "at_instruction";

  // A key cannot be invented. On failure: action_key null, hold, and the record lands under
  //   UNKEYED_RECORD_KEY — the same fallback the fixedIssues path uses.
  //   BREAKS: unwrapped, a throw reaches the backstop as gate: null, which has no way back.
  let keyFailure = null;
  const action_key = await safeHook(h.buildActionKey, [userId, fixed],
    e => { keyFailure = e?.message ?? String(e); return null; });
  if (keyFailure !== null) {
    return {
      fixed, action_key: null, phase,
      fields: null, extra_fields: null,
      advisory_notes: "",
      user_checklist: checklist,
      unknown_count: null, unverified_checklist_count: null,
      call_arguments: null,
      gate: { kind: "action_key_failed", _diag: { detail: keyFailure } },
      execution_decision: "hold",
      reason: "hold: action_key could not be built",
      timestamp: h.now(),
    };
  }

  // [CORE] Step 1-0: Tool determination gate. Must sit above getRequiredFields/getAdvisoryNotes.
  //   The verdict is the hook's; everything around it is not. Reaching lookupField at all depends on this.
  //   BREAKS: move it lower and an undetermined Tool's required/description ride into the gate.
  // [CALLER CONTRACT] mcpTool arrives already selected; there is no selection hook here, and c3 only records
  //   mcpTool.name. Order owed by the caller: settle C2, then select the Tool from it. Selected earlier,
  //   this gate is validating a guess. A contract, not a guarantee — the gate refuses a Tool without ever
  //   learning how it was chosen.
  const matchResult = await safeHook(h.confirmToolNameMatchesIntent, [fixed.c2_user_action_name, mcpTool],
    e => ({ approved: false, reason: `hook_error: ${e?.message ?? String(e)}` }));
  // Shape is checked too. undefined and missing fields are also not approved — a hook's silence is not approval.
  const c3Approved = matchResult?.approved === true;
  const c3Reason = matchResult?.reason ?? (c3Approved ? null : "hook did not return { approved, reason }");
  // Recorded on both paths, from the same expression the gate branches on — record and decision cannot
  //   disagree. Approval used to be silent: only refusals left a trace, so "why did it run with this Tool"
  //   had no answer.
  //   BREAKS: read c3_match.approved as permission downstream and it is a bypass switch. It records what
  //     was decided here; it does not carry the decision forward.
  // NOTE: reason is the hook's text, stored verbatim in a keyed bucket. No masking hook exists.
  fixed.c3_match = { approved: c3Approved, reason: c3Reason };
  if (!c3Approved) {
    // ask_user until the ceiling. Undetermined is something to ask about, not a defect.
    // NOTE: an ask/hold choice, not a verdict on the selection. "Chose wrong" and "not yet settled" are
    //   indistinguishable here — the selection was never seen. They separate by comparing
    //   _diag.candidate_tool across attempts under one action_key, which happens outside.
    const toolExhausted = toolAttempt >= TOOL_ATTEMPT_LIMIT;
    return {
      fixed, action_key, phase,
      fields: null,
      advisory_notes: "",              // Do not carry an undetermined Tool's description
      user_checklist: checklist,       // Echo of the raw input. Not a verification result
      unknown_count: null,             //   "no decision made" is expressed by count: null
      unverified_checklist_count: null,
      gate: {
        // A hold that carries a gate, as in Step 1-a. Distinct from the backstop's gate: null.
        kind: toolExhausted ? "tool_undetermined_exhausted" : "tool_undetermined",
        user_message: toolExhausted ? MSG_TOOL_EXHAUSTED : MSG_TOOL_UNDETERMINED,
        // null means there is no value to auto-retry with.
        next_tool_attempt: toolExhausted ? null : toolAttempt + 1,
        // Logs only. A mismatch and a hook exception are operationally different signals.
        _diag: {
          candidate_tool: mcpTool?.name ?? null,
          user_action: fixed?.c2_user_action_name ?? null,
          reason: c3Reason,
          attempt: toolAttempt, limit: TOOL_ATTEMPT_LIMIT,
        },
      },
      // ask_user re-entry: raise tool_attempt and call again with a REPLACED mcpTool. The user's restatement
      //   feeds the reselection; it is not an answer to attach to a field.
      // exhausted: leave the skeleton; settle it in conversation. Re-entry is a NEW request at attempt 0.
      //   POLICY: the caller carries the count. Resetting it every turn restores the loop this ceiling stops.
      execution_decision: toolExhausted ? "hold" : "ask_user",
      reason: `${toolExhausted ? "hold" : "ask_user"}: tool undetermined (${c3Reason}) attempt=${toolAttempt}/${TOOL_ATTEMPT_LIMIT}`,
      timestamp: h.now(),
    };
  }

  // ── Everything below is reached only after the Tool is determined ───────────
  // [CALLER CONTRACT] / [ask_user re-entry] / [Re-ask ceiling] — see APPENDIX.

  // Step 2: Provider Checklist — separate enforceable from advisory
  const advisoryNotes = await h.getAdvisoryNotes(mcpTool);

  const ctx = { userAnswers, checklistAnswers, instruction, preSetData, measured_data, priorExecutionState, agentPolicy,
                phase,   // The basis for applyFieldPolicy's per-phase judgment
                fieldSchemas: mcpTool?.inputSchema?.properties ?? {} };

  // Step 2-a: candidate slots. The superset the lookup may try, not the slot list.
  let candidateFailure = null;
  const candidates = await safeHook(h.getCandidateSlots, [mcpTool],
    e => { candidateFailure = e?.message ?? String(e); return null; });
  if (!Array.isArray(candidates)) {
    // An unreadable schema is not a tool with no arguments.
    return {
      fixed, action_key, phase,
      fields: null, extra_fields: null,
      advisory_notes: advisoryNotes,
      user_checklist: checklist,
      unknown_count: null, unverified_checklist_count: null,
      call_arguments: null,
      gate: {
        kind: "schema_unsupported",
        _diag: { detail: candidateFailure ?? "getCandidateSlots returned no list" },
      },
      execution_decision: "hold",
      reason: "hold: tool input schema undetermined or unsupported",
      timestamp: h.now(),
    };
  }

  // Step 3: per-field lookup chain → Known/Unknown records. Common to both phases.
  //   BREAKS: skip it for non-immediate work and a missing value surfaces at trigger time, with nobody to ask.
  // Sequential on purpose: parallel fires one LLM/measurement call per field at once (rate limits, cost).
  const resolvedAll = [];
  for (const fieldName of candidates) resolvedAll.push(await resolveField(h, fieldName, ctx));

  // Step 3-0: materialize the slot list. Only names that came back known are handed over.
  const groundedNames = resolvedAll.filter(f => f.status === "known").map(f => f.name);
  const slotSet = await safeHook(h.materializeSlots, [mcpTool, groundedNames],
    e => ({ status: "unsupported", detail: `materializeSlots hook failed: ${e?.message ?? String(e)}` }));

  if (!slotSet || slotSet.status === "unsupported") {
    return {
      fixed, action_key, phase,
      fields: null,                 // No slot decision was made. Distinct from []
      extra_fields: resolvedAll,
      advisory_notes: advisoryNotes,
      user_checklist: checklist,
      unknown_count: null, unverified_checklist_count: null,
      call_arguments: null,
      gate: {
        kind: "schema_unsupported",
        _diag: { detail: slotSet?.detail ?? "materializeSlots returned no status",
                 lookup_failures: lookupFailures(resolvedAll) },
      },
      execution_decision: "hold",
      reason: `hold: slot list could not be materialized (${slotSet?.detail ?? "no status"})`,
      timestamp: h.now(),
    };
  }

  if (slotSet.status === "branch_unresolved" || slotSet.status === "branch_conflict") {
    // NOTE: no ceiling here, same as the value gate. See [Re-ask ceiling] in APPENDIX.
    const conflict = slotSet.status === "branch_conflict";
    return {
      fixed, action_key, phase,
      fields: null,
      extra_fields: resolvedAll,
      advisory_notes: advisoryNotes,
      user_checklist: checklist,
      unknown_count: null,          // No slot list to count against
      unverified_checklist_count: null,
      call_arguments: null,
      gate: {
        kind: conflict ? "branch_conflict" : "branch_unresolved",
        user_message: conflict ? MSG_BRANCH_CONFLICT : MSG_BRANCH_UNRESOLVED,
        branch_options: slotSet.options,   // For rendering
        _diag: { grounded: groundedNames, matched: slotSet.matched ?? null,
                 lookup_failures: lookupFailures(resolvedAll) },
      },
      execution_decision: "ask_user",
      reason: `ask_user: ${slotSet.status} (grounded=${groundedNames.length})`,
      timestamp: h.now(),
    };
  }

  // Step 3-1: partition. fields = what blocks, extra_fields = looked up but not gating.
  //   BREAKS: merge the two and an absent optional argument blocks execution.
  const byName = new Map(resolvedAll.map(f => [f.name, f]));
  const slotNames = new Set(slotSet.required);
  // A slot outside the candidate set was never looked up. Unknown, never assumed absent.
  const fields = slotSet.required.map(name => byName.get(name) ?? {
    name, value: undefined, status: "unknown", source: null, origin_source: null,
    pending_at_trigger: false, note: "slot was not in the candidate set", resolved_at: h.now(),
  });
  const extra_fields = resolvedAll.filter(f => !slotNames.has(f.name));

  // Step 3-a: non-immediate branch — values now, conditions at trigger time.
  // CONTRACT: the scheduler must re-run runPreflight with deferred_input at trigger time.
  //   Passing a deferred record straight to executeIfReady violates the contract. Non-immediate means deferred, not skipped.
  // NOTE: passing here is a preliminary decision. requiredFields is a snapshot and may differ at trigger time.
  if (phase === "at_instruction") {
    const unknownNow = fields.filter(f => f.status === "unknown");
    const blocking = unknownNow.filter(f => f.pending_at_trigger !== true);
    const pendingCount = unknownNow.length - blocking.length;

    if (blocking.length > 0) {
      // Block the scheduling itself (fail-closed). This is the last moment the user is present.
      // POLICY: can be changed to "schedule anyway, flagged unresolved" — a choice that accepts failure at trigger time.
      return {
        fixed, action_key, phase, fields, extra_fields,
        advisory_notes: advisoryNotes,
        user_checklist: checklist,        // Raw input. Not verified at this phase
        unknown_count: unknownNow.length, // Total (including pending). gate is authoritative for what blocks
        unverified_checklist_count: null, // No decision made. Not 0
        call_arguments: null,             // Assembled at trigger time only
        gate: {
          unknown_fields: blocking.map(f => ({ name: f.name, note: f.note ?? null })),
          unverified_checklist: [],       // Not performed. Not "all verified" (see count: null above)
          _diag: { phase, pending_at_trigger: pendingCount, lookup_failures: lookupFailures(fields) },
        },
        execution_decision: "ask_user",
        reason: await h.formatReason("ask_user", { unknown_fields: blocking, unverified_checklist: [] }),
        timestamp: h.now(),
      };
    }

    return {
      fixed, action_key, phase, fields, extra_fields,   // Actual decision results. For comparison at trigger time
      advisory_notes: advisoryNotes,
      user_checklist: checklist,          // Carried unverified, as things to confirm at trigger time
      unknown_count: unknownNow.length,   // Only pending remains. May not be 0
      unverified_checklist_count: null,
      call_arguments: null,               // Re-assembled at trigger time
      gate: null,                         // The gate stands only at trigger time
      execution_decision: "deferred",
      reason: `deferred: c1_when_case is "${fixed.c1_when_case}" — awaiting trigger (pending_at_trigger=${pendingCount})`,
      deferred_input: await h.buildDeferredInput({ instruction, mcpTool, preSetData, agentPolicy, userChecklist: checklist, userAnswers, checklistAnswers }),
      timestamp: h.now(),
    };
  }

  // Step 3-b: [add in the adopting system] call permission, target resource existence, call quota, duplicate-execution check.
  //   These are trigger-time realities and cannot be seen in advance at instruction time.

  // Step 4: verify the User Checklist (immediate = right before execution, so check now)
  // Hook failure and anything other than verified demote to unverified. The hook cannot erase the id.
  const finalUserChecklist = [];
  for (const item of checklist) {
    const out = await safeHook(h.verifyUserChecklistItem, [item, ctx],
      e => ({ status: "unverified", source: null, note: `checklist verification hook failed: ${e?.message ?? String(e)}` }));
    const verified = out?.status === "verified";
    finalUserChecklist.push({ ...item, ...(out ?? {}), id: item.id, status: verified ? "verified" : "unverified" });
  }

  // Step 5: tally what is unmet — both fields and checklist. advisory_notes is not tallied.
  const unknownFields = fields.filter(f => f.status === "unknown");
  const unknown_count = unknownFields.length;
  const unverifiedItems = finalUserChecklist.filter(i => i.status !== "verified");
  const unverified_checklist_count = unverifiedItems.length;

  // Step 6: assemble the call from settled values. Slots are what must be settled, arguments are what
  //   gets sent — an optional value the user stated belongs only in the second set.
  // NOTE: assumes "field name = argument key, flat object". Nested schemas are unsupported upstream.
  const call_arguments = Object.fromEntries(
    [...fields, ...extra_fields].filter(f => f.status === "known").map(f => [f.name, f.value])
  );

  // Step 6-a: gate decision. gate is authoritative, reason is a derived rendering.
  // NOTE: no per-Tool risk branching. delete_all_records and list_records pass the same gate.
  // NOTE: ctx.agentPolicy is read nowhere. Consume it or remove it.
  const gate = {
    unknown_fields: unknownFields.map(f => ({ name: f.name, note: f.note ?? null })),
    unverified_checklist: unverifiedItems.map(i => ({ id: i.id, description: i.description, note: i.note ?? null })),
    _diag: { lookup_failures: lookupFailures([...fields, ...extra_fields]), slot_branch: slotSet.branch ?? null },
  };
  const valueGateClean = gate.unknown_fields.length === 0 && gate.unverified_checklist.length === 0;

  // Step 6-b: whole-object validation. Run only on an otherwise clean gate — with unknowns outstanding
  //   the object is knowingly incomplete and the violation says nothing.
  const payloadOut = valueGateClean
    ? await safeHook(h.validatePayload, [call_arguments, mcpTool?.inputSchema, ctx],
        e => `payload validation hook failed: ${e?.message ?? String(e)}`)
    : null;
  const payload_violation = typeof payloadOut === "string" ? payloadOut : null;
  if (payload_violation) {
    // Not a question. Every slot is settled and the object is still illegal.
    gate.kind = "payload_invalid";
    gate.payload_violation = payload_violation;
  }

  const execution_decision = !valueGateClean ? "ask_user" : (payload_violation ? "hold" : "execute");

  return {
    fixed, action_key, phase, fields, extra_fields,
    advisory_notes: advisoryNotes,   // Recorded only. Not part of the gate
    user_checklist: finalUserChecklist,
    unknown_count, unverified_checklist_count,
    call_arguments,                  // The exact object executeIfReady sends
    gate,
    execution_decision,
    reason: payload_violation
      ? `hold: payload invalid — ${payload_violation}`
      : await h.formatReason(execution_decision, gate),
    timestamp: h.now(),
  };
}

// [OPTIONAL] Rendering only. Not part of the gate decision, adds no information.
function formatReason(execution_decision, gate) {
  return `${execution_decision}: unknown_fields=${gate?.unknown_fields?.length ?? 0}, unverified_checklist=${gate?.unverified_checklist?.length ?? 0}`;
}

// [OPTIONAL] POLICY: preserve = intent at instruction time (instruction/userChecklist/userAnswers).
//       re-fetch = reality at trigger time (mcpTool schema/preSetData/agentPolicy).
//       measured_data and checklistAnswers must not be preserved (stale measurements; conditions are a trigger-time decision).
// NOTE: preserving is freezing. user_answer is the first source and beats the measurement at trigger time.
//   Values that go stale should not be asked for — pass them through with pending_at_trigger.
function buildDeferredInput({ instruction, mcpTool, preSetData, agentPolicy, userChecklist, userAnswers }) {
  return { instruction, userChecklist, userAnswers };
}

/** Keep decision and recording separate, but call them as a pair so nothing goes unrecorded */
async function runPreflightAndRecord(h, input) {
  // NOTE: locking and serialization across concurrent preflight/execution on the same actionKey is the caller's responsibility.
  const executionState = await runPreflight(h, input);
  const record = await recordExecutionState(h, executionState);
  return record;
}


// 5-1. Recording Execution State — standard JSON serialization + persistence

// [REQUIRED-OP] CONTRACT: key design = the blast radius of prior_state. Treat it as an opaque string.
//   `${userId}:${c3}` reuses broadly / `${userId}:${c3}:${intent}` groups like intents / unique per run (most conservative)
// POLICY (c2_source): a fallback-sourced C2 was never confirmed against anything said in this request.
//   Narrow its blast radius — per-run key for "pre_set_data", shared key for "instruction".
//   Treated alike, a stale pre-set name inherits the baseline of a request never made.
//   Signature unchanged: existing implementations keep working, they just stop distinguishing the two.
function buildActionKey(userId, fixed) {
  throw new Error("not implemented");
}

// [CALLER CONTRACT] Call this for closed gates too, not only executions. A "hold" leaves for conversation
//   and nothing calls back in, so record before leaving or the attempt vanishes.
//   Record only the runs that reached execute and the log shows a first-try success where the user actually
//   recovered it over two refusals, and the candidate_tool comparison loses the attempts it compares.
//   A user who gives up under a repeated ask: record the last state as "failed". Abandonment is not an input
//   here — it just stops the next call — so unrecorded it looks like a resolved request, and repeat-ask
//   loops stay invisible in exactly the cases that prove them.
async function recordExecutionState(h, executionState) {
  // Records with a null action_key (failed before fixed was settled) have no lineage. Collect them under a reserved key.
  const action_key = executionState.action_key ?? null;
  const record = {
    schema_version: "1.8",   // 1.5: fixed slots may be null (unsettled). 1.6: fixed.c2_source added
    //   1.8: fixed.c3_match added. Older records record no approval, only refusals.
    //   Pre-1.6 records may carry comparison_key fields; the skeleton neither writes nor reads them.
    //   1.7: fields[] may carry lookup_failed / _diag_note; gate._diag may carry lookup_failures
    //   Readers must not assume fixed slots are strings, nor that c2_source exists on older records
    action_key,
    phase: executionState.phase ?? null,   // Instruction-time and trigger-time records accumulate under the same key
    fixed: executionState.fixed,
    fields: executionState.fields,
    advisory_notes: executionState.advisory_notes ?? "",   // Not part of the gate. Recorded for audit
    user_checklist: executionState.user_checklist,
    unknown_count: executionState.unknown_count,
    unverified_checklist_count: executionState.unverified_checklist_count ?? null,
    gate: executionState.gate ?? null,
    execution_decision: executionState.execution_decision,
    reason: executionState.reason,
    timestamp: executionState.timestamp,
    ...(executionState.deferred_input !== undefined ? { deferred_input: executionState.deferred_input } : {}),
  };

  // NOTE: there is no masking hook. fields.value is persisted verbatim (account numbers, amounts, recipients, tokens).
  //   Deferred records and deferred_input.userAnswers also sit in plaintext from instruction time until trigger.
  // CONTRACT: records accumulate under the same key. Append-only, or at minimum preserve executed separately.
  //   BREAKS: with last-write-wins, a preflight record overwrites the executed baseline.
  // [UNKEYED BUCKET POLICY] retention, capacity, and what must never be stored — see APPENDIX.
  await h.storage.persist(action_key ?? UNKEYED_RECORD_KEY, record);
  return record;
}

/**
 * Lookup for the prior_state source.
 * CONTRACT: return only the most recent executed record. Nothing else may serve as baseline. null if none.
 */
async function getPriorExecutionState(h, actionKey) {
  return await h.storage.load(actionKey);
}

// Storage port — persist/load are a pair. The "only executed is baseline" invariant spans both.
//   NOTE: the port takes an opaque key — the adapter branches on UNKEYED_RECORD_KEY itself to apply the
//     retention above. No class label is written; derive it from execution_decision + gate.kind:
//     config = gate null & hold / intent = gate.kind intent_undetermined* / internal = gate null &
//     reason starting "preflight error:".
//   NOTE: the port contract carries no integrity requirement. Append-only, access control, and masking belong in the adapter.

// 6. Execution — call the actual MCP Tool only when the gate is satisfied (execute)
// CONTRACT: pass only a record returned by recordExecutionState.
// NOTE: no re-fetch from storage, no integrity check. Hand it a hand-built object and the gate is bypassed.
// NOTE: nothing here checks that mcpTool is the tool the gate judged — compare mcpTool.name against
//   executionState.fixed.c3_provider_action_name upstream. Not an integrity concern but an MCP-management
//   one: where the agent binds a request to a server and tool, and how long that binding survives
//   re-entry (tool_reselected_by_user) and the deferred wait.
// POLICY: if decision and execution cross a trust boundary, signing/TTL/nonce belong to the adopting system.
async function executeIfReady(h, executionState, mcpTool, callMcpTool) {
  if (executionState.execution_decision !== "execute") {
    // ask_user: inject answers as userAnswers/checklistAnswers and re-run (the question text comes from gate).
    // deferred: not applicable. Reached only if the scheduler re-ran it and it became execute.
    return { status: "held", executionState };
  }

  // NOTE: there is no re-confirmation point right before execution. Judge staleness from fields[].resolved_at.
  // The payload is read from the record, never rebuilt here.
  //   BREAKS: reassembling from fields[] drops every optional argument and re-derives an object the gate
  //     never validated. No recorded payload means held.
  const args = executionState.call_arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return { status: "held", executionState };

  // Do not retry. Even when this throws, the provider side may have executed.
  // POLICY: for payments and transfers, use an idempotency key and confirm by measurement before any retry.
  let result;
  let callError = null;
  try {
    result = await callMcpTool(mcpTool.name, args);
  } catch (e) {
    callError = e;
  }

  // NOTE: the reason below bypasses formatReason and is assembled inline. Rendering should be unified.
  const finalRecord = await recordExecutionState(h, {
    ...executionState,
    execution_decision: callError ? "failed" : "executed",
    reason: callError
      ? `${executionState.reason} / call failed: ${callError?.message ?? String(callError)}`
      : `${executionState.reason} / call succeeded`,
    timestamp: h.now(),
  });

  if (callError) return { status: "failed", error: callError, executionState: finalRecord };
  return { status: "executed", result, executionState: finalRecord };
}

// 7. Assembly — hook/port injection and construction-time validation

// Hooks with no default implementation, or where no safe default exists. Missing ones make createPreflight refuse to build.
const REQUIRED_HOOKS = [
  "classifyWhenCase", "extractUserActionName", "confirmToolNameMatchesIntent",
  "extractFromInstruction", "measureFromEnvironment", "buildActionKey",
];

// Hooks that have a default implementation whose default is "do not verify". Unwired, the gate is weak.
// NOTE: applyFieldPolicy's default refuses prior_state, but still validates nothing. It stays on this list for that.
// NOTE: unwired, validatePayload lets a value that fills its slot while violating the schema through.
const UNSAFE_DEFAULT_HOOKS = ["applyFieldPolicy", "validateFieldSchema", "verifyUserChecklistItem", "validatePayload"];

const defaultHooks = {
  classifyWhenCase, extractUserActionName, confirmToolNameMatchesIntent,
  getRequiredFields, getCandidateSlots, materializeSlots, getAdvisoryNotes,
  extractFromInstruction, measureFromEnvironment,
  applyFieldPolicy, validateFieldSchema, validatePayload, verifyUserChecklistItem,
  formatReason, buildDeferredInput, buildActionKey,
};

/**
 * Build a preflight instance by injecting hooks and ports.
 * Missing required hooks, missing storage, and misspelled hook names fail at construction, not as a runtime hold.
 * With strict=true, the defaults of [REQUIRED-SAFETY] hooks (which do not verify) are also rejected.
 * If unsafeDefaults in the return value is non-empty, the gate is in a weak state.
 */
function createPreflight({ hooks = {}, storage, clock, strict = false } = {}) {
  const known = new Set(Object.keys(defaultHooks));
  const unknown = Object.keys(hooks).filter(n => !known.has(n));
  if (unknown.length) throw new Error(`createPreflight: unknown hook name — ${unknown.join(", ")}`);

  const notFn = Object.keys(hooks).filter(n => typeof hooks[n] !== "function");
  if (notFn.length) throw new Error(`createPreflight: hook is not a function — ${notFn.join(", ")}`);

  const missing = REQUIRED_HOOKS.filter(n => typeof hooks[n] !== "function");
  if (missing.length) throw new Error(`createPreflight: required hook missing — ${missing.join(", ")}`);

  if (typeof storage?.persist !== "function" || typeof storage?.load !== "function") {
    throw new Error("createPreflight: storage.persist / storage.load required");
  }
  if (clock !== undefined && typeof clock !== "function") {
    throw new Error("createPreflight: clock must be a function (returning an ISO string)");
  }

  // Migration guard. An override left on getRequiredFields would be ignored by the gate.
  if (typeof hooks.getRequiredFields === "function" && typeof hooks.materializeSlots !== "function") {
    throw new Error(
      "createPreflight: getRequiredFields no longer feeds the gate. Move that logic into " +
      "materializeSlots(mcpTool, groundedFieldNames), and widen getCandidateSlots if it probed extra names."
    );
  }

  const unsafeDefaults = UNSAFE_DEFAULT_HOOKS.filter(n => typeof hooks[n] !== "function");
  if (strict && unsafeDefaults.length) {
    throw new Error(`createPreflight(strict): defaults not permitted — ${unsafeDefaults.join(", ")}`);
  }

  const h = { ...defaultHooks, ...hooks, storage, now: clock ?? (() => new Date().toISOString()) };

  return {
    runPreflight: input => runPreflight(h, input),
    runPreflightAndRecord: input => runPreflightAndRecord(h, input),
    executeIfReady: (state, mcpTool, callMcpTool) => executeIfReady(h, state, mcpTool, callMcpTool),
    recordExecutionState: state => recordExecutionState(h, state),
    getPriorExecutionState: actionKey => getPriorExecutionState(h, actionKey),
    unsafeDefaults,
  };
}

module.exports = { createPreflight, defaultHooks, intentFingerprint };


/* ============================================================================
 * [APPENDIX] Decision path — top to bottom. Early exits take precedence.
 *
 * Instruction (array of trust-labeled segments)
 *      ▼
 * Step 0. checklist id check ────────► "hold" (config defect — before any question is asked)
 *      ▼
 * Step 1. resolveFixedChecklist
 *      │ └─ Extract C1 (When/Case), C2 (User Action Name); C3 = mcpTool.name
 *      │    C2: instruction → fixedPreSet fallback (the fallback must not override the utterance)
 *      │    C1: no fallback. It sets phase and irreversibility — utterance only
 *      │    Hook throw / C1 out of enum / C2 empty → an issue. Unsettled slots stay null, never substituted
 *      ▼
 * Step 1-a. intent gate  [issues > 0]
 *      ├─ [attempt <  2] ────────────────► "ask_user" (kind: intent_undetermined)
 *      │                                    └─ next_intent_attempt = attempt+1; re-call with it
 *      └─ [attempt >= 2] ────────────────► "hold"     (kind: intent_undetermined_exhausted)
 *                                           └─ next_intent_attempt = null. No auto re-entry; resolve in
 *                                              conversation. Carry-forward is default, reset needs a
 *                                              new-request signal (see POLICY).
 *      ▼
 * Step 1-b. buildActionKey(userId, fixed) → action_key
 *      └─ throws ────────────────────────► "hold" (kind: action_key_failed)
 *      │ └─ Both the record key and the prior_state lookup key. It sets the blast radius.
 *      ▼
 * Step 1-c. confirmToolNameMatchesIntent
 *      ├─ [approved !== true, tool_attempt <  2] ► "ask_user" (kind: tool_undetermined)
 *      │                                    └─ next_tool_attempt = attempt+1; reselect mcpTool, re-call
 *      ├─ [approved !== true, tool_attempt >= 2] ► "hold"     (kind: tool_undetermined_exhausted)
 *                                           └─ next_tool_attempt = null. Settle the Tool in conversation.
 *      ▼
 * Step 1-1. phase = (c1 === "immediate") ? at_trigger : at_instruction
 *      ▼
 * Step 2-a. getCandidateSlots → the superset the lookup may try (declared properties ∪ every branch's required)
 *      └─ not a list ────────────────────► "hold" (kind: schema_unsupported)
 *      ▼
 * Step 2-3. resolveField per candidate                      ← common to both phases
 *      │ └─ lookupField walks five sources → all empty means "unknown"
 *      │    an instruction/measurement hook that THROWS settles unknown on the spot — no later source,
 *      │    no applyFieldPolicy
 *      │    (known then goes applyFieldPolicy → validateFieldSchema; a violation demotes to unknown)
 *      ▼
 * Step 3-0. materializeSlots(mcpTool, groundedNames)  ← grounded = came back known, nothing else
 *      ├─ unsupported ──────────────────► "hold"     (kind: schema_unsupported)
 *      ├─ branch_unresolved / conflict ─► "ask_user" (carries branch_options, no unknown_fields)
 *      └─ resolved → fields = the slot set, extra_fields = everything else that was looked up
 *      ▼
 * Step 3-a. [at_instruction] values now, conditions at trigger
 *      │ └─ blocking = unknowns not marked pending_at_trigger
 *      ├─ [blocking > 0] ────────────────► "ask_user" (ask before scheduling)
 *      ├─ [blocking = 0] ────────────────► "deferred" (+ fields, deferred_input)
 *      ▼  (below: at_trigger only)
 * Step 4. verifyUserChecklistItem (at_trigger only — conditions must be judged now)
 *      │ └─ anything other than status === "verified" becomes "unverified"
 *      ▼
 * Step 5-6. gate tally → assemble call_arguments (fields ∪ extra_fields, known only) → validatePayload
 *      ├─ [unknown 0 AND unverified 0, payload valid] ──► "execute" ─► executeIfReady ─► record "executed"
 *      ├─ [unknown 0 AND unverified 0, payload invalid] ► "hold"     (kind: payload_invalid)
 *      └─ [otherwise] ──────────────────────────────────► "ask_user"
 *      NOTE: executeIfReady sends call_arguments verbatim. It never rebuilds the payload.
 *
 * Feedback: only executed records become the baseline for prior_state on the next run.
 * Exception: a throw at any step is caught by runPreflight's backstop as "hold".
 *
 * POLICY (do NOT store): the raw instruction.
 *   BREAKS: stored, every ambiguous utterance accumulates in plaintext. 
 *
 * Background: turning forms into natural language erased the provenance of values, so there is no
 *       way to decide when to ask. This resembles a validator (Pydantic), except that questions about
 *       intent and context come first, and blanks are never filled without provenance.
 *       unknown is not the model's self-report; it is what remains after all five sources were checked.
 *       What the three states distinguish is whether the check happened, not whether the requirement is met.
 *
 * Principles: Separation → Validation → Enforcement → Traceability
 *   Separation   trust-labeled segments; fixed checklist (C1/C2/C3) kept apart from value lookup
 *   Validation   lookupField → applyFieldPolicy → validateFieldSchema
 *   Binding      gate → execution_decision → executeIfReady (the record is read, not re-derived)
 *   Traceability source / origin_source / recordExecutionState
 *
 * - Position:   sits in front of a validator (Pydantic)
 * - Design:     intent and context are judged by fixed, tool-independent questions (guarding against unrequested execution)
 * - Data:       lookup, not generation. All empty means unknown
 * - Slots:      materialized from schema + already-grounded state. Root required[] is one case of that, not the rule
 * - Payload:    slots are what must be settled, arguments are what gets sent. Four separate facts:
 *               where values may come from / what must be settled / whether it was settled from a
 *               permitted source / whether the whole object is legal
 * - Input:      only inputs carrying a trust label can produce known (both instruction and pre-set data)
 *               same for the C2 fallback: wrapper plus trust "user", never a raw string
 *               values from the instruction must name their coordinates via a span within a segment; unnamed means rejected
 * - Inheritance: the first source is never erased by any path
 *               prior_state inherits on "executed" alone; the default refuses it, allowing it is the adopting system's
 * - Timing:     values at instruction time, conditions at trigger time. Only values that cannot be asked for now get pending_at_trigger
 * - Decision:   if even one unknown remains, do not execute — record instead
 * - Execution:  reference only recorded state. A hook failure is not a pass; it is unmet
 * ============================================================================
 */
