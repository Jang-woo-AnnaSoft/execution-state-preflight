"use strict";

/**
 * The checks the skeleton makes itself since 1.16, each its own slot in the record (spec 3.3.1).
 *
 *   node declared-checks-test.js
 *
 * No API calls. One scenario, a pickup, and the hooks a test needs to reach each check.
 *
 *   1. Labelled lines are read by default (4.2.1, 6.3). A line with no confirmed form is unverified
 *      and routed by its label; it is never absent.
 *   2. A value's format is its own check. With no validator it is unverified — definition repair,
 *      not a pass (6.3). The whole argument object likewise.
 *   3. Every checklist item carries its version, the record carries the checklist's (6.1), and a
 *      trigger run that finds the rules changed does not carry the approvals given under the old ones.
 *   4. Who may give a value (3.3): a [Required] value_source condition takes the value from a system
 *      source only, a [Verify] one from the user only, and the gate checks it from its own record.
 *   5. Words inside a limit the user declared are not a value for the slot it limits.
 *   6. All of it reaches the persisted record (the record is a whitelist).
 */

const { createPreflight, ruleHash } = require("../execution-state-preflight");
const { locatedActionName } = require("./c2-stub");

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(72)} got=${JSON.stringify(got)}${ok ? "" : `  want=${JSON.stringify(want)}`}`);
}
const heading = t => console.log(`\n--- ${t} ---`);

const SCHEMA = {
  type: "object",
  properties: {
    item_id: { type: "string" },
    time: { type: "string", format: "date-time" },
    location: { type: "string" },
    buyer_contact: { type: "string" },
  },
  required: ["item_id", "time", "location", "buyer_contact"],
};
const tool = (description = "Schedule a pickup.", inputSchema = SCHEMA) =>
  ({ name: "schedule_pickup", description, inputSchema });

const SAT_2PM = "2026-10-31T14:00:00+09:00";
const SAT_3PM = "2026-10-31T15:00:00+09:00";
const TEXT = "Set up the pickup for LST-2291 at 2026-10-31T14:00:00+09:00, Hongdae station lockers.";
const SAID = [{ trust: "user", text: TEXT }];
const at = (text, word) => ({ value: word, segment_index: 0, span: [text.indexOf(word), text.indexOf(word) + word.length] });

// A validator that checks what this schema declares: type, and date-time as RFC 3339 with an offset.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function fieldCheck(v, s) {
  if (!s) return null;
  if (s.type === "string" && typeof v !== "string") return `expected string, got ${typeof v}`;
  if (s.format === "date-time" && !DATE_TIME.test(String(v))) return `expected date-time, got ${JSON.stringify(v)}`;
  return null;
}
function payloadCheck(args, schema) {
  const missing = (schema?.required ?? []).filter(k => !(k in (args ?? {})));
  if (missing.length) return `missing ${missing.join(", ")}`;
  for (const [k, v] of Object.entries(args ?? {})) { const e = fieldCheck(v, schema?.properties?.[k]); if (e) return `${k}: ${e}`; }
  return null;
}

function hooks({ text = TEXT, extract, measured = {}, validators = "wired", conditions, verify, when = "immediate", over = {} } = {}) {
  const ex = extract ?? {
    item_id: at(text, "LST-2291"), time: at(text, SAT_2PM), location: at(text, "Hongdae station lockers"),
  };
  return {
    classifyWhenCase: () => when,
    extractUserActionName: locatedActionName(),
    confirmToolNameMatchesIntent: () => ({ approved: true, reason: "one tool" }),
    extractFromInstruction: f => (f in ex ? ex[f] : { none: "absent" }),
    measureFromEnvironment: f => (f in measured ? { valid: true, value: measured[f] } : { none: "absent" }),
    buildActionKey: () => "u:schedule_pickup",
    ...(validators === "wired" ? { validateFieldSchema: fieldCheck, validatePayload: payloadCheck } : {}),
    ...(conditions !== undefined ? { getProviderConditions: () => conditions } : {}),
    ...(verify ? { verifyProviderCondition: verify } : {}),
    ...over,
  };
}

function memStorage() {
  const all = [];
  return {
    all,
    async persist(key, record) { all.push({ key, record: JSON.parse(JSON.stringify(record)) }); return record; },
    async load() { return null; },
  };
}

async function run(opts = {}, input = {}) {
  const storage = memStorage();
  const preflight = createPreflight({ hooks: hooks(opts), storage });
  const r = await preflight.runPreflightAndRecord({
    userId: "u", instruction: opts.instruction ?? (opts.text ? [{ trust: "user", text: opts.text }] : SAID),
    mcpTool: opts.tool ?? tool(), measured_data: {}, userChecklist: [], userAnswers: {}, ...input,
  });
  return { r, persisted: storage.all.at(-1)?.record ?? null };
}
const vc = (r, id) => (r.value_checks ?? []).find(c => c.id === id) ?? null;
const field = (r, n) => (r.fields ?? []).find(f => f.name === n) ?? {};
const cond = (r, i = 0) => (r.provider_checklist ?? [])[i] ?? {};

(async () => {
  console.log("CHECKS THE SKELETON MAKES ITSELF (1.16)");
  const ALL_MEASURED = { buyer_contact: "in-app chat (@kim_2291)" };

  // ══ 1 ══════════════════════════════════════════════════════════════════════════════════
  heading("1. labelled lines are read by default (4.2.1)");
  {
    const plain = await run({ measured: ALL_MEASURED });
    check("no labelled line, everything checked: executes", plain.r.execution_decision, "execute");
    check("  and the provider checklist is empty", plain.r.provider_checklist, []);

    const req = await run({ measured: ALL_MEASURED,
      tool: tool("Schedule a pickup.\n[Required] The sale must be agreed, as shown by the order status.") });
    check("a [Required] line with no confirmed form: definition_repair", req.r.execution_decision, "definition_repair");
    check("  it is in the checklist, unverified", [cond(req.r).label, cond(req.r).status, cond(req.r).route],
      ["Required", "unverified", "definition_repair"]);
    check("  its wording is the description", cond(req.r).description, "The sale must be agreed, as shown by the order status.");
    check("  its id is the line's hash", cond(req.r).id,
      `schedule_pickup:${ruleHash("[Required] The sale must be agreed, as shown by the order status.")}`);

    const ver = await run({ measured: ALL_MEASURED, tool: tool("Schedule a pickup.\n[Verify] Confirm the pickup with the seller.") });
    check("a [Verify] line with no confirmed form: asks", [ver.r.execution_decision, cond(ver.r).route], ["ask_user", "ask_user"]);

    const note = await run({ measured: ALL_MEASURED, tool: tool("Schedule a pickup.\n[Notice] The buyer sees it immediately.") });
    check("a [Notice] line: executes, with the disclosure handed over", [note.r.execution_decision, note.r.gate?.disclosures?.length], ["execute", 1]);

    const typo = await run({ measured: ALL_MEASURED, tool: tool("Schedule a pickup.\n[Requried] The sale must be agreed.") });
    check("a label typo is not dropped: definition_repair", [typo.r.execution_decision, cond(typo.r).route], ["definition_repair", "definition_repair"]);

    const moved = await run({ measured: ALL_MEASURED,
      tool: tool("[Notice] The buyer sees it immediately.\nSchedule a pickup.\n[Notice] Times are local.") });
    const moved2 = await run({ measured: ALL_MEASURED,
      tool: tool("Schedule a pickup.\n[Notice] Times are local.\n[Notice] The buyer sees it immediately.") });
    check("reordering lines keeps each line's id", moved.r.provider_checklist.map(c => c.id).sort(),
      moved2.r.provider_checklist.map(c => c.id).sort());
    const reworded = await run({ measured: ALL_MEASURED, tool: tool("Schedule a pickup.\n[Notice] The buyer sees it at once.") });
    check("rewording a line changes its id", cond(reworded.r).id === cond(note.r).id, false);

    const hooked = await run({ measured: ALL_MEASURED, conditions: [],
      tool: tool("Schedule a pickup.\n[Required] The sale must be agreed.") });
    check("an adopter's getProviderConditions replaces the default", hooked.r.execution_decision, "execute");
  }

  // ══ 2 ══════════════════════════════════════════════════════════════════════════════════
  heading("2. a value's format is its own check (6.3)");
  {
    const ok = await run({ measured: ALL_MEASURED });
    check("wired, valid: each slot's format checked", ["item_id", "time", "location", "buyer_contact"].map(n => vc(ok.r, `${n}:format`)?.status),
      ["checked", "checked", "checked", "checked"]);
    check("  and the payload's", vc(ok.r, "payload")?.status, "checked");
    check("  unverified count 0", ok.r.unverified_value_check_count, 0);

    const unwired = await run({ measured: ALL_MEASURED, validators: "unwired" });
    check("no validator: definition_repair, not execute", unwired.r.execution_decision, "definition_repair");
    check("  every format check unverified", ["item_id", "time", "location", "buyer_contact"].map(n => vc(unwired.r, `${n}:format`)?.status),
      ["unverified", "unverified", "unverified", "unverified"]);
    check("  the values stay as found", field(unwired.r, "time").status, "known");
    check("  the gate names the checks, not the user", [unwired.r.gate?.kind, (unwired.r.gate?.definition_repair_checks ?? []).length, unwired.r.gate?.unknown_fields?.length],
      ["definition_repair", 4, 0]);

    const opPre = createPreflight({ hooks: (() => { const h = hooks({ measured: ALL_MEASURED }); delete h.validatePayload; return h; })(), storage: memStorage() });
    const op = await opPre.runPreflight({ userId: "u", instruction: SAID, mcpTool: tool(), measured_data: {}, userChecklist: [] });
    check("payload validator unwired, fields wired: definition_repair", op.execution_decision, "definition_repair");
    check("  the payload check unverified", vc(op, "payload")?.status, "unverified");

    const said = "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae station lockers.";
    const phrase = await run({ text: said, measured: ALL_MEASURED,
      extract: { item_id: at(said, "LST-2291"), time: at(said, "2pm this Saturday"), location: at(said, "Hongdae station lockers") } });
    check("a phrase in a date-time slot: rejected, and the slot is asked", [vc(phrase.r, "time:format")?.status, field(phrase.r, "time").status, phrase.r.execution_decision],
      ["rejected", "unknown", "ask_user"]);
    check("  rejected is not counted; the blank is", [phrase.r.unverified_value_check_count, phrase.r.gate?.unknown_fields?.map(f => f.name)], [0, ["time"]]);

    const answered = await run({ text: said, measured: ALL_MEASURED,
      extract: { item_id: at(said, "LST-2291"), time: at(said, "2pm this Saturday"), location: at(said, "Hongdae station lockers") } },
      { userAnswers: { time: SAT_2PM } });
    check("the user's answer in the declared form: checked, executes", [vc(answered.r, "time:format")?.status, vc(answered.r, "time:format")?.source, answered.r.execution_decision],
      ["checked", "user_answer", "execute"]);

    const threw = await run({ measured: ALL_MEASURED, over: { validateFieldSchema: () => { throw new Error("validator down"); } } });
    check("a validator that throws: unverified, the value is not dropped", [vc(threw.r, "time:format")?.status, field(threw.r, "time").status, threw.r.execution_decision],
      ["unverified", "known", "definition_repair"]);
    const odd = await run({ measured: ALL_MEASURED, over: { validateFieldSchema: () => true } });
    check("an unreadable reply (true) is not a pass", [vc(odd.r, "time:format")?.status, odd.r.execution_decision], ["unverified", "definition_repair"]);

    const unknown = await run({ measured: {} });
    check("a slot still unknown: its format check waits", [vc(unknown.r, "buyer_contact:format")?.status, unknown.r.execution_decision], ["pending_on_slot", "ask_user"]);

    const later = await run({ measured: ALL_MEASURED, validators: "unwired", when: "scheduled" });
    check("at instruction time too: no validator blocks the scheduling", [later.r.phase, later.r.execution_decision], ["at_instruction", "definition_repair"]);
    const laterOk = await run({ measured: ALL_MEASURED, when: "scheduled" });
    check("  and with one, it is scheduled", laterOk.r.execution_decision, "deferred");

    const badPayload = await run({ measured: ALL_MEASURED, over: { validatePayload: () => "the slot is taken" } });
    check("an illegal payload: hold, its check unmet", [badPayload.r.execution_decision, vc(badPayload.r, "payload")?.status], ["hold", "unmet"]);
  }

  // ══ 3 ══════════════════════════════════════════════════════════════════════════════════
  heading("3. the version of the rules (6.1)");
  {
    const EVENING = { id: "chk_evening", label: "Required", stated_as: "Nothing after 8pm.", constrains: ["time"],
                      compare: { type: "string", pattern: "T(?:[01][0-9]|20:00)" } };
    const a = await run({ measured: ALL_MEASURED }, { userChecklist: [EVENING] });
    const item = (a.r.user_checklist ?? [])[0] ?? {};
    check("a user item carries its version", typeof item.rule_hash, "string");
    const spaced = await run({ measured: ALL_MEASURED }, { userChecklist: [{ ...EVENING, stated_as: "Nothing  after\n8pm." }] });
    check("  spacing is not a different rule", spaced.r.user_checklist[0].rule_hash, item.rule_hash);
    const reformed = await run({ measured: ALL_MEASURED }, { userChecklist: [{ ...EVENING, compare: { type: "string", pattern: "T(?:[01][0-9]|21:00)" } }] });
    check("  a changed comparison form is", reformed.r.user_checklist[0].rule_hash === item.rule_hash, false);
    const caller = await run({ measured: ALL_MEASURED }, { userChecklist: [{ ...EVENING, rule_hash: "forged" }] });
    check("  the caller cannot write it", caller.r.user_checklist[0].rule_hash, item.rule_hash);
    check("the record carries the checklist's version", typeof a.r.checklist_digest, "string");
    const withLine = await run({ measured: ALL_MEASURED, tool: tool("Schedule a pickup.\n[Notice] The buyer sees it immediately.") }, { userChecklist: [EVENING] });
    check("  a provider line changes it", withLine.r.checklist_digest === a.r.checklist_digest, false);

    // Scheduled at instruction time, re-run at the trigger.
    const APPROVE = { id: "chk_public", label: "Verify", stated_as: "Public places only.", constrains: ["location"] };
    const approvedFromAnswers = (item, ctx) => (ctx?.checklistAnswers?.[item.id] === true
      ? { ...item, status: "verified", source: "user_answer" } : { ...item, status: "unverified", source: null });
    const sched = await run({ measured: ALL_MEASURED, when: "scheduled", over: { verifyUserChecklistItem: approvedFromAnswers } },
      { userChecklist: [APPROVE], checklistAnswers: { chk_public: true } });
    const din = sched.r.deferred_input ?? {};
    check("a deferred record carries the version it was scheduled under", din.checklist_digest_at_instruction, sched.r.checklist_digest);

    const trigger = (checklist) => run({ measured: ALL_MEASURED, over: { verifyUserChecklistItem: approvedFromAnswers } },
      { userChecklist: checklist, checklistAnswers: { chk_public: true }, checklist_digest_at_instruction: din.checklist_digest_at_instruction });
    const same = await trigger([APPROVE]);
    check("trigger, rules unchanged: the approval stands, executes", [same.r.checklist_changed, same.r.execution_decision], [null, "execute"]);
    const changed = await trigger([{ ...APPROVE, stated_as: "Public places only, indoors." }]);
    check("trigger, a rule changed: recorded", [changed.r.checklist_changed?.at_instruction, changed.r.checklist_changed?.now === changed.r.checklist_digest],
      [din.checklist_digest_at_instruction, true]);
    check("  the approvals given under the old rules are voided", changed.r.checklist_changed?.approvals_voided, ["chk_public"]);
    check("  so it is asked again, not executed", [changed.r.user_checklist[0].status, changed.r.execution_decision], ["unverified", "ask_user"]);
  }

  // ══ 4 ══════════════════════════════════════════════════════════════════════════════════
  heading("4. who may give a value (3.3, value_source)");
  {
    const CONTACT = { id: "c_contact", label: "Required", description: "The buyer's contact is read from the platform.",
                      compare: { kind: "value_source", slot: "buyer_contact" } };
    const PLACE = { id: "c_place", label: "Verify", description: "The location is the place the seller names.",
                    compare: { kind: "value_source", slot: "location" } };
    const TIME = { id: "c_time", label: "Verify", description: "The time is the seller's, or a buyer request inside the seller's range.",
                   compare: { kind: "value_source", slot: "time", measured_within_user_range: true } };
    let called = 0;
    const verify = () => { called += 1; return { status: "unverified", source: null }; };

    const typed = "Set up the pickup for LST-2291 at 2026-10-31T14:00:00+09:00, Hongdae station lockers, call me at 010-1234.";
    const ex = { item_id: at(typed, "LST-2291"), time: at(typed, SAT_2PM), location: at(typed, "Hongdae station lockers"), buyer_contact: at(typed, "010-1234") };
    const req = await run({ text: typed, extract: ex, measured: ALL_MEASURED, conditions: [CONTACT], verify });
    check("[Required]: a contact typed in the instruction is not consulted", field(req.r, "buyer_contact").source, "measured_data");
    check("  the slot's allowed sources say so", field(req.r, "buyer_contact").allowed_sources, ["measured_data"]);
    check("  the condition is checked by the gate, from the record", [cond(req.r).status, cond(req.r).source], ["checked", "measured_data"]);
    check("  the hook is not asked", called, 0);
    check("  the field names the rule", field(req.r, "buyer_contact").source_rule_ids, ["c_contact"]);
    check("  executes", req.r.execution_decision, "execute");

    const noMeasure = await run({ text: typed, extract: ex, conditions: [CONTACT], verify,
      over: { measureFromEnvironment: () => undefined } });
    check("[Required], the measurement not in yet: the system is asked, not the user", [field(noMeasure.r, "buyer_contact").route, noMeasure.r.execution_decision],
      ["system_lookup", "system_lookup"]);
    const reportedNone = await run({ text: typed, extract: ex, measured: {}, conditions: [CONTACT], verify });
    check("[Required], the platform reports none: NULL, a required NULL holds", [field(reportedNone.r, "buyer_contact").status, reportedNone.r.execution_decision],
      ["null", "hold"]);

    const offer = { ...ALL_MEASURED, location: "Gangnam station exit 3", time: SAT_3PM };
    const silent = "Set up the pickup for LST-2291.";
    const exSilent = { item_id: at(silent, "LST-2291") };
    const place = await run({ text: silent, extract: exSilent, measured: offer, conditions: [CONTACT, PLACE, TIME], verify });
    check("[Verify]: the buyer's suggested place is not the location", [field(place.r, "location").status, field(place.r, "location").route], ["unknown", "ask_user"]);
    check("  its condition waits on the slot", cond(place.r, 1).status, "pending_on_slot");
    check("  the seller is asked for it", place.r.gate?.unknown_fields?.map(f => f.name).includes("location"), true);
    const placeAnswered = await run({ text: silent, extract: exSilent, measured: offer, conditions: [CONTACT, PLACE, TIME], verify },
      { userAnswers: { location: "Gangnam station exit 3", time: SAT_3PM } });
    check("  the seller sends it back: checked from user_answer", [cond(placeAnswered.r, 1).status, cond(placeAnswered.r, 1).source], ["checked", "user_answer"]);
    check("  and executes", placeAnswered.r.execution_decision, "execute");

    check("[Verify] with a measured range: no range set, the buyer's time is not used", field(place.r, "time").status, "unknown");
    const RANGE = { id: "chk_window", label: "Required", stated_as: "Any time this Saturday between 1pm and 6pm.", constrains: ["time"] };
    const inRange = (item, ctx) => {
      const t = (ctx.fields ?? []).find(f => f.name === "time");
      return t?.value >= "2026-10-31T13:00:00+09:00" && t?.value <= "2026-10-31T18:00:00+09:00"
        ? { ...item, status: "verified", source: t.source } : { ...item, status: "unmet", source: t?.source ?? "measured_data" };
    };
    const ranged = await run({ text: silent, extract: exSilent, measured: offer, conditions: [CONTACT, PLACE, TIME], verify,
      over: { verifyUserChecklistItem: inRange } }, { userChecklist: [RANGE], userAnswers: { location: "Gangnam station exit 3" } });
    check("  with the seller's range: the buyer's request settles it", [field(ranged.r, "time").source, cond(ranged.r, 2).status, cond(ranged.r, 2).source],
      ["measured_data", "checked", "measured_data"]);
    check("  and executes", ranged.r.execution_decision, "execute");

    const bad = async (c) => (await run({ measured: ALL_MEASURED, conditions: [c], verify })).r;
    check("a value_source with no slot: definition_repair",
      cond(await bad({ id: "x", label: "Verify", compare: { kind: "value_source" } })).route, "definition_repair");
    check("[Required] with measured_within_user_range: definition_repair",
      cond(await bad({ id: "x", label: "Required", compare: { kind: "value_source", slot: "time", measured_within_user_range: true } })).route, "definition_repair");
    check("[Notice] as a value_source: definition_repair",
      cond(await bad({ id: "x", label: "Notice", compare: { kind: "value_source", slot: "time" } })).status, "disclosure_required");
    check("constrains naming another slot: definition_repair",
      cond(await bad({ id: "x", label: "Verify", constrains: ["time"], compare: { kind: "value_source", slot: "location" } })).route, "definition_repair");

    const clash = await run({ measured: ALL_MEASURED, conditions: [CONTACT], verify,
      over: { getAllowedSources: f => (f === "buyer_contact" ? ["user_answer"] : null) } });
    check("two declarations with no source in common: definition_repair, and says why",
      [field(clash.r, "buyer_contact").route, /no source in common/.test(field(clash.r, "buyer_contact").note ?? "")], ["definition_repair", true]);
  }

  // ══ 5 ══════════════════════════════════════════════════════════════════════════════════
  heading("5. words inside a limit are not a value");
  {
    const limited = "Pick up LST-2291 at Hongdae station lockers. Nothing after 8pm.";
    const LIMIT = { id: "chk_evening", label: "Required", stated_as: "Nothing after 8pm.", constrains: ["time"] };
    const ex = { item_id: at(limited, "LST-2291"), time: at(limited, "8pm"), location: at(limited, "Hongdae station lockers") };
    const judged = [];
    const eq = (v, t, f) => { judged.push(f); return String(v).toLowerCase() === String(t).toLowerCase(); };
    const r = (await run({ text: limited, extract: ex, measured: ALL_MEASURED, over: { spanSupportsValue: eq } }, { userChecklist: [LIMIT] })).r;
    check("'8pm' inside the limit's wording: refused", [field(r, "time").status, vc(r, "time:limit:chk_evening")?.status], ["unknown", "rejected"]);
    check("  the source is traced as rejected", field(r, "time").lookup_trace?.find(t => t.source === "instruction")?.result, "rejected");
    check("  and the seller is asked", [r.execution_decision, r.gate?.unknown_fields?.map(f => f.name)], ["ask_user", ["time"]]);
    check("  spanSupportsValue was not asked about it", judged.includes("time"), false);

    const located = { ...LIMIT, stated_as: undefined, located_at: { segment_index: 0, span: [limited.indexOf("Nothing"), limited.length] } };
    const byPos = (await run({ text: limited, extract: ex, measured: ALL_MEASURED }, { userChecklist: [located] })).r;
    check("by position, when the item says where its words are", vc(byPos, "time:limit:chk_evening")?.status, "rejected");

    const both = "Pick up LST-2291 at 2026-10-31T14:00:00+09:00, Hongdae station lockers. Nothing after 8pm.";
    const exBoth = { item_id: at(both, "LST-2291"), time: at(both, SAT_2PM), location: at(both, "Hongdae station lockers") };
    const outside = (await run({ text: both, extract: exBoth, measured: ALL_MEASURED,
      over: { verifyUserChecklistItem: (item) => ({ ...item, status: "verified", source: "instruction" }) } },
      { userChecklist: [{ ...LIMIT, located_at: { segment_index: 0, span: [both.indexOf("Nothing"), both.length] } }] })).r;
    check("a value outside the limit: its limit check is checked", [vc(outside, "time:limit:chk_evening")?.status, field(outside, "time").source], ["checked", "instruction"]);

    const noLimit = (await run({ text: limited, extract: ex, measured: ALL_MEASURED })).r;
    check("with no limit declared, no limit check", (noLimit.value_checks ?? []).some(c => c.kind === "limit_wording"), false);
  }

  // ══ 6 ══════════════════════════════════════════════════════════════════════════════════
  heading("6. it all reaches the persisted record");
  {
    const LIMIT = { id: "chk_evening", label: "Required", stated_as: "Nothing after 8pm.", constrains: ["time"] };
    const { r, persisted } = await run({ measured: ALL_MEASURED, tool: tool("Schedule a pickup.\n[Notice] The buyer sees it immediately.") },
      { userChecklist: [LIMIT] });
    check("schema_version", persisted?.schema_version, "1.16");
    check("value_checks", persisted?.value_checks?.length, r.value_checks.length);
    check("unverified_value_check_count", persisted?.unverified_value_check_count, r.unverified_value_check_count);
    check("checklist_digest", persisted?.checklist_digest, r.checklist_digest);
    check("checklist_changed (null, not dropped)", "checklist_changed" in (persisted ?? {}), true);
    check("each item's rule_hash", [persisted?.user_checklist?.[0]?.rule_hash, persisted?.provider_checklist?.[0]?.rule_hash].every(h => typeof h === "string"), true);
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall ok");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("THREW:", e.stack); process.exit(1); });
