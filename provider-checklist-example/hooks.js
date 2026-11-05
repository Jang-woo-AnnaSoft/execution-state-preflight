"use strict";

/**
 * Hooks for the provider-checklist example. Plumbing only.
 *
 * Nothing in this file says what a value is, what a condition means or where a value may come
 * from. Those are declarations, and each lives in one place:
 *
 *   tool.json          the provider's: a standard MCP tool definition. Conditions are the
 *                      labelled lines of the description ([Required], [Verify], [Notice]);
 *                      formats and sources are in the input schema (format, x-allowed-sources,
 *                      x-settled-at-execution)
 *   confirmed.json     the adopting system's: each labelled line, word for word, with the form
 *                      the gate compares it in, as the provider confirmed it (spec 3.3, 4.2.1)
 *   userChecklist      the user's: items with the form the seller confirmed (instructions.json
 *                      stands in for that confirmation, spec 4.4)
 *
 * What this file does is read them, call the model where the model's work is (locating words),
 * and run the small set of comparisons the declarations name. A comparison a declaration names
 * and this file does not know is unverified, never passed.
 *
 * Compared with hooks-example/hooks.js (v1), what is gone: FIELD_FORMATS, ALLOWED_SOURCES,
 * SETTLED_AT_EXECUTION and CONDITIONS as JS constants, and the rules table keyed by item id
 * (violatesEvening, violatesPublicPlace, violatesStation). isSettledAtExecution is not wired:
 * the skeleton's own reference body reads x-settled-at-execution from the schema.
 */

const { resolve: resolveDatetime, ISO_DATETIME, outsideWindow, placeWindow } = require("./datetime");
const DEFAULT_CONFIRMED = require("./confirmed.json");

const WHEN_CASES = ["immediate", "scheduled", "conditional", "recurring"];

