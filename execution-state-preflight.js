/**
 * ============================================================================
 * [Execution State Preflight Architecture] — a verification skeleton that runs
 * before an MCP Tool call.
 *
 * Premise: Tool selection accuracy never reaches 100%. The remainder contains
 * transfers, deletions, and sends. Accuracy and containment are sequential, not
 * alternative — containment does not become unnecessary as accuracy improves.
 * This skeleton does not improve selection. It keeps a wrong one out of execution.
 *
 * Two places are [CORE].
 *   lookupField — walks five sources, never generates a value, unknown when empty.
 *     Self-contained and deterministic: same input, same record.
 *   Step 1-0 Tool gate — the one judgment this skeleton cannot make itself. The
 *     verdict is delegated to a hook; placement, fail-closed default, ceiling, and
 *     record are not.
 * Everything else exists so that neither can be bypassed.
 * This file is a specification. Layer boundaries are not prescribed.
 * Background, decision path, and principles are in the [APPENDIX] at the bottom.
 *
 * Hook grades = [REQUIRED-OP]     absent → cannot run
 *               [REQUIRED-SAFETY] runs, but verification is disabled
 *               [OPTIONAL]        default is safe
 * Prefixes = "CONTRACT:" what the hook must honor
 *            "POLICY:"   what the adopting system decides
 *            "NOTE:"     what the skeleton does not do
 *            "BREAKS:"   what happens if you remove or change this
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
 *   // NOTE: no staleness slot. See [TIER 4 STALENESS] on applyFieldPolicy.
 * @property {boolean} [lookup_failed]  // A tier 1/3 hook threw. Set by lookupField only. See [LOOKUP HOOK FAILURE]
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
 *           |"intent_undetermined"|"intent_undetermined_exhausted"} [kind]
 *   // Omitted means value_gate (the original shape).
 *   // intent_undetermined*: C1/C2 could not be settled. Carries user_message, never unknown_fields
 *   //   (requiredFields is not even read yet at that point).
 * @property {{name: string, note: string|null}[]} [unknown_fields]        // Absent on tool_undetermined
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
 *   // of preSetData: tier 2 reads every key there, so a reserved key would collide with a same-named field.
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
 * @property {FieldRecord[]|null} fields  // null if no decision was made — distinct from [] ("computed, came out empty")
 * @property {string} advisory_notes    // Provider description — recorded only, not part of the gate
 * @property {UserChecklistItem[]} user_checklist
 * @property {number|null} unknown_count  // null if no decision was made — distinct from 0 (all known)
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
//      invalidation basis anywhere in this file — see tier 0).
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

// C2 fallback. Tier 2's acceptance conditions: wrapper shape plus trust "user".
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
function getRequiredFields(mcpTool) {
  // Only required is gated. properties flows into ctx.fieldSchemas and is used for format validation.
  // NOTE: this schema is provider self-reported. An empty required means zero fields and unconditional pass.
  // POLICY: trusted provider lists, schema fingerprint pinning, and rug pull detection belong to the adopting system.
  //   Do not blanket-hold — tools with no arguments (list-style) legitimately exist.
  return mcpTool.inputSchema?.required ?? [];
}

function getAdvisoryNotes(mcpTool) {
  // Natural language is not enforceable, so it stays out of the gate. Records and LLM context only.
  // POLICY: whether to enforce is the adopting system's call.
  return mcpTool.description ?? "";
}

// 4. Per-field lookup chain
//    The five tiers decide only whether a value EXISTS. Format validation comes after (applyFieldPolicy → validateFieldSchema).
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
// NOTE: an empty tier leaves no trace in the record. (This is lookup, not validation.)
//     Demotion reasons from the validation stage are written to note by resolveField.
// [LOOKUP HOOK FAILURE] A throw is not an empty tier. It settles the field unknown and ends the chain:
//     tier 1 undefined → tier 2 runs  /  tier 1 throws → tier 2 never runs
//     tier 3 undefined → tier 4 runs  /  tier 3 throws → tier 4 never runs
//     BREAKS: bare calls let a throw escape to the backstop — one field kills the run. Falling through
//       instead hands the slot to a lower tier, with no trace per the NOTE above.
// ────────────────────────────────────────────────────────────────

const LOOKUP_HOOK_FAILED = Symbol("lookup_hook_failed");
const lookupFailed = tier => e => ({ [LOOKUP_HOOK_FAILED]: true, tier, detail: e?.message ?? String(e) });

// BREAKS: exception text in note reaches the user via gate.unknown_fields.
function lookupFailureRecord(fieldName, failure) {
  return {
    name: fieldName, value: undefined, status: "unknown", source: null, origin_source: null,
    lookup_failed: true,
    pending_at_trigger: false,
    note: `lookup hook failed (tier: ${failure.tier})`,
    _diag_note: failure.detail,
  };
}
async function lookupField(h, fieldName, ctx) {
  const { userAnswers, instruction, preSetData, priorExecutionState } = ctx;
  // For tiers 0–3, this decision is itself the first source.
  const fresh = rec => ({ ...rec, origin_source: rec.source });

  // Tier 0: user answer (injected on re-run after ask_user)
  // NOTE: filling userAnswers happens outside the skeleton.
  // BREAKS: LLM parsing output here makes the top tier model output.
  // NOTE: a user_answer has no expiry and outranks a later measurement.
  // POLICY: invalidate on a change to what the value derived from, not on elapsed time.
  if (userAnswers && fieldName in userAnswers) {
    return fresh({ name: fieldName, value: userAnswers[fieldName], status: "known", source: "user_answer" });
  }

  // Tier 1: instruction — known only from a trusted segment with a valid span.
  //   To use a value from an untrusted segment, ask and take it back as user_answer.
  //   If instruction is a string, this entire tier dies (fail-closed).
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

  // Tier 2: pre-set data — accepted only with trust "user". A raw value without the wrapper is rejected.
  //   NOTE: old-schema input looks like every field being stuck at unknown. Check here first when migrating.
  if (preSetData && fieldName in preSetData) {
    const entry = preSetData[fieldName];
    if (entry && typeof entry === "object" && "value" in entry && entry.trust === "user") {
      return fresh({ name: fieldName, value: entry.value, status: "known", source: "pre_set_data" });
    }
  }

  // Tier 3: measurement — accepted only when valid.
  // NOTE: the means of observation is not recorded. If this hook is LLM-based, it is not a measurement.
  const fromMeasurement = await safeHook(h.measureFromEnvironment, [fieldName, ctx],
    lookupFailed("measured_data"));
  if (fromMeasurement?.[LOOKUP_HOOK_FAILED]) return lookupFailureRecord(fieldName, fromMeasurement);
  if (fromMeasurement !== undefined && fromMeasurement.valid) {
    return fresh({ name: fieldName, value: fromMeasurement.value, status: "known", source: "measured_data" });
  }

  // Tier 4: prior Execution State.
  //   NOTE: "executed" is the ONLY condition checked here — not age, not staleness. applyFieldPolicy runs
  //     after this and is the only place the inheritance can still be refused ([TIER 4 STALENESS]).
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

// [REQUIRED-SAFETY] The default implementation passes everything through. Coercion and domain rules only.
// CONTRACT: do not throw. To block: { ...record, value: undefined, status: "unknown", source: null, note }
//   No falling back to a lower tier. record.source lets you express per-source policies.
// CONTRACT (phase): if an at_instruction unknown will be settled at trigger time, set pending_at_trigger: true
//   (e.g. balance, current time). This mark is the only thing the gate excuses.
//   The default implementation never sets it → without your own, every unknown becomes a question at instruction time.
//   BREAKS: an over-asked answer freezes as tier 0 and beats the measurement at trigger time.
// [TIER 4 STALENESS] — POLICY, not contract. A gap statement, not a feature.
//   Tier 4 inherits an executed value unconditionally; nothing above notices if it is a year old.
//   resolved_at cannot detect it either — resolveField stamps the LOOKUP, so inherited values read as fresh.
//   This hook is the only place staleness can be caught, and its default catches nothing.
//   A design here needs at minimum:
//     - a comparable projection of value (a bucket, not the value), compared against the prior record
//     - a version on that projection, compared FIRST — mismatch is void, not equal
//     - a procedure answering "same bucket?", never "does this change matter?"
//   BREAKS: skip it and a stale prior_state value satisfies the gate and gets executed.
//   NOTE: comparison_key / comparison_key_version were removed from FieldRecord — a declared slot the
//     skeleton never reads reads as a guarantee. Put any equivalent in record.note or your own type.
function applyFieldPolicy(record, ctx) {
  return record;
}

// [REQUIRED-SAFETY] The default implementation checks nothing. Unwired, there is no format validation (including type).
// CONTRACT: null if it passes, a reason string if it violates. This is where AJV or similar goes.
function validateFieldSchema(value, schema, ctx) {
  return null;
}

// [REQUIRED-OP] CONTRACT: { valid, value } or undefined (no means of observation). valid:false must never become known.
// NOTE: the return shape is not validated. A raw value arrives with valid undefined and is silently skipped.
// NOTE: undefined moves on to tier 4; a throw settles the field unknown. Do not throw for "cannot observe".
function measureFromEnvironment(fieldName, ctx) {
  if (ctx.measured_data && fieldName in ctx.measured_data) return ctx.measured_data[fieldName];
  return undefined;
}

// [REQUIRED-OP] Extract a value from the instruction (LLM). Unimplemented means every field stays unknown.
// CONTRACT: instruction is an InstructionSegment[].
//   Found → { value, segment_index, span: [start, end] }  /  not found or extraction failed → undefined
//   NOTE: undefined moves on to tier 2; a throw settles the field unknown. Do not throw for "not found".
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

  const action_key = await h.buildActionKey(userId, fixed);

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
  const requiredFields = await h.getRequiredFields(mcpTool);
  const advisoryNotes = await h.getAdvisoryNotes(mcpTool);

  // Step 3: per-field lookup chain → Known/Unknown records (enforceable only). Common to both phases.
  //   BREAKS: skip it for non-immediate work and a missing value surfaces at trigger time, with nobody to ask.
  const ctx = { userAnswers, checklistAnswers, instruction, preSetData, measured_data, priorExecutionState, agentPolicy,
                phase,   // The basis for applyFieldPolicy's per-phase judgment
                fieldSchemas: mcpTool?.inputSchema?.properties ?? {} };
  // Sequential on purpose: parallel fires one LLM/measurement call per field at once (rate limits, cost).
  const fields = [];
  for (const fieldName of requiredFields) fields.push(await resolveField(h, fieldName, ctx));

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
        fixed, action_key, phase, fields,
        advisory_notes: advisoryNotes,
        user_checklist: checklist,        // Raw input. Not verified at this phase
        unknown_count: unknownNow.length, // Total (including pending). gate is authoritative for what blocks
        unverified_checklist_count: null, // No decision made. Not 0
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
      fixed, action_key, phase, fields,   // Actual decision results. For comparison at trigger time
      advisory_notes: advisoryNotes,
      user_checklist: checklist,          // Carried unverified, as things to confirm at trigger time
      unknown_count: unknownNow.length,   // Only pending remains. May not be 0
      unverified_checklist_count: null,
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

  // Step 6: gate decision. gate is authoritative, reason is a derived rendering.
  // NOTE: no per-Tool risk branching. delete_all_records and list_records pass the same gate.
  // NOTE: ctx.agentPolicy is read nowhere. Consume it or remove it.
  const gate = {
    unknown_fields: unknownFields.map(f => ({ name: f.name, note: f.note ?? null })),
    unverified_checklist: unverifiedItems.map(i => ({ id: i.id, description: i.description, note: i.note ?? null })),
    _diag: { lookup_failures: lookupFailures(fields) },
  };
  const execution_decision =
    gate.unknown_fields.length === 0 && gate.unverified_checklist.length === 0 ? "execute" : "ask_user";

  return {
    fixed, action_key, phase, fields,
    advisory_notes: advisoryNotes,   // Recorded only. Not part of the gate
    user_checklist: finalUserChecklist,
    unknown_count, unverified_checklist_count,
    gate,
    execution_decision,
    reason: await h.formatReason(execution_decision, gate),
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
// NOTE: preserving is freezing. user_answer is tier 0 and beats the measurement at trigger time.
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
 * Lookup for tier 4 of the chain.
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
  // NOTE: assumes "field name = argument key, flat object". Breaks on nested schemas and key-mapping Tools.
  const args = Object.fromEntries(executionState.fields.map(f => [f.name, f.value]));

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
// BREAKS: the default applyFieldPolicy makes tier 4 staleness undetectable ([TIER 4 STALENESS]).
//   A config error, not a safe default. Use strict, or accept unconditional inheritance knowingly.
const UNSAFE_DEFAULT_HOOKS = ["applyFieldPolicy", "validateFieldSchema", "verifyUserChecklistItem"];

const defaultHooks = {
  classifyWhenCase, extractUserActionName, confirmToolNameMatchesIntent,
  getRequiredFields, getAdvisoryNotes, extractFromInstruction, measureFromEnvironment,
  applyFieldPolicy, validateFieldSchema, verifyUserChecklistItem,
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
 * Step 2-3. getRequiredFields → resolveField per field      ← common to both phases
 *      │ └─ lookupField walks five tiers → all empty means "unknown"
 *      │    a tier 1/3 hook that THROWS settles unknown on the spot — no lower tier, no applyFieldPolicy
 *      │    (known then goes applyFieldPolicy → validateFieldSchema; a violation demotes to unknown)
 *      ▼
 * Step 3-a. [at_instruction] values now, conditions at trigger
 *      │ └─ blocking = unknowns not marked pending_at_trigger
 *      ├─ [blocking > 0] ────────────────► "ask_user" (ask before scheduling)
 *      ├─ [blocking = 0] ────────────────► "deferred" (+ fields, deferred_input)
 *      ▼  (below: at_trigger only)
 * Step 4. verifyUserChecklistItem (at_trigger only — conditions must be judged now)
 *      │ └─ anything other than status === "verified" becomes "unverified"
 *      ▼
 * Step 5-6. gate tally
 *      ├─ [unknown 0 AND unverified 0] ──► "execute" ─► executeIfReady ─► record "executed"
 *      └─ [otherwise] ───────────────────► "ask_user"
 *
 * Feedback: only executed records become the baseline for tier 4 (prior_state) on the next run.
 * Exception: a throw at any step is caught by runPreflight's backstop as "hold".
 *
 * ── [CALLER CONTRACT] for whoever calls runPreflight ─────────────────────────────────────────
 * Decide execution by an allow condition:
 *     if (executionState.execution_decision !== "execute") return;   // correct
 *     if (result.unknown_count > 0) { ... }                          // wrong
 *   BREAKS: used as a block condition, null > 0 === false lets the not-yet-computed state through.
 *
 * [ask_user re-entry] The answer to tool_undetermined is not userAnswers — replace mcpTool and call again.
 *   Re-running the hook on the reselected Tool loops the question forever, so the adopting system sets a
 *   flag in the input. The skeleton does not read it (it would become a bypass switch). Only the name is
 *   fixed: input.tool_reselected_by_user.
 *
 * [Re-ask ceiling] The intent and Tool gates carry their own ceilings (INTENT_ATTEMPT_LIMIT,
 *   TOOL_ATTEMPT_LIMIT); the caller only carries the counters forward. The value_gate has none — when the
 *   same field is asked repeatedly under one action_key, hold after a ceiling of your own.
 *
 * ── [UNKEYED BUCKET POLICY] for whoever writes the storage adapter ───────────────────────────
 * UNKEYED_RECORD_KEY only. Retention here may differ from keyed buckets: append-only exists to protect the
 *   executed baseline, and this bucket holds none — getPriorExecutionState never reads it (tier 4 looks up
 *   by action_key). Write-only audit material.
 *   BREAKS: apply this retention to a keyed bucket and you delete the baseline tier 4 needs.
 *
 * Who lands here (all return before action_key exists):
 *   config   — checklist item without id (Step 0)
 *   intent   — fixed undetermined: both the ask_user and the exhausted hold (Step 1-a)
 *   internal — runPreflight backstop
 *   No class label is written; derive it from execution_decision + gate.kind (see the storage port note).
 *
 * POLICY (retention) — the adapter implements this; the skeleton only writes:
 *   config, intent → 14 days. Tuning material, short useful life.
 *   internal       → 90 days, or forward to error tracking and keep out of here. Bugs, not user behavior.
 *   gate._diag     → strip after 7 days, keep the rest. Raw hook exception text, already never-expose.
 *                    fields[]._diag_note is the same class but sits in KEYED buckets — same schedule.
 *   capacity       → cap and evict oldest-first, on top of expiry. The intent gate writes up to
 *                    INTENT_ATTEMPT_LIMIT + 1 records per request and a bad client repeats without bound.
 *
 * POLICY (do NOT store): the raw instruction, even for debugging. gate.intent_fingerprint is already there
 *   and repeated failures on one utterance show up by comparing fingerprints — the actual signal. Reading
 *   the utterance is an exceptional investigation; put it behind a separate approval path.
 *   BREAKS: stored, every ambiguous utterance accumulates in plaintext — weakest retention, no masking hook.
 *
 * Background: turning forms into natural language erased the provenance of values, so there is no
 *       way to decide when to ask. This resembles a validator (Pydantic), except that questions about
 *       intent and context come first, and blanks are never filled without provenance.
 *       unknown is not the model's self-report; it is what remains after all five sources were checked.
 *
 * Principles: Separation → Validation → Enforcement → Traceability
 *   Separation   trust-labeled segments; fixed checklist (C1/C2/C3) kept apart from value lookup
 *   Validation   lookupField → applyFieldPolicy → validateFieldSchema
 *   Enforcement  gate → execution_decision → executeIfReady
 *   Traceability source / origin_source / recordExecutionState
 *
 * - Position:   sits in front of a validator (Pydantic)
 * - Design:     intent and context are judged by fixed, tool-independent questions (guarding against unrequested execution)
 * - Data:       lookup, not generation. All empty means unknown
 * - Input:      only inputs carrying a trust label can produce known (both instruction and pre-set data)
 *               same for the C2 fallback: wrapper plus trust "user", never a raw string
 *               values from the instruction must name their coordinates via a span within a segment; unnamed means rejected
 * - Inheritance: the first source is never erased by any path
 *               tier 4 inherits on "executed" alone; refusing a stale one is the adopting system's
 * - Timing:     values at instruction time, conditions at trigger time. Only values that cannot be asked for now get pending_at_trigger
 * - Decision:   if even one unknown remains, do not execute — record instead
 * - Execution:  reference only recorded state. A hook failure is not a pass; it is unmet
 * ============================================================================
 */
