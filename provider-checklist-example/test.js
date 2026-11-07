"use strict";

/**
 * Offline checks for the provider-checklist example. No API calls.
 *
 *   node test.js
 *
 * Every behaviour this folder adds over v1 has a check here: the provider's lines written in words and
 * compared only in the form the provider confirmed, the input schema's formats, the seller's items in
 * their confirmed forms, and the comparison with v1 itself.
 */

const fs = require("fs");
const path = require("path");
const { runArm } = require("./arm");
const { makeAsk, PROVIDER_FORMS } = require("./stub");
const { labelledLines, checkAgainst } = require("./hooks");
const { rows, providerName } = require("./compare");
const S = require("./instructions.json");
const TOOL = require("./tool.json");

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(66)} got=${JSON.stringify(got)}${ok ? "" : `  want=${JSON.stringify(want)}`}`);
}
const ins = id => S.instructions.find(i => i.id === id);
const field = (r, n) => r.fields.find(f => f.name === n);
// A provider line's id is its hash; find it by its opening words.
const line = (r, start) => r.provider_checklist.find(c => (c.description ?? "").startsWith(start));
const SALE = "The sale must be agreed", OWNER = "The listing must be the seller's own", NOTICE = "The buyer sees";
const item = (r, id) => r.user_checklist.find(c => c.id === id);
const vcheck = (r, id) => (r.value_checks ?? []).find(c => c.id === id);
const clone = o => JSON.parse(JSON.stringify(o));

async function run(id, condition, over = {}) {
  const i = ins(id);
  return runArm({ ctx: { ...S.conditions[condition].context, ...(over.ctx ?? {}) }, instructionText: i.text,
    userChecklist: over.userChecklist ?? i.user_checklist ?? [], userAnswers: over.userAnswers ?? {},
    checklistAnswers: over.checklistAnswers ?? {},
    date: S.date_modes[over.date ?? "said"], ask: makeAsk(id, over.extractor ?? "faithful"), runId: `t-${id}-${condition}`,
    ...(over.tool ? { tool: over.tool } : {}), ...(over.forms ? { forms: over.forms } : {}),
    ...(over.confirmedTool ? { confirmedTool: over.confirmedTool } : {}),
    ...(over.confirmForms === false ? { confirmForms: false } : {}) });
}

(async () => {
  console.log("--- 1. the provider's declaration is the description's labelled lines, in words ---");
  check("seven labelled lines in tool.json", labelledLines(TOOL.description).map(l => l.label),
    ["Required", "Required", "Verify", "Verify", "Verify", "Required", "Notice"]);
  check("the input schema holds forms only: no description, no x- keyword",
    Object.values(TOOL.inputSchema.properties).flatMap(p => Object.keys(p).filter(k => k === "description" || k.startsWith("x-"))), []);
  check("prose is not a condition", labelledLines("Does a thing.\nNo label here.").length, 0);
  check("any bracketed word is read as a label, typos included", labelledLines("[Requried] X.").map(l => l.label), ["Requried"]);
  check("the stand-in model has a form for every line but the notice", labelledLines(TOOL.description)
    .filter(l => l.label !== "Notice").every(l => PROVIDER_FORMS.some(([s]) => l.text.startsWith(s))), true);

  console.log("\n--- 2. a line is compared only in the form the provider confirmed ---");
  // The seller's "2pm this Saturday" is not a date-time, and nothing here converts it. With the seller's
  //   confirmed time as an answer (what graph.js collects), g1-01 runs.
  const SAT_2PM = { time: "2026-10-31T14:00:00+09:00" };
  const g1 = await run("g1-01", "clean", { userAnswers: SAT_2PM });
  check("g1-01 with the seller's confirmed time: executes", g1.outcome, "call");
  check("  [Required] sale agreed: checked from the order status", [line(g1, SALE).status, line(g1, SALE).source], ["checked", "measured_data"]);
  check("  [Required] the seller's own listing: checked from the platform", [line(g1, OWNER).status, line(g1, OWNER).source], ["checked", "measured_data"]);
  check("  each line says who confirmed its form", line(g1, SALE).form_approval?.approved_by, "provider (test)");
  check("  [Notice] surfaced as a disclosure", g1.disclosures.length > 0 && line(g1, NOTICE).status, "disclosure_required");

  const reworded = clone(TOOL);
  reworded.description = reworded.description.replace("as shown by the order status", "as the order status shows");
  const rw = await run("g1-01", "clean", { tool: reworded, confirmedTool: TOOL, userAnswers: SAT_2PM });
  check("reworded line: its confirmation does not apply, so it is pending", [line(rw, SALE).status, line(rw, SALE).form_pending], ["unverified", true]);
  check("  [Required] goes back to the provider", line(rw, SALE).route, "definition_repair");
  check("  and the run does not execute", rw.outcome, "definition_repair");

  const typo = clone(TOOL);
  typo.description = typo.description.replace("[Required] The sale", "[Requried] The sale");
  const ty = await run("g1-01", "clean", { tool: typo, userAnswers: SAT_2PM });
  check("a typo in the label: held, not dropped", [line(ty, SALE).route, ty.outcome], ["definition_repair", "definition_repair"]);

  const pending = await run("g1-01", "clean", { ctx: { order_status: "pending" }, userAnswers: SAT_2PM });
  check("order not agreed: unmet, held", [line(pending, SALE).status, pending.outcome], ["unmet", "hold"]);
  const noOrder = await run("g1-01", "clean", { ctx: { order_status: undefined }, userAnswers: SAT_2PM });
  check("no measurement of the order: unverified, not executed", [line(noOrder, SALE).status, noOrder.outcome !== "call"], ["unverified", true]);
  const notMine = await run("g1-01", "clean", { ctx: { listing_owned_by_seller: false }, userAnswers: SAT_2PM });
  check("someone else's listing: unmet, held", [line(notMine, OWNER).status, notMine.outcome], ["unmet", "hold"]);

  const none = await run("g1-01", "clean", { confirmForms: false, userAnswers: SAT_2PM });
  check("no line confirmed: nothing is compared, the run stops", [none.provider_checklist.filter(c => c.form_pending).length, none.outcome], [6, "definition_repair"]);

  console.log("\n--- 3. who gives each value comes from the provider's lines; its form from the schema ---");
  check("item_id: the seller's only", field(g1, "item_id").allowed_sources, ["user_answer", "instruction", "pre_set_data"]);
  check("location: the seller's only", field(g1, "location").allowed_sources, ["user_answer", "instruction", "pre_set_data"]);
  check("buyer_contact: measured only", field(g1, "buyer_contact").allowed_sources, ["measured_data"]);
  check("  each says which line narrowed it", field(g1, "buyer_contact").source_rule_ids?.length, 1);
  const raw = await run("g1-01", "clean");
  check("g1-01 as said: '2pm this Saturday' fails the date-time format", [field(raw, "time").status, vcheck(raw, "time:format")?.status, raw.outcome], ["unknown", "rejected", "ask"]);
  check("  the location the seller named is taken from the instruction", [field(raw, "location").status, field(raw, "location").source], ["known", "instruction"]);
  check("every value's format is a check of its own", ["item_id", "location", "buyer_contact"].map(n => vcheck(raw, `${n}:format`)?.status), ["checked", "checked", "checked"]);
  check("the listing number has the provider's form", [checkAgainst(TOOL.inputSchema.properties.item_id, "LST-2291").ok, checkAgainst(TOOL.inputSchema.properties.item_id, "LST-229").ok], [true, false]);
  const offer = await run("g5-01", "offer_in_range");
  check("g5 offer_in_range: the measured location is not taken", field(offer, "location").status, "unknown");
  check("  the measured time is, inside the seller's window", [field(offer, "time").source, field(offer, "time").range_declared], ["measured_data", true]);
  const noWindow = await run("g5-01", "offer_in_range", { userChecklist: [] });
  check("same offer, no window declared: the time is not taken (3.3)", [field(noWindow, "time").status, field(noWindow, "time").range_declared], ["unknown", false]);
  check("  settled at execution, from the [Verify] line's confirmed form", field(noWindow, "time").settled_at_execution, true);
  const g4 = await run("g4-01", "clean", { userAnswers: { time: "Saturday 2pm", location: "Hongdae station lockers" } });
  check("g4 answered 'Saturday 2pm': fails the schema's date-time format", field(g4, "time").status, "unknown");
  check("  the note names the format", /date-time/.test(JSON.stringify(field(g4, "time"))), true);
  check("  the answered location is taken (a user source)", [field(g4, "location").status, field(g4, "location").source], ["known", "user_answer"]);

  console.log("\n--- 4. the user's items are compared in their confirmed form ---");
  const late = await run("g2-01", "clean", { userAnswers: { time: "2026-10-31T21:00:00+09:00", location: "Hongdae station lockers" } });
  check("g2-01 answered 21:00: unmet against the confirmed schema", item(late, "chk_evening").status, "unmet");
  const eight = await run("g2-01", "clean", { userAnswers: { time: "2026-10-31T20:00:00+09:00", location: "Hongdae station lockers" } });
  check("g2-01 answered 20:00: inside", item(eight, "chk_evening").status, "verified");
  check("  a location limit with no comparison form is unverified, not passed", item(eight, "chk_public").status, "unverified");
  check("  so the seller is asked about it", eight.outcome, "ask");
  const said = { time: "2026-10-31T21:00:00+09:00", location: "Hongdae station lockers" };
  // An approval is bound to the item's version and the values shown (6.3), as the gate asks for it.
  const yes = id => ({ answer: true, shown: { location: "Hongdae station lockers" }, rule_hash: item(eight, id).rule_hash });
  const overrule = await run("g2-01", "clean", { userAnswers: said,
    checklistAnswers: { chk_evening: { answer: true, shown: { time: said.time }, rule_hash: item(eight, "chk_evening").rule_hash }, chk_public: yes("chk_public") } });
  check("a seller's yes does not overrule a comparison form", item(overrule, "chk_evening").status, "unmet");
  check("  it does settle an item that has none", [item(overrule, "chk_public").status, item(overrule, "chk_public").source], ["verified", "user_answer"]);
  const bare = await run("g2-01", "clean", { userAnswers: said, checklistAnswers: { chk_public: true } });
  check("  a bare yes, naming no place, settles nothing", [item(bare, "chk_public").status, typeof item(bare, "chk_public").approval_voided], ["unverified", "string"]);
  const moved = await run("g2-01", "clean", { userAnswers: { ...said, location: "Gangnam station exit 3" }, checklistAnswers: { chk_public: yes("chk_public") } });
  check("  a yes given for another place settles nothing", item(moved, "chk_public").status, "unverified");
  const out = await run("g5-01", "offer_out_of_range");
  check("g5 offer outside the window: unmet, held", [item(out, "chk_window").status, out.outcome], ["unmet", "hold"]);
  const utc = await run("g5-01", "offer_in_range", { ctx: { pickup_request: { ...S.conditions.offer_in_range.context.pickup_request, time: "2026-10-31T05:00:00Z" } } });
  check("a measured time in another offset is compared as a moment (14:00 KST)", item(utc, "chk_window").status, "verified");

  console.log("\n--- 4-b. a check that cannot be run is not a check that passed ---");
  const ts = await run("g1-01", "clean", { userAnswers: SAT_2PM,
    forms: { [SALE]: { compare: { source: "measured_data", measure: "order_status", schema: { constt: "agreed" } }, constrains: [] } } });
  check("a confirmed schema with an unknown keyword: unverified", line(ts, SALE).status, "unverified");
  check("  [Required] goes back to the provider, not executed", [line(ts, SALE).route, ts.outcome], ["definition_repair", "definition_repair"]);
  const badItem = clone(S.instructions.find(i => i.id === "g2-01").user_checklist);
  badItem[0].compare = { type: "string", notBefore: "20:00" };
  const bi = await run("g2-01", "clean", { userChecklist: badItem, userAnswers: { time: "2026-10-31T19:00:00+09:00", location: "Hongdae station lockers" } });
  check("a user item whose schema cannot be run: unverified, not verified", item(bi, "chk_evening").status, "unverified");

  console.log("\n--- 5. a limit is still not a value ---");
  const eager = await run("g5-01", "offer_in_range", { extractor: "over_eager" });
  check("over-eager extractor quotes 'a subway station' as the location", field(eager, "location").status, "unknown");
  check("  refused: the words sit inside chk_station's own wording", eager.outcome, "ask");
  const eager2 = await run("g2-01", "clean", { extractor: "over_eager" });
  check("over-eager '8pm' and 'public places': neither settles a slot", [field(eager2, "time").status, field(eager2, "location").status], ["unknown", "unknown"]);

  console.log("\n--- 6. compared with v1 ---");
  const all = await rows();
  const changed = all.filter(r => r.v1.outcome !== r.v2.outcome).map(r => `${r.extractor}:${r.id}/${r.condition}:${r.v1.outcome}->${r.v2.outcome}`);
  check("runs compared (35 per extractor)", all.length, 70);
  // g1: the seller's time words are not converted in code, so the time is confirmed with the seller.
  // g5: the location the buyer proposed is the seller's to name.
  check("outcome changes: g1's time words and g5's proposed location", changed, [
    "faithful:g1-01/clean:call->ask", "faithful:g1-02/clean:call->ask", "faithful:g1-03/clean:call->ask",
    "faithful:g5-01/offer_in_range:call->ask", "faithful:g5-02/offer_in_range:call->ask",
    "over_eager:g1-01/clean:call->ask", "over_eager:g1-02/clean:call->ask", "over_eager:g1-03/clean:call->ask",
    "over_eager:g5-01/offer_in_range:call->ask", "over_eager:g5-02/offer_in_range:call->ask"]);
  check("v2 never executes where v1 did not", all.filter(r => r.v2.outcome === "call" && r.v1.outcome !== "call").length, 0);
  const saleName = providerName({ label: "Required", description: labelledLines(TOOL.description)[0].text });
  check("every v2 run checked the provider's sale line", all.every(r => r.v2.checks.includes(`${saleName}:checked`)), true);

  console.log("\n--- 7. the gate holds no rule of its own ---");
  // The code lives in adopt-example/gate.js, the file an adopter copies unchanged.
  const src = fs.readFileSync(path.join(__dirname, "..", "adopt-example", "gate.js"), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
  const named = Object.keys(TOOL.inputSchema.properties).filter(n => new RegExp(`["'\`]${n}["'\`]`).test(src));
  check("no slot name appears in gate.js code", named, []);
  const ids = S.instructions.flatMap(i => (i.user_checklist ?? []).map(x => x.id));
  check("no item id appears in gate.js code", [...new Set(ids)].filter(id => src.includes(id)), []);
  check("no measurement name appears in gate.js code", ["order_status", "listing_owned_by_seller"].filter(n => src.includes(n)), []);
  const required = [...src.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]);
  check("gate.js loads LangGraph, the skeleton and a validator, nothing else", required,
    ["@langchain/langgraph", "./execution-state-preflight", "../execution-state-preflight", "ajv", "ajv-formats"]);
  // pattern and format appear only as keys passed through from the schema to the question form.
  check("no comparison of its own: no comparison keyword appears in gate.js code",
    ["formatMinimum", "formatMaximum", "const:", "maximum", "not_after", "not_before"].filter(k => src.includes(k)), []);

  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("THREW:", e.stack); process.exit(1); });
