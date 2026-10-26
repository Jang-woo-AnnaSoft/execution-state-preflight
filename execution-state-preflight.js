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
 * @property {"known"|"unknown"|"null"} status
 *   // "null" (a string, never JS null): every permitted source reported nothing and no route remains
 *   //   (5.1). Written by the gate from lookup_trace, never accepted from a hook. Not counted as unknown;
 *   //   a required slot that is "null" is unmet (6.3), and a "null" value is never sent to the tool.
 * @property {"instruction"|"pre_set_data"|"measured_data"|"user_answer"|null} source
 *   // prior_state never appears: inheritance alone does not settle a slot (5.2).
 * @property {"instruction"|"pre_set_data"|"measured_data"|"user_answer"|null} [origin_source]
 *   // The first source. prior_state can never appear here (it inherits).
 * @property {boolean} [pending_at_trigger]
 *   // Marks "unknown is correct now, will be settled at trigger time". Only applyFieldPolicy sets it.
 *   // It excuses a field only at the at_instruction gate. At at_trigger, unknown is unmet without exception.
 *   // NOTE: no staleness slot. prior_state never settles a slot (5.2); see Source 5 in lookupField.
 * @property {boolean} [lookup_failed]  // The instruction or measurement hook threw. Set by lookupField only.
 *                                       //   See [LOOKUP HOOK FAILURE]
 * @property {string} [_diag_note]      // Hook exception text. Logs only — never copied into note
 * @property {string} [note]
 * @property {string} resolved_at
 * @property {string[]} allowed_sources // Which of the five 5.2 sources this slot may consult (getAllowedSources)
 * @property {{source: string, result: "found"|"absent"|"no_place"|"no_report"|"cannot_answer"|"rejected"|"failed"|"candidate"}[]} lookup_trace
 *   // Every source the gate consulted for this slot, in order, and what came back (5.2: a source
 *   //   that was checked stays on the record). A source not in allowed_sources is not consulted and
 *   //   not listed; the chain stops at the first "found", so later sources are not listed either.
 *   //   absent         the hook checked and reports the value is not there ({ none: "absent" }) — a
 *   //                  report of nothing (5.2, 6.2). Recorded; does not settle the slot or end the chain
 *   //   no_place       the hook reports there is no place to check ({ none: "no_place" }) — a gap in
 *   //                  the declaration (5.1, 4.5c)
 *   //   no_report      nothing came back — NOT a report of nothing. The source was not checked (5.2).
 *   //                  Also what an absent key in userAnswers / preSetData / a prior record gives; see
 *   //                  [REPORTING NOTHING]
 *   //   cannot_answer  the source said it could not answer (measured_data valid:false). Not a
 *   //                  confirmation of "nothing" either (5.1)
 *   //   rejected       something came back and the gate refused it (untrusted segment, span that does
 *   //                  not state the value, pre-set entry without trust "user")
 *   //   failed         the hook threw (lookup_failed)
 *   //   candidate      prior_state held a value. Not a confirmation: the slot stays unknown and the
 *   //                  value waits on the user (prior_candidate, 5.2)
 *   //   Written by the gate, never by a hook: resolveField re-attaches it after applyFieldPolicy.
 * @property {boolean} [derived]       // The value was computed from the span plus other inputs, not stated
 * @property {Object[]} [derived_from]  // Every other input a derived value rests on, as the gate verified it:
 *   //   { source: "instruction", segment_index, span, text } | { source: "measured_data", name, value }
 * @property {{value: *, origin_source: string|null, action_key: string|null}} [prior_candidate]
 *   // Present on an unknown slot whose prior_state held a value. Shown with the question; confirmed only
 *   //   by coming back as user_answer.
 * @property {"ask_user"|"system_lookup"|"definition_repair"|null} route
 *   // 4.5 route for an UNKNOWN slot, recorded on the slot (6.3). null on known slots.
 *   //   Computed by routeFor from allowed_sources and lookup_trace, never chosen by a model or a hook:
 *   //   a hook that threw or a no_place report → definition_repair (4.5c); user_answer permitted and the
 *   //   user has not said "none" → ask_user (4.5a); a measurement still open → system_lookup (4.5b);
 *   //   anything else left open → definition_repair.
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
 *           |"action_key_failed"|"lookup_failed"|"system_lookup"|"definition_repair"|"unmet"|"exhausted"} [kind]
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
 *   // Each FieldRecord carries allowed_sources: which of the five 5.2 sources were permitted for
 *   // that slot. The route for an unknown follows from it (4.5), and it is on known records too.
 * @property {FieldRecord[]|null} [extra_fields]
 *   // Looked up through the same chain but outside the slot set: optional arguments, and values that
 *   // grounded a branch. Never counted by the gate; eligible for call_arguments when known.
 * @property {Object|null} [call_arguments]
 *   // The object executeIfReady would send, assembled from settled (known) values only. null on the
 *   //   early returns and on deferred, where no slot set was judged. On the value gate it is assembled
 *   //   whatever the decision — a hold or an ask still carries the partial object for the record.
 *   //   What stops it being sent is the decision: executeIfReady sends it only on "execute".
 * @property {string} advisory_notes    // Provider description — recorded only, not part of the gate
 * @property {UserChecklistItem[]} user_checklist
 * @property {Object[]|null} [provider_checklist]
 *   // The provider's declared conditions, each with its label and the route it took. The gated half
 *   // of the provider checklist; advisory_notes is the half that is only recorded.
 *   // Statuses: checked | unmet | unverified | pending_on_slot | disclosure_required.
 *   // There is no "verified" here — see [PROVIDER CONDITIONS].
 * @property {number|null} unknown_count  // Over fields (slots) only. extra_fields are never counted.
 *   // null if no decision was made — distinct from 0 (all known)
 * @property {number|null} unverified_checklist_count
 * @property {number|null} unverified_provider_count
 *   // Provider conditions not compared. pending_on_slot and disclosure_required are not counted.
 * @property {GateResult|null} gate     // The authoritative decision. Consumers read this, not reason.
 * @property {"execute"|"ask_user"|"system_lookup"|"definition_repair"|"exhausted"|"hold"|"deferred"|"executed"|"failed"} execution_decision
 *   // deferred: the normal wait for non-immediate work (distinct from hold). Only "executed" counts as baseline.
 *   // On the value gate, hold means what 4.5 means by it: the check FINISHED and its result prohibits
 *   //   (unmet, payload_invalid). system_lookup and definition_repair are routes still open (4.5b, 4.5c)
 *   //   and are not hold — 4.5: "a finished check" and "a missing check" merged lose where the work goes.
 *   // exhausted: the remaining blanks are on routes that reached their ceiling — intent/tool asks, or
 *   //   the value gate's ask_user / system_lookup (createPreflight limits). Finished, not prohibited.
 *   // The early returns (config defect, action_key, schema_unsupported, backstop) are definition_repair.
 * @property {Object} [deferred_input]  // Present only on deferred records — the input for re-running at trigger time
 * @property {string} reason            // A derived rendering. gate is authoritative.
 * @property {string} timestamp
 */


// 1-1. Skeleton defenses — "hooks must not throw" is a contract, not a guarantee.
const WHEN_CASES = ["immediate", "scheduled", "conditional", "recurring"];
// The five sources of 5.2, in search order. Not a trust ranking.
const SOURCES = ["user_answer", "instruction", "pre_set_data", "measured_data", "prior_state"];

