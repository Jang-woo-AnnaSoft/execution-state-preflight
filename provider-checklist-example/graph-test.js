"use strict";

/**
 * The LangGraph flow around the unchanged skeleton. No API calls; the model is stub.js.
 *
 *   npm install && node graph-test.js
 */

const { Command } = require("@langchain/langgraph");
const { buildGraph, CHECK_PREFIX } = require("./graph");
const { runArm, measuredFor } = require("./arm");
const { buildUserTurn } = require("./prompts");
const { makeAsk } = require("./stub");
const S = require("./instructions.json");

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(66)} got=${JSON.stringify(got)}${ok ? "" : `  want=${JSON.stringify(want)}`}`);
}

let thread = 0;
// One run: start the graph, then answer each pause with the next reply in `replies`.
async function drive(id, condition, replies = [], { proposals = {}, userChecklist, userAnswers } = {}) {
  const ins = S.instructions.find(i => i.id === id);
  const ctx = S.conditions[condition].context, date = S.date_modes.said;
  const calls = [];
  const g = buildGraph({ ask: makeAsk(id), callTool: async (name, args) => { calls.push({ name, args }); } });
  const cfg = { configurable: { thread_id: `t${++thread}` } };
  const requests = [], schemas = [];
  let state = await g.invoke({ segments: buildUserTurn(ctx, ins.text, date).segments, measuredData: measuredFor(ctx, date),
    userChecklist: userChecklist ?? ins.user_checklist ?? [], proposals, ...(userAnswers ? { userAnswers } : {}) }, cfg);
  for (;;) {
    const pending = (await g.getState(cfg)).tasks.flatMap(t => t.interrupts ?? []);
    if (pending.length === 0) break;
    requests.push(pending[0].value);
    schemas.push(pending[0].response_schema ?? null);
    const reply = replies.shift();
    if (!reply) break;                       // nobody answers: the run stays paused
    state = await g.invoke(new Command({ resume: reply }), cfg);
  }
  return { state, calls, requests, schemas };
}
const accept = content => ({ action: "accept", content });
const SAT_2PM = "2026-10-31T14:00:00+09:00";
const LOCKERS = "Hongdae station lockers";

(async () => {
  console.log("--- 1. the graph asks for exactly what the gate listed ---");
  const g4 = await drive("g4-01", "clean");
  const req = g4.requests[0];
  check("g4-01: pauses at ask", g4.requests.length, 1);
  check("  the request is an elicitation form", req.mode, "form");
  check("  it asks for the gate's blanks, no more", Object.keys(req.requestedSchema.properties), ["time", "location"]);
  check("  field schemas are the tool's, without x- keywords", req.requestedSchema.properties.time, {
    type: "string", format: "date-time",
    description: "One moment, not a range, with a time zone offset. The seller states it, or sets a range that a pickup request from the buyer must fall inside" });
  check("  nothing executed while paused", g4.calls.length, 0);
  const rs = g4.schemas[0];
  check("  the reply's shape is at Interrupt.response_schema", rs?.properties?.action?.enum, ["accept", "decline", "cancel"]);
  check("  its content is the request's schema, formats included", rs?.properties?.content?.properties?.time?.format, "date-time");
  check("  content is exactly the request's requestedSchema", JSON.stringify(rs?.properties?.content) === JSON.stringify(req.requestedSchema), true);

  console.log("\n--- 2. accept: the gate judges again, and only its arguments are used ---");
  const ok = await drive("g4-01", "clean", [accept({ time: SAT_2PM, location: LOCKERS, buyer_contact: "call me at 010-0000" })]);
  check("accepted: executed once", [ok.state.ended, ok.calls.length], ["executed", 1]);
  check("  time and location from the seller's reply", [ok.calls[0].args.time, ok.calls[0].args.location], [SAT_2PM, LOCKERS]);
  check("  a key the request did not ask for is dropped", ok.calls[0].args.buyer_contact, "in-app chat (@kim_2291)");
  check("  the gate looked the answers up as user_answer", ok.state.verdict.fields.filter(f => ["time", "location"].includes(f.name)).map(f => f.source), ["user_answer", "user_answer"]);

  // State can carry values the gate did not accept (here, answers loaded by the adopter). The tool still
  //   gets the gate's arguments and nothing else.
  const loaded = await drive("g1-01", "clean", [], { userAnswers: { time: SAT_2PM, buyer_contact: "call me at 010-0000" } });
  check("a value in state the gate refused never reaches the tool", [loaded.state.ended, loaded.calls[0]?.args.buyer_contact], ["executed", "in-app chat (@kim_2291)"]);
  check("  the tool gets exactly the gate's call_arguments", JSON.stringify(loaded.calls[0]?.args) === JSON.stringify(loaded.state.executedWith), true);

  console.log("\n--- 3. decline or cancel: nothing runs ---");
  const dec = await drive("g4-01", "clean", [{ action: "decline" }]);
  check("declined: ended, tool not called", [dec.state.ended, dec.calls.length], ["declined", 0]);
  const can = await drive("g4-01", "clean", [{ action: "cancel" }]);
  check("cancelled: ended, tool not called", [can.state.ended, can.calls.length], ["cancelled", 0]);

  console.log("\n--- 4. a reply that fails the schema's format is asked again, up to the ceiling ---");
  // The second reply also slips in a location. Only time was asked for, so it must not reach the gate:
  //   user_answer is looked up before anything else, so a kept key would replace the settled location.
  const bad = await drive("g4-01", "clean", [accept({ time: "Saturday 2pm", location: LOCKERS }), accept({ time: SAT_2PM, location: "61 Yeonhui-ro" })]);
  check("'Saturday 2pm' is not a date-time: asked again", bad.requests.length, 2);
  check("  the second ask is only for time", Object.keys(bad.requests[1].requestedSchema.properties), ["time"]);
  check("  the location already given is kept", bad.calls[0]?.args.location, LOCKERS);
  check("  a location slipped into a time-only reply is dropped before the gate", bad.state.userAnswers.location, LOCKERS);
  check("  then executed", bad.state.ended, "executed");
  const odd = await drive("g4-01", "clean", [accept({ time: 1400, location: LOCKERS }), accept({ time: SAT_2PM })]);
  check("response_schema is not enforced: a reply off its type does not throw, the gate asks again", [odd.requests.length, odd.state.ended], [2, "executed"]);
  const twice = await drive("g4-01", "clean", [accept({ time: "Saturday 2pm", location: LOCKERS }), accept({ time: "2pm" })]);
  check("two unusable replies: exhausted, not executed", [twice.state.verdict.decision, twice.calls.length], ["exhausted", 0]);

  console.log("\n--- 5. a model's proposal is a default, not a value ---");
  const prop = { time: SAT_2PM, location: LOCKERS };
  const shown = await drive("g4-01", "clean", [], { proposals: prop });
  check("the proposal is shown as the fields' defaults", [shown.requests[0].requestedSchema.properties.time.default, shown.requests[0].requestedSchema.properties.location.default], [SAT_2PM, LOCKERS]);
  check("  and settles nothing on its own: paused, not executed", shown.calls.length, 0);
  const same = await drive("g4-01", "clean", [accept(prop)], { proposals: prop });
  check("accepted as shown: executed with the shown values", same.calls[0]?.args.time, SAT_2PM);
  const edited = await drive("g4-01", "clean", [accept({ time: "2026-10-31T15:00:00+09:00", location: LOCKERS })], { proposals: prop });
  check("edited by the seller: executed with what the seller sent", edited.calls[0]?.args.time, "2026-10-31T15:00:00+09:00");
  const dropped = await drive("g4-01", "clean", [{ action: "cancel" }], { proposals: prop });
  check("proposal shown, then cancelled: not executed", dropped.calls.length, 0);

  // The seller said "2pm this Saturday". Nothing in code turns that into a date. A model reads it as
  //   Saturday 31 October 14:00 and proposes that; the seller sees it and sends it.
  const g1 = await drive("g1-01", "clean", [accept({ time: SAT_2PM })], { proposals: { time: SAT_2PM } });
  check("g1-01: the seller's time words are asked about, with the model's reading as the default",
    [Object.keys(g1.requests[0].requestedSchema.properties), g1.requests[0].requestedSchema.properties.time.default], [["time"], SAT_2PM]);
  check("  the location the seller named is not asked again", g1.calls[0]?.args.location, LOCKERS);
  check("  sent as shown: executed with that moment", [g1.state.ended, g1.calls[0]?.args.time], ["executed", SAT_2PM]);

  console.log("\n--- 6. an item only the seller can confirm ---");
  const pub = await drive("g2-01", "clean", [accept({ time: "2026-10-31T19:00:00+09:00", location: LOCKERS }), accept({ [CHECK_PREFIX + "chk_public"]: true })]);
  check("g2-01: first the blanks, then the item it could not compare", pub.requests.map(r => Object.keys(r.requestedSchema.properties)), [["time", "location"], [CHECK_PREFIX + "chk_public"]]);
  check("  confirmed: executed", pub.state.ended, "executed");
  check("  chk_evening compared in code, chk_public confirmed by the seller", pub.state.verdict.user_checklist.map(i => `${i.id}:${i.status}:${i.source}`), ["chk_evening:verified:user_answer", "chk_public:verified:user_answer"]);
  const notPub = await drive("g2-01", "clean", [accept({ time: "2026-10-31T19:00:00+09:00", location: LOCKERS }), accept({ [CHECK_PREFIX + "chk_public"]: false })]);
  check("the seller says it does not hold: held, not executed", [notPub.state.verdict.decision, notPub.calls.length], ["hold", 0]);
  const late = await drive("g2-01", "clean", [accept({ time: "2026-10-31T21:00:00+09:00", location: LOCKERS })]);
  check("an answer past 8pm: held by the seller's own limit", [late.state.verdict.decision, late.calls.length], ["hold", 0]);

  console.log("\n--- 7. the graph's first verdict is the arm's verdict ---");
  const mismatched = [];
  for (const ins of S.instructions) {
    for (const condition of S.instruction_conditions[String(ins.group)] ?? []) {
      const ctx = S.conditions[condition].context, date = S.date_modes.said;
      const arm = await runArm({ ctx, instructionText: ins.text, userChecklist: ins.user_checklist ?? [], date, ask: makeAsk(ins.id), runId: `a-${ins.id}` });
      const run = await drive(ins.id, condition);
      if (arm.decision !== run.state.verdict.decision) mismatched.push(`${ins.id}/${condition}: ${arm.decision} vs ${run.state.verdict.decision}`);
    }
  }
  check("35 runs: the same decision with and without the graph", mismatched, []);

  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("THREW:", e.stack); process.exit(1); });
