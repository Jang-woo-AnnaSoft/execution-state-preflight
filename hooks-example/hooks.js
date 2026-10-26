"use strict";

/**
 * Arm C hooks for execution-state-preflight.js.
 *
 * Six hooks are required. Four are thin because this experiment has one task
 * and one tool. Two do real work and are the ones to read.
 *
 * DISCLOSED SIMPLIFICATIONS (these belong in the published write-up):
 *   1. confirmToolNameMatchesIntent always approves. There is one tool, so
 *      there is nothing to choose between. Spec 8.1 says tool selection is not
 *      verified by code anyway; this experiment does not test it.
 *   2. (no longer a simplification) userChecklist is wired. The limits the seller
 *      states in group 2 are declared as items and compared by the hook below.
 *      The first version left it empty and called that a scope choice — which was
 *      wrong. verifyUserChecklistItem could not see the resolved fields, so an item
 *      constraining a slot was not implementable. The skeleton now hands the hook
 *      ctx.fields, and an item whose slot is still UNKNOWN is pending_on_slot
 *      rather than a question.
 *   3. Several optional hooks run on the skeleton's defaults, and the live list is
 *      preflight.unsafeDefaults, read at runtime rather than copied here — a count
 *      written into a comment goes stale the next time the skeleton gains a hook.
 *      It is written into every arm C record, so the published runs carry on their
 *      face whichever ones were unwired. The experiment measures the value gate, so
 *      field policy, payload validation and the provider conditions are absent.
 *      validateFieldSchema IS wired, for the one format tool.js declares (time is
 *      an ISO 8601 datetime with an offset). It was left out at first on the
 *      reasoning that the experiment measures the value gate, and the first smoke
 *      run showed why that was wrong: with no format check the value gate sent
 *      "2pm this Saturday" to a datetime slot. A span that is real is not yet a
 *      value of the declared kind.
 *      getAllowedSources IS wired, before run 1, for one slot: buyer_contact may
 *      come only from measured_data (tool.js ALLOWED_SOURCES). Every other slot
 *      permits all five. The cost: a contact the user types in the instruction is
 *      not consulted, and a conflict between it and the measurement is not
 *      recorded. No instruction here states a contact that contradicts the
 *      measured one.
 *   4. spanSupportsValue is wired, but for every slot it still does what the
 *      default does: equality. Its contract asks the hook to judge whether the
 *      span states the value FOR THE SLOT, and equality cannot: "Nothing after
 *      8pm" contains a time and states none. Here the role check is pushed into
 *      the extraction prompt instead (see "A LIMIT IS NOT A VALUE" below), which is
 *      a prompt, not a check — so group 2 is a live test of this hole rather than a
 *      demonstration that it is closed. If arm C executes a group 2 instruction,
 *      this is why. What the wiring adds is the derived datetime only: the date
 *      resolver (datetime.js) turns the span plus the date the seller stated plus
 *      the measured year and zone into a datetime, and names all of them.
 *
 * NOT a simplification: extractFromInstruction also checks that the text at the
 * returned span equals the value. The skeleton now does this itself through
 * spanSupportsValue, so this is a redundant second check rather than a deviation.
 * It stays because arm C's whole claim is that a generated value does not settle
 * a slot — a redundant check costs nothing, a missing one invalidates the arm.
 */

const { squash, violatesEvening, violatesPublicPlace, violatesStation } = require("./normalize");
const { ALLOWED_SOURCES, FIELD_FORMATS } = require("./tool");
const { resolve: resolveDatetime, ISO_DATETIME, placeWindow, outsideWindow } = require("./datetime");

const WHEN_CASES = ["immediate", "scheduled", "conditional", "recurring"];

/** Join only the segments the user actually typed. */
function trustedText(instruction) {
  return (instruction ?? [])
    .filter(s => s?.trust === "user")
    .map(s => s.text)
    .join("\n");
}