// A declared allowed set, normalized. Absent or malformed means all five — so an adopter who
//   declares nothing gets the behavior this skeleton had before the field existed.
//   BREAKS: default to the empty set and every slot dies closed with no route and no blank.
function allowedSourceSet(declared) {
  if (!Array.isArray(declared)) return new Set(SOURCES);
  const kept = declared.filter(x => SOURCES.includes(x));
  return kept.length ? new Set(kept) : new Set(SOURCES);
}
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
// Default ceilings for the value gate's two retriable routes. Overridable per preflight (createPreflight
//   limits: { ask, lookup }), since 4.5 leaves the value to the adopting system.
const ASK_ATTEMPT_LIMIT = 2;
const LOOKUP_ATTEMPT_LIMIT = 2;

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
  // A hook that returns null REPORTS that the instruction does not settle C1. That is an answer, not a
  //   crash, and it is recorded as unresolved — the code C2 uses for the same fact. Same route either
  //   way (the intent gate asks), but the record must not say the classifier broke when it said "I
  //   cannot tell" (5.2: a report of nothing is not a failure to report).
  //   BREAKS: fold null into hook_error — as this did, because throwing was the only way to say it —
  //     and a correct "undecidable" reads as a broken hook in every audit.
  if (!c1Failed && c1 === null) {
    issues.push({ slot: "c1_when_case", code: "unresolved", detail: "classifier reported the instruction does not settle it" });
  } else if (!c1Failed && !WHEN_CASES.includes(c1)) {
    // C1 enum check. Moved here from runPreflightInner so that "threw" and "returned garbage" share one path.
    issues.push({ slot: "c1_when_case", code: "out_of_enum", detail: JSON.stringify(c1) });
  }
  const c1Ok = !issues.some(i => i.slot === "c1_when_case");

  // C2: utterance first, pre-set second. Same order as field values, different reason — there instruction
  //   wins as fresher intent; here the fallback must not OVERRIDE what was just said.
  //   BREAKS: check the fallback first and a stored name silently redirects a different request.
  // NOTE: length caps and whole-input echoes remain the hook's post-processing job. An echo is a non-empty
  //   string, passes usableActionName, and flows into action_key.
  let c2HookError = null;
  const fromInstruction = await safeHook(h.extractUserActionName, [instruction],
    e => { c2HookError = e?.message ?? String(e); return undefined; });
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
    } else if (c2HookError !== null) {
      // The hook failed — it did not report that the instruction names no action. Recording it as
      //   "unresolved — instruction and pre-set both empty" said something untrue about the
      //   instruction (the first said run: a refused model call on "Set up a time to hand over
      //   LST-2291"). Same route either way; the record must say which happened. Mirror of C1.
      issues.push({ slot: "c2_user_action_name", code: "hook_error", detail: c2HookError });
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

// [REQUIRED-OP] Returns one of WHEN_CASES, or null when the instruction does not settle it.
//   null is a report ("I cannot tell") and is recorded as unresolved; a throw is a broken hook and is
//   recorded as hook_error. Both go to the intent gate, which asks.
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

// Spec 6.3 lists "read labels, expand them into slots, reflect them in the verdict" among the gate's
//   responsibilities. That is getProviderConditions + verifyProviderCondition, below. This hook is the
//   OTHER half: whatever the description says that nobody turned into a declaration.
//   What is still not done here is parsing a condition out of prose, and that is 4.2.1's parsing
//   contract — trusted declarer, fixed syntax, deterministic parsing — which the specification leaves
//   to the adopting system rather than to the gate. An adopter who parses labels out of a description
//   hands the result to getProviderConditions, where it is compared like any other declaration.
//   BREAKS: lower the bar and the description becomes an input the gate interprets, so a reworded
//     sentence upstream silently changes what is enforced.
//   NOTE: prose that stays here reaches the model as context and nothing more. A restricting condition
//     left in this string is enforced only if the model reads it, which is the arrangement this
//     specification exists to replace — so a condition that matters belongs in a declaration.
function getAdvisoryNotes(mcpTool) {
  // Natural language is not enforceable, so it stays out of the gate. Records and LLM context only.
  // POLICY: whether to enforce is the adopting system's call.
  return mcpTool.description ?? "";
}

// ────────────────────────────────────────────────────────────────
// [PROVIDER CONDITIONS] The gated half of the provider checklist (spec 4.2, 4.2.1).
//
// A condition must be counted and must never be sent. fields and extra_fields are both assembled
// into call_arguments at Step 6, so a condition cannot live there — it would reach the tool as an
// argument. This list is to conditions what user_checklist is to user items.
//
// INVARIANT: the provider loop writes only to its own array. It never touches fields, extra_fields,
//   call_arguments or user_checklist. That is what keeps direction one-way (5.1): a slot is promoted
//   by being CHECKED, never by being SATISFIED. A condition that holds removes a reason to block and
//   supplies no grounds to execute — those come from the user's declared intent (4.2.1, Section 0).
//   BREAKS: let a checked condition settle a slot or satisfy a user item and one upstream edit —
//     a condition rewritten as always-true — becomes a fail-open switch for every call.
//
// Item shape (the adopting system owns the field names; these are what the gate reads):
//   { id, label: "Required"|"Verify"|"Notice", description, constrains: string[] }
// How the declaration arrives does not matter. Labels parsed out of a description and conditions
//   handed over as a structured field produce the same comparison; the parsing contract
//   (4.2.1: trusted declarer, fixed syntax, deterministic parsing) attaches only to the former,
//   and three fixed tokens settle the last two of those by design.
const PROVIDER_LABELS = new Set(["required", "verify", "notice"]);

// [REQUIRED-SAFETY] The sources that can confirm a [Required] condition. 4.2.1: "confirmed only from
//   the declared SYSTEM source". Of the five sources in 5.2 exactly one is a system source:
//     measured_data  — system state read on the spot, and 5.2 requires the read to be a live measurement
//     user_answer    — the user's words
//     instruction    — the user's words, typed earlier. This is the vector 8.4 is about
//     pre_set_data   — the user's words, approved and stored earlier (5.2)
//     prior_state    — inherited, and 5.2 only counts it once the user confirms it, as user_answer
//   So four of the five are the user speaking at different times, and none of them satisfies a
//   provider condition. A whitelist, not a blacklist: a source added later is refused until someone
//   decides it is a system source.
//   BREAKS: allow instruction and "the CFO approved this on a call" clears a limit by being typed
//     into the request — the exact conflict 8.4 says the comparison must not move on.
const SYSTEM_SOURCES = new Set(["measured_data"]);

// Fixed tokens, so this is matching and not interpretation. Accepts "[Required]" and "required".
// An unrecognized label is NOT ignored: it routes to definition_repair.
//   BREAKS: treat an unknown label as "no condition" and a typo in a declaration silently deletes it,
//     which is the one failure this whole list exists to prevent.
function normalizeProviderLabel(label) {
  if (typeof label !== "string") return null;
  const t = label.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return PROVIDER_LABELS.has(t) ? t : null;
}

// [UNSAFE DEFAULT] Returns no conditions for every tool. Unwired, the provider checklist is empty
//   and the gate is back to arguments only.
// NOTE: reached only after the tool determination gate, so the tool is settled here and an empty
//   list legitimately means "this tool declares no conditions" — unlike getRequiredFields, where a
//   missing schema and required: [] had to be told apart.
function getProviderConditions(mcpTool) {
  return [];
}

// [UNSAFE DEFAULT] Verifies nothing.
// CONTRACT: { status: "checked" | "unmet" | "unverified", source, note? }. Do not throw.
//   "checked" — compared against a declared source and it does not prohibit. Promotes nothing.
//   "unmet"   — compared, and it prohibits. A source is required, for the reason a known value needs
//               one: without it, "prohibited" is a claim rather than a finding.
//   "unverified" — not compared. Routed by label, not by guesswork: [Verify] to the user,
//               [Required] to definition_repair (4.5c).
// There is deliberately no "verified" status. A user item can end verified because the user is the
//   one who declared it; a provider condition is a reason not to execute and nothing more (4.2.1).
function verifyProviderCondition(condition, ctx) {
  return { status: "unverified", source: null, note: "verifyProviderCondition not wired" };
}

// 4.5 route of one slot, from its declared sources and its lookup result. Not a judgment: the same
//   inputs give the same route, and no hook or model is consulted (4.5: "the model does not choose").
//   known / null       no route — the check is done
//   definition_repair  a hook threw, or a source reported there is no place to check (5.1, 4.5c). No
//                      user answer and no re-measurement fills a gap in the declaration
//   ask_user           user_answer is permitted and the user has not yet reported "none"
//   system_lookup      otherwise, if a measurement is still open (not reported absent)
//   definition_repair  otherwise. What is left open is a source neither the user nor the system can
//                      re-answer: an extractor or a caller map that gave no report (4.5c) — the fix
//                      is to make it report
function routeFor(rec, allowed_sources, trace = []) {
  if (rec.status === "known" || rec.status === "null") return null;
  if (rec.lookup_failed === true) return "definition_repair";
  if (trace.some(t => t.result === "no_place")) return "definition_repair";
  const result = src => trace.find(t => t.source === src)?.result;
  if (allowedSourceSet(allowed_sources).has("user_answer") && result("user_answer") !== "absent") return "ask_user";
  const open = trace.filter(t => t.result !== "absent");
  if (open.some(t => t.source === "measured_data")) return "system_lookup";
  return "definition_repair";
}

// 5.1: the slot is NULL when every declared check reported nothing and no route remains. Every
//   permitted source is consulted on an unknown slot, so "every entry is absent" is both halves: each
//   check reported, and nothing is left open. no_report, cannot_answer, rejected and a prior_state
//   candidate all leave something open, so none of them can make NULL. Nor can a route that ended at
//   its ceiling — that is not a report (4.5, 5.2).
const isNullByTrace = trace => trace.length > 0 && trace.every(t => t.result === "absent");

// 4. Per-field lookup chain
//    The five sources decide only whether a value EXISTS. Format validation comes after (applyFieldPolicy → validateFieldSchema).
//    BREAKS: reorder and a later intent loses to an earlier one; demoting user_answer ignores the answer just given.
async function resolveField(h, fieldName, ctx) {
  const resolved_at = h.now();
  // Declared per slot, read once. Every return below carries it, on the known path too: a reader
  //   who cannot see what was permitted cannot tell a value that came from the only allowed source
  //   from one that came from a source nobody meant to permit.
  const declared = await safeHook(h.getAllowedSources, [fieldName, ctx.mcpTool], () => null);
  const allowed_sources = [...allowedSourceSet(declared)];
  const record = await lookupField(h, fieldName, { ...ctx, allowed_sources });
  // lookup_trace and route are the gate's own facts, so they are written last, over whatever a policy
  //   hook returned. A hook may demote a value; it may not rewrite what was consulted or who resolves it.
  //   BREAKS: spread them before ...rec and a policy that builds a fresh record drops the trace — the
  //     record then shows a slot that was never looked up.
  //   NULL is the gate's too: written here from the trace, never accepted from a hook.
  const trace = record.lookup_trace ?? [];
  const stamp = rec => {
    const status = rec.status === "unknown" && rec.lookup_failed !== true && isNullByTrace(trace)
      ? "null" : rec.status;
    const out = { ...rec, status, allowed_sources, resolved_at, lookup_trace: trace };
    // The candidate is the gate's fact as well. It survives a policy that rebuilds the record, and it
    //   is dropped once the slot settles (the user confirmed it, as user_answer, or chose otherwise).
    if (status === "unknown" && record.prior_candidate) out.prior_candidate = record.prior_candidate;
    else delete out.prior_candidate;
    out.route = routeFor(out, allowed_sources, trace);
    return out;
  };
  // BREAKS: run applyFieldPolicy here and it can set pending_at_trigger — the at_instruction gate excuses
  //   the field, and a crashed extractor gets scheduled instead of asked about.
  if (record.lookup_failed === true) return stamp(record);

  // Hook failure and shape violation both demote to unknown.
  const out = await safeHook(h.applyFieldPolicy, [record, ctx],
    e => ({ ...record, value: undefined, status: "unknown", source: null,
            note: `field policy hook failed: ${e?.message ?? String(e)}` }));
  let settled = (out && (out.status === "known" || out.status === "unknown"))
    ? out
    : { ...record, value: undefined, status: "unknown", source: null,
        note: "field policy hook did not return a valid FieldRecord" };
  // A policy demotes; it never promotes, and never moves a value to another source. Either would let
  //   a hook settle what the lookup did not — the one thing this gate exists to refuse (5.2, 2.4).
  //   Before prior_state stopped settling, passing it through was exactly that, and it was "opt-in".
  //   NOTE: a known value with the same source but a different value (normalization) is let through.
  if (settled.status === "known" && (record.status !== "known" || settled.source !== record.source)) {
    settled = { ...record, value: undefined, status: "unknown", source: null,
                note: "field policy may demote a value, never promote one or change its source (5.2)" };
  }

  // Only known is checked. unknown is already unmet.
  if (settled.status !== "known") return stamp(settled);
  const schemaOut = await safeHook(h.validateFieldSchema, [settled.value, ctx.fieldSchemas?.[fieldName], ctx, fieldName],
    e => `validation hook failed: ${e?.message ?? String(e)}`);
  const violation = typeof schemaOut === "string" ? schemaOut : null;
  if (!violation) return stamp(settled);
  // A format violation is a defect, not a not-yet-arrived value. Clear the pending mark so it also blocks at instruction time.
  return stamp({ ...settled, value: undefined, status: "unknown", source: null,
           pending_at_trigger: false,
           note: `schema violation (source ${settled.source ?? "unknown"}): ${violation}` });
}

// ────────────────────────────────────────────────────────────────
// [CORE] Never generates a value. Looks up five sources in order. If all are empty, unknown.
// Every consulted source leaves an entry in lookup_trace (5.2: a source that was checked stays on the
//     record). Demotion reasons from the validation stage are written to note by resolveField.
// [REPORTING NOTHING] 5.2 separates "no report" from "a report of nothing", 5.1 lets a source report
//     NULL from the first round, and 6.2 names two kinds of nothing. The two lookup hooks may return:
//       { none: "absent" }    checked the designated place, and the value is not there
//       { none: "no_place" }  there is no place to check for this slot (a gap in the declaration, 4.5c)
//       undefined             no report — recorded as no_report, which means NOT checked
//     An explicit object rather than JS null on purpose: `??` and `==` merge null into undefined, and
//     that merge is exactly the one 5.2 forbids. Any other `none`, or `none` alongside `value`, is
//     rejected — an ambiguous report is not a report of nothing.
//     A report of nothing never settles the slot and never ends the chain: the next source still runs
//     (5.2). It cannot open anything — at most it narrows what is left.
// [SLOT NULL] When every permitted source reported absent, the slot's status is "null" (5.1), written
//     by resolveField from the trace (isNullByTrace). A required "null" is unmet and holds (6.3); a
//     "null" value is never sent. Anything left open — no_report, cannot_answer, rejected, a candidate,
//     a route that ended at its ceiling — keeps the slot UNKNOWN.
//   The three map sources report nothing the same way, from whoever filled the map (D1, D3):
//     userAnswers[slot] = { none: "absent" }      the user said there is none
//     preSetData[slot]  = { none: "absent" }      the caller looked in the settings, none
//     priorExecutionState = { none: "absent" }    the caller looked in storage, nothing executed
//   An absent KEY stays no_report: the gate cannot tell "loaded, none" from "passed {}". Only "absent"
//     is accepted there — "no place to check" is the declaration's to say, not a user's or a caller's.
// [LOOKUP HOOK FAILURE] A throw is not an empty source. It settles the field unknown and ends the chain:
//     instruction undefined → pre_set_data runs  /  instruction throws → pre_set_data never runs
//     measured_data undefined → prior_state runs  /  measured_data throws → prior_state never runs
//     BREAKS: bare calls let a throw escape to the backstop — one field kills the run. Falling through
//       instead hands the slot to a later source, and the record would show a clean "no_report".
//     Route: definition_repair (4.5c). No user answer fixes a hook that threw, so the slot is never
//       put in front of the user, on either phase.
// ────────────────────────────────────────────────────────────────

// A lookup hook's report of nothing. Returns "absent" | "no_place" for a well-formed report, "malformed"
//   for an object that carries `none` but is not one, and null when the return is not a report of
//   nothing at all (undefined, or a found value).
const NONE_REPORTS = new Set(["absent", "no_place"]);
function noneReport(ret) {
  if (!ret || typeof ret !== "object" || !("none" in ret)) return null;
  return NONE_REPORTS.has(ret.none) && !("value" in ret) ? ret.none : "malformed";
}

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
// Check every input a derived value names (see spanSupportsValue). Returns { ok, deps } with each dep
//   as verified, { ok: false, why } when one does not hold, or { failed } when re-measuring threw.
async function verifyDerivedFrom(h, declared, instruction, ctx) {
  if (!Array.isArray(declared) || declared.length === 0) {
    return { ok: false, why: "derived without derived_from — what it rests on is not named" };
  }
  const deps = [];
  for (const d of declared) {
    if (d?.source === "instruction") {
      const seg = instruction?.[d.segment_index];
      const sp = d.span;
      const valid = Array.isArray(sp) && sp.length === 2 && Number.isInteger(sp[0]) && Number.isInteger(sp[1]) &&
        sp[0] >= 0 && sp[0] < sp[1] && sp[1] <= (seg?.text?.length ?? -1);
      if (seg?.trust !== "user" || !valid) return { ok: false, why: "an instruction input is not a valid span in a trusted segment" };
      deps.push({ source: "instruction", segment_index: d.segment_index, span: [sp[0], sp[1]],
                  text: seg.text.slice(sp[0], sp[1]) });
    } else if (d?.source === "measured_data" && typeof d.name === "string") {
      const m = await safeHook(h.measureFromEnvironment, [d.name, ctx], lookupFailed("measured_data"));
      if (m?.[LOOKUP_HOOK_FAILED]) return { failed: m };
      if (!m || m.valid !== true || JSON.stringify(m.value) !== JSON.stringify(d.value)) {
        return { ok: false, why: `measured input "${d.name}" is not what the system measures` };
      }
      deps.push({ source: "measured_data", name: d.name, value: m.value });
    } else {
      // user_answer, pre_set_data, prior_state could be added the same way when a use needs them.
      return { ok: false, why: `an input of source ${JSON.stringify(d?.source)} cannot be checked here` };
    }
  }
  return { ok: true, deps };
}

async function lookupField(h, fieldName, ctx) {
  const { userAnswers, instruction, preSetData, priorExecutionState } = ctx;
  // What each consulted source returned, in order. Attached to every record this function returns.
  const trace = [];
  const saw = (source, result) => trace.push({ source, result });
  const traced = rec => ({ ...rec, lookup_trace: trace });
  // For the first four sources, this decision is itself the origin.
  const fresh = rec => traced({ ...rec, origin_source: rec.source });
  const failedAt = failure => { saw(failure.source, "failed"); return traced(lookupFailureRecord(fieldName, failure)); };

  // Which sources may be consulted for THIS slot (4.5: the route follows from the slot's declared
  //   allowed sources). Same shape as the fixed checklist's C2, which has had a two-source list in
  //   resolveFixedChecklist since the start: an ordered set, first hit wins, no weights. The
  //   difference is where it lives. C2 is the same slot on every call, so its sources belong in the
  //   gate; these slots are the tool's arguments and vary per tool, so theirs are declared (6.1).
  // NOTE: "may be consulted" is not "may settle". applyFieldPolicy still runs on whatever answered,
  //   and prior_state never settles at all (Source 5).
  const allowed = allowedSourceSet(ctx.allowed_sources);
  // The three map sources the gate reads itself accept one report of nothing, from whoever filled the
  //   map: { none: "absent" } — "I looked, there is none". Nothing else from them is a report of
  //   nothing; no_place in particular is a declaration gap, which a user or a caller does not report.
  const mapNone = v => { const r = noneReport(v); return r === null ? null : (r === "absent" ? "absent" : "rejected"); };

  // Source 1 — user_answer (injected on re-run after ask_user)
  // NOTE: filling userAnswers happens outside the skeleton.
  // BREAKS: LLM parsing output here makes the first source model output.
  // NOTE: a user_answer has no expiry and outranks a later measurement.
  // POLICY: invalidate on a change to what the value derived from, not on elapsed time.
  // D1: the user may answer "there is none" — { none: "absent" }. That is a report of nothing by the
  //   one who checked (5.1), recorded, and the search goes on (5.2). It is never a value.
  if (allowed.has("user_answer")) {
    if (userAnswers && fieldName in userAnswers) {
      const none = mapNone(userAnswers[fieldName]);
      if (none) {
        saw("user_answer", none);
      } else {
        saw("user_answer", "found");
        return fresh({ name: fieldName, value: userAnswers[fieldName], status: "known", source: "user_answer" });
      }
    } else {
      saw("user_answer", "no_report");
    }
  }

  // Source 2 — instruction: known only from a trusted segment with a valid span.
  //   To use a value from an untrusted segment, ask and take it back as user_answer.
  //   If instruction is a string, this entire source dies (fail-closed).
  const fromInstruction = allowed.has("instruction")
    ? await safeHook(h.extractFromInstruction, [fieldName, instruction], lookupFailed("instruction"))
    : undefined;
  if (fromInstruction?.[LOOKUP_HOOK_FAILED]) return failedAt(fromInstruction);
  const instructionNone = noneReport(fromInstruction);
  if (allowed.has("instruction") && fromInstruction === undefined) saw("instruction", "no_report");
  // A report of nothing is recorded and the search goes on (5.2). Never a value, never the end.
  else if (instructionNone) saw("instruction", instructionNone === "malformed" ? "rejected" : instructionNone);
  else if (fromInstruction !== undefined) {
    const seg = instruction?.[fromInstruction?.segment_index];
    const sp = fromInstruction?.span;
    const spanValid = Array.isArray(sp) && sp.length === 2 &&
      Number.isInteger(sp[0]) && Number.isInteger(sp[1]) &&
      sp[0] >= 0 && sp[0] < sp[1] && sp[1] <= (seg?.text?.length ?? -1);
    if (seg?.trust === "user" && spanValid) {
      // The span is the hook's claim about WHERE the value is. The gate checks whether
      // the value is actually there. Without this, a generated value acquires
      // source: "instruction" and the record asserts a provenance that does not exist.
      // The policy knob is WHICH comparison, never WHETHER there is one.
      const atSpan = seg.text.slice(sp[0], sp[1]);
      const support = await safeHook(h.spanSupportsValue, [fromInstruction.value, atSpan, fieldName, ctx],
        lookupFailed("instruction"));
      if (support?.[LOOKUP_HOOK_FAILED]) return failedAt(support);
      let supported = support === true || support?.supported === true;
      // A derived value ("2pm this Saturday" → 2026-10-31T14:00+09:00) rests on more than the span:
      //   the date the user said elsewhere, the year and time zone the system measured. Each of those
      //   must be named (derived_from) and the gate checks each one itself. A derived value that names
      //   nothing it rests on, or names something that is not there, does not settle the slot.
      //   BREAKS: accept derived: true on the hook's word — as this did — and the record says the value
      //     came from the instruction while a clock reading nobody recorded sits inside it.
      let derivedFrom = null;
      if (supported && support?.derived === true) {
        derivedFrom = await verifyDerivedFrom(h, support.derived_from, instruction, ctx);
        if (derivedFrom.failed) return failedAt(derivedFrom.failed);
        if (!derivedFrom.ok) {
          saw("instruction", "rejected");
          return traced({ name: fieldName, value: undefined, status: "unknown", source: null, origin_source: null,
                          note: `derived value not supported: ${derivedFrom.why}` });
        }
      }
      if (supported) {
        saw("instruction", "found");
        return fresh({
          name: fieldName, value: fromInstruction.value, status: "known", source: "instruction",
          // WHERE, not just "instruction". A record that names a source without
          // saying where in it cannot be re-checked by anyone but this gate, so
          // the auditor would have to take the gate's word — which is the thing
          // this specification refuses to do for the model.
          located_at: { segment_index: fromInstruction.segment_index, span: [sp[0], sp[1]] },
          // A derived match ("tomorrow" → a date) is recorded as derived. The span then
          // points at supporting text rather than stating the value, and the record says so.
          ...(derivedFrom?.ok
            ? { derived: true, derived_from: derivedFrom.deps,
                note: `derived from instruction text "${atSpan}" and ${derivedFrom.deps.length} other input(s)` }
            : {}),
        });
      }
      // The span does not say the value. This source did not settle the slot; the search goes on.
    }
    // Untrusted segment, invalid span, or a span that does not state the value. Something came back
    //   and the gate refused it — a different fact from the hook returning nothing.
    saw("instruction", "rejected");
  }

  // Source 3 — pre_set_data: accepted only with trust "user". A raw value without the wrapper is rejected.
  //   NOTE: old-schema input looks like every field being stuck at unknown. Check here first when migrating.
  // D3: the caller may write { none: "absent" } for a slot it looked up in the settings and found no
  //   entry for. An absent KEY stays no_report — the gate cannot tell "loaded, none" from "passed {}".
  if (allowed.has("pre_set_data")) {
    if (preSetData && fieldName in preSetData) {
      const entry = preSetData[fieldName];
      const none = mapNone(entry);
      if (none) {
        saw("pre_set_data", none);
      } else if (entry && typeof entry === "object" && "value" in entry && entry.trust === "user") {
        saw("pre_set_data", "found");
        return fresh({ name: fieldName, value: entry.value, status: "known", source: "pre_set_data" });
      } else {
        saw("pre_set_data", "rejected");
      }
    } else {
      saw("pre_set_data", "no_report");
    }
  }

  // Source 4 — measured_data: accepted only when valid.
  // NOTE: the means of observation is not recorded. If this hook is LLM-based, it is not a measurement.
  const fromMeasurement = allowed.has("measured_data")
    ? await safeHook(h.measureFromEnvironment, [fieldName, ctx], lookupFailed("measured_data"))
    : undefined;
  if (fromMeasurement?.[LOOKUP_HOOK_FAILED]) return failedAt(fromMeasurement);
  // Read before the found check: an object carrying `none` is never a value, whatever else it carries.
  const measurementNone = noneReport(fromMeasurement);
  // BREAKS: `fromMeasurement.valid` without ?. — as this was — and a hook returning null throws here,
  //   outside safeHook, so one slot takes the whole run to the backstop with no record of which.
  if (!measurementNone && fromMeasurement !== undefined && fromMeasurement?.valid) {
    saw("measured_data", "found");
    return fresh({ name: fieldName, value: fromMeasurement.value, status: "known", source: "measured_data" });
  }
  if (allowed.has("measured_data")) {
    // Three different facts, kept apart (5.1, 5.2):
    //   absent / no_place  the source checked and reports nothing there / nowhere to check
    //   cannot_answer      valid:false — the source could not answer this question. Not "nothing"
    //   no_report          undefined — nothing came back, so nothing was checked
    // Any other shape is refused, not trusted.
    saw("measured_data", fromMeasurement === undefined ? "no_report"
      : measurementNone ? (measurementNone === "malformed" ? "rejected" : measurementNone)
      : fromMeasurement?.valid === false ? "cannot_answer" : "rejected");
  }

  // Source 5 — prior_state: inherited from a previous execution.
  //   5.2: inheritance alone does not confirm a slot; the value counts only once the user confirms it,
  //   and then as user_answer. So this source NEVER settles. A value found here is recorded as a
  //   candidate, the slot stays unknown, and the question to the user carries the candidate.
  //   Enforced here, not left to applyFieldPolicy — a rule kept by hook discipline is a rule the gate
  //   does not hold (the same reason [Required] is enforced in the gate, 4.2.1).
  //   BREAKS: let it settle — as this did when a policy hook passed it through — and a payment's
  //     amount arrives in a refund as KNOWN (policy-test part 5).
  //   NOTE: "executed" is the ONLY condition checked on the record — not age, not which action wrote
  //     it. The candidate carries the record's action_key so the question can say where it came from.
  //   NOTE: origin_source is inherited onto the candidate. Erasing it opens a laundering path.
  //   D3: the caller may pass { none: "absent" } for "looked in storage, nothing executed".
  //     A record handed in that is executed and holds no known value for this slot is also "absent"
  //     — the gate checked the record it was given. A record that is not executed is refused.
  //     null/undefined stays no_report.
  if (allowed.has("prior_state")) {
    const priorNone = mapNone(priorExecutionState);
    const executed = priorExecutionState?.execution_decision === "executed";
    const fromPriorState = !priorNone && executed
      ? priorExecutionState.fields?.find(f => f.name === fieldName && f.status === "known")
      : undefined;
    if (fromPriorState) {
      saw("prior_state", "candidate");
      return traced({ name: fieldName, value: undefined, status: "unknown", source: null, origin_source: null,
                      prior_candidate: { value: fromPriorState.value,
                                         origin_source: fromPriorState.origin_source ?? null,
                                         action_key: priorExecutionState.action_key ?? null } });
    }
    saw("prior_state", priorNone ? priorNone
      : executed ? "absent"
      : priorExecutionState == null ? "no_report" : "rejected");
  }
  // All empty → unknown. The allowed set rides along: the route is chosen from it (4.5), and a
  //   record that does not carry it cannot say why nothing was asked of the user.
  return traced({ name: fieldName, value: undefined, status: "unknown", source: null, origin_source: null });
}

// Which of the five sources may be consulted for this slot (5.2, 4.5). Returning null or anything
//   malformed means all five, which is what this skeleton did before the hook existed.
// CONTRACT: a subset of SOURCES, or null. Do not throw.
// NOTE: this answers "may be consulted", not "may settle". applyFieldPolicy still judges whatever
//   answered. prior_state never settles regardless (Source 5).
// POLICY: this is a declaration, so it belongs with the checklist and changes without a deploy (6.1,
//   7.2). Encoding it in a hook body instead is the scattering 2.8 describes.
function getAllowedSources(fieldName, mcpTool) {
  return null;
}

// [REQUIRED-SAFETY] Passes everything through. It used to be where prior_state was refused, and passing it
//   through was how an adopter "accepted inheritance"; the gate now refuses it itself (5.2: inheritance
//   alone never confirms), so the branch below never sees a prior_state record. Kept as a guard.
// CONTRACT: do not throw. To block: { ...record, value: undefined, status: "unknown", source: null }.
//   Demote only: a returned known whose record was not known, or whose source changed, is refused by the
//   gate (resolveField).
//   No falling back to a later source. Set pending_at_trigger: true for an at_instruction unknown that
//   settles at trigger time — the only thing the gate excuses, and the default never sets it.
function applyFieldPolicy(record, ctx) {
  if (record.source !== "prior_state") return record;
  return { ...record, value: undefined, status: "unknown", source: null };
}

// [REQUIRED-SAFETY] The default implementation checks nothing. Unwired, there is no format validation (including type).
// CONTRACT: null if it passes, a reason string if it violates. This is where AJV or similar goes.
//   Called with (value, schema, ctx, fieldName). fieldName was added so a format declared outside the
//   schema object can be found without matching schema objects by reference.
function validateFieldSchema(value, schema, ctx) {
  return null;
}

// [REQUIRED-OP] CONTRACT: one of
//   { valid: true, value }   measured, and this is the value
//   { valid: false }         this source cannot answer the question (5.1). Never becomes known
//   { none: "absent" }       measured, and there is nothing there — a report of nothing (5.2, 6.2)
//   { none: "no_place" }     there is nothing to measure for this slot — a gap in the declaration
//   undefined                no report. Recorded as no_report, which means NOT checked
// NOTE: any other shape is refused and traced as rejected. A raw value with no `valid` is one of them.
// NOTE: everything but a throw moves on to prior_state; a throw settles the field unknown. Do not throw
//   for "cannot observe" — say which of the above it is.
function measureFromEnvironment(fieldName, ctx) {
  if (ctx.measured_data && fieldName in ctx.measured_data) return ctx.measured_data[fieldName];
  return undefined;
}

// [REQUIRED-OP] Extract a value from the instruction (LLM). Unimplemented means every field stays unknown.
// CONTRACT: instruction is an InstructionSegment[].
//   Found → { value, segment_index, span: [start, end] }
//   Looked, not there → { none: "absent" }. Nowhere to look for this slot → { none: "no_place" }.
//   No report → undefined (recorded as no_report: NOT checked). An extractor that looked and found
//     nothing must say so; returning undefined erases the check it just did (5.2, 6.2).
//   NOTE: everything but a throw moves on to pre_set_data; a throw settles the field unknown. Do not throw for "not found".
//   segment_index = the segment the value came from. span = the character range within that segment's text (half-open).
//   A missing or out-of-bounds span is rejected, and the text at the span is compared against value
//   by spanSupportsValue. A span that does not say the value does not settle the slot.
//   BREAKS: misreport a trusted segment and the trust check is defeated.
function extractFromInstruction(fieldName, instruction) {
  return undefined;
}

// [OPTIONAL] Does the text at the span state this as the value FOR THIS SLOT?
// CONTRACT: true | { supported: true, derived?: boolean, derived_from?: Dep[] } | false.
//   A throw is a lookup failure. Called with (value, textAtSpan, fieldName, ctx).
//   derived: true REQUIRES derived_from — every other input the value rests on:
//     { source: "instruction", segment_index, span }   another place the user said it
//     { source: "measured_data", name, value }          a system measurement (clock year, time zone)
//   The gate checks each: an instruction dep must be a valid span in a trusted segment; a measured
//   dep is re-measured through measureFromEnvironment and must be valid and equal. Any that fails,
//   or a derived value with none named, leaves the slot unsettled (rejected). What passes is
//   recorded on the field as derived_from, so the record names every input, not just the span.
//
// Equality is NECESSARY AND NOT SUFFICIENT, and the default only does equality — which is why
// it is on UNSAFE_DEFAULT_HOOKS. The span proves WHERE the text is, not what role it plays:
//
//     "Arrange the pickup. Nothing after 8pm, and public places only."
//
// A faithful extractor can return time="8pm" with a correct span. Trusted segment, valid span,
// the text really does say "8pm" — every check passes, and the gate schedules the pickup AT the
// limit the user set, at a place called "public places". Worse than a fabricated value: the
// record is TRUE. An auditor re-verifying it confirms it. The record is true and the execution
// is wrong. A limit, a negation, an example and a prohibition all carry value-shaped tokens.
//
// A sentence that constrains belongs to the user checklist (a range of values or state), not to the value lookup.
// The gate cannot tell them apart from the text alone; this hook must. The default cannot, so
// a system that relies on it is running without this check — strict mode refuses it.
// POLICY: an adopting system supplies a role-aware comparator. For a derived value
//   ("tomorrow" → a date) it returns derived: true, so the record shows the span supported the
//   value rather than stating it. A bare true for a derived value makes the record claim the
//   instruction said something it did not.
function spanSupportsValue(value, textAtSpan) {
  const norm = s => String(s).toLowerCase().replace(/[.,!?;:'"()\[\]]/g, " ").replace(/\s+/g, " ").trim();
  return norm(value) === norm(textAtSpan);
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
      provider_checklist: null, unverified_provider_count: null,
      gate: null,
      execution_decision: "definition_repair",   // backstop: an implementation gap (4.5c)
      // NOTE: the internal error message is carried verbatim. Filter what reaches the user in formatReason.
      reason: `preflight error: ${e?.message ?? String(e)}`,
      timestamp: h.now(),
    };
  }
}

// NOTE: there is no agentPolicy input. The gate compares declared conditions against the state of the
//   world at execution time; it does not judge the actor's permission, which belongs to the executing
//   party or the policy layer. An input the gate accepts but never compares is the exact shape this
//   specification exists to rule out, so it is absent rather than carried unread.
//   A policy that must gate execution is declared as a checklist item: it becomes a slot and is
//   compared like any other.
async function runPreflightInner(h, { userId, instruction, mcpTool, preSetData, fixedPreSet, measured_data, priorExecutionState, userChecklist, userAnswers, checklistAnswers, intent_attempt, tool_attempt, ask_attempt, lookup_attempt }) {
  const checklist = userChecklist ?? [];
  // Ceilings on the two resolution routes that can be retried (4.5: asking the user and the system
  //   lookup both have one; the adopting system sets it). Same contract as intent_attempt: the caller
  //   carries the count per action and sends back gate.next_ask_attempt / next_lookup_attempt.
  //   Absent or malformed = 0. A larger value only brings "exhausted" forward, never "execute".
  //   D4: one count per route per action, not per slot — the same shape as intent_attempt.
  const askAttempt = Number.isInteger(ask_attempt) && ask_attempt >= 0 ? ask_attempt : 0;
  const lookupAttempt = Number.isInteger(lookup_attempt) && lookup_attempt >= 0 ? lookup_attempt : 0;

  // Asks already spent on the Fixed checklist. Absent or malformed = 0.
  // NOTE: caller-supplied and the skeleton DOES read it, unlike input.tool_reselected_by_user.
  //   Direction is why: a larger value only brings "exhausted" forward, never produces "execute". Not a bypass.
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
      provider_checklist: null, unverified_provider_count: null,
      gate: null,   // Not a question. There is nothing for the user to answer
      execution_decision: "definition_repair",
      reason: `definition_repair: checklist item without id at index: ${unidentified.join(", ")}`,
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
      provider_checklist: null, unverified_provider_count: null,
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
      execution_decision: exhausted ? "exhausted" : "ask_user",
      reason: `${exhausted ? "exhausted" : "ask_user"}: fixed undetermined (${fixedIssues.map(i => `${i.slot}:${i.code}`).join(", ")}) attempt=${attempt}/${INTENT_ATTEMPT_LIMIT}`,
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
      provider_checklist: null, unverified_provider_count: null,
      call_arguments: null,
      gate: { kind: "action_key_failed", _diag: { detail: keyFailure } },
      execution_decision: "definition_repair",
      reason: "definition_repair: action_key could not be built",
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
      provider_checklist: null, unverified_provider_count: null,
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
      execution_decision: toolExhausted ? "exhausted" : "ask_user",
      reason: `${toolExhausted ? "exhausted" : "ask_user"}: tool undetermined (${c3Reason}) attempt=${toolAttempt}/${TOOL_ATTEMPT_LIMIT}`,
      timestamp: h.now(),
    };
  }

  // ── Everything below is reached only after the Tool is determined ───────────
  // [CALLER CONTRACT] / [ask_user re-entry] / [Re-ask ceiling] — see APPENDIX.

  // Step 2: Provider Checklist — separate enforceable from advisory
  const advisoryNotes = await h.getAdvisoryNotes(mcpTool);
  // Declared conditions. Obtained from the tool, not from input: the provider declares these, and
  //   per 4.4 the provider checklist comes from the tool's own declarations once the tool is settled.
  //   A failure here returns one item with a null label, which routes to definition_repair. Fail-closed:
  //   a crashed condition fetch must not look like a tool that declares no conditions.
  const rawProviderConditions = await safeHook(h.getProviderConditions, [mcpTool],
    e => [{ id: null, label: null, note: `getProviderConditions failed: ${e?.message ?? String(e)}` }]);
  //   Normalized here rather than at the loop: the at_instruction records carry this array too, and a
  //   hook that returns a non-array would otherwise put null in provider_checklist, which already means
  //   "no decision made". Two meanings on one value is how a record stops being readable.
  const providerConditions = Array.isArray(rawProviderConditions) ? rawProviderConditions : [];

  const ctx = { userAnswers, checklistAnswers, instruction, preSetData, measured_data, priorExecutionState,
                phase,   // The basis for applyFieldPolicy's per-phase judgment
                fieldSchemas: mcpTool?.inputSchema?.properties ?? {},
                mcpTool };

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
      provider_checklist: null, unverified_provider_count: null,
      call_arguments: null,
      gate: {
        kind: "schema_unsupported",
        _diag: { detail: candidateFailure ?? "getCandidateSlots returned no list" },
      },
      execution_decision: "definition_repair",
      reason: "definition_repair: tool input schema undetermined or unsupported",
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
      provider_checklist: null, unverified_provider_count: null,
      call_arguments: null,
      gate: {
        kind: "schema_unsupported",
        _diag: { detail: slotSet?.detail ?? "materializeSlots returned no status",
                 lookup_failures: lookupFailures(resolvedAll) },
      },
      execution_decision: "definition_repair",
      reason: `definition_repair: slot list could not be materialized (${slotSet?.detail ?? "no status"})`,
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
      provider_checklist: null, unverified_provider_count: null,
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
    // Same routes as the immediate path, read from each slot. What blocks the scheduling is only what
    //   can be settled NOW: a blank the user can answer, while the user is still here, and a gap in a
    //   declaration, which waiting will not fill.
    //   10: a slot only the system can answer is NOT settled now. 4.5: only what was confirmed by asking
    //   is fixed at instruction time; the rest is checked again at the trigger, and system state is
    //   measured at execution time, not inherited (3.5). So it is excused to the trigger like
    //   pending_at_trigger, and the trigger-time gate routes it. A NULL slot is excused the same way:
    //   its sources are re-read at the trigger, and whether it prohibits is judged there (6.3).
    //   BREAKS: split on lookup_failed alone — as this once did — and a measurement-only slot reaches the
    //     user as a question on this phase while the immediate path correctly withholds it.
    const repairNow = unknownNow.filter(f => f.route === "definition_repair");
    const failedNow = repairNow.filter(f => f.lookup_failed === true);
    const gapsNow = repairNow.filter(f => f.lookup_failed !== true);
    const blocking = unknownNow.filter(f => f.pending_at_trigger !== true && f.route === "ask_user");
    const systemNow = unknownNow.filter(f => f.route === "system_lookup");
    const pendingCount = unknownNow.length - blocking.length - repairNow.length;
    const askExhaustedNow = askAttempt >= h.limits.ask;

    if (blocking.length > 0 || repairNow.length > 0) {
      const decision = repairNow.length ? "definition_repair"
        : askExhaustedNow ? "exhausted" : "ask_user";
      // Block the scheduling itself (fail-closed). This is the last moment the user is present.
      // POLICY: can be changed to "schedule anyway, flagged unresolved" — a choice that accepts failure at trigger time.
      return {
        fixed, action_key, phase, fields, extra_fields,
        advisory_notes: advisoryNotes,
        user_checklist: checklist,        // Raw input. Not verified at this phase
        unknown_count: unknownNow.length, // Total (including pending). gate is authoritative for what blocks
        unverified_checklist_count: null, // No decision made. Not 0
        provider_checklist: providerConditions,  // Raw declarations. Conditions are trigger-time (4.5)
        unverified_provider_count: null,         // Not performed at this phase
        call_arguments: null,             // Assembled at trigger time only
        gate: {
          unknown_fields: blocking.map(f => ({ name: f.name, note: f.note ?? null,
            ...(f.prior_candidate ? { candidate: f.prior_candidate } : {}) })),
          unverified_checklist: [],       // Not performed. Not "all verified" (see count: null above)
          ...(failedNow.length ? {
            kind: "lookup_failed",
            lookup_failed_fields: failedNow.map(f => ({ name: f.name, note: f.note ?? null })),
          } : {}),
          ...(gapsNow.length ? {
            ...(failedNow.length ? {} : { kind: "definition_repair" }),
            definition_repair_fields: gapsNow.map(f => ({ name: f.name,
              open: (f.lookup_trace ?? []).filter(t => t.result !== "absent").map(t => `${t.source}:${t.result}`),
              note: f.note ?? null })),
          } : {}),
          ...(decision === "exhausted" ? { kind: "exhausted",
            exhausted: [{ route: "ask_user", attempt: askAttempt, limit: h.limits.ask, names: blocking.map(f => f.name) }] } : {}),
          next_ask_attempt: decision === "ask_user" ? askAttempt + 1 : (askExhaustedNow ? null : askAttempt),
          // Recorded, not blocking: these are answered at the trigger (see above).
          ...(systemNow.length ? { deferred_system_lookup: systemNow.map(f => f.name) } : {}),
          _diag: { phase, pending_at_trigger: pendingCount, lookup_failures: lookupFailures(fields) },
        },
        execution_decision: decision,
        reason: failedNow.length
          ? `definition_repair: lookup hook failed — ${failedNow.map(f => f.name).join(", ")} ` +
            `(definition/implementation gap; no user answer settles these)`
          : gapsNow.length
          ? `definition_repair: no source can answer — ${gapsNow.map(f => f.name).join(", ")}`
          : decision === "exhausted"
          ? `exhausted: ask_user ${askAttempt}/${h.limits.ask} (${blocking.map(f => f.name).join(", ")})`
          : await h.formatReason(decision, { unknown_fields: blocking, unverified_checklist: [] }),
        timestamp: h.now(),
      };
    }

    return {
      fixed, action_key, phase, fields, extra_fields,   // Actual decision results. For comparison at trigger time
      advisory_notes: advisoryNotes,
      user_checklist: checklist,          // Carried unverified, as things to confirm at trigger time
      unknown_count: unknownNow.length,   // Only pending remains. May not be 0
      unverified_checklist_count: null,
      provider_checklist: providerConditions,  // Raw declarations. Conditions are trigger-time (4.5)
      unverified_provider_count: null,         // Not performed at this phase
      call_arguments: null,               // Re-assembled at trigger time
      gate: null,                         // The gate stands only at trigger time
      execution_decision: "deferred",
      reason: `deferred: c1_when_case is "${fixed.c1_when_case}" — awaiting trigger (pending_at_trigger=${pendingCount})`,
      deferred_input: await h.buildDeferredInput({ instruction, mcpTool, preSetData, userChecklist: checklist, userAnswers, checklistAnswers }),
      timestamp: h.now(),
    };
  }

  // Step 3-b: [add in the adopting system] call permission, target resource existence, call quota, duplicate-execution check.
  //   These are trigger-time realities and cannot be seen in advance at instruction time.

  // Step 4: verify the User Checklist (immediate = right before execution, so check now)
  // Hook failure and anything other than verified demote to unverified. The hook cannot erase the id.
  //
  // The hook is handed the RESOLVED fields. The most common user item is a limit on a
  // value ("nothing after 8pm", "public places only"), and comparing one needs the value
  // the lookup actually settled on — which may have come from any of the five sources.
  // Without this the hook would have to redo the cascade itself, so such an item was not
  // implementable at all.
  const checklistCtx = { ...ctx, fields, extra_fields };

  // A limit cannot be compared while the slot it limits is still UNKNOWN. That is not a
  // question for the user — they declared the rule; what is missing is the value, and the
  // value is already in the blank list. So an item waiting on an unknown slot is recorded
  // and NOT counted, and it becomes evaluable on the next round once the slot is filled.
  //   The gate verifies the claim rather than trusting it: the item must name a slot, and
  //   that slot must actually be unknown here. Otherwise "waiting" would be a bypass.
  const unknownNames = new Set(fields.filter(f => f.status === "unknown").map(f => f.name));
  // Every name this run actually looked up. A constrains entry outside this set names nothing, so
  //   the item cannot be compared against it — 6.3: a condition that cannot be compared stays
  //   unknown. Without this check a one-character typo in constrains produces a CLEAN verdict: the
  //   name is not in unknownNames, so nothing is pending, and the hook compares against a value the
  //   item was never about. The record then says the rule was confirmed.
  //   BREAKS: skip it and "nothing after 8pm" misspelt comes out verified with count 0.
  //   The addressee follows the declarer (7.1): a user item goes back to the user as a blank, and a
  //   provider condition is a broken declaration and goes to definition_repair (see Step 4-b).
  const lookedUpNames = new Set([...fields, ...extra_fields].map(f => f.name));
  const missingTargets = targets => targets.filter(n => !lookedUpNames.has(n));
  const finalUserChecklist = [];
  for (const item of checklist) {
    const targets = Array.isArray(item.constrains) ? item.constrains : [];
    const unknownTargets = missingTargets(targets);
    if (unknownTargets.length > 0) {
      // The user declared this rule against something that is not a slot of this call. No comparison
      //   is possible, and the fix is theirs: restate the limit. It counts, so it does not pass.
      finalUserChecklist.push({
        ...item, id: item.id, status: "unverified", source: null,
        note: `constrains names nothing that was looked up: ${unknownTargets.join(", ")}`,
      });
      continue;
    }
    const waitingOn = targets.filter(n => unknownNames.has(n));
    if (waitingOn.length > 0) {
      finalUserChecklist.push({
        ...item, id: item.id, status: "pending_on_slot", source: null, waiting_on: waitingOn,
        note: `cannot be compared yet: ${waitingOn.join(", ")} unknown`,
      });
      continue;
    }
    const out = await safeHook(h.verifyUserChecklistItem, [item, checklistCtx],
      e => ({ status: "unverified", source: null, note: `checklist verification hook failed: ${e?.message ?? String(e)}` }));
    // Three outcomes, not two. "unmet" is a condition that WAS checked and prohibits
    // execution — the specification's hold. Collapsing it into "unverified" makes the
    // record say "not checked" about something that was checked and violated, and sends
    // the user a question they cannot answer: they declared the rule and broke it.
    //   A source is required for unmet, for the same reason a known value needs one.
    const st = out?.status === "verified" ? "verified"
             : (out?.status === "unmet" && out?.source) ? "unmet"
             : "unverified";
    finalUserChecklist.push({ ...item, ...(out ?? {}), id: item.id, status: st });
  }

  // Step 4-b: verify the Provider Checklist — the conditions the provider declared on this tool.
  // Same counting, different routing, and one status fewer. See [PROVIDER CONDITIONS] above.
  const finalProviderChecklist = [];
  for (const cond of providerConditions) {
    const label = normalizeProviderLabel(cond?.label);
    const base = { ...cond, id: cond?.id ?? null, label: cond?.label ?? null };

    if (label === null) {
      // Not a condition we can act on, and not one we may drop. The declaration itself is the gap.
      finalProviderChecklist.push({ ...base, status: "unverified", source: null,
        route: "definition_repair",
        note: base.note ?? `unrecognized label: ${JSON.stringify(cond?.label ?? null)}` });
      continue;
    }

    if (label === "notice") {
      // [Notice] is attached to a constraint, not a condition (4.2.1). It is a disclosure obligation
      //   before execution, not a gate. Gate it and "the user was told" becomes grounds for executing,
      //   which 4.2.1 rules out, and 2.2 says that confirmation degrades into a click-through anyway.
      // Unlike advisory_notes this is structured and identified, and it is surfaced in gate.disclosures
      //   so the executing party cannot miss it. It is still not enforced: whether a sentence reached a
      //   human is not observable here.
      //   POLICY: gating this on an acknowledgement passed back by the caller is the adopting system's
      //     call — 8.3 leaves accepting that risk to its policy.
      finalProviderChecklist.push({ ...base, status: "disclosure_required", source: null, route: null });
      continue;
    }

    // A condition cannot be compared while the slot it constrains is still UNKNOWN. Same reasoning as
    //   the user items above, and the same verification: the item must name the slot, and that slot
    //   must really be unknown here.
    const targets = Array.isArray(cond.constrains) ? cond.constrains : [];
    // A constrains entry that names nothing is a broken declaration, and the provider wrote it, so
    //   it goes back to the provider whatever the label says. The user cannot answer for a field
    //   name in someone else's declaration.
    const unknownTargets = missingTargets(targets);
    if (unknownTargets.length > 0) {
      finalProviderChecklist.push({ ...base, status: "unverified", source: null,
        route: "definition_repair",
        note: `constrains names nothing that was looked up: ${unknownTargets.join(", ")}` });
      continue;
    }
    const waitingOn = targets.filter(n => unknownNames.has(n));
    if (waitingOn.length > 0) {
      finalProviderChecklist.push({ ...base, status: "pending_on_slot", source: null, route: null,
        waiting_on: waitingOn,
        note: `cannot be compared yet: ${waitingOn.join(", ")} unknown` });
      continue;
    }

    const out = await safeHook(h.verifyProviderCondition, [cond, checklistCtx],
      e => ({ status: "unverified", source: null, note: `provider condition hook failed: ${e?.message ?? String(e)}` }));

    // Both outcomes need a source. 5.1 settles a state by whether it was looked up from a declared
    //   source, so "checked" with no source is the hook asserting it rather than evidencing it — the
    //   claim 2.4 says cannot be told from a real one. Symmetry with unmet is the point: name only one
    //   of them and the undefended one becomes the way through.
    let st = (out?.status === "checked" && out?.source) ? "checked"
           : (out?.status === "unmet" && out?.source) ? "unmet"
           : "unverified";
    let note = out?.note ?? null;
    if (out?.status === "checked" && !out?.source) {
      note = `a condition reported checked must name the source it was checked from (5.1)`;
    } else if (out?.status === "unmet" && !out?.source) {
      note = `a condition reported unmet must name the source it was checked from (5.1)`;
    }

    // [Required] is confirmed only from a declared system source (4.2.1). Enforced here rather than
    //   left to the hook: 8.4 turns on a user's request not being an allowed source for a provider
    //   condition, and a rule kept only by hook discipline is a rule the gate does not actually hold.
    //   The test is SYSTEM_SOURCES, not "is it user_answer". Four of the five sources are the user
    //   speaking at different times, so naming one of them leaves the other three open.
    if (label === "required" && st !== "unverified" && !SYSTEM_SOURCES.has(out?.source)) {
      st = "unverified";
      note = `[Required] is confirmed only from a declared system source (4.2.1); hook returned ` +
             `${JSON.stringify(out?.status)} from ${JSON.stringify(out?.source ?? null)}`;
    }

    // [NOT IMPLEMENTED] Spec 6.3 binds each approval to a {slot_id, value} pair, voids it when the value
    //   changes, and records the set of slots shown with it. This skeleton does none of that: a [Verify]
    //   approval is whatever verifyProviderCondition reports, with its source. An approval given for one
    //   amount therefore still reads as given after the amount changes, unless the hook checks.
    //   POLICY: until the gate does it, the hook must compare the approved value against the settled
    //     one in ctx.fields and return unverified on a mismatch. Implementing it here needs a caller
    //     contract for approvals (what was shown, for which values), which this skeleton does not have.
    // The label decides the route, so nothing here is a judgment call. [Verify] creates a user
    //   approval slot; [Required] cannot be answered by the user and is a gap in the declaration
    //   or the lookup path (4.5c).
    const route = st === "unverified"
      ? (label === "verify" ? "ask_user" : "definition_repair")
      : null;

    finalProviderChecklist.push({ ...base, ...(out ?? {}), id: base.id, label: base.label, status: st, route, note });
  }

  // Step 5: tally what is unmet — both fields and checklist. advisory_notes is not tallied.
  // A field whose lookup hook threw is separated out here. It is unknown, but it is not a blank:
  // no user answer fixes a hook that crashed, and asking sends the user a question that will come
  // back identically next run while the one person who can fix it never hears about it.
  // Per 4.5 this is the definition-repair route, not the user-query route.
  const allUnknown = fields.filter(f => f.status === "unknown");
  // 4.5 splits the unknowns by who can resolve them, and the slot's declared sources decide — not the
  //   model, and not this code. The route is already on each slot (routeFor, 6.3); these lists are
  //   read from it, so the gate's lists and the slots' records cannot disagree.
  //   A slot that does not permit user_answer is 4.5(b): the system can answer it and the user is NOT
  //   asked. Before allowed_sources, every unknown went to the user, so a measurement-only slot
  //   produced a question nobody could answer.
  // definition_repair has two causes and two addressees (7.1): a hook that threw is the implementer's,
  //   a source with no place to check (or a source left with no report) is the declaration's.
  const repairFields = allUnknown.filter(f => f.route === "definition_repair");
  const failedLookups = repairFields.filter(f => f.lookup_failed === true);
  const declarationGaps = repairFields.filter(f => f.lookup_failed !== true);
  const unknownFields = allUnknown.filter(f => f.route === "ask_user");
  const systemLookups = allUnknown.filter(f => f.route === "system_lookup");
  const unknown_count = allUnknown.length;   // total. gate is authoritative for what blocks
  // Counted: only what was NOT checked. pending_on_slot waits on a blank that is already
  // counted; unmet was checked and is recorded as unmet, outside the count (spec 6.3).
  const unverifiedItems = finalUserChecklist.filter(
    i => i.status !== "verified" && i.status !== "pending_on_slot" && i.status !== "unmet");
  const unmetItems = finalUserChecklist.filter(i => i.status === "unmet");
  const unverified_checklist_count = unverifiedItems.length;

  // Provider conditions, split by where the work goes rather than by status alone (7.1).
  // disclosure_required and pending_on_slot are counted by neither: the first is not a gate, and the
  // second waits on a blank already in the count.
  const providerUnmet = finalProviderChecklist.filter(c => c.status === "unmet");
  const providerUnverified = finalProviderChecklist.filter(c => c.status === "unverified");
  const providerRepair = providerUnverified.filter(c => c.route === "definition_repair");
  const providerAsk = providerUnverified.filter(c => c.route === "ask_user");
  const providerDisclosures = finalProviderChecklist.filter(c => c.status === "disclosure_required");
  const unverified_provider_count = providerUnverified.length;

  // Step 6: assemble the call from settled values. Slots are what must be settled, arguments are what
  //   gets sent — an optional value the user stated belongs only in the second set.
  // NOTE: assumes "field name = argument key, flat object". Nested schemas are unsupported upstream.
  const call_arguments = Object.fromEntries(
    [...fields, ...extra_fields].filter(f => f.status === "known").map(f => [f.name, f.value])
  );

  // Step 6-a: gate decision. gate is authoritative, reason is a derived rendering.
  // NOTE: no per-Tool risk branching. delete_all_records and list_records pass the same gate.
  const gate = {
    // A slot with a prior_state candidate carries it, so the question can be "use this again?" — the
    //   confirmation 5.2 requires. The answer comes back as user_answer; the candidate itself never settles.
    unknown_fields: unknownFields.map(f => ({ name: f.name, note: f.note ?? null,
      ...(f.prior_candidate ? { candidate: f.prior_candidate } : {}) })),
    unverified_checklist: unverifiedItems.map(i => ({ id: i.id, description: i.description, note: i.note ?? null })),
    _diag: { lookup_failures: lookupFailures([...fields, ...extra_fields]), slot_branch: slotSet.branch ?? null },
  };
  // A broken lookup is definition repair addressed to whoever owns the hook, and it outranks the question
  // to the user: with a crashed extractor the other blanks are not known to be blanks either.
  // kind is set so a consumer can tell "the user didn't say" from "our extractor is broken"
  // without reading _diag, which is diagnostics and not part of the contract.
  if (failedLookups.length > 0) {
    gate.kind = "lookup_failed";
    gate.lookup_failed_fields = failedLookups.map(f => ({ name: f.name, note: f.note ?? null }));
  }
  // A slot whose sources reported no place to check, or left a source no one can re-answer (an
  //   extractor or a caller map with no report). No user answer fills it; the declaration or the
  //   caller has to report (4.5c, 5.1).
  if (declarationGaps.length > 0) {
    if (!gate.kind) gate.kind = "definition_repair";
    gate.definition_repair_fields = declarationGaps.map(f => ({
      name: f.name,
      open: (f.lookup_trace ?? []).filter(t => t.result !== "absent").map(t => `${t.source}:${t.result}`),
      note: f.note ?? null,
    }));
  }
  // 4.5(b): the system can answer these and the user is not asked. Like definition_repair below,
  //   nothing a user answer settles — but a different addressee: the lookup, not the declaration.
  //   Separate fields and separate decision words so a consumer can tell retry from repair (7.1).
  //   Neither is hold: both are routes still open (4.5).
  if (systemLookups.length > 0) {
    if (!gate.kind) gate.kind = "system_lookup";
    gate.system_lookup = systemLookups.map(f =>
      ({ name: f.name, allowed_sources: f.allowed_sources ?? null, note: f.note ?? null }));
  }
  // A provider condition the gate could not compare is the provider's gap, not a question for the
  // user — 4.5(c), the same route as a crashed lookup but a different addressee, which is why the
  // two keep separate fields (7.1: a parser problem belongs to the implementer, an undeclared or
  // unreadable condition to whoever declared it).
  if (providerRepair.length > 0) {
    if (!gate.kind) gate.kind = "definition_repair";
    gate.definition_repair = providerRepair.map(c =>
      ({ id: c.id, label: c.label, description: c.description, note: c.note ?? null }));
  }
  // [Verify] conditions still waiting on the user's approval. A blank like any other.
  if (providerAsk.length > 0) {
    gate.unverified_provider = providerAsk.map(c =>
      ({ id: c.id, label: c.label, description: c.description, note: c.note ?? null }));
  }
  // [Notice] items. Never counted, never a reason to hold — there is nothing to satisfy, and gating
  // one would make "the user was told" grounds for executing, which 4.2.1 rules out.
  //   This is a HAND-OFF, not a check. The gate cannot observe whether a sentence reached a human, so
  //   it states the obligation and the executing party discharges it (3.5). A consumer that ignores
  //   this field executes without a disclosure the provider required — the gate records that it said
  //   so, and nothing more.
  //   POLICY: whether to require an acknowledgement before executing is the adopting system's call.
  //     8.3 leaves accepting that kind of risk to its policy.
  if (providerDisclosures.length > 0) {
    gate.disclosures = providerDisclosures.map(c =>
      ({ id: c.id, description: c.description, declared_by: "provider", required_before_execution: true }));
  }
  // A checked condition that prohibits execution is recorded, not asked about. One list for both
  // declarers, each entry tagged: the verdict is the same, the addressee is not (7.1).
  // 6.3: a required value confirmed as NULL is unmet. fields are the materialized slots — the ones the
  //   tool requires — so every NULL among them prohibits. The requirement is the tool's (4.2), hence
  //   declared_by provider. An optional argument that is NULL is not here: it is simply not sent.
  //   BREAKS: leave it out — as the first cut of NULL did — and a required slot every source reported
  //     empty is neither unknown nor unmet, so the gate counts zero and executes without it.
  const nullRequired = fields.filter(f => f.status === "null");
  const allUnmet = [
    ...unmetItems.map(i => ({ id: i.id, description: i.description, note: i.note ?? null, declared_by: "user" })),
    ...providerUnmet.map(c => ({ id: c.id, description: c.description, note: c.note ?? null, declared_by: "provider", label: c.label })),
    ...nullRequired.map(f => ({ id: f.name, slot: f.name, declared_by: "provider", kind: "required_null",
      description: `required value "${f.name}" — every permitted source reported none`,
      note: `NULL from ${(f.lookup_trace ?? []).map(t => t.source).join(", ")} (6.3)` })),
  ];
  if (allUnmet.length > 0) {
    gate.unmet = allUnmet;
  }
  const valueGateClean = repairFields.length === 0 && providerRepair.length === 0 &&
    systemLookups.length === 0 &&
    gate.unknown_fields.length === 0 && gate.unverified_checklist.length === 0 &&
    providerAsk.length === 0;

  // Step 6-b: whole-object validation. Run only on an otherwise clean gate — with unknowns outstanding
  //   the object is knowingly incomplete and the violation says nothing.
  const payloadOut = valueGateClean
    ? await safeHook(h.validatePayload, [call_arguments, mcpTool?.inputSchema, ctx],
        e => `payload validation hook failed: ${e?.message ?? String(e)}`)
    : null;
  const payload_violation = typeof payloadOut === "string" ? payloadOut : null;
  if (payload_violation) {
    // Not a question. Every slot is settled and the object is still illegal.
    if (!gate.kind) gate.kind = "payload_invalid";
    gate.payload_violation = payload_violation;
  }

  // An unmet condition is a hold whether or not blanks remain. It was compared against SETTLED
  // values — a condition whose target is still unknown is pending_on_slot, and one whose target
  // names nothing is unverified — so filling the remaining blanks cannot turn it met. Asking then
  // sends the user to fill in a form for an execution that is already prohibited, and 4.5 says a
  // hold does not go back to asking.
  //   The blanks are still in the record; what changes is that they are not asked about.
  //   BREAKS: ask anyway and the user answers three questions to be told no at the end.
  if (allUnmet.length > 0 && !gate.kind) gate.kind = "unmet";

  // kind precedence, most-doubt-casting first. Each is set only if nothing earlier claimed it, and
  // every field stays present, so a consumer reading one kind never loses the rest:
  //   lookup_failed     the extractor crashed, so no other blank is known to be a blank either
  //   definition_repair a declaration could not be read
  //   unmet             everything readable was read, and a declared condition prohibits this
  //   payload_invalid   every slot settled and the object is still illegal
  // BREAKS: overwrite unconditionally — as this did — and the kind reported depends on the order
  //   the branches happen to run in.
  // Decision. hold is reserved for what 4.5 calls hold: the check FINISHED and its result prohibits.
  //   A route still open is named as that route, not as hold (4.5: merge "a finished check" with "a
  //   missing check" and the work loses where it should go).
  //   hold               unmet (user or provider condition checked and prohibits), payload_invalid
  //   definition_repair  a lookup hook threw, or a provider condition could not be compared (4.5c)
  //   system_lookup      a blank only the system can answer (4.5b). The user is not asked
  //   ask_user           a blank the user can answer (4.5a)
  //   exhausted          what is left is on a route that reached its ceiling (4.5: a route that reaches
  //                      its ceiling has finished and is not tried again). Not hold — nothing was found
  //                      to prohibit — and not NULL — a ceiling is not a report of nothing (5.2)
  // Precedence: a finished prohibition first — no route still open can turn an unmet condition met,
  //   since it was compared against SETTLED values. Then the open routes, the one no user answer can
  //   close before the one it can: definition_repair, system_lookup, ask_user. A route past its
  //   ceiling is not open, so the next one is tried; exhausted only when none is left.
  //   POLICY: system_lookup above ask_user means the user is not asked while a system answer is
  //     outstanding. Both lists stay in gate, so an adopter that wants both at once can read both.
  //   NOTE: this precedence is for the decision word. gate.kind keeps its own precedence above, so a
  //     record can carry decision hold with kind lookup_failed. gate is authoritative (6.4).
  //   definition_repair has no ceiling: retrying a declaration gap changes nothing, so it is not
  //     retried in the first place — it waits on whoever owns the declaration.
  const askOutstanding = gate.unknown_fields.length + gate.unverified_checklist.length + providerAsk.length;
  const askExhausted = askAttempt >= h.limits.ask;
  const lookupExhausted = lookupAttempt >= h.limits.lookup;
  const execution_decision =
    allUnmet.length > 0 ? "hold"
    : (repairFields.length > 0 || providerRepair.length > 0) ? "definition_repair"
    : (systemLookups.length > 0 && !lookupExhausted) ? "system_lookup"
    : payload_violation ? "hold"
    : (askOutstanding > 0 && !askExhausted) ? "ask_user"
    : (systemLookups.length > 0 || askOutstanding > 0) ? "exhausted"
    : "execute";
  // The counts go back to the caller, which carries them (the gate is stateless), the same contract
  //   as intent_attempt: send next_* back as input on the re-run, null means do not re-enter that route.
  gate.next_ask_attempt = execution_decision === "ask_user" ? askAttempt + 1 : (askExhausted ? null : askAttempt);
  gate.next_lookup_attempt = execution_decision === "system_lookup" ? lookupAttempt + 1
    : (lookupExhausted ? null : lookupAttempt);
  if (execution_decision === "exhausted") {
    if (!gate.kind) gate.kind = "exhausted";
    gate.exhausted = [
      ...(systemLookups.length && lookupExhausted
        ? [{ route: "system_lookup", attempt: lookupAttempt, limit: h.limits.lookup, names: systemLookups.map(f => f.name) }] : []),
      ...(askOutstanding && askExhausted
        ? [{ route: "ask_user", attempt: askAttempt, limit: h.limits.ask,
             names: [...gate.unknown_fields.map(f => f.name), ...gate.unverified_checklist.map(i => i.id),
                     ...providerAsk.map(c => c.id)] }] : []),
    ];
  }

  return {
    fixed, action_key, phase, fields, extra_fields,
    advisory_notes: advisoryNotes,   // Recorded only. Not part of the gate
    user_checklist: finalUserChecklist,
    provider_checklist: finalProviderChecklist,
    unknown_count, unverified_checklist_count, unverified_provider_count,
    call_arguments,                  // The exact object executeIfReady sends
    gate,
    execution_decision,
    // Rendered from the same branch as the decision, so the reason never names a different verdict.
    reason: allUnmet.length > 0
      ? `hold: unmet — ${allUnmet.map(i => `${i.id} [${i.declared_by}] (${i.note ?? "prohibited"})`).join("; ")}`
      : failedLookups.length > 0
      ? `definition_repair: lookup hook failed — ${failedLookups.map(f => f.name).join(", ")} ` +
        `(definition/implementation gap; no user answer settles these)`
      : providerRepair.length > 0
      ? `definition_repair: provider condition not comparable — ${providerRepair.map(c => c.id ?? "(unidentified)").join(", ")} ` +
        `(no user answer settles these)`
      : declarationGaps.length > 0
      ? `definition_repair: no source can answer — ${declarationGaps.map(f => f.name).join(", ")} ` +
        `(no place to check, or a source that gave no report; no user answer settles these)`
      : execution_decision === "exhausted"
      ? `exhausted: ${gate.exhausted.map(e => `${e.route} ${e.attempt}/${e.limit} (${e.names.join(", ")})`).join("; ")}`
      : payload_violation && execution_decision === "hold"
        ? `hold: payload invalid — ${payload_violation}`
        : await h.formatReason(execution_decision, gate),
    timestamp: h.now(),
  };
}

