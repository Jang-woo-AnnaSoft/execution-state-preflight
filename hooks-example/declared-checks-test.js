"use strict";

/**
 * The checks the skeleton makes itself since 1.16, each its own slot in the record (spec 3.3.1).
 *
 *   node declared-checks-test.js
 *
 * No API calls. One scenario, a pickup, and the hooks a test needs to reach each check.
 *
 *   1. Labelled lines are read by default (4.2.1, 6.3). A line no model could put into a comparable
 *      form is unverified and routed to definition repair; it is never absent.
 *   2. A value's format is its own check. With no validator it is unverified — definition repair,
 *      not a pass (6.3). The whole argument object likewise.
 *   3. Every checklist item carries its version, the record carries the checklist's (6.1), and a
 *      trigger run that finds the rules changed does not carry the approvals given under the old ones.
 *   4. Who may give a value (3.3): a [Required] value_source condition takes the value from a system
 *      source only, a [Verify] one from the user only, and the gate checks it from its own record.
 *   5. Words inside a limit the user declared are not a value for the slot it limits.
 *   6. All of it reaches the persisted record (the record is a whitelist).
 *   7. A labelled line is translated into a comparable form once, the translation is kept and the record
 *      shows it (3.3, 4.2.1). Nobody approves it; a reworded line is translated again.
 *   8. The conditions the user stated in the instruction become items (4.4), checked against the
 *      user's words, and asked about until the user confirms their form — in conversation.
 *   9. An approval is bound to the values it was shown with and to the item's version (6.3, 6.1).
 *  10. A reply counts only for a question this unit was asked, in the user's words after it, and each
 *      route's tries are counted by the gate from the unit's own records (4.5, 4.6).
 *  11. The gate reads the tool's definition itself, and measures with the values it settled.
 *
 * The user's replies are written as they would arrive: the user's own words appended to the instruction
 * (ports.js answerRound), read by a stand-in for the model (readReplies).
 */

const { createPreflight, ruleHash, describeForm, readTranslatedForms, renderValue, stopFacts } = require("../execution-state-preflight");
const { locatedActionName } = require("./c2-stub");
const { withPorts, askRound, answerRound, hasAnswers, REPLY } = require("./ports");

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

// A stand-in for the model that reads replies: every question asked is answered by the first of "yes",
//   "no" or "none" in the user's words after it. answerRound replaces it with one reply per answer.
function plainReplies(instruction, questions) {
  const claims = [];
  for (const q of questions) {
    for (let i = q.asked_through; i < instruction.length; i++) {
      const seg = instruction[i];
      if (seg?.trust !== "user") continue;
      const m = /\b(yes|no|none)\b/i.exec(seg.text);
      if (!m) continue;
      const word = m[1].toLowerCase();
      if (word === "none" && q.kind !== "value") continue;
      claims.push({ target: q.target, ...(word === "none" ? { none: "absent" } : { answer: word === "yes" }),
                    quote: m[1], segment_index: i, span: [m.index, m.index + m[1].length] });
      break;
    }
  }
  return claims.length ? claims : { none: "absent" };
}