/**
 * @param adapter  Provider adapter (providers.js). Same two operations for every
 *                 company, so these hooks are identical across models.
 * @param ask      Optional injection point, mainly for tests. Defaults to the
 *                 adapter's JSON call. gate-test.js passes a stub so the gate can
 *                 be exercised with no API key and no provider.
 * @param meter    Optional { calls: [] }. Every model call these hooks make is
 *                 appended: which hook, whether it parsed, why the model stopped,
 *                 what it cost, and on failure the error and the head of the reply.
 *                 A separate object, not a property of the hooks, because
 *                 createPreflight refuses any key it does not know as a hook.
 */
// Year and time zone as the system measured them, or nulls. Never from what anyone said.
function measuredClock(measured) {
  const y = measured?.clock_year, z = measured?.timezone;
  return { year: y?.valid === true ? y.value : null, tz: z?.valid === true ? z.value : null };
}

function createHooks({ adapter, model, runId, measuredData, ask, meter }) {
  // One wrapper for every call, so nothing a hook asks the model goes unrecorded.
  async function call(m, system, user, hook) {
    const entry = { hook, ok: false, stop_reason: null, usage: null };
    meter?.calls?.push(entry);
    try {
      if (ask) {
        const json = await ask(m, system, user);
        entry.ok = true;
        return json;
      }
      const r = adapter.callJsonMeta
        ? await adapter.callJsonMeta(m, system, user)
        : { json: await adapter.callJson(m, system, user), stop_reason: null, usage: null };
      Object.assign(entry, { ok: true, stop_reason: r.stop_reason ?? null, usage: r.usage ?? null,
                             blocks: r.blocks ?? null });
      return r.json;
    } catch (e) {
      Object.assign(entry, { error: e?.message ?? String(e), stop_reason: e?.stop_reason ?? null,
                             usage: e?.usage ?? null, blocks: e?.blocks ?? null, head: e?.head ?? null });
      throw e;
    }
  }
  // ONE extraction per run, shared by every field — including when it fails. The promise is cached
  //   before it settles, so a failure is the same failure for every field.
  //   BREAKS: cache only successes — as this did — and a failed call is silently retried by the next
  //     field, each field then reads a DIFFERENT extraction, and one run can be half broken and half
  //     clean (the first smoke run: item_id failed, time and location came from a second call).
  //     That is a retry around a failure that nobody asked for, inside the harness that measures it.
  const extractionCache = new Map();

  function extractAll(instruction) {
    const key = JSON.stringify(instruction);
    if (!extractionCache.has(key)) extractionCache.set(key, extractOnce(instruction));
    return extractionCache.get(key);
  }

  async function extractOnce(instruction) {

    const segments = (instruction ?? []).map((s, i) => ({
      index: i, trust: s.trust, text: s.text
    }));

    const system =
      "You locate values inside text. You never supply a value that is not literally present.\n" +
      "For each requested field, either point at the exact substring that states it, or report it as absent.\n" +
      "Return JSON only.";

    const user =
      "Segments:\n" +
      JSON.stringify(segments, null, 2) +
      "\n\nFields to locate: item_id, time, location, buyer_contact\n\n" +
      "For each field return either\n" +
      '  {"found": true, "value": "<the exact substring>", "segment_index": <int>, "span": [start, end]}\n' +
      "or\n" +
      '  {"found": false}\n\n' +
      "span is a half-open character range into that segment's text, and text.slice(start, end) " +
      "must equal value exactly. Do not derive, infer, convert or reformat. If the text does not " +
      "state the field, report found: false.\n\n" +
      "A LIMIT IS NOT A VALUE. Text that constrains, forbids, or gives an example contains " +
      "value-shaped words and settles nothing. \"Nothing after 8pm\" does not state a time; it " +
      "rules times out. \"Public places only\" does not state a place. \"I never meet at my home\" " +
      "does not state a place. For those, report found: false — the field is still unstated.\n\n" +
      'Reply as {"item_id": ..., "time": ..., "location": ..., "buyer_contact": ...}';

    return call(model, system, user, "extraction");
  }

  return {
    // [REQUIRED-OP] Must not default to immediate when undecidable.
    async classifyWhenCase(instruction) {
      const system =
        "You classify WHEN THE TOOL CALL SHOULD BE MADE — not when the thing being arranged happens.\n" +
        `Answer with exactly one of: ${WHEN_CASES.join(", ")}.\n` +
        "immediate = make the call now, in this turn.\n" +
        "scheduled = do not call now; wait until a stated clock time and call then.\n" +
        "conditional = do not call now; wait for a stated event and call then.\n" +
        "recurring = call repeatedly on a cycle.\n\n" +
        "A time or date INSIDE what is being arranged is an argument to the call, not a delay before it. " +
        '"Book the table for 7pm" is immediate: the booking is made now, for 7pm. ' +
        '"Book the table at 7pm tonight, not before" is scheduled: the call itself waits.\n\n' +
        'If the instruction does not settle this, answer {"when_case": null}.\n' +
        "Return JSON only.";
      const out = await call(model, system,
        `Instruction:\n${trustedText(instruction)}\n\nReply as {"when_case": "..."} or {"when_case": null}`, "when_case");
      const v = out?.when_case;
      // The model answered {"when_case": null}: it reports the instruction does not settle C1. Pass
      //   that on as null — a report, recorded as unresolved. It used to be thrown, which the record
      //   could only read as a broken hook (g3-02 in the first smoke run).
      if (out && "when_case" in out && v === null) return null;
      if (!WHEN_CASES.includes(v)) {
        // Anything else is a reply that answers nothing. Contract: do not substitute.
        throw new Error(`when_case reply unusable: ${JSON.stringify(out).slice(0, 120)}`);
      }
      return v;
    },

    // [REQUIRED-OP] From trusted segments only.
    async extractUserActionName(instruction) {
      const system =
        "You report what the speaker calls the action they are asking for, in their own words.\n" +
        "Use a short noun phrase taken from their wording. Do not use tool names. Return JSON only.";
      const out = await call(model, system,
        `Text:\n${trustedText(instruction)}\n\nReply as {"action_name": "..."}`, "action_name");
      const name = String(out?.action_name ?? "").trim();
      if (!name || name.length > 60) throw new Error("action name unusable");
      return name;
    },

    // [REQUIRED-SAFETY] Simplification 1. Disclosed above.
    confirmToolNameMatchesIntent(userActionName, mcpTool) {
      return {
        approved: true,
        reason: `single-tool experiment: '${userActionName}' accepted for '${mcpTool?.name}' without comparison`
      };
    },

    // [REQUIRED-OP] The real work. Returns a location, never a value of its own.
    async extractFromInstruction(fieldName, instruction) {
      let all;
      try {
        all = await extractAll(instruction);
      } catch (e) {
        throw new Error(`extraction failed: ${e.message}`);   // settles the field unknown
      }

      const hit = all?.[fieldName];
      // The model's {"found": false} is a report: it looked and the field is not stated. Pass it on as
      // one. Turning it into undefined — as this did — recorded a check the model made as a check
      // nobody made (spec 5.2: no report and a report of nothing are different).
      // A field missing from the reply, or a found that is neither true nor false, is not a report of
      // anything, and stays undefined.
      if (hit?.found === false) return { none: "absent" };
      if (!hit || hit.found !== true) return undefined;        // no report → next source

      const { value, segment_index, span } = hit;
      if (!Array.isArray(span) || span.length !== 2) return undefined;

      const seg = (instruction ?? [])[segment_index];
      if (!seg || typeof seg.text !== "string") return undefined;

      const [start, end] = span;
      if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
      if (start < 0 || end > seg.text.length || start >= end) return undefined;

      // Simplification 3: the span must actually say the value.
      const atSpan = seg.text.slice(start, end);
      if (squash(atSpan) !== squash(value)) return undefined;

      // A datetime slot: the seller said "2pm this Saturday"; the tool needs a moment. Derive it in
      //   code from that span, the date the seller stated, and the year and zone the system
      //   measured. Still a location claim — the span is unchanged — and spanSupportsValue below
      //   re-derives it and names every input. If it cannot be derived, the literal goes forward
      //   and the format check refuses it: an unconfirmed date is not filled in.
      if (FIELD_FORMATS[fieldName] === "iso_datetime") {
        const r = resolveDatetime(atSpan, instruction, measuredClock(measuredData));
        if (r) return { value: r.iso, segment_index, span: [start, end] };
      }
      return { value, segment_index, span: [start, end] };
    },

    // [OPTIONAL, wired] Equality for every slot, as the skeleton's default does — the role check
    //   ("a limit is not a value") is still NOT implemented; see disclosure 4. What it adds is the
    //   derived datetime: it re-derives the value from the span and the conversation and, if it
    //   matches, says so with every input named. The gate then checks each input itself.
    spanSupportsValue(value, textAtSpan, fieldName, ctx) {
      if (FIELD_FORMATS[fieldName] === "iso_datetime" && ISO_DATETIME.test(String(value))) {
        const r = resolveDatetime(textAtSpan, ctx?.instruction,
                                  measuredClock(ctx?.measured_data ?? measuredData));
        return r && r.iso === value ? { supported: true, derived: true, derived_from: r.derived_from } : false;
      }
      return squash(value) === squash(textAtSpan);
    },

    // [OPTIONAL, wired] The formats declared in tool.js. Nothing else is checked here.
    validateFieldSchema(value, schema, ctx, fieldName) {
      if (FIELD_FORMATS[fieldName] === "iso_datetime" && !ISO_DATETIME.test(String(value))) {
        return `"${fieldName}" must be an ISO 8601 date-time with an offset; got "${value}"`;
      }
      return null;
    },

    // [REQUIRED-OP] CONTRACT: { valid, value }, { valid: false }, { none: "absent" | "no_place" }, or
    //   undefined. Here measuredData carries whatever the arm put in it, passed through as is.
    measureFromEnvironment(fieldName, ctx) {
      const src = ctx?.measured_data ?? measuredData;
      if (src && fieldName in src) return src[fieldName];
      return undefined;
    },

    // [OPTIONAL] Reads the declaration in tool.js. null = all five (skeleton default).
    getAllowedSources(fieldName) {
      return ALLOWED_SOURCES[fieldName] ?? null;
    },

    // [REQUIRED-OP] Most conservative key: unique per run, so prior_state never
    // carries across runs. Every run in this experiment starts cold.
    buildActionKey(userId, fixed) {
      return `${userId}:${fixed?.c3_provider_action_name ?? "unknown"}:${runId}`;
    },

    // [OPTIONAL but the one most adopters need] Compare a declared user limit against
    // the value the lookup actually settled on.
    //
    // Three outcomes, and all three matter:
    //   verified   the value is inside the limit
    //   unmet      the value is outside it. CHECKED, and it prohibits — a hold, not a
    //              question. The user declared the rule; asking them about it is asking
    //              them to confirm what they already said
    //   unverified the comparison could not be made at all (unparseable value, no rule
    //              for this item). This is the only one that counts and comes back
    //
    // The fourth case never reaches here: an item whose slot is still UNKNOWN is held by
    // the gate as pending_on_slot, because there is nothing yet to compare against.
    //
    // NOTE: a source is required for unmet. "It violates" is a claim about a value, and a
    //   claim about a value needs to say which value — same rule as a known slot.
    // NOTE: the comparison is deterministic (normalize.js), not a model call. A model here
    //   would make the verdict probabilistic, which is what the gate exists to avoid.
    verifyUserChecklistItem(item, ctx) {
      const byName = Object.fromEntries((ctx?.fields ?? []).map(f => [f.name, f]));
      // Group 5's window is placed on the calendar from what the seller said and the measured year
      //   and zone (datetime.js). The bounds it was compared against go into the note, so the record
      //   says which Saturday "this Saturday" was taken to be — the comparison is re-checkable.
      const clock = measuredClock(ctx?.measured_data ?? measuredData);
      const placed = item.window ? placeWindow(item.window, ctx?.instruction, clock) : null;
      const rules = {
        chk_evening:  { slot: "time",     test: violatesEvening,     bad: "is after the stated cutoff" },
        chk_public:   { slot: "location", test: violatesPublicPlace, bad: "is not a public place" },
        chk_not_home: { slot: "location", test: violatesPublicPlace, bad: "is a private address" },
        // A range the seller approves in advance (spec 3.3). Same three outcomes: inside is verified
        //   and needs no question, outside is unmet (a hold), and a window that cannot be placed —
        //   no date said, no measured year or zone — is unverified, never "inside".
        chk_window:   { slot: "time",     test: v => outsideWindow(v, item.window, ctx?.instruction, clock),
                        bad: placed ? `is outside ${placed.start}..${placed.end}` : "is outside the window",
                        ok: placed ? `is within ${placed.start}..${placed.end}` : null },
        chk_station:  { slot: "location", test: violatesStation,     bad: "is not at a station" },
      };
      const rule = rules[item.id];
      if (!rule) {
        // An item with no rule is NOT verified. The default must never pass something
        // nobody compared, and this is the shape a typo in an id takes.
        return { ...item, status: "unverified", source: null, note: `no comparison rule for "${item.id}"` };
      }
      const field = byName[rule.slot];
      const value = field?.value;
      const violated = rule.test(value);
      if (violated === null) {
        // Undecidable is unverified, never "fine". violatesEvening returns null when it
        // cannot parse the value at all, and a value it cannot read is not a value it cleared.
        return { ...item, status: "unverified", source: null,
                 note: `cannot compare ${rule.slot}=${JSON.stringify(value ?? null)}` +
                       (item.window && !placed ? `: the window "${item.window.day}" could not be placed on the calendar` : "") };
      }
      return violated
        ? { ...item, status: "unmet", source: field?.source ?? "instruction",
            note: `${rule.slot}=${JSON.stringify(value)} ${rule.bad}` }
        : { ...item, status: "verified", source: field?.source ?? "instruction",
            note: `${rule.slot}=${JSON.stringify(value)} ${rule.ok ?? "is within the limit"}` };
    }
  };
}