// [OPTIONAL] Rendering only. Not part of the gate decision, adds no information.
function formatReason(execution_decision, gate) {
  const lf = gate?.lookup_failed_fields?.length ?? 0;
  const pv = gate?.unverified_provider?.length ?? 0;
  const dr = gate?.definition_repair?.length ?? 0;
  const sl = gate?.system_lookup?.length ?? 0;
  const ds = gate?.disclosures?.length ?? 0;
  return `${execution_decision}: unknown_fields=${gate?.unknown_fields?.length ?? 0}, ` +
    `unverified_checklist=${gate?.unverified_checklist?.length ?? 0}` +
    (pv ? `, unverified_provider=${pv}` : "") +
    (dr ? `, definition_repair=${dr}` : "") +
    (sl ? `, system_lookup=${sl}` : "") +
    (lf ? `, lookup_failed=${lf}` : "") +
    (ds ? `, disclosures=${ds}` : "");
}

// [OPTIONAL] POLICY: preserve = intent at instruction time (instruction/userChecklist/userAnswers).
//       re-fetch = reality at trigger time (mcpTool schema/preSetData).
//       measured_data and checklistAnswers must not be preserved (stale measurements; conditions are a trigger-time decision).
// NOTE: preserving is freezing. user_answer is the first source and beats the measurement at trigger time.
//   Values that go stale should not be asked for — pass them through with pending_at_trigger.
function buildDeferredInput({ instruction, mcpTool, preSetData, userChecklist, userAnswers }) {
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
    schema_version: "1.12",   // 1.5: fixed slots may be null (unsettled). 1.6: fixed.c2_source added
    //   1.12: a derived field carries derived_from (every input it rests on, verified by the gate).
    //        On older records derived: true with no derived_from means the inputs were not recorded.
    //   1.11: fields[] carry route (4.5 route of an unknown, 6.3) and lookup_trace (each consulted source
    //        and what it returned, 5.2, including a hook's report of nothing: absent / no_place). On the value gate, execution_decision may be "system_lookup" or
    //        "definition_repair"; "hold" there now means only a finished check that prohibits. A 1.10
    //        record's "hold" may be any of the three — read its gate.kind.
    //   1.8: fixed.c3_match added. Older records record no approval, only refusals.
    //   Pre-1.6 records may carry comparison_key fields; the skeleton neither writes nor reads them.
    //   1.7: fields[] may carry lookup_failed / _diag_note; gate._diag may carry lookup_failures
    //   1.10: fields[] carry allowed_sources; gate may carry system_lookup (4.5b). On an older record
    //        a missing allowed_sources means the field did not exist, not that nothing was permitted.
    //   1.9: provider_checklist / unverified_provider_count added; gate may carry definition_repair,
    //        unverified_provider and disclosures, and gate.unmet entries now carry declared_by.
    //        On a pre-1.9 record the absence of provider_checklist means the field did not exist,
    //        NOT that the tool declared no conditions.
    //   Readers must not assume fixed slots are strings, nor that c2_source exists on older records
    // NOTE: this object is a whitelist, not a spread of executionState. A field computed by the gate
    //   and left out here is computed and then dropped — it reaches no consumer and no later run.
    //   BREAKS: add a gate output without adding it here and the verdict silently loses it.
    // [NOT IMPLEMENTED] Spec 6.1 asks the record to carry WHICH VERSION of the checklist the verdict
    //   was made against, because a changed checklist voids earlier verdicts based on it. This
    //   skeleton records no version and compares none.
    //   POLICY: the adopting system manages this. The practical exposure is narrow — conditions are
    //     never inherited (5.2) and are re-read at trigger time (4.5), so a stale checklist does not
    //     produce a wrong verdict today. What is lost is reconstructing a PAST verdict: given a rule
    //     that has since changed, the record cannot say which wording was in force.
    //   An adopter that needs it puts a version on each item and carries it through: the gate passes
    //     unrecognized item fields along untouched, so the version lands in user_checklist and
    //     provider_checklist without the gate having to know about it.
    action_key,
    phase: executionState.phase ?? null,   // Instruction-time and trigger-time records accumulate under the same key
    fixed: executionState.fixed,
    fields: executionState.fields,
    advisory_notes: executionState.advisory_notes ?? "",   // Not part of the gate. Recorded for audit
    user_checklist: executionState.user_checklist,
    provider_checklist: executionState.provider_checklist ?? null,   // null = no decision made, not []
    unknown_count: executionState.unknown_count,
    unverified_checklist_count: executionState.unverified_checklist_count ?? null,
    unverified_provider_count: executionState.unverified_provider_count ?? null,
    gate: executionState.gate ?? null,
    call_arguments: executionState.call_arguments ?? null,   // The exact payload executeIfReady sends
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
// [DEMONSTRATION ONLY — this function is where the skeleton departs from the specification]
//
// The specification separates verdict from execution (3.5): the gate records slot states, the
// routes taken, the count and the unmet items, and then the EXECUTING PARTY loads that record
// by action_key + phase, decides for itself, and writes its own record. Nothing executes from
// the gate's own record.
//
// This skeleton instead writes `execution_decision` into the gate's record and this function
// follows it. That is not the separation; it is a convenience so a single-process example runs
// end to end. The branch `if (decision === "execute") executeIfReady(...)` reproduces inside one
// call stack exactly what the specification asks to be two parties.
//   BREAKS: carried into a real system, the thing that decided is the thing that executed, and
//     the record cannot show that anyone else agreed. Load the record on the executing side.
// POLICY: a conforming adopter deletes this function and reads the persisted record instead.
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
// NOTE: applyFieldPolicy's default validates nothing (prior_state is refused by the gate, not by it). It stays on this list for that.
// NOTE: unwired, validatePayload lets a value that fills its slot while violating the schema through.
// NOTE: spanSupportsValue's default does equality, which its contract says is not sufficient.
//   Unwired, a limit or a negation containing a value-shaped token settles a slot (see 8.x).
// NOTE: getAllowedSources returns null, meaning all five sources, for every slot. Unwired, every
//   unknown is askable and 4.5(b) is not honored: a slot only the system can answer still produces a
//   question for the user. Direction is safe (more sources consulted, none newly accepted — the
//   policy hook still judges), but the route is wrong.
// NOTE: getProviderConditions returns [] for every tool, so unwired the provider checklist is back to
//   arguments only and a declared condition is silently absent.
// NOTE: verifyProviderCondition verifies nothing. Unwired it is safe in DIRECTION — a provider condition
//   can only block, so it never opens anything — but every declared condition then lands as unverified
//   and routes to definition_repair, which holds. Weak, not fail-open, and loud rather than silent.
const UNSAFE_DEFAULT_HOOKS = ["applyFieldPolicy", "validateFieldSchema", "verifyUserChecklistItem",
                              "validatePayload", "spanSupportsValue",
                              "getProviderConditions", "verifyProviderCondition",
                              "getAllowedSources"];

const defaultHooks = {
  classifyWhenCase, extractUserActionName, confirmToolNameMatchesIntent,
  getRequiredFields, getCandidateSlots, materializeSlots, getAdvisoryNotes,
  getProviderConditions, verifyProviderCondition, getAllowedSources,
  extractFromInstruction, spanSupportsValue, measureFromEnvironment,
  applyFieldPolicy, validateFieldSchema, validatePayload, verifyUserChecklistItem,
  formatReason, buildDeferredInput, buildActionKey,
};

/**
 * Build a preflight instance by injecting hooks and ports.
 * Missing required hooks, missing storage, and misspelled hook names fail at construction, not as a runtime hold.
 * With strict=true, the defaults of [REQUIRED-SAFETY] hooks (which do not verify) are also rejected.
 * If unsafeDefaults in the return value is non-empty, the gate is in a weak state.
 */
function createPreflight({ hooks = {}, storage, clock, strict = false, limits = {} } = {}) {
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

  // Route ceilings (4.5: "the adopting system sets the ceiling"). Defaults match INTENT_ATTEMPT_LIMIT.
  //   A value that is not a non-negative integer falls back to the default rather than to no ceiling.
  const lim = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);
  const routeLimits = { ask: lim(limits.ask, ASK_ATTEMPT_LIMIT), lookup: lim(limits.lookup, LOOKUP_ATTEMPT_LIMIT) };
  const h = { ...defaultHooks, ...hooks, storage, limits: routeLimits,
              now: clock ?? (() => new Date().toISOString()) };

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
 * Step 0. checklist id check ────────► "definition_repair" (config defect — before any question is asked)
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
 *      └─ [attempt >= 2] ────────────────► "exhausted" (kind: intent_undetermined_exhausted)
 *                                           └─ next_intent_attempt = null. No auto re-entry; resolve in
 *                                              conversation. Carry-forward is default, reset needs a
 *                                              new-request signal (see POLICY).
 *      ▼
 * Step 1-b. buildActionKey(userId, fixed) → action_key
 *      └─ throws ────────────────────────► "definition_repair" (kind: action_key_failed)
 *      │ └─ Both the record key and the prior_state lookup key. It sets the blast radius.
 *      ▼
 * Step 1-c. confirmToolNameMatchesIntent
 *      ├─ [approved !== true, tool_attempt <  2] ► "ask_user" (kind: tool_undetermined)
 *      │                                    └─ next_tool_attempt = attempt+1; reselect mcpTool, re-call
 *      ├─ [approved !== true, tool_attempt >= 2] ► "exhausted" (kind: tool_undetermined_exhausted)
 *                                           └─ next_tool_attempt = null. Settle the Tool in conversation.
 *      ▼
 * Step 1-1. phase = (c1 === "immediate") ? at_trigger : at_instruction
 *      ▼
 * Step 2-a. getCandidateSlots → the superset the lookup may try (declared properties ∪ every branch's required)
 *      └─ not a list ────────────────────► "definition_repair" (kind: schema_unsupported)
 *      ▼
 * Step 2-3. resolveField per candidate                      ← common to both phases
 *      │ └─ lookupField walks five sources → all empty means "unknown"
 *      │    an instruction/measurement hook that THROWS settles unknown on the spot — no later source,
 *      │    no applyFieldPolicy
 *      │    (known then goes applyFieldPolicy → validateFieldSchema; a violation demotes to unknown)
 *      ▼
 * Step 3-0. materializeSlots(mcpTool, groundedNames)  ← grounded = came back known, nothing else
 *      ├─ unsupported ──────────────────► "definition_repair" (kind: schema_unsupported)
 *      ├─ branch_unresolved / conflict ─► "ask_user" (carries branch_options, no unknown_fields)
 *      └─ resolved → fields = the slot set, extra_fields = everything else that was looked up
 *      ▼
 * Step 3-a. [at_instruction] values now, conditions at trigger
 *      │ └─ unknowns by route (routes as in Step 5-6). system_lookup and NULL slots are excused to the
 *      │    trigger (4.5: only what was confirmed by asking is fixed now); pending_at_trigger likewise
 *      ├─ [route definition_repair] ─────► "definition_repair"
 *      ├─ [route ask_user, ask under ceiling] ► "ask_user" (ask before scheduling)
 *      ├─ [route ask_user, ask at ceiling] ──► "exhausted"
 *      ├─ [none of the above] ───────────► "deferred" (+ fields, deferred_input)
 *      ▼  (below: at_trigger only)
 * Step 4. verifyUserChecklistItem (at_trigger only — conditions must be judged now)
 *      │ └─ anything other than status === "verified" becomes "unverified"
 *      ▼
 * Step 5-6. gate tally → assemble call_arguments (fields ∪ extra_fields, known only) → validatePayload
 *      Each slot not found is one of (computed by the gate from allowed sources + lookup_trace, 6.3):
 *      ├─ every permitted source reported absent ► status "null" (5.1). Required → unmet
 *      ├─ hook threw, or a no_place report ─► route definition_repair (4.5c)
 *      ├─ user_answer permitted, user has not said "none" ► route ask_user (gate.unknown_fields)
 *      ├─ a measurement still open ─────► route system_lookup     (4.5b, user not asked)
 *      └─ anything else left open ──────► route definition_repair (a source that cannot report)
 *      prior_state never settles: a value there is a candidate carried on the question (5.2)
 *      Decision, first match wins:
 *      ├─ [any unmet, incl. required NULL] ─────────────► "hold"   (a finished check that prohibits — 4.5)
 *      ├─ [route definition_repair, or provider condition not comparable] ► "definition_repair"
 *      ├─ [route system_lookup, lookup under ceiling] ──► "system_lookup"
 *      ├─ [unknown 0 AND unverified 0, payload invalid] ► "hold"   (kind: payload_invalid)
 *      ├─ [anything to ask, ask under ceiling] ─────────► "ask_user"
 *      ├─ [what is left is past its ceiling] ───────────► "exhausted"
 *      └─ [otherwise] ──────────────────────────────────► "execute" ─► executeIfReady ─► record "executed"
 *      NOTE: executeIfReady sends call_arguments verbatim. It never rebuilds the payload.
 *
 * Feedback: only executed records become the baseline for prior_state on the next run.
 * Exception: a throw at any step is caught by runPreflight's backstop as "definition_repair".
 *
 * hold, everywhere in this file, means only what 4.5 means: a check that finished and prohibits. The
 *   early returns above the value gate are not that. A config defect, an action_key that could not be
 *   built, an unsupported schema and the backstop are gaps in a definition or an implementation
 *   (definition_repair, 4.5c). Intent and tool asks that reached their ceiling are routes that ended
 *   (exhausted, 4.5: "a route that reaches its ceiling has finished"). gate.kind names each one.
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
 *   Routing      an unknown's route comes from the slot's declared allowed sources, the same ordered
 *                first-hit-wins shape C2 has had in resolveFixedChecklist from the start, and is
 *                written on the slot (fields[].route); the gate's lists are read from it
 *   Separation   trust-labeled segments; fixed checklist (C1/C2/C3) kept apart from value lookup;
 *                three lists kept apart by declarer — fields (arguments), user_checklist,
 *                provider_checklist. Only the first is ever sent to the tool.
 *   Validation   lookupField → applyFieldPolicy → validateFieldSchema
 *   Direction    a user item may end verified; a provider condition may only block. Satisfying one
 *                promotes nothing, so an always-true condition is never a fail-open switch
 *   Binding      gate → execution_decision → executeIfReady (the record is read, not re-derived)
 *   Traceability source / origin_source / declared_by on unmet / recordExecutionState
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
 *               prior_state never settles: an executed record's value becomes a candidate the user confirms (5.2)
 * - Timing:     values at instruction time, conditions at trigger time. Only values that cannot be asked for now get pending_at_trigger
 * - Decision:   if even one unknown remains, do not execute — record instead
 * - Execution:  reference only recorded state. A hook failure is not a pass; it is unmet
 * ============================================================================
 */