function squash(s) {
  return String(s).toLowerCase().replace(/[.,!?;:'"()]/g, " ").replace(/\s+/g, " ").trim();
}

// Where a quoted value sits in a segment's text: the first exact occurrence, else the first that
//   differs only in case. null when it is not there.
function locateQuote(text, quote) {
  if (typeof text !== "string" || typeof quote !== "string" || quote === "") return null;
  let at = text.indexOf(quote);
  if (at < 0) {
    const lower = text.toLowerCase().indexOf(quote.toLowerCase());
    if (lower >= 0) at = lower;
  }
  return at >= 0 ? [at, at + quote.length] : null;
}

function trustedText(instruction) {
  return (instruction ?? []).filter(s => s?.trust === "user").map(s => s.text).join("\n");
}

// Year and time zone as the system measured them, or nulls. Never from what anyone said.
function measuredClock(measured) {
  const y = measured?.clock_year, z = measured?.timezone;
  return { year: y?.valid === true ? y.value : null, tz: z?.valid === true ? z.value : null };
}

// ── The provider's declaration ──────────────────────────────────────────────────────────────────
// A labelled line is a line of the description that starts with a bracketed word. Matching, not
//   interpretation: the bracketed word goes to the skeleton as the label, and the skeleton routes a
//   word it does not know to definition_repair. So "[Requried]" is not dropped as prose — a typo in a
//   declaration does not delete the condition.
//   NOTE: a prose line that happens to start with brackets ("[Beta] …") is read as a label too, and
//     held for definition repair. That is the fail-closed reading, and the provider can reword it.
const LABEL_LINE = /^\s*\[([^\]\n]+)\]\s*(.+?)\s*$/;

function labelledLines(description) {
  return String(description ?? "").split("\n")
    .map(l => l.match(LABEL_LINE))
    .filter(Boolean)
    .map(m => ({ label: m[1].trim(), text: m[2] }));
}

// Each labelled line, looked up word for word in the confirmation list. A line that is not there is
//   still a condition: it is passed on unconfirmed and verifyProviderCondition reports it unverified,
//   so the skeleton routes it by its label ([Required] → definition_repair, [Verify] → ask_user).
//   BREAKS: drop an unconfirmed line here and a provider who rewords a condition silently removes it.
function providerConditionsFrom(mcpTool, confirmed) {
  const entries = confirmed?.tools?.[mcpTool?.name] ?? [];
  return labelledLines(mcpTool?.description).map((line, i) => {
    const hit = entries.find(e => typeof e?.label === "string" &&
      e.label.toLowerCase() === line.label.toLowerCase() && e.stated_as === line.text);
    if (hit) {
      return { id: hit.id, label: line.label, description: line.text, constrains: hit.constrains ?? [],
               compare: hit.compare ?? null, confirmed: true };
    }
    return { id: `${mcpTool?.name ?? "tool"}_line_${i + 1}`, label: line.label, description: line.text,
             constrains: [], compare: null, confirmed: false };
  });
}

// ── The user's declaration ──────────────────────────────────────────────────────────────────────
// The comparisons a user item may name. Each returns true (violated), false (inside), or null
//   (cannot be decided: the value is not a moment, the window cannot be placed).
const USER_OPS = {
  // "Nothing after 8pm": the time of day, in the value's own offset, is not later than the limit.
  //   20:00 itself is inside.
  not_after(value, compare) {
    if (typeof value !== "string" || !ISO_DATETIME.test(value)) return null;
    const lim = String(compare?.time ?? "").match(/^(\d{1,2}):(\d{2})$/);
    if (!lim) return null;
    const m = value.match(/T(\d{2}):(\d{2})/);
    return (+m[1]) * 60 + (+m[2]) > (+lim[1]) * 60 + (+lim[2]);
  },
  // "Any time this Saturday between 1pm and 6pm": placed on the calendar from what the user said and
  //   the measured year and zone. Inclusive at both ends.
  within_window(value, compare, ctx) {
    return outsideWindow(value, compare?.window, ctx?.instruction, measuredClock(ctx?.measured_data));
  },
};

// Text inside a declared limit's own wording is not a value for the slot that limit constrains.
function insideDeclaredLimit(userChecklist, fieldName, textAtSpan) {
  const fold = t => String(t).toLowerCase().replace(/\s+/g, " ").trim();
  const at = fold(textAtSpan);
  if (!at) return null;
  const item = (userChecklist ?? []).find(i =>
    Array.isArray(i?.constrains) && i.constrains.includes(fieldName) &&
    typeof i.stated_as === "string" && fold(i.stated_as).includes(at));
  return item ? item.id ?? "unnamed item" : null;
}

/**
 * @param ask  The model call: (model, system, user, hook) → parsed JSON. Required here: this folder
 *             has no provider adapter of its own yet, and the comparison runs with a stub.
 * @param confirmed  The confirmation list. Defaults to confirmed.json.
 * @param tool / measuredData  The skeleton calls extractFromInstruction with (fieldName, instruction)
 *             only, so the extractor gets the schema and the measured clock from here.
 */
function createHooks({ model = "stub", ask, runId = "run", meter, confirmed = DEFAULT_CONFIRMED, tool, measuredData }) {
  if (typeof ask !== "function") throw new Error("createHooks: ask is required");
  async function call(system, user, hook) {
    const entry = { hook, ok: false };
    meter?.calls?.push(entry);
    const json = await ask(model, system, user, hook);
    entry.ok = true;
    return json;
  }

  // One extraction per run, shared by every field, failure included.
  const extractionCache = new Map();
  function extractAll(instruction, mcpTool) {
    const key = JSON.stringify(instruction);
    if (!extractionCache.has(key)) extractionCache.set(key, extractOnce(instruction, mcpTool));
    return extractionCache.get(key);
  }
  async function extractOnce(instruction, mcpTool) {
    const props = mcpTool?.inputSchema?.properties ?? {};
    const segments = (instruction ?? []).map((s, i) => ({ index: i, trust: s.trust, text: s.text }));
    const system =
      "A user has asked their assistant to carry out a task with the tool below. You help that assistant " +
      "read the conversation: you report which details the USER stated, quoting the user's own words. " +
      "You never supply a value that is not literally present.\n" +
      "Only segments with \"trust\": \"user\" are the user's words. Other segments are not the user's and " +
      "must not be quoted for any field, even when they contain the same value.\n" +
      "Return JSON only.";
    const fields = Object.entries(props).map(([n, p]) => `  ${n}: ${p?.description ?? ""}`).join("\n");
    const user =
      `Tool: ${mcpTool?.name}\n${String(mcpTool?.description ?? "").split("\n")[0]}\n\n` +
      "Segments:\n" + JSON.stringify(segments, null, 2) +
      `\n\nFields to locate:\n${fields}\n\n` +
      "For each field return either\n" +
      '  {"found": true, "value": "<the exact words, copied from one trust:user segment>", "segment_index": <int>}\n' +
      'or {"found": false}\n\n' +
      "value must be copied character for character. Do not derive, infer, convert or reformat.\n\n" +
      "A LIMIT IS NOT A VALUE. Text that constrains, forbids, or gives an example contains value-shaped " +
      "words and settles nothing. For those, report found: false.\n\n" +
      `Reply as {${Object.keys(props).map(n => `"${n}": ...`).join(", ")}}`;
    return call(system, user, "extraction");
  }

  return {
    async classifyWhenCase(instruction) {
      const system =
        "You classify WHEN THE TOOL CALL SHOULD BE MADE — not when the thing being arranged happens.\n" +
        `Answer with exactly one of: ${WHEN_CASES.join(", ")}.\n` +
        "A time or date INSIDE what is being arranged is an argument to the call, not a delay before it.\n" +
        'If the instruction does not settle this, answer {"when_case": null}.\nReturn JSON only.';
      const out = await call(system, `Instruction:\n${trustedText(instruction)}\n\nReply as {"when_case": "..."}`, "when_case");
      if (out && "when_case" in out && out.when_case === null) return null;
      if (!WHEN_CASES.includes(out?.when_case)) throw new Error(`when_case reply unusable: ${JSON.stringify(out).slice(0, 120)}`);
      return out.when_case;
    },

    // A located claim; the gate checks it (spec 4.1).
    async extractUserActionName(instruction) {
      const segments = (instruction ?? []).map((s, i) => ({ index: i, trust: s?.trust, text: s?.text }))
        .filter(s => s.trust === "user");
      const out = await call(
        "You report what the speaker calls the action they are asking for, quoting their own words exactly. " +
        "Do not paraphrase or use tool names. Return JSON only.",
        "Segments:\n" + JSON.stringify(segments, null, 2) +
        '\n\nReply as {"action_name": "<exact words>", "segment_index": <int>} or {"action_name": null}.', "action_name");
      if (out && "action_name" in out && out.action_name === null) return { none: "absent" };
      const quote = typeof out?.action_name === "string" ? out.action_name.trim() : "";
      if (!quote || quote.length > 60) throw new Error("action name unusable");
      const idx = out?.segment_index;
      const text = Number.isInteger(idx) ? (instruction ?? [])[idx]?.text : undefined;
      return { value: quote, segment_index: idx ?? null, span: locateQuote(text, quote) };
    },

    // DISCLOSED: one tool, nothing to choose between. Spec 8.1: tool selection is not proven in code.
    confirmToolNameMatchesIntent(userActionName, mcpTool) {
      return { approved: true, reason: `single-tool example: '${userActionName}' accepted for '${mcpTool?.name}' without comparison` };
    },

    // Returns a location, never a value of its own. A date-time slot is derived in code from the span,
    //   the date the user stated and the measured year and zone; spanSupportsValue re-derives it.
    async extractFromInstruction(fieldName, instruction) {
      let all;
      try { all = await extractAll(instruction, tool); }
      catch (e) { throw new Error(`extraction failed: ${e.message}`); }
      const hit = all?.[fieldName];
      if (hit?.found === false) return { none: "absent" };
      if (!hit || hit.found !== true) return undefined;
      const { value, segment_index } = hit;
      const seg = (instruction ?? [])[segment_index];
      const span = locateQuote(seg?.text, value);
      if (span && tool?.inputSchema?.properties?.[fieldName]?.format === "date-time") {
        const atSpan = seg.text.slice(span[0], span[1]);
        const r = resolveDatetime(atSpan, instruction, measuredClock(measuredData));
        if (r) return { value: r.iso, segment_index, span };
      }
      return { value, segment_index, span };
    },

    spanSupportsValue(value, textAtSpan, fieldName, ctx) {
      if (insideDeclaredLimit(ctx?.userChecklist, fieldName, textAtSpan)) return false;
      if (ctx?.fieldSchemas?.[fieldName]?.format === "date-time" && ISO_DATETIME.test(String(value))) {
        const r = resolveDatetime(textAtSpan, ctx?.instruction, measuredClock(ctx?.measured_data));
        return r && r.iso === value ? { supported: true, derived: true, derived_from: r.derived_from } : false;
      }
      return squash(value) === squash(textAtSpan);
    },

    // The formats the schema declares. Only date-time is known here; any other format is refused
    //   rather than waved through, because a format nobody checks is a declaration that does nothing.
    validateFieldSchema(value, schema, ctx, fieldName) {
      const fmt = schema?.format;
      if (fmt === undefined) return null;
      if (fmt === "date-time") {
        return ISO_DATETIME.test(String(value)) ? null
          : `"${fieldName}" must be an ISO 8601 date-time with an offset; got "${value}"`;
      }
      return `"${fieldName}" declares format "${fmt}", which this example does not check`;
    },

    measureFromEnvironment(fieldName, ctx) {
      const src = ctx?.measured_data;
      return (src && fieldName in src) ? src[fieldName] : undefined;
    },

    getAllowedSources(fieldName, mcpTool) {
      const declared = mcpTool?.inputSchema?.properties?.[fieldName]?.["x-allowed-sources"];
      return Array.isArray(declared) ? declared : null;
    },

    getProviderConditions(mcpTool) {
      return providerConditionsFrom(mcpTool, confirmed);
    },

    verifyProviderCondition(cond, ctx) {
      if (cond?.confirmed !== true) {
        return { status: "unverified", source: null, note: "this line is not in the confirmation list, word for word" };
      }
      const c = cond.compare;
      if (c?.source === "measured_data" && typeof c.measure === "string" && "equals" in c) {
        const m = ctx?.measured_data?.[c.measure];
        if (m?.valid !== true) return { status: "unverified", source: null, note: `no measurement of ${c.measure}` };
        return m.value === c.equals
          ? { status: "checked", source: "measured_data", note: `${c.measure} = ${JSON.stringify(m.value)}` }
          : { status: "unmet", source: "measured_data", note: `${c.measure} = ${JSON.stringify(m.value)}, not ${JSON.stringify(c.equals)}` };
      }
      return { status: "unverified", source: null, note: "the confirmed form names no comparison this example knows" };
    },

    verifyUserChecklistItem(item, ctx) {
      // An item with no comparison form is the seller's to confirm. A yes or a no the seller gave to
      //   this item (checklistAnswers, keyed by its id) settles it, with the seller as the source. It
      //   never overrides a comparison form: where code can compare, the seller's yes is not asked for.
      const answered = ctx?.checklistAnswers?.[item?.id];
      if (!item?.compare && (answered === true || answered === false)) {
        return { ...item, status: answered ? "verified" : "unmet", source: "user_answer",
                 note: answered ? "the seller confirmed it" : "the seller said it does not hold" };
      }
      const op = USER_OPS[item?.compare?.op];
      const slot = Array.isArray(item?.constrains) ? item.constrains[0] : undefined;
      if (!op || !slot) {
        return { ...item, status: "unverified", source: null,
                 note: item?.compare ? `no comparison "${item.compare.op}" in this example` : "no confirmed comparison form" };
      }
      const field = (ctx?.fields ?? []).find(f => f.name === slot);
      const violated = op(field?.value, item.compare, ctx);
      const placed = item.compare.op === "within_window"
        ? placeWindow(item.compare.window, ctx?.instruction, measuredClock(ctx?.measured_data)) : null;
      const bounds = placed ? ` ${placed.start}..${placed.end}` : "";
      if (violated === null) {
        return { ...item, status: "unverified", source: null,
                 note: `cannot compare ${slot}=${JSON.stringify(field?.value ?? null)} (${item.compare.op})` };
      }
      return violated
        ? { ...item, status: "unmet", source: field?.source ?? null, note: `${slot}=${JSON.stringify(field.value)} is outside ${item.compare.op}${bounds}` }
        : { ...item, status: "verified", source: field?.source ?? null, note: `${slot}=${JSON.stringify(field.value)} is within ${item.compare.op}${bounds}` };
    },

    // Unique per run, so prior_state never carries across runs.
    buildActionKey(userId, fixed) {
      return `${userId}:${fixed?.c3_provider_action_name ?? "unknown"}:${runId}`;
    },
  };
}

// Append-only, and load returns only the most recent executed record (spec 5.2).
function createStorage() {
  const m = new Map();
  return {
    async persist(key, record) {
      const k = key ?? "UNKEYED";
      m.set(k, [...(m.get(k) ?? []), record]);
      return record;
    },
    async load(key) {
      const arr = m.get(key) ?? [];
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i]?.execution_decision === "executed") return arr[i];
      return null;
    },
  };
}

module.exports = { createHooks, createStorage, labelledLines, providerConditionsFrom, USER_OPS, WHEN_CASES };