/**
 * In-memory storage. Each run gets its own.
 *
 * CONTRACT: the skeleton calls `persist(key, record)` and `load(key)` — two arguments
 * on the write. The first version of this file took `persist(record)` and derived the
 * key from `record.action_key`, so every write landed under "UNKEYED" with the KEY
 * STRING as the value, and `load` always returned null.
 *
 * It passed every suite. gate-test.js never read storage back, and the experiment
 * builds a unique action_key per run so prior_state was never expected to find
 * anything. A dead source is indistinguishable from an empty one: the lookup simply
 * moves to the next source, which is fail-closed and therefore silent.
 *
 * An adopter who copied it would have prior_state permanently dead and no way to tell.
 *
 * value-source-test.js part 4 wraps THIS adapter and runs the round trip through it, so the
 * signature is now checked by something. Each test writing its own adapter is how the bug above
 * survived: the suites were green and the file an adopter copies was the broken one.
 */
function createStorage() {
  const m = new Map();
  return {
    async persist(key, record) {
      const k = key ?? record?.action_key ?? "UNKEYED";
      const arr = m.get(k) ?? [];
      arr.push(record);
      m.set(k, arr);
      return record;
    },
    // CONTRACT: the most recent EXECUTED record, and nothing else. Spec 5.2 inherits a value only
    // from an execution the record confirms happened, so a hold or a deferred record is not a
    // baseline. Returning the last record of any kind hands one back — and while the skeleton
    // checks execution_decision at the prior_state source and would ignore it, an adapter that
    // relies on being double-checked downstream is not the adapter to copy.
    async load(key) {
      const arr = m.get(key) ?? [];
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i]?.execution_decision === "executed") return arr[i];
      }
      return null;
    },
    dump() {
      return Object.fromEntries(m);
    }
  };
}

module.exports = { createHooks, createStorage, WHEN_CASES };
