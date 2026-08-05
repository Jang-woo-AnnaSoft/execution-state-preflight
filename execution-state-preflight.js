/**
 * ============================================================================
 * [Execution State Preflight Architecture] — a verification skeleton that runs
 * before an MCP Tool call.
 *
 * The core is lookupField (marked [CORE]). Everything else exists so that
 * decision runs without gaps.
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
 *   // preSetData[fieldName] = PreSetEntry. A raw value without the wrapper is not accepted.
 *   // POLICY: what counts as a "decision" is up to the adopting system. The skeleton only checks shape.
 *
 * @typedef {Object} FieldRecord
 * @property {string} name
 * @property {*} value
 * @property {"known"|"unknown"} status
 * @property {"instruction"|"pre_set_data"|"measured_data"|"prior_state"|"user_answer"|null} source
 * @property {"instruction"|"pre_set_data"|"measured_data"|"user_answer"|null} [origin_source]
 *   // The first source. prior_state can never appear here (it inherits). Baseline eligibility per origin_source belongs in applyFieldPolicy.
 * @property {boolean} [pending_at_trigger]
 *   // Marks "unknown is correct now, will be settled at trigger time". Only applyFieldPolicy sets it.
 *   // It excuses a field only at the at_instruction gate. At at_trigger, unknown is unmet without exception.
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
 * @property {"value_gate"|"tool_undetermined"} [kind]  // Omitted means value_gate (the original shape)
 * @property {{name: string, note: string|null}[]} [unknown_fields]        // Absent on tool_undetermined
 * @property {{id: string, description: string, note: string|null}[]} [unverified_checklist]
 * @property {string} [user_message]    // tool_undetermined only. Shown to the user verbatim.
 * @property {Object} [_diag]           // Logs only. Never expose to the user (contains candidate_tool).
 *
 * @typedef {Object} ExecutionState
 * @property {string|null} action_key   // Baseline lineage key. null if it failed before fixed was settled.
 * @property {"at_instruction"|"at_trigger"|null} phase
 *   // Records from both moments accumulate under the same action_key. This is the key that separates them.
 * @property {Object|null} fixed        // C1(When/Case) / C2(User Action Name) / C3(Tool Name)
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

// User-facing text. Does not include the candidate Tool name.
// BREAKS: naming it turns the question into an approval step (users pick what they are shown).
// POLICY: with few Tools you may present a list. No default selection, no "recommended" marker.
const MSG_TOOL_UNDETERMINED =
  "I could not determine which tool to use. Please restate what you want to do.";

async function safeHook(fn, args, onFail) {
  try {
    return await fn(...args);   // BREAKS: drop the await and an async hook's rejection escapes, letting an unverified value through
  } catch (e) {
    return onFail(e);
  }
}

function unidentifiedChecklistIndexes(userChecklist) {
  return (userChecklist ?? [])
    .map((item, idx) => (typeof item?.id === "string" && item.id !== "" ? -1 : idx))
    .filter(idx => idx >= 0);
}

// 2. Settling C1/C2/C3
async function resolveFixedChecklist(h, instruction, mcpTool) {
  return {
    c1_when_case: await h.classifyWhenCase(instruction),
    c2_user_action_name: await h.extractUserActionName(instruction),
    c3_provider_action_name: mcpTool.name,
  };
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
function confirmToolNameMatchesIntent(userActionName, mcpTool) {
  throw new Error("not implemented");
}

// 3. Provider Checklist — enforceable (inputSchema.required) vs advisory (description)
//    POLICY: annotations are server self-reported, so they stay out of the gate. Including them is the adopting system's call.
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
//    BREAKS: reorder them and a later intent loses to an earlier one. Demote user_answer and the answer given at instruction time is ignored.
async function resolveField(h, fieldName, ctx) {
  // BREAKS: move this below the lookup and a slow hook's value gets recorded as fresher than it is.
  const resolved_at = h.now();
  const record = await lookupField(h, fieldName, ctx);
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
// NOTE: rejections leave no trace in the record. (This is lookup, not validation.)
//     Demotion reasons from the validation stage are written to note by resolveField.
// ────────────────────────────────────────────────────────────────
async function lookupField(h, fieldName, ctx) {
  const { userAnswers, instruction, preSetData, priorExecutionState } = ctx;
  // For tiers 0–3, this decision is itself the first source.
  const fresh = rec => ({ ...rec, origin_source: rec.source });

  // Tier 0: user answer (injected on re-run after ask_user)
  // NOTE: filling userAnswers happens outside the skeleton.
  // BREAKS: put LLM parsing output here and the top tier becomes model output.
  if (userAnswers && fieldName in userAnswers) {
    return fresh({ name: fieldName, value: userAnswers[fieldName], status: "known", source: "user_answer" });
  }

  // Tier 1: instruction — known only from a trusted segment with a valid span.
  //   To use a value from an untrusted segment, ask and take it back as user_answer.
  //   If instruction is a string, this entire tier dies (fail-closed).
  const fromInstruction = await h.extractFromInstruction(fieldName, instruction);
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
  const fromMeasurement = await h.measureFromEnvironment(fieldName, ctx);
  if (fromMeasurement !== undefined && fromMeasurement.valid) {
    return fresh({ name: fieldName, value: fromMeasurement.value, status: "known", source: "measured_data" });
  }

  // Tier 4: prior Execution State. Only executed records are baseline.
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
//   BREAKS: an over-asked answer freezes as user_answer (tier 0) and beats the measurement at trigger time.
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
function measureFromEnvironment(fieldName, ctx) {
  if (ctx.measured_data && fieldName in ctx.measured_data) return ctx.measured_data[fieldName];
  return undefined;
}

// [REQUIRED-OP] Extract a value from the instruction (LLM). Unimplemented means every field stays unknown.
// CONTRACT: instruction is an InstructionSegment[].
//   Found → { value, segment_index, span: [start, end] }  /  not found or extraction failed → undefined
//   segment_index = the segment the value came from. span = the character range within that segment's text (half-open).
//   A missing or out-of-bounds span is rejected. The skeleton checks shape and bounds only.
//   BREAKS: misreport a trusted segment and the trust check is defeated.
// POLICY: the comparison method (literal match / compare after normalization) and whether derived values
//   ("tomorrow" → a date) count as known belong to the adopting system.
//   BREAKS: allow derived values and span becomes a pointer to supporting text, not proof of the value.
function extractFromInstruction(fieldName, instruction) {
  return undefined;
}

// 4-1. User Checklist — same principle as fields. Not verified for non-immediate work (deferred): it would be stale at trigger time.

// [REQUIRED-SAFETY] CONTRACT: do not throw, return with status filled in. Undecidable or failed → unverified.
// The default implementation does not trust the incoming status. Only what the hook actively verified is verified.
function verifyUserChecklistItem(item, ctx) {
  return { ...item, status: "unverified", source: null, note: "verification hook not implemented (default)" };
}

// 5. Running preflight

// backstop — the last layer for failures that per-hook demotion cannot catch. Returns a recordable state even when something blows up.
async function runPreflight(h, input) {
  try {
    return await runPreflightInner(h, input);   // BREAKS: drop the await and the catch below cannot catch the rejection
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

async function runPreflightInner(h, { userId, instruction, mcpTool, preSetData, measured_data, priorExecutionState, agentPolicy, userChecklist, userAnswers, checklistAnswers }) {
  const checklist = userChecklist ?? [];

  // Step 1: settle Fixed. Every failure holds without throwing.
  //   BREAKS: move this later and subsequent returns are recorded without an action_key, severing the lineage.
  const fixed = await resolveFixedChecklist(h, instruction, mcpTool);

  // C1 enum check.
  // BREAKS: remove this and an out-of-enum value gets swallowed as deferred by Step 1-1's `!== "immediate"`, waiting forever.
  if (!WHEN_CASES.includes(fixed?.c1_when_case)) {
    return {
      fixed, action_key: null, phase: null, fields: null, advisory_notes: "", user_checklist: checklist,
      unknown_count: null, unverified_checklist_count: null,
      gate: null,
      execution_decision: "hold",
      reason: `invalid c1_when_case: ${JSON.stringify(fixed?.c1_when_case)} (allowed: ${WHEN_CASES.join(" | ")})`,
      timestamp: h.now(),
    };
  }

  // NOTE: if the same instruction is classified "scheduled" again on the trigger re-run, it waits forever.
  //   Carrying trigger context in the input so it lands on immediate is the adopting system's job.
  const phase = fixed.c1_when_case === "immediate" ? "at_trigger" : "at_instruction";

  const action_key = await h.buildActionKey(userId, fixed);

  // Checklist id check. The skeleton does not assign arbitrary ids.
  //   BREAKS: let an item through without an id and there is no key to reattach the ask_user answer to.
  const unidentified = unidentifiedChecklistIndexes(checklist);
  if (unidentified.length > 0) {
    return {
      fixed, action_key, phase, fields: null, advisory_notes: "", user_checklist: checklist,
      unknown_count: null, unverified_checklist_count: null,
      gate: null,
      execution_decision: "hold",
      reason: `checklist item without id at index: ${unidentified.join(", ")}`,
      timestamp: h.now(),
    };
  }

  // Step 1-0: Tool determination gate. Must sit above getRequiredFields/getAdvisoryNotes.
  //   BREAKS: move it lower and an undetermined Tool's required/description ride into the gate.
  const matchResult = await safeHook(h.confirmToolNameMatchesIntent, [fixed.c2_user_action_name, mcpTool],
    e => ({ approved: false, reason: `hook_error: ${e?.message ?? String(e)}` }));
  // Shape is checked too. undefined and missing fields are also not approved — a hook's silence is not approval.
  if (matchResult?.approved !== true) {
    // ask_user, not hold. Undetermined is something to ask about, not a defect.
    return {
      fixed, action_key, phase,
      // null = no decision made. Distinct from [] ("computed, came out empty").
      fields: null,
      advisory_notes: "",              // Do not carry an undetermined Tool's description
      user_checklist: checklist,       // Echo of the raw input. Not a verification result
      unknown_count: null,             //   "no decision made" is expressed by count: null
      unverified_checklist_count: null,
      gate: {
        kind: "tool_undetermined",
        user_message: MSG_TOOL_UNDETERMINED,
        // Logs only. A mismatch and a hook exception are operationally different signals.
        _diag: {
          candidate_tool: mcpTool?.name ?? null,
          user_action: fixed?.c2_user_action_name ?? null,
          reason: matchResult?.reason ?? "hook did not return { approved, reason }",
        },
      },
      execution_decision: "ask_user",
      reason: `ask_user: tool undetermined (${matchResult?.reason ?? "hook did not return { approved, reason }"})`,
      timestamp: h.now(),
    };
  }

  // ── Everything below is reached only after the Tool is determined ───────────
  // [CALLER CONTRACT] Decide execution by an allow condition.
  //     if (executionState.execution_decision !== "execute") return;   // correct
  //     if (result.unknown_count > 0) { ... }                          // wrong
  //   BREAKS: used as a block condition, null > 0 === false lets the not-yet-computed state through.
  //
  // [ask_user re-entry] The answer to tool_undetermined is not userAnswers — replace mcpTool and call again.
  //   NOTE: re-running the hook on the reselected Tool loops the question forever. The flag belongs in the input, set by the adopting system.
  //   The skeleton does not read it (it would become a bypass switch). Only the name is fixed: input.tool_reselected_by_user.
  //
  // [Re-ask ceiling] When it repeats under the same action_key, hold after a ceiling (2–3). Counting attempts is the adopting system's job.

  // Step 2: Provider Checklist — separate enforceable from advisory
  const requiredFields = await h.getRequiredFields(mcpTool);
  const advisoryNotes = await h.getAdvisoryNotes(mcpTool);

  // Step 3: per-field lookup chain → Known/Unknown records (enforceable only). Common to both phases.
  //   BREAKS: skip it for non-immediate work and you learn a value is missing only at trigger time (with nobody to ask).
  const ctx = { userAnswers, checklistAnswers, instruction, preSetData, measured_data, priorExecutionState, agentPolicy,
                phase,   // The basis for applyFieldPolicy's per-phase judgment
                fieldSchemas: mcpTool?.inputSchema?.properties ?? {} };
  // Sequential resolution. BREAKS: parallelize and LLM/measurement calls fire at once, one per field (rate limits, cost).
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
          _diag: { phase, pending_at_trigger: pendingCount },
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
  // BREAKS: shorten to gate?.unknown_fields.length and a tool_undetermined gate throws a TypeError.
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
function buildActionKey(userId, fixed) {
  throw new Error("not implemented");
}

async function recordExecutionState(h, executionState) {
  // Records with a null action_key (failed before fixed was settled) have no lineage. Collect them under a reserved key.
  const action_key = executionState.action_key ?? null;
  const record = {
    schema_version: "1.4",
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
//   NOTE: the port contract carries no integrity requirement. Append-only, access control, and masking belong in the adapter.

// 6. Execution — call the actual MCP Tool only when the gate is satisfied (execute)
// CONTRACT: pass only a record returned by recordExecutionState.
// NOTE: no re-fetch from storage, no integrity check. Hand it a hand-built object and the gate is bypassed.
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

  // Only executed counts as baseline.
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

module.exports = { createPreflight, defaultHooks };


/* ============================================================================
 * [APPENDIX] Decision path — top to bottom. Early exits take precedence.
 *
 * Instruction (array of trust-labeled segments)
 *      ▼
 * Step 1. resolveFixedChecklist
 *      │ └─ Extract C1 (When/Case), C2 (User Action Name); C3 = mcpTool.name
 *      ├─ [C1 outside WHEN_CASES] ───────► "hold" (early exit)
 *      ▼
 * Step 1-a. buildActionKey(userId, fixed) → action_key
 *      │ └─ Both the record key and the prior_state lookup key. It sets the blast radius.
 *      ├─ [checklist item has no id] ────► "hold" (early exit)
 *      ▼
 * Step 1-0. confirmToolNameMatchesIntent
 *      ├─ [approved !== true] ───────────► "ask_user" (kind: tool_undetermined)
 *      ▼
 * Step 1-1. phase = (c1 === "immediate") ? at_trigger : at_instruction
 *      ▼
 * Step 2-3. getRequiredFields → resolveField per field      ← common to both phases
 *      │ └─ lookupField walks five tiers → all empty means "unknown"
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
 *               values from the instruction must name their coordinates via a span within a segment; unnamed means rejected
 * - Inheritance: the first source is never erased by any path
 * - Timing:     values at instruction time, conditions at trigger time. Only values that cannot be asked for now get pending_at_trigger
 * - Decision:   if even one unknown remains, do not execute — record instead
 * - Execution:  reference only recorded state. A hook failure is not a pass; it is unmet
 * ============================================================================
 */
