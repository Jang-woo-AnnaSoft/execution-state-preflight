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
 *   confirmed.json     the provider's, kept by the adopting system: each labelled line, word for
 *                      word, with how it is checked — a measurement and a JSON Schema — as the
 *                      provider confirmed it (spec 3.3, 4.2, 4.2.1)
 *   userChecklist      the user's: items with a JSON Schema the slot's value must satisfy, as the
 *                      seller confirmed it (instructions.json stands in for that, spec 3.3, 4.4)
 *
 * What this file does is read them, call the model where the model's work is (locating words),
 * and evaluate the declared JSON Schemas with a standard validator (Ajv). How a condition is
 * checked is the declaration's; this file knows no comparison of its own. A schema the validator
 * cannot compile — an unknown keyword, say — is unverified, never passed.
 *
 * Nothing here converts words into values either. "2pm this Saturday" is not turned into a date:
 * it fails the schema's date-time format and is asked about, where a model can propose the date
 * and the seller confirm it (graph.js).
 *
 * Compared with hooks-example/hooks.js (v1), what is gone: FIELD_FORMATS, ALLOWED_SOURCES,
 * SETTLED_AT_EXECUTION and CONDITIONS as JS constants; the rules table keyed by item id
 * (violatesEvening, violatesPublicPlace, violatesStation); and the date parser. isSettledAtExecution
 * is not wired: the skeleton's own reference body reads x-settled-at-execution from the schema.
 */

const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const DEFAULT_CONFIRMED = require("./confirmed.json");

// The validator. strict: a keyword it does not know is an error, not something to skip — a declared
//   check that cannot be run must not read as a check that passed. The two x- keywords are the
//   schema's own declarations about sources, not checks on the value, so they are registered as
//   annotations and ignored here.
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addVocabulary(["x-allowed-sources", "x-settled-at-execution"]);
const compiled = new WeakMap();

// { ok: true|false, errors } when the value was checked; { error } when the schema cannot be compiled.
function checkAgainst(schema, value) {
  if (!schema || typeof schema !== "object") return { error: "no schema" };
  let validate = compiled.get(schema);
  if (!validate) {
    try { validate = ajv.compile(schema); } catch (e) { return { error: e.message }; }
    compiled.set(schema, validate);
  }
  const ok = validate(value);
  return { ok, errors: ok ? null : ajv.errorsText(validate.errors) };
}

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
 * @param tool  The skeleton calls extractFromInstruction with (fieldName, instruction) only, so the
 *             extractor gets the schema from here.
 */
function createHooks({ model = "stub", ask, runId = "run", meter, confirmed = DEFAULT_CONFIRMED, tool }) {
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

    // Returns a location and the words at it, never a value of its own. Words that are not in the
    //   slot's declared form ("2pm this Saturday" for a date-time) fail validateFieldSchema and are
    //   asked about.
    async extractFromInstruction(fieldName, instruction) {
      let all;
      try { all = await extractAll(instruction, tool); }
      catch (e) { throw new Error(`extraction failed: ${e.message}`); }
      const hit = all?.[fieldName];
      if (hit?.found === false) return { none: "absent" };
      if (!hit || hit.found !== true) return undefined;
      const { value, segment_index } = hit;
      const seg = (instruction ?? [])[segment_index];
      return { value, segment_index, span: locateQuote(seg?.text, value) };
    },

    spanSupportsValue(value, textAtSpan, fieldName, ctx) {
      if (insideDeclaredLimit(ctx?.userChecklist, fieldName, textAtSpan)) return false;
      return squash(value) === squash(textAtSpan);
    },

    // The field's own schema, as the provider declared it, checked by the validator. A schema it
    //   cannot compile refuses the value rather than waving it through.
    validateFieldSchema(value, schema, ctx, fieldName) {
      if (!schema) return null;
      const out = checkAgainst(schema, value);
      if (out.error) return `"${fieldName}" has a schema the validator cannot run: ${out.error}`;
      return out.ok ? null : `"${fieldName}" does not match its declared schema: ${out.errors}; got ${JSON.stringify(value)}`;
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
      if (c?.source !== "measured_data" || typeof c.measure !== "string") {
        return { status: "unverified", source: null, note: "the confirmed form names no measurement to check" };
      }
      const m = ctx?.measured_data?.[c.measure];
      if (m?.valid !== true) return { status: "unverified", source: null, note: `no measurement of ${c.measure}` };
      const out = checkAgainst(c.schema, m.value);
      if (out.error) return { status: "unverified", source: null, note: `the confirmed schema cannot be run: ${out.error}` };
      return out.ok
        ? { status: "checked", source: "measured_data", note: `${c.measure} = ${JSON.stringify(m.value)}` }
        : { status: "unmet", source: "measured_data", note: `${c.measure} = ${JSON.stringify(m.value)}: ${out.errors}` };
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
      const slot = Array.isArray(item?.constrains) ? item.constrains[0] : undefined;
      if (!item?.compare || !slot) {
        return { ...item, status: "unverified", source: null, note: "no confirmed comparison form" };
      }
      const field = (ctx?.fields ?? []).find(f => f.name === slot);
      const out = checkAgainst(item.compare, field?.value);
      if (out.error) {
        return { ...item, status: "unverified", source: null, note: `the confirmed schema cannot be run: ${out.error}` };
      }
      return out.ok
        ? { ...item, status: "verified", source: field?.source ?? null, note: `${slot}=${JSON.stringify(field.value)} satisfies the confirmed schema` }
        : { ...item, status: "unmet", source: field?.source ?? null, note: `${slot}=${JSON.stringify(field?.value)}: ${out.errors}` };
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

module.exports = { createHooks, createStorage, labelledLines, providerConditionsFrom, checkAgainst, WHEN_CASES };
