"use strict";

/**
 * Offline checks for the provider-checklist example. No API calls.
 *
 *   node test.js
 *
 * Every behaviour this folder adds over v1 has a check here: the labelled lines, the confirmation
 * list, the schema keywords, the user items' comparison forms, and the comparison with v1 itself.
 */

const fs = require("fs");
const path = require("path");
const { runArm } = require("./arm");
const { makeAsk } = require("./stub");
const { labelledLines } = require("./hooks");
const { rows } = require("./compare");
const S = require("./instructions.json");
const TOOL = require("./tool.json");
const CONFIRMED = require("./confirmed.json");

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(66)} got=${JSON.stringify(got)}${ok ? "" : `  want=${JSON.stringify(want)}`}`);
}
const ins = id => S.instructions.find(i => i.id === id);
const field = (r, n) => r.fields.find(f => f.name === n);
const cond = (r, id) => r.provider_checklist.find(c => c.id === id);
const item = (r, id) => r.user_checklist.find(c => c.id === id);
const clone = o => JSON.parse(JSON.stringify(o));

async function run(id, condition, over = {}) {
  const i = ins(id);
  return runArm({ ctx: { ...S.conditions[condition].context, ...(over.ctx ?? {}) }, instructionText: i.text,
    userChecklist: over.userChecklist ?? i.user_checklist ?? [], userAnswers: over.userAnswers ?? {},
    checklistAnswers: over.checklistAnswers ?? {},
    date: S.date_modes[over.date ?? "said"], ask: makeAsk(id, over.extractor ?? "faithful"), runId: `t-${id}-${condition}`,
    ...(over.tool ? { tool: over.tool } : {}), ...(over.confirmed ? { confirmed: over.confirmed } : {}) });
}

(async () => {
  console.log("--- 1. the provider's declaration is the description's labelled lines ---");
  check("three lines in tool.json, two of them labelled", labelledLines(TOOL.description).map(l => l.label), ["Required", "Notice"]);
  check("prose is not a condition", labelledLines("Does a thing.\nNo label here.").length, 0);
  check("any bracketed word is read as a label, typos included", labelledLines("[Requried] X.").map(l => l.label), ["Requried"]);

  console.log("\n--- 2. a line is compared only in the form the provider confirmed ---");
  const g1 = await run("g1-01", "clean");
  check("g1-01 clean: executes", g1.outcome, "call");
  check("  [Required] sale agreed: checked from the order status", [cond(g1, "cond_sale_agreed").status, cond(g1, "cond_sale_agreed").source], ["checked", "measured_data"]);
  check("  [Notice] surfaced as a disclosure", g1.disclosures.length > 0 && cond(g1, "cond_buyer_sees").status, "disclosure_required");

  const reworded = clone(TOOL);
  reworded.description = reworded.description.replace("as shown by the order status", "as the order status shows");
  const rw = await run("g1-01", "clean", { tool: reworded });
  check("reworded line: not in the confirmation list, so unverified", rw.provider_checklist[0].status, "unverified");
  check("  [Required] goes back to the provider", rw.provider_checklist[0].route, "definition_repair");
  check("  and the run does not execute", rw.outcome, "definition_repair");

  const typo = clone(TOOL);
  typo.description = typo.description.replace("[Required]", "[Requried]");
  const ty = await run("g1-01", "clean", { tool: typo });
  check("a typo in the label: held, not dropped", [ty.provider_checklist[0].route, ty.outcome], ["definition_repair", "definition_repair"]);

  const pending = await run("g1-01", "clean", { ctx: { order_status: "pending" } });
  check("order not agreed: unmet, held", [cond(pending, "cond_sale_agreed").status, pending.outcome], ["unmet", "hold"]);
  const noOrder = await run("g1-01", "clean", { ctx: { order_status: undefined } });
  check("no measurement of the order: unverified, not executed", [cond(noOrder, "cond_sale_agreed").status, noOrder.outcome !== "call"], ["unverified", true]);

  const emptyList = { tools: {} };
  const nl = await run("g1-01", "clean", { confirmed: emptyList });
  check("an empty confirmation list confirms nothing", [nl.provider_checklist[0].status, nl.outcome], ["unverified", "definition_repair"]);

  console.log("\n--- 3. sources and formats come from the input schema ---");
  check("location: user sources only", field(g1, "location").allowed_sources, ["user_answer", "instruction", "pre_set_data"]);
  check("buyer_contact: measured only", field(g1, "buyer_contact").allowed_sources, ["measured_data"]);
  const offer = await run("g5-01", "offer_in_range");
  check("g5 offer_in_range: the measured location is not taken", field(offer, "location").status, "unknown");
  check("  the measured time is, inside the seller's window", [field(offer, "time").source, field(offer, "time").range_declared], ["measured_data", true]);
  const noWindow = await run("g5-01", "offer_in_range", { userChecklist: [] });
  check("same offer, no window declared: the time is not taken (3.3)", [field(noWindow, "time").status, field(noWindow, "time").range_declared], ["unknown", false]);
  check("  the skeleton's default read x-settled-at-execution", field(noWindow, "time").settled_at_execution, true);
  const g4 = await run("g4-01", "clean", { userAnswers: { time: "Saturday 2pm", location: "Hongdae station lockers" } });
  check("g4 answered 'Saturday 2pm': fails the schema's date-time format", field(g4, "time").status, "unknown");
  check("  the note names the format", /ISO 8601/.test(JSON.stringify(field(g4, "time"))), true);
  check("  the answered location is taken (a user source)", [field(g4, "location").status, field(g4, "location").source], ["known", "user_answer"]);

  console.log("\n--- 4. the user's items are compared in their confirmed form ---");
  const late = await run("g2-01", "clean", { userAnswers: { time: "2026-10-31T21:00:00+09:00", location: "Hongdae station lockers" } });
  check("g2-01 answered 21:00: not_after 20:00 is unmet", item(late, "chk_evening").status, "unmet");
  const eight = await run("g2-01", "clean", { userAnswers: { time: "2026-10-31T20:00:00+09:00", location: "Hongdae station lockers" } });
  check("g2-01 answered 20:00: inside", item(eight, "chk_evening").status, "verified");
  check("  a location limit with no comparison form is unverified, not passed", item(eight, "chk_public").status, "unverified");
  check("  so the seller is asked about it", eight.outcome, "ask");
  const said = { time: "2026-10-31T21:00:00+09:00", location: "Hongdae station lockers" };
  const overrule = await run("g2-01", "clean", { userAnswers: said, checklistAnswers: { chk_evening: true, chk_public: true } });
  check("a seller's yes does not overrule a comparison form", item(overrule, "chk_evening").status, "unmet");
  check("  it does settle an item that has none", [item(overrule, "chk_public").status, item(overrule, "chk_public").source], ["verified", "user_answer"]);
  const out = await run("g5-01", "offer_out_of_range");
  check("g5 offer outside the window: unmet, held", [item(out, "chk_window").status, out.outcome], ["unmet", "hold"]);

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
  check("outcome changes: only the platform's proposed location in g5", changed, [
    "faithful:g5-01/offer_in_range:call->ask", "faithful:g5-02/offer_in_range:call->ask",
    "over_eager:g5-01/offer_in_range:call->ask", "over_eager:g5-02/offer_in_range:call->ask"]);
  check("v2 never executes where v1 did not", all.filter(r => r.v2.outcome === "call" && r.v1.outcome !== "call").length, 0);
  check("every v2 run checked the provider's [Required] line", all.every(r => r.v2.checks.includes("cond_sale_agreed:checked")), true);

  console.log("\n--- 7. the hooks hold no rule of their own ---");
  const src = fs.readFileSync(path.join(__dirname, "hooks.js"), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
  const named = Object.keys(TOOL.inputSchema.properties).filter(n => new RegExp(`["'\`]${n}["'\`]`).test(src));
  check("no slot name appears in hooks.js code", named, []);
  const ids = [...CONFIRMED.tools.schedule_pickup.map(e => e.id), ...S.instructions.flatMap(i => (i.user_checklist ?? []).map(x => x.id))];
  check("no condition or item id appears in hooks.js code", [...new Set(ids)].filter(id => src.includes(id)), []);

  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("THREW:", e.stack); process.exit(1); });