function hooks({ text = TEXT, extract, measured = {}, validators = "wired", conditions, verify, when = "immediate", tool: t, over = {} } = {}) {
  const ex = extract ?? {
    item_id: at(text, "LST-2291"), time: at(text, SAT_2PM), location: at(text, "Hongdae station lockers"),
  };
  return withPorts({
    classifyWhenCase: () => when,
    extractUserActionName: locatedActionName(),
    confirmToolNameMatchesIntent: () => ({ approved: true, reason: "one tool" }),
    extractFromInstruction: f => (f in ex ? ex[f] : { none: "absent" }),
    measure: f => (f in measured ? { valid: true, value: measured[f] } : { none: "absent" }),
    buildActionKey: () => "u:schedule_pickup",
    readReplies: plainReplies,
    ...(validators === "wired" ? { validateFieldSchema: fieldCheck, validatePayload: payloadCheck } : {}),
    ...(conditions !== undefined ? { getProviderConditions: () => conditions } : {}),
    ...(verify ? { verifyProviderCondition: verify } : {}),
    ...over,
  }, { tool: t ?? tool() });
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

// A reply counts only for a question this unit was asked, so a run with answers first runs the round
//   that asked them, under the same key and storage — the order it happens in (part 10 tests the rule
//   itself, with noPriorAsk). The answers are the user's reply (ports.js): userAnswers { slot: value }
//   is the user approving that value when the question showed it, checklistAnswers { id: true|false }
//   the user answering an item's question.
async function run(opts = {}, input = {}) {
  const storage = opts.storage ?? memStorage();
  const t = opts.tool ?? tool();
  const { userAnswers, checklistAnswers, ...rest } = input;
  const answers = { userAnswers: userAnswers ?? {}, checklistAnswers: checklistAnswers ?? {} };
  const base = {
    userId: "u", instruction: opts.instruction ?? (opts.text ? [{ trust: "user", text: opts.text }] : SAID),
    toolCall: { name: t.name }, userChecklist: [], ...rest,
  };
  const h = hooks({ ...opts, tool: t });
  if (!hasAnswers(answers)) {
    const preflight = createPreflight({ hooks: h, storage });
    const r = await preflight.runPreflightAndRecord(base);
    return { r, persisted: lastRecord(storage), preflight, storage };
  }
  if (!opts.noPriorAsk) {
    await createPreflight({ hooks: askRound(h, answers), storage }).runPreflightAndRecord({ ...(opts.askInput ?? base) });
  }
  const reply = answerRound(h, base.instruction, answers);
  const preflight = createPreflight({ hooks: reply.hooks, storage });
  const r = await preflight.runPreflightAndRecord({ ...base, instruction: reply.instruction });
  return { r, persisted: lastRecord(storage), preflight, storage };
}
// A provider line's version with its form left out, to show the form is part of it.
const itemHashWithout = r => ruleHash(`${cond(r).label ?? ""}\u0000${cond(r).description ?? ""}\u0000null`);
const lastRecord = storage => storage.all.filter(e => !e.key.startsWith("__form_")).at(-1)?.record ?? null;
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
    const op = await opPre.runPreflight({ userId: "u", instruction: SAID, toolCall: { name: "schedule_pickup" }, userChecklist: [] });
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
    check("  and the tool call, for the trigger to run on", din.toolCall?.name, "schedule_pickup");

    // At the trigger the seller is asked to approve, and replies. The question carries the item's version
    //   and the place shown; the seller's yes is bound to both.
    const trigger = (asked, now) => run({ measured: ALL_MEASURED, over: { verifyUserChecklistItem: approvedFromAnswers },
        askInput: { userId: "u", instruction: SAID, toolCall: { name: "schedule_pickup" }, userChecklist: asked,
                    checklist_digest_at_instruction: din.checklist_digest_at_instruction } },
      { userChecklist: now, checklistAnswers: { chk_public: true }, checklist_digest_at_instruction: din.checklist_digest_at_instruction });
    const same = await trigger([APPROVE], [APPROVE]);
    check("trigger, rules unchanged: the approval stands, executes", [same.r.checklist_changed, same.r.execution_decision], [null, "execute"]);
    const CHANGED = { ...APPROVE, stated_as: "Public places only, indoors." };
    const changed = await trigger([APPROVE], [CHANGED]);
    check("trigger, a rule changed: recorded", [changed.r.checklist_changed?.at_instruction, changed.r.checklist_changed?.now === changed.r.checklist_digest],
      [din.checklist_digest_at_instruction, true]);
    check("  a yes given while the old rule was asked is voided", changed.r.checklist_changed?.approvals_voided, ["chk_public"]);
    check("  so it is asked again, not executed", [changed.r.user_checklist[0].status, changed.r.execution_decision], ["unverified", "ask_user"]);
    const askedNew = await trigger([CHANGED], [CHANGED]);
    check("  a yes to the question as it now stands counts", askedNew.r.execution_decision, "execute");
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
      over: { measure: () => undefined } });
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
    check("schema_version", persisted?.schema_version, "1.26");
    check("value_checks", persisted?.value_checks?.length, r.value_checks.length);
    check("unverified_value_check_count", persisted?.unverified_value_check_count, r.unverified_value_check_count);
    check("checklist_digest", persisted?.checklist_digest, r.checklist_digest);
    check("checklist_changed (null, not dropped)", "checklist_changed" in (persisted ?? {}), true);
    check("each item's rule_hash", [persisted?.user_checklist?.[0]?.rule_hash, persisted?.provider_checklist?.[0]?.rule_hash].every(h => typeof h === "string"), true);
  }

  // ══ 7 ══════════════════════════════════════════════════════════════════════════════════
  heading("7. a labelled line is translated once, kept, and shown in the record (3.3, 4.2.1)");
  {
    const WORDS = "The buyer's contact is read from the platform, never from what anyone says.";
    const LINE = `Schedule a pickup.\n[Required] ${WORDS}`;
    const proposal = { compare: { kind: "value_source", slot: "buyer_contact" }, constrains: [] };
    let proposed = 0;
    const propose = req => { proposed += 1; return req.label === "Required" ? { ...proposal, by: "stub-model" } : undefined; };
    const storage = memStorage();
    const first = await run({ storage, measured: ALL_MEASURED, tool: tool(LINE), over: { proposeComparableForm: propose } });
    check("translated on first sight and compared in this run: executes", [cond(first.r).status, cond(first.r).source, first.r.execution_decision],
      ["checked", "measured_data", "execute"]);
    check("  nobody is asked to approve it", [first.r.gate?.form_approvals ?? null, first.r.gate?.questions ?? null], [null, null]);
    check("  the record shows the form, the words code wrote from it, and who translated it",
      [JSON.stringify(cond(first.r).compare), cond(first.r).form_translation?.text, cond(first.r).form_translation?.translated_by, cond(first.r).form_translation?.new],
      [JSON.stringify(proposal.compare), describeForm(proposal, "Required"), "stub-model", true]);
    check("  the model was asked once", proposed, 1);
    const kept = storage.all.filter(e => e.key.startsWith("__form_translation__")).map(e => e.record);
    check("  the translation is kept under the line's own key", [kept.length, kept[0]?.kind, kept[0]?.status, kept[0]?.key === cond(first.r).form_translation?.key],
      [1, "form_translation", "translated", true]);

    const second = await run({ storage, measured: ALL_MEASURED, tool: tool(LINE), over: { proposeComparableForm: propose } });
    check("the same words: the kept translation, the model not asked again", [cond(second.r).form_translation?.new, proposed, second.r.execution_decision],
      [false, 1, "execute"]);
    check("  compared the same way", JSON.stringify(cond(second.r).compare), JSON.stringify(cond(first.r).compare));
    check("  the line's version includes its form", cond(second.r).rule_hash === itemHashWithout(second.r), false);

    const reworded = await run({ storage, measured: ALL_MEASURED, over: { proposeComparableForm: propose },
      tool: tool("Schedule a pickup.\n[Required] The buyer's contact is read from the platform only.") });
    check("a reworded line is translated again", [proposed, cond(reworded.r).form_translation?.new], [2, true]);

    const none = await run({ measured: ALL_MEASURED, tool: tool(LINE), over: { proposeComparableForm: () => undefined } });
    check("no form proposed: unverified, the declaration's gap", [cond(none.r).status, cond(none.r).route, none.r.execution_decision],
      ["unverified", "definition_repair", "definition_repair"]);
    check("  and says why", /no form was proposed/.test(cond(none.r).note ?? ""), true);
    const threw = await run({ measured: ALL_MEASURED, tool: tool(LINE), over: { proposeComparableForm: () => { throw new Error("model down"); } } });
    check("a translation that throws: unverified, nothing kept", [cond(threw.r).status, /model down/.test(cond(threw.r).note ?? ""),
      threw.storage.all.some(e => e.key.startsWith("__form_translation__"))], ["unverified", true, false]);
    const misfit = await run({ measured: ALL_MEASURED, tool: tool(LINE), over: { proposeComparableForm: () => ({ compare: { kind: "user_approval" } }) } });
    check("a form that does not fit the label ([Required] as the user's approval): not used", [cond(misfit.r).status, /\[Required\]/.test(cond(misfit.r).note ?? "")],
      ["unverified", true]);

    const noList = memStorage({ withList: false });
    const blind = await run({ storage: noList, measured: ALL_MEASURED, tool: tool(LINE), over: { proposeComparableForm: propose } });
    check("a storage that cannot list cannot keep a translation: unverified (fail-closed)", [cond(blind.r).status, /cannot list/.test(cond(blind.r).note ?? "")],
      ["unverified", true]);

    const request = { declared_by: "provider", tool: "schedule_pickup", label: "Required", wording: WORDS };
    const refuse = async (fn, r, o) => { try { await fn(r, o); return "accepted"; } catch (e) { return e.message.replace(/^form approval: /, ""); } };
    check("approveForm on a provider line: refused, it is not approved", /not approved/.test(await refuse(first.preflight.approveForm, request, { form: proposal, approved_by: "x" })), true);
    const before = proposed;
    await first.preflight.revokeForm(request, { revoked_by: "ops" });
    const again = await run({ storage, measured: ALL_MEASURED, tool: tool(LINE), over: { proposeComparableForm: propose } });
    check("revokeForm drops the translation: the next run translates the line again", [proposed - before, cond(again.r).form_translation?.new], [1, true]);

    // The form in words, written by code from the form.
    check("a value_source form, in words", describeForm(proposal, "Required"),
      "buyer_contact is taken only from a system measurement (measured_data). The user's words and answers never fill it, and the user is not asked for it.");
    check("  a measured fact", describeForm({ compare: { source: "measured_data", measure: "order_status", schema: { const: "agreed" } } }, "Required"),
      "holds only when the system measurement order_status is exactly \"agreed\". A measurement that cannot be read leaves it unconfirmed, and the run does not execute.");
    check("  the user's own value, a measurement inside their range too",
      /only from the user.*only inside a range the user set/.test(describeForm({ compare: { kind: "value_source", slot: "time", measured_within_user_range: true } }, "Verify")), true);
    check("  the user's approval, for the values shown",
      /each time, for the values of location shown/.test(describeForm({ compare: { kind: "user_approval" }, constrains: ["location"] }, "Verify")), true);
    check("  a kind it does not read says so", /compared by the adopting system's own code/.test(describeForm({ compare: { kind: "not_after", hhmm: "20:00" } }, "")), true);
    check("  a form that does not fit its label says so", /does not fit its label/.test(describeForm({ compare: { kind: "value_source", slot: "time", measured_within_user_range: true } }, "Required")), true);
    const read = await readTranslatedForms(storage, tool(LINE));
    check("readTranslatedForms: each labelled line with its kept form, for audit", [read.length, read[0].label, JSON.stringify(read[0].form?.compare), read[0].translated_by],
      [1, "Required", JSON.stringify(proposal.compare), "stub-model"]);
    check("  a line not translated yet reads null", (await readTranslatedForms(memStorage(), tool(LINE)))[0].form, null);

    // [ALSO MEASURED] A [Verify] line about a value the user can give and the system can also measure:
    //   the translation is marked for review. The mark changes no verdict.
    const PLINE = "Schedule a pickup.\n[Verify] The location is the place the seller names.";
    const asSource = () => ({ compare: { kind: "value_source", slot: "location" }, constrains: ["location"] });
    const pStore = memStorage();
    const names = list => ({ proposeComparableForm: asSource, getMeasurableNames: () => list });
    const marked = await run({ storage: pStore, measured: ALL_MEASURED, tool: tool(PLINE), over: names(["order_status", "location"]) });
    const plain = await run({ measured: ALL_MEASURED, tool: tool(PLINE), over: names(["order_status"]) });
    check("a [Verify] line about a value the system can also measure: the translation is marked for review",
      [cond(marked.r).form_translation?.review?.also_measured, /check that the form says what the sentence means/.test(cond(marked.r).form_translation?.review?.why ?? "")], [["location"], true]);
    check("  the mark changes no verdict: the same decision and status as without it",
      [marked.r.execution_decision, cond(marked.r).status, cond(marked.r).source], [plain.r.execution_decision, cond(plain.r).status, cond(plain.r).source]);
    check("  and is in the record as persisted", marked.persisted?.provider_checklist?.[0]?.form_translation?.review?.also_measured, ["location"]);
    const unnamed = await run({ measured: ALL_MEASURED, tool: tool(PLINE), over: { proposeComparableForm: asSource } });
    const broken = await run({ measured: ALL_MEASURED, tool: tool(PLINE), over: { proposeComparableForm: asSource, getMeasurableNames: () => { throw new Error("x"); } } });
    check("  not marked: a value not measured, no names given, or a names hook that throws",
      [cond(plain.r).form_translation?.review, cond(unnamed.r).form_translation?.review, cond(broken.r).form_translation?.review, broken.r.execution_decision],
      [undefined, undefined, undefined, plain.r.execution_decision]);
    const req = await run({ measured: ALL_MEASURED, tool: tool(LINE), over: { proposeComparableForm: propose, getMeasurableNames: () => ["buyer_contact"] } });
    check("  a [Required] line is not marked: its label already says only the system's value counts", cond(req.r).form_translation?.review, undefined);
    check("readTranslatedForms marks it too, given the names; not without them",
      [(await readTranslatedForms(pStore, tool(PLINE), { measurements: ["location"] }))[0].review?.also_measured, (await readTranslatedForms(pStore, tool(PLINE)))[0].review],
      [["location"], undefined]);

    // A [Verify] line translated as the user's approval of a slot: the seller is asked, with the place shown.
    const VLINE = "Schedule a pickup.\n[Verify] The seller agrees to the pickup place.";
    const asApproval = () => ({ compare: { kind: "user_approval" }, constrains: ["location"] });
    const v1 = await run({ measured: ALL_MEASURED, tool: tool(VLINE), over: { proposeComparableForm: asApproval } });
    const q = (v1.r.gate?.questions ?? []).find(x => x.kind === "approve") ?? {};
    check("translated [Verify] line: the seller is asked, with the place shown", [v1.r.execution_decision, q.shown?.location, q.shown_text?.location],
      ["ask_user", "Hongdae station lockers", JSON.stringify("Hongdae station lockers")]);
    const v2 = await run({ measured: ALL_MEASURED, tool: tool(VLINE), over: { proposeComparableForm: asApproval } },
      { checklistAnswers: { [cond(v1.r).id]: true } });
    check("  the seller's yes, bound: checked from user_answer, executes", [cond(v2.r).status, cond(v2.r).source, v2.r.execution_decision],
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

    // Confirmed in conversation: the question shows the user's words and what code says the form checks;
    //   the user's yes keeps the form, and the condition is compared in it in the same run.
    const NOT_AFTER = { compare: { kind: "not_after", hhmm: "20:00" }, constrains: ["time"] };
    const proposeUser = req => (req.declared_by === "user" ? NOT_AFTER : undefined);
    const sConv = memStorage();
    const convAsk = await run({ storage: sConv, text: said, extract: ex, measured: ALL_MEASURED,
      over: { extractUserConditions: extract([claim]), proposeComparableForm: proposeUser, verifyUserChecklistItem: evening } });
    const fq = (convAsk.r.gate?.questions ?? []).find(x => x.kind === "confirm_form") ?? {};
    check("the user is asked to confirm the form, shown with what it checks", [fq.wording, fq.text, convAsk.r.execution_decision],
      ["Nothing after 8pm.", describeForm(NOT_AFTER, ""), "ask_user"]);
    const convYes = await run({ storage: sConv, instruction: [{ trust: "user", text: said }, { trust: "user", text: "yes" }], extract: ex, measured: ALL_MEASURED,
      over: { extractUserConditions: extract([claim]), proposeComparableForm: proposeUser, verifyUserChecklistItem: evening } });
    const it3 = (convYes.r.user_checklist ?? []).find(i => i.extracted) ?? {};
    check("  the user's yes keeps it, and it is compared in this run: executes", [it3.form_approval?.approved_by, it3.status, convYes.r.execution_decision],
      ["user:u", "verified", "execute"]);

    // [FORM TRIED] The question shows what the proposed form says about the values shown with it, computed
    //   by the same comparison the gate runs. A wrong form shows as wrong, before the user confirms it.
    const tried = (await Promise.all([NOT_AFTER, { compare: { kind: "not_after", hhmm: "12:00" }, constrains: ["time"] }].map(async form => {
      const r = await run({ storage: memStorage(), text: said, extract: ex, measured: ALL_MEASURED,
        over: { extractUserConditions: extract([claim]), proposeComparableForm: req => (req.declared_by === "user" ? form : undefined), verifyUserChecklistItem: evening } });
      const q = (r.r.gate?.questions ?? []).find(x => x.kind === "confirm_form") ?? {};
      return [q.tried?.result, (r.r.gate?.question_block ?? []).some(l => l.endsWith(`for time = 2026-10-31 (Sat) 14:00 +09:00: ${q.tried?.result}`))];
    })));
    check("a proposed form is tried on the value shown: a right one holds, a wrong one does not, and the block says so",
      tried, [["holds", true], ["does not hold", true]]);
    const notTried = await run({ storage: memStorage(), text: said, extract: ex, measured: ALL_MEASURED,
      over: { extractUserConditions: extract([claim]), proposeComparableForm: req => (req.declared_by === "user" ? { compare: { kind: "user_approval" }, constrains: ["time"] } : undefined) } });
    check("  a form with nothing to compute is not tried", ((notTried.r.gate?.questions ?? []).find(x => x.kind === "confirm_form") ?? {}).tried ?? null, null);

    // [NO FORM] The model looked and no form fits ("public places only"): not left pending, but asked
    //   like an item with no form, the user approving it for the values shown.
    const pub = { quote: "Public places only.", segment_index: 0, span: [0, 0], constrains: ["location"] };
    const saidPub = "Pick up LST-2291 at 2026-10-31T14:00:00+09:00, Hongdae station lockers. Public places only.";
    const pubClaim = { ...pub, span: [saidPub.indexOf("Public"), saidPub.length] };
    const exPub = { item_id: at(saidPub, "LST-2291"), time: at(saidPub, SAT_2PM), location: at(saidPub, "Hongdae station lockers") };
    const noForm = req => (req.declared_by === "user" ? null : undefined);
    const sPub = memStorage();
    const p1 = await run({ storage: sPub, text: saidPub, extract: exPub, measured: ALL_MEASURED,
      over: { extractUserConditions: extract([pubClaim]), proposeComparableForm: noForm } });
    const pi = (p1.r.user_checklist ?? []).find(i => i.extracted) ?? {};
    const pq = (p1.r.gate?.questions ?? []).find(x => x.kind === "approve" && x.id === pi.id) ?? {};
    check("no form fits: not pending, asked for approval with the value shown",
      [Boolean(pi.form_pending), typeof pi.form_none?.why, pq.shown?.location, p1.r.execution_decision], [false, "string", "Hongdae station lockers", "ask_user"]);
    const p2 = await run({ storage: sPub, instruction: [{ trust: "user", text: saidPub }, { trust: "user", text: "yes" }], extract: exPub, measured: ALL_MEASURED,
      over: { extractUserConditions: extract([pubClaim]), proposeComparableForm: noForm } });
    const pi2 = (p2.r.user_checklist ?? []).find(i => i.extracted) ?? {};
    check("  the user's yes for that value: verified, executes", [pi2.status, pi2.source, p2.r.execution_decision], ["verified", "user_answer", "execute"]);
    const p3 = await run({ storage: memStorage(), text: saidPub, extract: exPub, measured: ALL_MEASURED,
      over: { extractUserConditions: extract([pubClaim]), proposeComparableForm: () => undefined } });
    const pi3 = (p3.r.user_checklist ?? []).find(i => i.extracted) ?? {};
    const asApprovalUser = req => (req.declared_by === "user" ? { compare: { kind: "user_approval" }, constrains: ["location"] } : undefined);
    const sA = memStorage();
    const pa1 = await run({ storage: sA, text: saidPub, extract: exPub, measured: ALL_MEASURED,
      over: { extractUserConditions: extract([pubClaim]), proposeComparableForm: asApprovalUser } });
    const pai = (pa1.r.user_checklist ?? []).find(i => i.extracted) ?? {};
    check("  'the user approves it' proposed: the same as no form — no form to confirm, the place asked about",
      [Boolean(pai.form_pending), (pa1.r.gate?.questions ?? []).map(q => q.kind)], [false, ["approve"]]);
    const pa2 = await run({ storage: sA, instruction: [{ trust: "user", text: saidPub }, { trust: "user", text: "yes" }], extract: exPub, measured: ALL_MEASURED,
      over: { extractUserConditions: extract([pubClaim]), proposeComparableForm: asApprovalUser } });
    check("    one yes: verified, executes", [((pa2.r.user_checklist ?? []).find(i => i.extracted) ?? {}).status, pa2.r.execution_decision], ["verified", "execute"]);
    // [UNFIT FORM] A form no user's condition can take is not put to the user to confirm: taken as no form,
    //   the proposal kept beside it. A real model proposed value_source for "Use the buyer's in-app chat",
    //   and the seller was shown "a value_source form that does not fit its label".
    const unfitForms = {
      value_source: { compare: { kind: "value_source", slot: "location" }, constrains: ["location"] },
      unnamed_measure: { compare: { source: "measured_data", schema: { const: true } }, constrains: [] },
      no_value: { compare: { const: "Hongdae station lockers" }, constrains: [] },
    };
    const unfitSeen = [];
    for (const [name, form] of Object.entries(unfitForms)) {
      const uf = await run({ storage: memStorage(), text: saidPub, extract: exPub, measured: ALL_MEASURED,
        over: { extractUserConditions: extract([pubClaim]), proposeComparableForm: req => (req.declared_by === "user" ? form : undefined) } });
      const ui = (uf.r.user_checklist ?? []).find(i => i.extracted) ?? {};
      const qs = uf.r.gate?.questions ?? [];
      unfitSeen.push([name, Boolean(ui.form_pending), qs.map(q => q.kind), /does not fit a user's condition/.test(ui.form_none?.why ?? ""),
        JSON.stringify(ui.form_none?.proposed?.compare) === JSON.stringify(form.compare), (uf.r.gate?.question_block ?? []).some(l => /does not fit/.test(l))]);
    }
    check("  a form no user's condition can take: not asked to confirm, approved for the value shown, the proposal kept",
      unfitSeen, Object.keys(unfitForms).map(n => [n, false, ["approve"], true, true, false]));
    const fitting = await run({ storage: memStorage(), text: saidPub, extract: exPub, measured: ALL_MEASURED,
      over: { extractUserConditions: extract([pubClaim]), proposeComparableForm: req => (req.declared_by === "user" ? { compare: { const: "Hongdae station lockers" }, constrains: ["location"] } : undefined) } });
    check("    a schema on the value it constrains still fits: asked to confirm, as before",
      (fitting.r.gate?.questions ?? []).map(q => q.kind), ["confirm_form"]);
    const standingApproval = { id: "pref_pub", stated_as: "Public places only.", constrains: ["location"], compare: { kind: "user_approval" } };
    let verifyCalls = 0;
    const sp = await run({ storage: memStorage(), text: saidPub, extract: exPub, measured: ALL_MEASURED,
      over: { verifyUserChecklistItem: (it) => { verifyCalls++; return { ...it, status: "unverified", source: null }; } } }, { userChecklist: [standingApproval] });
    check("  a standing item of kind user_approval is not handed to the comparison: it is asked about",
      [verifyCalls, ((sp.r.user_checklist ?? []).find(i => i.id === "pref_pub") ?? {}).note], [0, "the user approves it for the values shown"]);
    check("  no proposal at all (undefined) is not 'no form fits': still pending, for a form to be confirmed",
      [Boolean(pi3.form_pending), pi3.form_none ?? null], [true, null]);

    // [READ ONCE] Within a unit, the words already read are not read again: the conditions are carried,
    //   and a different split of the same words in a later round is set aside.
    {
      const two = "Pick up LST-2291 at 2026-10-31T14:00:00+09:00, Hongdae station lockers. Nothing after 8pm, public places only.";
      const exTwo = { item_id: at(two, "LST-2291"), time: at(two, SAT_2PM), location: at(two, "Hongdae station lockers") };
      const A = { quote: "Nothing after 8pm", segment_index: 0, span: [two.indexOf("Nothing"), two.indexOf("Nothing") + 17], constrains: ["time"] };
      const B = { quote: "public places only", segment_index: 0, span: [two.indexOf("public"), two.indexOf("public") + 18], constrains: ["location"] };
      const merged = { quote: "Nothing after 8pm, public places only", segment_index: 0, span: [two.indexOf("Nothing"), two.length - 1], constrains: ["time", "location"] };
      const sOnce = memStorage();
      let calls = 0, proposals = 0;
      const extractOf = list => () => { calls++; return list; };
      const proposeOnce = req => { if (req.declared_by !== "user") return undefined; proposals++; return null; };
      const ids = r => (r.r.user_checklist ?? []).filter(i => i.extracted).map(i => i.stated_as);
      const r1 = await run({ storage: sOnce, instruction: [{ trust: "user", text: two }], extract: exTwo, measured: ALL_MEASURED,
        over: { extractUserConditions: extractOf([A, B]), proposeComparableForm: proposeOnce } });
      check("round 1: two conditions taken, and how far the words were read", [ids(r1), vc(r1.r, "user_conditions")?.read_through],
        [["Nothing after 8pm", "public places only"], 1]);
      const r2 = await run({ storage: sOnce, instruction: [{ trust: "user", text: two }, { trust: "user", text: "ok" }], extract: exTwo, measured: ALL_MEASURED,
        over: { extractUserConditions: extractOf([merged]), proposeComparableForm: proposeOnce } });
      check("round 2: the same words split differently are set aside; the two are carried",
        [ids(r2), /set aside/.test(vc(r2.r, "user_conditions")?.note ?? "")], [["Nothing after 8pm", "public places only"], true]);
      const callsBefore = calls;
      const r3 = await run({ storage: sOnce, instruction: [{ trust: "user", text: two }, { trust: "user", text: "ok" }, { trust: "assistant", text: "One more thing?" }],
        extract: exTwo, measured: ALL_MEASURED, over: { extractUserConditions: extractOf([merged]), proposeComparableForm: proposeOnce } });
      check("nothing new from the user: the extractor is not called, the conditions are carried", [calls - callsBefore, ids(r3)],
        [0, ["Nothing after 8pm", "public places only"]]);
      check("  'no form fits' was settled once in the unit: not proposed again", proposals, 2);
      const said4 = "And not on Sundays.";
      const C = { quote: "not on Sundays", segment_index: 3, span: [4, 18], constrains: ["time"] };
      const r4 = await run({ storage: sOnce, instruction: [{ trust: "user", text: two }, { trust: "user", text: "ok" }, { trust: "assistant", text: "One more thing?" }, { trust: "user", text: said4 }],
        extract: exTwo, measured: ALL_MEASURED, over: { extractUserConditions: extractOf([merged, C]), proposeComparableForm: proposeOnce } });
      check("new words with a new condition: it joins the carried ones", ids(r4), ["Nothing after 8pm", "public places only", "not on Sundays"]);
    }

    // [VALUE READ ONCE] Within a unit, a value read from the user's words is not read again from the same
    //   words. A real model read one sentence as "the Hongdae station lockers", then "Hongdae station
    //   lockers": the yes to "public places only", bound to the place shown, stopped counting each round.
    {
      const sv = "Pick up LST-2291 at 2026-10-31T14:00:00+09:00 at the Hongdae station lockers. Public places only.";
      const pubV = { quote: "Public places only.", segment_index: 0, span: [sv.indexOf("Public"), sv.length], constrains: ["location"] };
      const exWith = place => ({ item_id: at(sv, "LST-2291"), time: at(sv, SAT_2PM), location: at(sv, place) });
      const noFormV = req => (req.declared_by === "user" ? null : undefined);
      const over = { extractUserConditions: extract([pubV]), proposeComparableForm: noFormV };
      const loc = r => (r.r.fields ?? []).find(f => f.name === "location") ?? {};
      const sV = memStorage();
      const v1 = await run({ storage: sV, instruction: [{ trust: "user", text: sv }], extract: exWith("the Hongdae station lockers"), measured: ALL_MEASURED, over });
      check("round 1: the place read, how far the words were read, and the approval asked for that place",
        [loc(v1).value, loc(v1).read_through, ((v1.r.gate?.questions ?? []).find(q => q.kind === "approve") ?? {}).shown?.location],
        ["the Hongdae station lockers", 1, "the Hongdae station lockers"]);
      const v2 = await run({ storage: sV, instruction: [{ trust: "user", text: sv }, { trust: "user", text: "yes" }], extract: exWith("Hongdae station lockers"), measured: ALL_MEASURED, over });
      check("round 2: the same words read differently are set aside; the place is carried, the yes counts, executes",
        [loc(v2).value, loc(v2).read_once?.set_aside?.value, loc(v2).source, v2.r.execution_decision],
        ["the Hongdae station lockers", "Hongdae station lockers", "instruction", "execute"]);
      const sN = memStorage();
      await run({ storage: sN, instruction: [{ trust: "user", text: sv }], extract: exWith("the Hongdae station lockers"), measured: ALL_MEASURED, over });
      const moved = "Make it Sinchon station instead.";
      const exMoved = { ...exWith("the Hongdae station lockers"), location: { value: "Sinchon station", segment_index: 1, span: [8, 23] } };
      const v3 = await run({ storage: sN, instruction: [{ trust: "user", text: sv }, { trust: "user", text: moved }], extract: exMoved, measured: ALL_MEASURED, over });
      check("  the user says a new place in new words: it is taken, not carried, and the approval is asked for it",
        [loc(v3).value, Boolean(loc(v3).read_once), ((v3.r.gate?.questions ?? []).find(q => q.kind === "approve") ?? {}).shown?.location, v3.r.execution_decision],
        ["Sinchon station", false, "Sinchon station", "ask_user"]);
      const v4 = await run({ storage: memStorage(), instruction: [{ trust: "user", text: sv }, { trust: "user", text: "yes" }], extract: exWith("Hongdae station lockers"), measured: ALL_MEASURED, over });
      check("  a first round has nothing to carry: the value is read as it comes", [loc(v4).value, Boolean(loc(v4).read_once)], ["Hongdae station lockers", false]);
    }

    // [FORM DECLINED] The user says no to the proposed form: the condition is approved by the user for the
    //   values shown, and the form is not proposed again in the unit.
    {
      let proposals = 0;
      const proposeCount = req => { if (req.declared_by !== "user") return undefined; proposals++; return NOT_AFTER; };
      const sD = memStorage();
      const d1 = await run({ storage: sD, instruction: [{ trust: "user", text: said }], extract: ex, measured: ALL_MEASURED,
        over: { extractUserConditions: extract([claim]), proposeComparableForm: proposeCount, verifyUserChecklistItem: evening } });
      check("the form is proposed and asked to confirm", [(d1.r.gate?.questions ?? []).map(q => q.kind), proposals], [["confirm_form"], 1]);
      const d2 = await run({ storage: sD, instruction: [{ trust: "user", text: said }, { trust: "user", text: "no" }], extract: ex, measured: ALL_MEASURED,
        over: { extractUserConditions: extract([claim]), proposeComparableForm: proposeCount, verifyUserChecklistItem: evening } });
      const di = (d2.r.user_checklist ?? []).find(i => i.extracted) ?? {};
      const dq = (d2.r.gate?.questions ?? []).find(q => q.kind === "approve" && q.id === di.id) ?? {};
      check("  the user says no: the form is not proposed again; the item is asked to approve for the time shown",
        [proposals, typeof di.form_none?.declined, dq.shown?.time, d2.r.execution_decision], [1, "object", SAT_2PM, "ask_user"]);
      const d3 = await run({ storage: sD, instruction: [{ trust: "user", text: said }, { trust: "user", text: "no" }, { trust: "user", text: "yes" }], extract: ex, measured: ALL_MEASURED,
        over: { extractUserConditions: extract([claim]), proposeComparableForm: proposeCount, verifyUserChecklistItem: evening } });
      const di3 = (d3.r.user_checklist ?? []).find(i => i.extracted) ?? {};
      check("  the user approves 14:00 for it: verified by the user, executes, the declined form kept in the record",
        [di3.status, di3.source, d3.r.execution_decision, Boolean(di3.form_none?.declined?.form), proposals], ["verified", "user_answer", "execute", true, 1]);
      // [REPLY IN FRONT] A reader that maps the last yes onto every question asked in the unit: the yes
      //   counts only for the question in front of it.
      const yesToAll = (instr, questions) => questions.map(q => ({ target: q.target, answer: true, quote: "yes", segment_index: 2, span: [0, 3] }));
      const sR = memStorage();
      await run({ storage: sR, instruction: [{ trust: "user", text: said }], extract: ex, measured: ALL_MEASURED,
        over: { extractUserConditions: extract([claim]), proposeComparableForm: proposeCount, verifyUserChecklistItem: evening } });
      await run({ storage: sR, instruction: [{ trust: "user", text: said }, { trust: "user", text: "no" }], extract: ex, measured: ALL_MEASURED,
        over: { extractUserConditions: extract([claim]), proposeComparableForm: proposeCount, verifyUserChecklistItem: evening } });
      const r3 = await run({ storage: sR, instruction: [{ trust: "user", text: said }, { trust: "user", text: "no" }, { trust: "user", text: "yes" }], extract: ex, measured: ALL_MEASURED,
        over: { extractUserConditions: extract([claim]), proposeComparableForm: proposeCount, verifyUserChecklistItem: evening, readReplies: yesToAll } });
      const ri = (r3.r.user_checklist ?? []).find(i => i.extracted) ?? {};
      const formClaim = (r3.r.value_checks ?? []).find(c => c.target === `form:${ri.id}`) ?? {};
      check("  [REPLY IN FRONT] a later yes mapped onto the form asked before is refused; it approves the question in front of it",
        [formClaim.status, /comes after a later question/.test(formClaim.note ?? ""), ri.status, ri.source, Boolean(ri.form_approval)],
        ["rejected", true, "verified", "user_answer", false]);
      const fresh = await run({ storage: memStorage(), instruction: [{ trust: "user", text: said }], extract: ex, measured: ALL_MEASURED,
        over: { extractUserConditions: extract([claim]), proposeComparableForm: proposeCount, verifyUserChecklistItem: evening } });
      check("  a new request: the form is proposed again (the no held for that unit only)",
        (fresh.r.gate?.questions ?? []).map(q => q.kind), ["confirm_form"]);
    }

    // [WITHDRAWN] A condition the user takes back is not dropped: the user confirms it, and it stays in the
    //   record as withdrawn. Declined, it is compared as before.
    {
      const late = "Pick up LST-2291 at 2026-10-31T21:00:00+09:00, Hongdae station lockers. Nothing after 8pm.";
      const back = "Keep 9pm and drop the 8pm limit.";
      const exLate = { item_id: at(late, "LST-2291"), time: at(late, "2026-10-31T21:00:00+09:00"), location: at(late, "Hongdae station lockers") };
      const cond = { quote: "Nothing after 8pm.", segment_index: 0, span: [late.indexOf("Nothing"), late.length], constrains: ["time"] };
      const withBack = { ...cond, withdrawn_by: { quote: "drop the 8pm limit", segment_index: 1, span: [back.indexOf("drop"), back.indexOf("drop") + 18] } };
      const NA = { compare: { kind: "not_after", hhmm: "20:00" }, constrains: ["time"] };
      const conv = (...more) => [{ trust: "user", text: late }, { trust: "user", text: back }, ...more];
      const over = list => ({ extractUserConditions: () => list, proposeComparableForm: req => (req.declared_by === "user" ? NA : undefined), verifyUserChecklistItem: evening });
      const sW = memStorage();
      const w1 = await run({ storage: sW, instruction: conv(), extract: exLate, measured: ALL_MEASURED, over: over([withBack]) });
      const wi = (w1.r.user_checklist ?? []).find(i => i.extracted) ?? {};
      const wq = (w1.r.gate?.questions ?? []).find(q => q.kind === "withdraw") ?? {};
      check("taken back in the user's words: not dropped, asked to confirm, and not compared meanwhile",
        [wi.status, wi.withdrawal?.status, wq.withdrawn_by, w1.r.execution_decision,
         (w1.r.gate?.question_block ?? []).includes('"Nothing after 8pm." — remove this condition? (you said: "drop the 8pm limit")')],
        ["unverified", "proposed", "drop the 8pm limit", "ask_user", true]);
      const w2 = await run({ storage: sW, instruction: conv({ trust: "user", text: "yes" }), extract: exLate, measured: ALL_MEASURED, over: over([withBack]) });
      const wi2 = (w2.r.user_checklist ?? []).find(i => i.extracted) ?? {};
      check("  confirmed: withdrawn, kept in the record with the words, 21:00 executes",
        [wi2.status, wi2.withdrawal?.status, wi2.withdrawal?.quote, w2.r.execution_decision], ["withdrawn", "confirmed", "drop the 8pm limit", "execute"]);
      const sN = memStorage();
      await run({ storage: sN, instruction: conv(), extract: exLate, measured: ALL_MEASURED, over: over([withBack]) });
      const n2 = await run({ storage: sN, instruction: conv({ trust: "user", text: "no" }), extract: exLate, measured: ALL_MEASURED, over: over([withBack]) });
      const ni = (n2.r.user_checklist ?? []).find(i => i.extracted) ?? {};
      check("  declined: the condition stands, and its form is asked for now", [ni.withdrawal?.status, n2.r.execution_decision,
        (n2.r.gate?.questions ?? []).some(q => q.kind === "confirm_form" && q.id === ni.id)], ["declined", "ask_user", true]);
      const n3 = await run({ storage: sN, instruction: conv({ trust: "user", text: "no" }, { trust: "user", text: "yes" }), extract: exLate, measured: ALL_MEASURED, over: over([withBack]) });
      check("    its form confirmed, it is compared: 21:00 is held", n3.r.execution_decision, "hold");
      const misplaced = { ...cond, withdrawn_by: { quote: "Hongdae station lockers", segment_index: 0, span: [late.indexOf("Hongdae"), late.indexOf("Hongdae") + 23] } };
      const m1 = await run({ storage: memStorage(), instruction: conv(), extract: exLate, measured: ALL_MEASURED, over: over([misplaced]) });
      const mi = (m1.r.user_checklist ?? []).find(i => i.extracted) ?? {};
      check("  words that come before the condition do not take it back: not kept, noted",
        [mi.withdrawal ?? null, /taking back not kept/.test(vc(m1.r, "user_conditions")?.note ?? "")], [null, true]);
      // Carried from an earlier round, and taken back in new words.
      const sC = memStorage();
      await run({ storage: sC, instruction: [{ trust: "user", text: late }], extract: exLate, measured: ALL_MEASURED, over: over([cond]) });
      const c2 = await run({ storage: sC, instruction: conv(), extract: exLate, measured: ALL_MEASURED, over: over([withBack]) });
      const ci = (c2.r.user_checklist ?? []).find(i => i.extracted) ?? {};
      check("  a carried condition taken back in the new words: asked to confirm", [ci.withdrawal?.status, c2.r.execution_decision], ["proposed", "ask_user"]);
    }

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

    // A range the user stated but has not confirmed yet does not open the slot to a measurement (3.3).
    const window = "Pick up LST-2291 at Hongdae station lockers. Any time this Saturday between 1pm and 6pm.";
    const winClaim = { quote: "Any time this Saturday between 1pm and 6pm.", segment_index: 0, span: [window.indexOf("Any"), window.length], constrains: ["time"] };
    const TIME_RULE = [{ id: "c_time", label: "Verify", description: "The seller's time, or a request inside their range.",
                         compare: { kind: "value_source", slot: "time", measured_within_user_range: true } }];
    const unconfirmedRange = await run({ text: window, extract: { item_id: at(window, "LST-2291"), location: at(window, "Hongdae station lockers") },
      measured: { ...ALL_MEASURED, time: SAT_3PM }, conditions: TIME_RULE, over: { extractUserConditions: extract([winClaim]) } });
    check("a range not yet confirmed: the buyer's requested time is not taken", [field(unconfirmedRange.r, "time").status, field(unconfirmedRange.r, "time").range_declared], ["unknown", false]);

    const unwired = createPreflight({ hooks: hooks({ measured: ALL_MEASURED }), storage: memStorage() });
    check("unwired, the gate says so: extractUserConditions is an unsafe default", unwired.unsafeDefaults.includes("extractUserConditions"), true);
  }

  // ══ 9 ══════════════════════════════════════════════════════════════════════════════════
  heading("9. an approval is bound to what it approved (6.3, 6.1)");
  {
    const PUBLIC = { id: "chk_public", stated_as: "Public places only.", constrains: ["location"], compare: null };
    const base = await run({ measured: ALL_MEASURED }, { userChecklist: [PUBLIC] });
    const q = (base.r.gate?.questions ?? []).find(x => x.target === "approve:chk_public") ?? {};
    check("the question shows the place and the item's version", [q.shown?.location, q.rule_hash === base.r.user_checklist[0].rule_hash],
      ["Hongdae station lockers", true]);
    check("  and code writes what the user sees", base.r.gate?.question_block, ['Public places only. — for location = "Hongdae station lockers"']);
    check("  with how far the conversation had run when it asked", base.r.gate?.asked_through, 1);
    const go = async (answer, opts = {}) => (await run({ measured: ALL_MEASURED, ...opts }, { userChecklist: [PUBLIC], checklistAnswers: { chk_public: answer } })).r;

    const yes = await go(true);
    check("a yes after the question: verified from user_answer, executes", [yes.user_checklist[0].status, yes.user_checklist[0].source, yes.execution_decision],
      ["verified", "user_answer", "execute"]);
    check("  the record keeps what was shown, and where the user said yes", [yes.user_checklist[0].approval?.shown, vc(yes, "approve:chk_public:answer")?.located_at?.segment_index],
      [{ location: "Hongdae station lockers" }, 1]);
    const no = await go(false);
    check("a no: unmet, held", [no.user_checklist[0].status, no.execution_decision], ["unmet", "hold"]);

    // The place changed between the question and the reply: the yes was for the place shown.
    const moved = "Set up the pickup for LST-2291 at 2026-10-31T14:00:00+09:00, Gangnam station exit 3.";
    const movedEx = { item_id: at(moved, "LST-2291"), time: at(moved, SAT_2PM), location: at(moved, "Gangnam station exit 3") };
    // Asked with the user's first words; answered after the user named another place.
    const sMoved = memStorage();
    await run({ measured: ALL_MEASURED, storage: sMoved }, { userChecklist: [PUBLIC] });
    const elsewhere = (await run({ measured: ALL_MEASURED, storage: sMoved, noPriorAsk: true, extract: movedEx,
        instruction: [{ trust: "user", text: moved }] },
      { userChecklist: [PUBLIC], checklistAnswers: { chk_public: true } })).r;
    check("a yes for the place shown, when the place is now another: voided", [/not the value it approved/.test(elsewhere.user_checklist[0].approval_voided ?? ""), elsewhere.execution_decision],
      [true, "ask_user"]);
    const REWORDED = { ...PUBLIC, stated_as: "Public places only, indoors." };
    const old = (await run({ measured: ALL_MEASURED, askInput: { userId: "u", instruction: SAID, toolCall: { name: "schedule_pickup" }, userChecklist: [PUBLIC] } },
      { userChecklist: [REWORDED], checklistAnswers: { chk_public: true } })).r;
    check("a yes given for another version of the item: voided", /another version/.test(old.user_checklist[0].approval_voided ?? ""), true);

    const RULE = { id: "chk_ok", stated_as: "Fine to go ahead.", compare: null };
    const plain = await run({ measured: ALL_MEASURED }, { userChecklist: [RULE], checklistAnswers: { chk_ok: true } });
    check("an item about no slot: a yes holds", plain.r.user_checklist[0].status, "verified");

    let seen = null;
    const spy = (item, ctx) => { seen = ctx.checklistAnswers; return { ...item, status: "unverified", source: null }; };
    const WITH_FORM = { id: "chk_evening", stated_as: "Nothing after 8pm.", constrains: ["time"], compare: { kind: "not_after", hhmm: "20:00" } };
    const sSpy = memStorage();
    await run({ measured: ALL_MEASURED, storage: sSpy }, { userChecklist: [PUBLIC] });
    await run({ measured: ALL_MEASURED, storage: sSpy, noPriorAsk: true, over: { verifyUserChecklistItem: spy }, extract: movedEx,
        instruction: [{ trust: "user", text: moved }] },
      { userChecklist: [PUBLIC, WITH_FORM], checklistAnswers: { chk_public: true } });
    check("a hook sees only the approvals that hold, as booleans", seen, {});
    const held = (item) => ({ ...item, status: "unmet", source: "instruction" });
    const over = await run({ measured: ALL_MEASURED, over: { verifyUserChecklistItem: held },
        askInput: { userId: "u", instruction: SAID, toolCall: { name: "schedule_pickup" }, userChecklist: [{ ...WITH_FORM, compare: null }] } },
      { userChecklist: [WITH_FORM], checklistAnswers: { chk_evening: true } });
    check("a yes does not override a comparison form", over.r.user_checklist[0].status, "unmet");

    const VCOND = { id: "c_place", label: "Verify", description: "The seller agrees to the place.", constrains: ["location"] };
    const pYes = await run({ measured: ALL_MEASURED, conditions: [VCOND] }, { checklistAnswers: { c_place: true } });
    check("a provider [Verify] condition: a yes after its question checks it from user_answer", [cond(pYes.r).status, cond(pYes.r).source, pYes.r.execution_decision],
      ["checked", "user_answer", "execute"]);
    const RCOND = { id: "c_req", label: "Required", description: "The sale must be agreed.", constrains: [] };
    const pReq = await run({ measured: ALL_MEASURED, conditions: [RCOND] }, { checklistAnswers: { c_req: true } });
    check("  a [Required] condition is not asked, so a yes has nothing to answer",
      [cond(pReq.r).status, pReq.r.execution_decision, vc(pReq.r, "approve:c_req:answer")], ["unverified", "definition_repair", null]);
  }

  // ══ 10 ═════════════════════════════════════════════════════════════════════════════════
  heading("10. replies count only for questions asked; tries are counted from the record (4.5, 4.6)");
  {
    const said = "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae station lockers.";
    const ex = { item_id: at(said, "LST-2291"), time: at(said, "2pm this Saturday"), location: at(said, "Hongdae station lockers") };
    const o = (extra = {}) => ({ text: said, extract: ex, measured: ALL_MEASURED, ...extra });

    const cold = await run(o({ noPriorAsk: true }), { userAnswers: { time: SAT_2PM } });
    check("a yes when this unit has asked nothing: it answers nothing", [field(cold.r, "time").status, cold.r.execution_decision, vc(cold.r, "value:time:answer")],
      ["unknown", "ask_user", null]);

    const storage = memStorage();
    const asked = await run(o({ storage, over: { proposeValue: f => (f === "time" ? { value: SAT_2PM } : undefined) } }));
    const tq = (asked.r.gate?.questions ?? []).find(x => x.target === "value:time") ?? {};
    check("the gate asks for the time, showing a model's reading of the user's words", [tq.candidate?.value, tq.candidate?.shown_text],
      [SAT_2PM, "2026-10-31 (Sat) 14:00 +09:00"]);
    check("  the reading is a candidate, checked against the slot's format before it is shown", vc(asked.r, "time:candidate")?.status, "checked");
    const answered = await run(o({ storage, noPriorAsk: true }), { userAnswers: { time: SAT_2PM, item_id: "LST-9999" } });
    check("  the user's yes to it sets the value, as user_answer", [field(answered.r, "time").source, field(answered.r, "time").value], ["user_answer", SAT_2PM]);
    check("  bound to what was shown, and where the user said it", [field(answered.r, "time").approval?.shown, field(answered.r, "time").approval?.located_at?.segment_index],
      [{ time: SAT_2PM }, 1]);
    check("  a yes slipped in for a slot not asked does not count", [field(answered.r, "item_id").value, vc(answered.r, "value:item_id:answer")?.status], ["LST-2291", "rejected"]);
    check("  executes, with the item the seller named", [answered.r.execution_decision, answered.r.call_arguments?.item_id], ["execute", "LST-2291"]);

    // [CALL DISAGREES] A smaller model proposed 2026-11-01 for "this Saturday", the seller's yes approved
    //   it, the agent's model called with 2026-10-31, and the run executed on the Sunday.
    {
      const SUN_2PM = "2026-11-01T14:00:00+09:00";
      const toolName = tool().name;
      const sd = memStorage();
      await run(o({ storage: sd, over: { proposeValue: f => (f === "time" ? { value: SUN_2PM } : undefined) } }));
      const differs = await run(o({ storage: sd, noPriorAsk: true }),
        { userAnswers: { time: SUN_2PM }, toolCall: { name: toolName, arguments: { time: SAT_2PM } } });
      const dq = (differs.r.gate?.questions ?? []).find(q => q.target === "value:time") ?? {};
      check("the user approved one value, the model's call says another: not executed, asked again with both shown",
        [differs.r.execution_decision, field(differs.r, "time").status, field(differs.r, "time").call_disagrees?.call, dq.candidate?.value, dq.disagrees?.call_value,
         (differs.r.gate?.question_block ?? []).some(l => l === "time = 2026-11-01 (Sun) 14:00 +09:00 — the assistant's call has 2026-10-31 (Sat) 14:00 +09:00")],
        ["ask_user", "unknown", SAT_2PM, SUN_2PM, SAT_2PM, true]);
      const again = await run(o({ storage: sd, noPriorAsk: true, instruction: [{ trust: "user", text: said }, { trust: "user", text: "yes" }] }),
        { userAnswers: { time: SUN_2PM }, toolCall: { name: toolName, arguments: { time: SAT_2PM } } });
      check("  a yes given with that shown settles it; the same difference is not asked again",
        [again.r.execution_decision, field(again.r, "time").value, field(again.r, "time").approval?.disagreed_with], ["execute", SUN_2PM, SAT_2PM]);
      const sSame = memStorage();
      await run(o({ storage: sSame, over: { proposeValue: f => (f === "time" ? { value: SAT_2PM } : undefined) } }));
      const sameInstant = await run(o({ storage: sSame, noPriorAsk: true }),
        { userAnswers: { time: SAT_2PM }, toolCall: { name: toolName, arguments: { time: "2026-10-31T05:00:00Z" } } });
      check("  the same moment written another way is not a difference", sameInstant.r.execution_decision, "execute");
      const sNoise = memStorage();
      await run(o({ storage: sNoise, over: { proposeValue: f => (f === "time" ? { value: SAT_2PM } : undefined) } }));
      const noise = await run(o({ storage: sNoise, noPriorAsk: true }),
        { userAnswers: { time: SAT_2PM }, toolCall: { name: toolName, arguments: { time: "this Saturday", location: "somewhere else" } } });
      check("  a call value not in the field's form, or a field from the user's own words, asks nothing", noise.r.execution_decision, "execute");
    }

    const badReading = await run(o({ over: { proposeValue: () => ({ value: "Saturday 2pm" }) } }));
    check("a reading not in the slot's format is not shown", [vc(badReading.r, "time:candidate")?.status, (badReading.r.gate?.questions ?? [])[0]?.candidate ?? null],
      ["rejected", null]);
    const s0 = memStorage();
    await run(o({ storage: s0 }));
    const nothingShown = await run(o({ storage: s0, noPriorAsk: true }), { userAnswers: { time: SAT_2PM } });
    check("  so a yes has nothing to approve", /nothing was shown/.test(vc(nothingShown.r, "value:time:answer")?.note ?? ""), true);
    const early = await run(o({ storage: memStorage() }));
    const before = [...SAID];
    const replyFirst = [{ trust: "user", text: said }, { trust: "user", text: "yes" }];
    const s9 = memStorage();
    await run(o({ storage: s9, instruction: replyFirst, over: { proposeValue: () => ({ value: SAT_2PM }) } }));
    const claimsEarly = (ins, qs) => qs.map(q => ({ target: q.target, answer: true, quote: "yes", segment_index: 1, span: [0, 3] }));
    const stale = await run(o({ storage: s9, instruction: replyFirst, over: { readReplies: claimsEarly } }));
    check("a yes written before the question was asked does not answer it", [field(stale.r, "time").status, /before the question/.test(vc(stale.r, "value:time:answer")?.note ?? "")],
      ["unknown", true]);
    void early; void before;
    const sBoth = memStorage();
    await run(o({ storage: sBoth, over: { proposeValue: () => ({ value: SAT_2PM }) } }));
    const both = [{ trust: "user", text: said }, { trust: "user", text: "yes, no" }];
    const bothClaims = (ins, qs) => qs.flatMap(q => [
      { target: q.target, answer: true, quote: "yes", segment_index: 1, span: [0, 3] },
      { target: q.target, answer: false, quote: "no", segment_index: 1, span: [5, 7] }]);
    const conflicted = await run(o({ storage: sBoth, noPriorAsk: true, instruction: both,
      over: { readReplies: bothClaims, proposeValue: () => ({ value: SAT_2PM }) } }));
    check("a reply that says yes and no in one place: neither counts", [field(conflicted.r, "time").status, /both yes and no/.test(vc(conflicted.r, "value:time:answer")?.note ?? "")],
      ["unknown", true]);
    const later2 = [...both, { trust: "user", text: "yes" }];
    const changedMind = (ins, qs) => [...bothClaims(ins, qs), ...qs.map(q => ({ target: q.target, answer: true, quote: "yes", segment_index: 2, span: [0, 3] }))];
    const settled = await run(o({ storage: sBoth, noPriorAsk: true, instruction: later2, over: { readReplies: changedMind } }));
    const kept = (settled.r.value_checks ?? []).filter(c => c.id === "value:time:answer");
    check("  a later reply settles it: the latest answer counts", [field(settled.r, "time").source, kept.find(c => c.status === "checked")?.located_at?.segment_index],
      ["user_answer", 2]);
    check("  the earlier ones, written before this question, are refused", kept.filter(c => c.status === "rejected").every(c => /before the question/.test(c.note)), true);

    let n = 0;
    const perRound = { buildActionKey: () => `u:schedule_pickup:${++n}` };
    const s2 = memStorage();
    const lost = await run(o({ storage: s2, over: perRound }), { userAnswers: { time: SAT_2PM } });
    check("a key unique per round: the unit was never asked, the reply is refused", field(lost.r, "time").status, "unknown");

    const s3 = memStorage({ withList: false });
    const blind = await run(o({ storage: s3 }), { userAnswers: { time: SAT_2PM } });
    check("a storage that cannot list: no reply counts (fail-closed)", [field(blind.r, "time").status, /cannot list/.test(vc(blind.r, "replies")?.note ?? "")], ["unknown", true]);

    const PUBLIC = { id: "chk_public", stated_as: "Public places only.", constrains: ["location"], compare: null };
    const sAsk = memStorage();
    await run({ measured: ALL_MEASURED, storage: sAsk }, { userChecklist: [PUBLIC] });
    const notAsked = await run({ measured: ALL_MEASURED, storage: sAsk, noPriorAsk: true }, { userChecklist: [PUBLIC], checklistAnswers: { chk_public: true, chk_other: true } });
    check("a yes for an item never asked about: refused", [vc(notAsked.r, "approve:chk_other:answer")?.status, /was not asked/.test(vc(notAsked.r, "approve:chk_other:answer")?.note ?? "")],
      ["rejected", true]);
    const threw = await run({ measured: ALL_MEASURED, over: { readReplies: () => { throw new Error("model down"); } } }, { userChecklist: [PUBLIC] });
    const threw2 = await run({ measured: ALL_MEASURED, storage: threw.storage, over: { readReplies: () => { throw new Error("model down"); } } }, { userChecklist: [PUBLIC] });
    check("a reply reader that throws: unverified, definition repair", [vc(threw2.r, "replies")?.status, threw2.r.execution_decision], ["unverified", "definition_repair"]);
    const unwired = createPreflight({ hooks: (() => { const h = hooks({ measured: ALL_MEASURED }); delete h.readReplies; return h; })(), storage: memStorage() });
    check("  unwired, the gate says so: readReplies is an unsafe default", unwired.unsafeDefaults.includes("readReplies"), true);

    // Ceilings, counted from the record. The caller passes 0 every time.
    const s4 = memStorage();
    const decisions = [];
    for (let i = 0; i < 3; i++) decisions.push((await run(o({ storage: s4 }), { ask_attempt: 0 })).r.execution_decision);
    check("asks counted from the record: the third round is exhausted, whatever the caller says", decisions, ["ask_user", "ask_user", "exhausted"]);
    const early2 = await run(o({}), { ask_attempt: 5 });
    check("  a caller can bring exhausted forward", early2.r.execution_decision, "exhausted");

    const s5 = memStorage();
    const look = [];
    const SYSTEM_ONLY = [{ id: "c_contact", label: "Required", description: "From the platform.", compare: { kind: "value_source", slot: "buyer_contact" } }];
    for (let i = 0; i < 3; i++) look.push((await run({ storage: s5, conditions: SYSTEM_ONLY, over: { measure: () => undefined } })).r.execution_decision);
    check("system lookups counted the same way", look, ["system_lookup", "system_lookup", "exhausted"]);

    const s6 = memStorage();
    const tools = [];
    for (let i = 0; i < 3; i++) tools.push((await run({ storage: s6, measured: ALL_MEASURED,
      over: { confirmToolNameMatchesIntent: () => ({ approved: false, reason: "not this tool" }) } })).r.execution_decision);
    check("and tool asks", tools, ["ask_user", "ask_user", "exhausted"]);

    const s7 = memStorage();
    const done = await run(o({ storage: s7 }), { userAnswers: { time: SAT_2PM } });
    const exec = await done.preflight.executeIfReady(done.r, tool(), async () => ({ ok: true }));
    check("once the unit has executed", exec.status, "executed");
    const again = await run(o({ storage: s7, noPriorAsk: true }), { userAnswers: { time: SAT_2PM } });
    check("  the next request under its key starts with nothing asked", field(again.r, "time").status, "unknown");
    // The ask before the execution is not counted: 'again' is this request's first ask, so one more is
    //   allowed before the ceiling of two. Counted, the next round would already be exhausted.
    const fresh = [];
    for (let i = 0; i < 2; i++) fresh.push((await run(o({ storage: s7 }))).r.execution_decision);
    check("  and with every count at zero", fresh, ["ask_user", "exhausted"]);

    const s8 = memStorage();
    const later = { ...o({ storage: s8, when: "scheduled" }) };
    const sched = await run(later, { userAnswers: { time: SAT_2PM } });
    check("a reply given at instruction time is kept for the trigger, in the conversation",
      [sched.r.execution_decision, sched.r.deferred_input?.instruction?.at(-1)?.text], ["deferred", REPLY]);
    const trig = await run({ ...o({ storage: s8 }), noPriorAsk: true }, { ...sched.r.deferred_input });
    check("  and counts there: it was asked, in this unit, and the reply is after it", [field(trig.r, "time").source, trig.r.execution_decision], ["user_answer", "execute"]);
  }

  // ══ 11 ═════════════════════════════════════════════════════════════════════════════════
  heading("11. the gate reads the definition itself, and measures with what it settled");
  {
    const { persisted, r } = await run({ measured: ALL_MEASURED });
    check("the record names the tool call and the definition read for it", [persisted?.tool_call?.name, typeof persisted?.tool_definition?.hash, typeof persisted?.tool_definition?.schema_hash],
      ["schedule_pickup", "string", "string"]);
    check("  every measurement, with the settled values it was made with", (persisted?.measurements ?? []).map(m => [m.name, m.result, m.with]),
      [["buyer_contact", "found", ["item_id", "location", "time"]]]);
    check("  the measurements reach the record", persisted?.measurements?.length, r.measurements.length);

    const args = await run({ measured: ALL_MEASURED }, { toolCall: { name: "schedule_pickup", arguments: { time: "made up by the model" } } });
    check("the model's arguments are recorded, never used as values", [args.r.tool_call?.arguments?.time, field(args.r, "time").value],
      ["made up by the model", SAT_2PM]);

    const down = await run({ measured: ALL_MEASURED, over: { readToolDefinition: () => { throw new Error("server down"); } } });
    check("a definition that cannot be read: definition_repair, \"tool definition not read\"", [down.r.execution_decision, down.r.gate?.kind, /tool definition not read/.test(down.r.reason)],
      ["definition_repair", "tool_definition_unread", true]);
    const other = await run({ measured: ALL_MEASURED, over: { readToolDefinition: () => ({ name: "cancel_pickup", description: "", inputSchema: SCHEMA }) } });
    check("  a definition of another tool is not read either", [other.r.execution_decision, /cancel_pickup/.test(other.r.reason)], ["definition_repair", true]);
    const noCall = await createPreflight({ hooks: hooks({}), storage: memStorage() }).runPreflight({ userId: "u", instruction: SAID });
    check("no tool call: definition_repair", [noCall.execution_decision, /toolCall\.name/.test(noCall.reason)], ["definition_repair", true]);
    const oldInput = await createPreflight({ hooks: hooks({}), storage: memStorage() })
      .runPreflight({ userId: "u", instruction: SAID, toolCall: { name: "schedule_pickup" }, mcpTool: tool(), measured_data: {}, userAnswers: {} });
    check("a tool, measurements or answers handed in: refused, not ignored", [oldInput.execution_decision, /mcpTool/.test(oldInput.reason), /measured_data/.test(oldInput.reason), /userAnswers/.test(oldInput.reason)],
      ["definition_repair", true, true, true]);
    let refused = null;
    try { createPreflight({ hooks: { ...hooks({}), measureFromEnvironment: () => undefined }, storage: memStorage() }); } catch (e) { refused = e.message; }
    check("measureFromEnvironment: refused at build, pointing to measure", /replaced by measure/.test(refused ?? ""), true);

    const changedSchema = await run({ measured: ALL_MEASURED, tool: tool("Schedule a pickup.", { ...SCHEMA, properties: { ...SCHEMA.properties, item_id: { type: "string", pattern: "^LST-\\d{4}$" } } }) });
    const plain = await run({ measured: ALL_MEASURED });
    check("a schema the provider changed changes the checklist's version", changedSchema.r.checklist_digest === plain.r.checklist_digest, false);

    // A measurement that depends on another value is made after that value is settled.
    const seen = [];
    // buyer_contact first in the schema, so only the gate's ordering puts it after item_id.
    const CONTACT_FIRST = { ...SCHEMA, properties: { buyer_contact: SCHEMA.properties.buyer_contact, item_id: SCHEMA.properties.item_id,
                                                   time: SCHEMA.properties.time, location: SCHEMA.properties.location } };
    const ordered = await run({ tool: tool("Schedule a pickup.", CONTACT_FIRST), conditions: [{ id: "c_contact", label: "Required", description: "From the platform.", compare: { kind: "value_source", slot: "buyer_contact" } }],
      over: { measure: (name, s) => { seen.push([name, s.values.item_id ?? null]); return name === "buyer_contact" ? { valid: true, value: `contact for ${s.values.item_id}` } : { none: "absent" }; } } });
    check("a slot only the system gives is measured after the values it may depend on", [seen[0], field(ordered.r, "buyer_contact").value],
      [["buyer_contact", "LST-2291"], "contact for LST-2291"]);
    const SALE = { id: "c_sale", label: "Required", description: "The sale must be agreed.", compare: { source: "measured_data", measure: "order_status", schema: { const: "agreed" } } };
    const condSeen = [];
    await run({ measured: ALL_MEASURED, conditions: [SALE],
      over: { measure: (name, s) => { condSeen.push([name, s.values.item_id ?? null]); return name === "order_status" ? { valid: true, value: "agreed" } : (name === "buyer_contact" ? { valid: true, value: "x" } : { none: "absent" }); },
              verifyProviderCondition: (c, ctx) => (ctx.measurements?.order_status?.value === "agreed" ? { status: "checked", source: "measured_data" } : { status: "unverified", source: null }) } });
    check("  a condition's measurement is made by the gate, with every settled value, and handed to the hook",
      condSeen.find(x => x[0] === "order_status"), ["order_status", "LST-2291"]);
    check("rendered values: a date-time carries its weekday, written by code", [renderValue(SAT_2PM, { format: "date-time" }), renderValue("x", {})],
      ["2026-10-31 (Sat) 14:00 +09:00", JSON.stringify("x")]);
  }

  heading("12. why a record does not execute, as facts for the user's side to put into words [STOP FACTS]");
  {
    // The shape of a real run: the sale line unmet from the order status, and the location line, which
    //   the model put into no form, a definition gap beside it.
    const held = {
      execution_decision: "hold",
      provider_checklist: [{ id: "p:1", description: "The sale must be agreed." }, { id: "p:2", description: "The location is the place the seller names." }],
      gate: { kind: "definition_repair",
        unmet: [{ id: "p:1", description: "The sale must be agreed.", note: 'order_status = "cancelled"', declared_by: "provider", label: "Required" }],
        definition_repair: [{ id: "p:2", label: "Verify", description: "The location is the place the seller names." }] },
    };
    check("a hold: what prohibits it, by its words, whose, and what was found; not the route still open beside it",
      stopFacts(held), { decision: "hold", items: [{ why: "not_allowed", condition: "The sale must be agreed.", set_by: "provider", found: 'order_status = "cancelled"' }] });
    check("  a user's condition is named by the words the user stated",
      stopFacts({ execution_decision: "hold", user_checklist: [{ id: "uc:1", stated_as: "Nothing after 8pm" }], gate: { kind: "unmet", unmet: [{ id: "uc:1", declared_by: "user", note: "21:00" }] } }).items,
      [{ why: "not_allowed", condition: "Nothing after 8pm", set_by: "user", found: "21:00" }]);
    check("  a hold with no unmet condition: the call itself, or the kind",
      [stopFacts({ execution_decision: "hold", gate: { kind: "payload_invalid", payload_violation: "bad" } }).items, stopFacts({ execution_decision: "hold", gate: { kind: "schema_unsupported" } }).items],
      [[{ why: "call_not_valid", found: "bad" }], [{ why: "cannot_proceed", found: "schema_unsupported" }]]);
    check("definition_repair: each line, check and field that could not be checked",
      stopFacts({ execution_decision: "definition_repair", gate: { kind: "definition_repair",
        definition_repair: [{ id: "p:2", description: "The location is the place the seller names." }],
        definition_repair_checks: [{ id: "time:format", slot: "time", note: "no validator" }],
        definition_repair_fields: [{ name: "location", note: "no place to check" }], lookup_failed_fields: [{ name: "buyer_contact", note: "threw" }] } }).items,
      [{ why: "cannot_be_checked", condition: "The location is the place the seller names.", set_by: "provider" },
       { why: "cannot_be_checked", field: "time", found: "no validator" },
       { why: "no_source", field: "location", found: "no place to check" }, { why: "no_source", field: "buyer_contact", found: "threw" }]);
    check("system_lookup, exhausted (ids named by their words), deferred",
      [stopFacts({ execution_decision: "system_lookup", gate: { kind: "system_lookup", system_lookup: [{ name: "order_status" }] } }).items,
       stopFacts({ execution_decision: "exhausted", provider_checklist: [{ id: "p:3", description: "Ask before booking." }],
         gate: { kind: "exhausted", exhausted: [{ route: "ask_user", attempt: 2, limit: 2, names: ["time", "p:3"] }] } }).items,
       stopFacts({ execution_decision: "deferred", fixed: { c1_when_case: "scheduled" }, gate: {} }).items],
      [[{ why: "waiting_on_system", names: ["order_status"] }], [{ why: "asked_enough", found: "ask_user", names: ["time", "Ask before booking."] }], [{ why: "later", found: "scheduled" }]]);
    check("a record that executes, asks or already ran: nothing to report as a stop",
      ["execute", "ask_user", "executed", "failed"].map(d => stopFacts({ execution_decision: d, gate: {} }).items), [[], [], [], []]);
    check("no record: no decision, no items", stopFacts(null), { decision: null, items: [] });
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall ok");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("THREW:", e.stack); process.exit(1); });
