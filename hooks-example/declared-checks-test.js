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
 *   7. A labelled line is compared only in the form its declarer confirmed (3.3, 4.2.1). The gate looks
 *      the confirmation up; a proposal confirms nothing; a reworded line or a revoked form is pending.
 *   8. The conditions the user stated in the instruction become items (4.4), checked against the
 *      user's words, and asked about until the user confirms their form.
 *   9. An approval is bound to the values it was shown with and to the item's version (6.3, 6.1).
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

// Append-only, with list(key): every record under a key, oldest first (what confirmations need).
function memStorage({ withList = true } = {}) {
  const all = [];
  const st = {
    all,
    async persist(key, record) { all.push({ key, record: JSON.parse(JSON.stringify(record)) }); return record; },
    async load() { return null; },
  };
  if (withList) st.list = async key => all.filter(e => e.key === key).map(e => e.record);
  return st;
}

async function run(opts = {}, input = {}) {
  const storage = opts.storage ?? memStorage();
  const preflight = createPreflight({ hooks: hooks(opts), storage });
  const r = await preflight.runPreflightAndRecord({
    userId: "u", instruction: opts.instruction ?? (opts.text ? [{ trust: "user", text: opts.text }] : SAID),
    mcpTool: opts.tool ?? tool(), measured_data: {}, userChecklist: [], userAnswers: {}, ...input,
  });
  return { r, persisted: storage.all.filter(e => !e.key.startsWith("__form_approval__")).at(-1)?.record ?? null, preflight, storage };
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
    check("a [Verify] line with no confirmed form: the provider confirms one first", [ver.r.execution_decision, cond(ver.r).route], ["definition_repair", "definition_repair"]);

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
      { userChecklist: [APPROVE] });
    const din = sched.r.deferred_input ?? {};
    check("a deferred record carries the version it was scheduled under", din.checklist_digest_at_instruction, sched.r.checklist_digest);
    // The seller's approval, as the gate asks for it: bound to the item's version and the place shown.
    const approval = { answer: true, shown: { location: "Hongdae station lockers" }, rule_hash: sched.r.user_checklist[0].rule_hash };

    const trigger = (checklist) => run({ measured: ALL_MEASURED, over: { verifyUserChecklistItem: approvedFromAnswers } },
      { userChecklist: checklist, checklistAnswers: { chk_public: approval }, checklist_digest_at_instruction: din.checklist_digest_at_instruction });
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
    check("schema_version", persisted?.schema_version, "1.17");
    check("value_checks", persisted?.value_checks?.length, r.value_checks.length);
    check("unverified_value_check_count", persisted?.unverified_value_check_count, r.unverified_value_check_count);
    check("checklist_digest", persisted?.checklist_digest, r.checklist_digest);
    check("checklist_changed (null, not dropped)", "checklist_changed" in (persisted ?? {}), true);
    check("each item's rule_hash", [persisted?.user_checklist?.[0]?.rule_hash, persisted?.provider_checklist?.[0]?.rule_hash].every(h => typeof h === "string"), true);
  }

  // ══ 7 ══════════════════════════════════════════════════════════════════════════════════
  heading("7. a labelled line is compared only in the form its declarer confirmed (3.3, 4.2.1)");
  {
    const LINE = "Schedule a pickup.\n[Required] The buyer's contact is read from the platform, never from what anyone says.";
    const proposal = { compare: { kind: "value_source", slot: "buyer_contact" }, constrains: [] };
    let proposed = 0;
    const propose = req => { proposed += 1; return req.label === "Required" ? proposal : undefined; };
    const storage = memStorage();
    const first = await run({ storage, measured: ALL_MEASURED, tool: tool(LINE), over: { proposeComparableForm: propose } });
    const req = first.r.gate?.form_approvals?.[0] ?? {};
    check("unconfirmed: the provider's gap, not the user's question", [first.r.execution_decision, cond(first.r).route], ["definition_repair", "definition_repair"]);
    check("  the request carries the words, the declarer and the proposal",
      [req.declared_by, req.label, req.wording, JSON.stringify(req.proposal)],
      ["provider", "Required", "The buyer's contact is read from the platform, never from what anyone says.", JSON.stringify(proposal)]);
    check("  a proposal confirms nothing", [cond(first.r).compare, cond(first.r).status], [null, "unverified"]);
    check("  the model was asked once", proposed, 1);

    const rec = await first.preflight.approveForm(req, { form: proposal, approved_by: "provider:ops" });
    check("approveForm writes a confirmation under the request's key", [rec.kind, rec.status, rec.key], ["form_approval", "approved", req.key]);
    const second = await run({ storage, measured: ALL_MEASURED, tool: tool(LINE), over: { proposeComparableForm: propose } });
    check("confirmed: compared in that form, executes", [cond(second.r).status, cond(second.r).source, second.r.execution_decision],
      ["checked", "measured_data", "execute"]);
    check("  the record says who confirmed it", cond(second.r).form_approval?.approved_by, "provider:ops");
    check("  and the model was not asked again", proposed, 1);
    check("  the line's version includes its form", cond(second.r).rule_hash === cond(first.r).rule_hash, false);

    const reworded = await run({ storage, measured: ALL_MEASURED,
      tool: tool("Schedule a pickup.\n[Required] The buyer's contact is read from the platform only.") });
    check("a reworded line is pending again", [cond(reworded.r).status, reworded.r.execution_decision], ["unverified", "definition_repair"]);

    const noList = memStorage({ withList: false });
    const blind = await run({ storage: noList, measured: ALL_MEASURED, tool: tool(LINE) });
    await blind.preflight.approveForm(req, { form: proposal, approved_by: "provider:ops" });
    const blind2 = await run({ storage: noList, measured: ALL_MEASURED, tool: tool(LINE) });
    check("a storage that cannot list shows no confirmation: pending (fail-closed)", cond(blind2.r).status, "unverified");

    await first.preflight.revokeForm(req, { revoked_by: "provider:ops" });
    const revoked = await run({ storage, measured: ALL_MEASURED, tool: tool(LINE) });
    check("revoked: pending again", cond(revoked.r).status, "unverified");

    const edited = await first.preflight.approveForm({ ...req, key: "__form_approval__:provider:elsewhere" }, { form: proposal, approved_by: "x" });
    check("a request edited to point elsewhere confirms its own words", edited.key, req.key);

    const refuse = async (r, opts) => { try { await first.preflight.approveForm(r, opts); return "accepted"; } catch (e) { return e.message.replace(/^form approval: /, ""); } };
    check("refused: no one named as approving", /approved_by/.test(await refuse(req, { form: proposal })), true);
    check("refused: a form with nothing to compare", /user_approval/.test(await refuse(req, { form: { compare: null }, approved_by: "x" })), true);
    check("refused: a [Required] line confirmed by the user's approval",
      /\[Required\]/.test(await refuse(req, { form: { compare: { kind: "user_approval" } }, approved_by: "x" })), true);
    check("refused: a value_source form that does not fit its label",
      await refuse(req, { form: { compare: { kind: "value_source", slot: "time", measured_within_user_range: true } }, approved_by: "x" }) !== "accepted", true);

    // A [Verify] line confirmed as the user's approval of a slot.
    const VLINE = "Schedule a pickup.\n[Verify] The seller agrees to the pickup place.";
    const vs = memStorage();
    const v1 = await run({ storage: vs, measured: ALL_MEASURED, tool: tool(VLINE) });
    await v1.preflight.approveForm(v1.r.gate.form_approvals[0], { form: { compare: { kind: "user_approval" }, constrains: ["location"] }, approved_by: "provider:ops" });
    const v2 = await run({ storage: vs, measured: ALL_MEASURED, tool: tool(VLINE) });
    const prompt = v2.r.gate?.unverified_provider?.[0]?.approve ?? {};
    check("confirmed [Verify] line: the seller is asked, with the place shown", [v2.r.execution_decision, prompt.shown?.location], ["ask_user", "Hongdae station lockers"]);
    const v3 = await run({ storage: vs, measured: ALL_MEASURED, tool: tool(VLINE) },
      { checklistAnswers: { [cond(v2.r).id]: { answer: true, shown: prompt.shown, rule_hash: prompt.rule_hash } } });
    check("  the seller's yes, bound: checked from user_answer, executes", [cond(v3.r).status, cond(v3.r).source, v3.r.execution_decision],
      ["checked", "user_answer", "execute"]);
  }

  // ══ 8 ══════════════════════════════════════════════════════════════════════════════════
  heading("8. the conditions the user stated become items (4.4)");
  {
    const said = "Pick up LST-2291 at 2026-10-31T14:00:00+09:00, Hongdae station lockers. Nothing after 8pm.";
    const ex = { item_id: at(said, "LST-2291"), time: at(said, SAT_2PM), location: at(said, "Hongdae station lockers") };
    const claim = { quote: "Nothing after 8pm.", segment_index: 0, span: [said.indexOf("Nothing"), said.length], constrains: ["time"] };
    const extract = list => () => list;
    const storage = memStorage();
    const a = await run({ storage, text: said, extract: ex, measured: ALL_MEASURED, over: { extractUserConditions: extract([claim]) } });
    const it = (a.r.user_checklist ?? []).find(i => i.extracted) ?? {};
    check("a stated limit becomes an item, located in the user's words", [it.stated_as, JSON.stringify(it.located_at)],
      ["Nothing after 8pm.", JSON.stringify({ segment_index: 0, span: claim.span })]);
    check("  its id is the words' hash", it.id, `uc:${ruleHash("Nothing after 8pm.")}`);
    check("  until its form is confirmed it is asked about", [it.status, a.r.execution_decision], ["unverified", "ask_user"]);
    const q = (a.r.gate?.unverified_checklist ?? []).find(i => i.id === it.id) ?? {};
    check("  the question is a form to confirm, from the user", [q.form_request?.declared_by, q.form_request?.wording], ["user", "Nothing after 8pm."]);
    check("  the extraction is a check of its own", vc(a.r, "user_conditions")?.status, "checked");

    const evening = (item, ctx) => {
      if (item.compare?.kind !== "not_after") return { ...item, status: "unverified", source: null };
      const t = (ctx.fields ?? []).find(f => f.name === "time");
      return t.value.slice(11, 16) <= item.compare.hhmm ? { ...item, status: "verified", source: t.source } : { ...item, status: "unmet", source: t.source };
    };
    await a.preflight.approveForm(q.form_request, { form: { compare: { kind: "not_after", hhmm: "20:00" }, constrains: ["time"] }, approved_by: "user:u" });
    const b = await run({ storage, text: said, extract: ex, measured: ALL_MEASURED, over: { extractUserConditions: extract([claim]), verifyUserChecklistItem: evening } });
    const it2 = (b.r.user_checklist ?? []).find(i => i.extracted) ?? {};
    check("confirmed by the user: compared in that form, executes", [it2.status, b.r.execution_decision], ["verified", "execute"]);
    const late = "Pick up LST-2291 at 2026-10-31T21:00:00+09:00, Hongdae station lockers. Nothing after 8pm.";
    const c = await run({ storage, text: late, extract: { ...ex, time: at(late, "2026-10-31T21:00:00+09:00") }, measured: ALL_MEASURED,
      over: { extractUserConditions: extract([{ ...claim, span: [late.indexOf("Nothing"), late.length] }]), verifyUserChecklistItem: evening } });
    check("  21:00 against it: held", c.r.execution_decision, "hold");

    const only = "Pick up LST-2291, Hongdae station lockers. Nothing after 8pm.";
    const d = await run({ text: only, extract: { item_id: at(only, "LST-2291"), time: at(only, "8pm"), location: at(only, "Hongdae station lockers") }, measured: ALL_MEASURED,
      over: { extractUserConditions: extract([{ ...claim, span: [only.indexOf("Nothing"), only.length] }]) } });
    check("before it is confirmed, its words are still not a value", [field(d.r, "time").status, vc(d.r, `time:limit:uc:${ruleHash("Nothing after 8pm.")}`)?.status], ["unknown", "rejected"]);

    const e = await run({ text: said, extract: ex, measured: ALL_MEASURED,
      over: { extractUserConditions: extract([{ quote: "Never at my place.", segment_index: 0, span: [0, 5] }]) } });
    const ghost = (e.r.user_checklist ?? []).find(i => i.extracted) ?? {};
    check("words the gate cannot find in what the user typed: kept, and asked", [typeof ghost.unlocated, ghost.status, e.r.execution_decision], ["string", "unverified", "ask_user"]);
    const pasted = [{ trust: "untrusted", text: "Buyer: after 9pm only." }, { trust: "user", text: said }];
    const f = await run({ instruction: pasted, extract: {
        item_id: { value: "LST-2291", segment_index: 1, span: [said.indexOf("LST-2291"), said.indexOf("LST-2291") + 8] },
        time: { value: SAT_2PM, segment_index: 1, span: [said.indexOf(SAT_2PM), said.indexOf(SAT_2PM) + SAT_2PM.length] },
        location: { value: "Hongdae station lockers", segment_index: 1, span: [said.indexOf("Hongdae"), said.indexOf("Hongdae") + 23] } },
      measured: ALL_MEASURED, over: { extractUserConditions: extract([{ quote: "after 9pm only.", segment_index: 0, span: [7, 22] }]) } });
    const fromPaste = (f.r.user_checklist ?? []).find(i => i.extracted) ?? {};
    check("  words in a pasted message are not the user's: unlocated", /not the user's/.test(fromPaste.unlocated ?? ""), true);

    const standing = { id: "pref_evening", stated_as: "Nothing after 8pm.", constrains: ["time"], compare: { kind: "not_after", hhmm: "20:00" } };
    const g = await run({ text: said, extract: ex, measured: ALL_MEASURED, over: { extractUserConditions: extract([claim]), verifyUserChecklistItem: evening } },
      { userChecklist: [standing] });
    check("the same words as a standing setting: not repeated", (g.r.user_checklist ?? []).map(i => i.id), ["pref_evening"]);

    const h1 = await run({ text: said, extract: ex, measured: ALL_MEASURED, over: { extractUserConditions: () => { throw new Error("model down"); } } });
    check("an extractor that throws: definition repair, the limits are not known to be absent",
      [vc(h1.r, "user_conditions")?.status, h1.r.execution_decision], ["unverified", "definition_repair"]);
    const h2 = await run({ text: said, extract: ex, measured: ALL_MEASURED, over: { extractUserConditions: () => ({ none: "absent" }) } });
    check("  'none stated' is a check that passed", [vc(h2.r, "user_conditions")?.status, h2.r.execution_decision], ["checked", "execute"]);
    const h3 = await run({ text: said, extract: ex, measured: ALL_MEASURED, over: { extractUserConditions: () => "eight pm" } });
    check("  an unreadable reply is not 'none'", vc(h3.r, "user_conditions")?.status, "unverified");

    const sched = await run({ text: said, extract: ex, measured: ALL_MEASURED, when: "scheduled", over: { extractUserConditions: extract([claim]) } });
    check("at instruction time: the user confirms the form before it is scheduled", [sched.r.phase, sched.r.execution_decision, sched.r.gate?.unverified_checklist?.[0]?.form_request?.declared_by],
      ["at_instruction", "ask_user", "user"]);
    const schedP = await run({ measured: ALL_MEASURED, when: "scheduled", tool: tool("Schedule a pickup.\n[Required] The sale must be agreed.") });
    check("  and an unconfirmed provider line stops it as a gap", schedP.r.execution_decision, "definition_repair");

    const unwired = createPreflight({ hooks: hooks({ measured: ALL_MEASURED }), storage: memStorage() });
    check("unwired, the gate says so: extractUserConditions is an unsafe default", unwired.unsafeDefaults.includes("extractUserConditions"), true);
  }

  // ══ 9 ══════════════════════════════════════════════════════════════════════════════════
  heading("9. an approval is bound to what it approved (6.3, 6.1)");
  {
    const PUBLIC = { id: "chk_public", stated_as: "Public places only.", constrains: ["location"], compare: null };
    const base = await run({ measured: ALL_MEASURED }, { userChecklist: [PUBLIC] });
    const ask = (base.r.gate?.unverified_checklist ?? [])[0]?.approve ?? {};
    check("the question shows the place and the item's version", [ask.shown?.location, ask.rule_hash === base.r.user_checklist[0].rule_hash],
      ["Hongdae station lockers", true]);
    const answer = (over = {}) => ({ answer: true, shown: ask.shown, rule_hash: ask.rule_hash, ...over });
    const go = async a => (await run({ measured: ALL_MEASURED }, { userChecklist: [PUBLIC], checklistAnswers: { chk_public: a } })).r;

    const yes = await go(answer());
    check("a yes for the place shown: verified from user_answer, executes", [yes.user_checklist[0].status, yes.user_checklist[0].source, yes.execution_decision],
      ["verified", "user_answer", "execute"]);
    check("  the record keeps what was shown with it", yes.user_checklist[0].approval?.shown, { location: "Hongdae station lockers" });
    const no = await go(answer({ answer: false }));
    check("a no: unmet, held", [no.user_checklist[0].status, no.execution_decision], ["unmet", "hold"]);
    const bare = await go(true);
    check("a bare true names no place: voided, asked again", [typeof bare.user_checklist[0].approval_voided, bare.execution_decision], ["string", "ask_user"]);
    const elsewhere = await go(answer({ shown: { location: "Gangnam station exit 3" } }));
    check("a yes for another place: voided", [/not the value it approved/.test(elsewhere.user_checklist[0].approval_voided ?? ""), elsewhere.execution_decision], [true, "ask_user"]);
    const silent = await go(answer({ shown: {} }));
    check("a yes that does not say which place: voided", /does not say which location/.test(silent.user_checklist[0].approval_voided ?? ""), true);
    const old = await go(answer({ rule_hash: "something-else" }));
    check("a yes for another version of the item: voided", /another version/.test(old.user_checklist[0].approval_voided ?? ""), true);

    const RULE = { id: "chk_ok", stated_as: "Fine to go ahead.", compare: null };
    const plain = await run({ measured: ALL_MEASURED }, { userChecklist: [RULE], checklistAnswers: { chk_ok: true } });
    check("an item about no slot: a bare true holds", plain.r.user_checklist[0].status, "verified");
    const plainChanged = await run({ measured: ALL_MEASURED }, { userChecklist: [RULE], checklistAnswers: { chk_ok: true }, checklist_digest_at_instruction: "an-older-version" });
    check("  but not once the rules have changed", [plainChanged.r.user_checklist[0].status, plainChanged.r.checklist_changed?.approvals_voided], ["unverified", ["chk_ok"]]);

    let seen = null;
    const spy = (item, ctx) => { seen = ctx.checklistAnswers; return { ...item, status: "unverified", source: null }; };
    const WITH_FORM = { id: "chk_evening", stated_as: "Nothing after 8pm.", constrains: ["time"], compare: { kind: "not_after", hhmm: "20:00" } };
    await run({ measured: ALL_MEASURED, over: { verifyUserChecklistItem: spy } },
      { userChecklist: [PUBLIC, WITH_FORM], checklistAnswers: { chk_public: true, chk_evening: { answer: true, shown: { time: SAT_2PM }, rule_hash: "x" } } });
    check("a hook sees only the approvals that hold, as booleans", seen, {});
    const held = (item) => ({ ...item, status: "unmet", source: "instruction" });
    const formHash = (await run({ measured: ALL_MEASURED }, { userChecklist: [WITH_FORM] })).r.user_checklist[0].rule_hash;
    const over = await run({ measured: ALL_MEASURED, over: { verifyUserChecklistItem: held } }, { userChecklist: [WITH_FORM],
      checklistAnswers: { chk_evening: { answer: true, shown: { time: SAT_2PM }, rule_hash: formHash } } });
    check("a yes does not override a comparison form", over.r.user_checklist[0].status, "unmet");

    const VCOND = { id: "c_place", label: "Verify", description: "The seller agrees to the place.", constrains: ["location"] };
    const pv = await run({ measured: ALL_MEASURED, conditions: [VCOND] });
    const pAsk = pv.r.gate?.unverified_provider?.[0]?.approve ?? {};
    const pYes = await run({ measured: ALL_MEASURED, conditions: [VCOND] }, { checklistAnswers: { c_place: { answer: true, shown: pAsk.shown, rule_hash: pAsk.rule_hash } } });
    check("a provider [Verify] condition: a bound yes checks it from user_answer", [cond(pYes.r).status, cond(pYes.r).source, pYes.r.execution_decision], ["checked", "user_answer", "execute"]);
    const pBare = await run({ measured: ALL_MEASURED, conditions: [VCOND] }, { checklistAnswers: { c_place: true } });
    check("  a bare true: voided, asked again", [typeof cond(pBare.r).approval_voided, pBare.r.execution_decision], ["string", "ask_user"]);
    const RCOND = { id: "c_req", label: "Required", description: "The sale must be agreed.", constrains: [] };
    const pReq = await run({ measured: ALL_MEASURED, conditions: [RCOND] }, { checklistAnswers: { c_req: true } });
    check("  a [Required] condition is not the user's to approve", [cond(pReq.r).status, pReq.r.execution_decision], ["unverified", "definition_repair"]);
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall ok");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("THREW:", e.stack); process.exit(1); });
