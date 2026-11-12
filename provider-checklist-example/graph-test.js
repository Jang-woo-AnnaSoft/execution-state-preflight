"use strict";

/**
 * The LangGraph flow around the unchanged skeleton (adopt-example/gate.js). No API calls; the models are
 * stub.js.
 *
 *   npm install && node graph-test.js
 *
 * The flow as it runs in use: the agent's model reads the conversation and calls the tool; the gate reads
 * the tool's definition and judges; when something is missing, the model asks in conversation and code
 * adds the values as they will be used; the user answers in words; the model calls again; the gate judges
 * again; the executing step reads the record and the tool runs with the record's arguments only.
 */

const { buildGraph, createStorage, Command } = require("./graph");
const { runArm, measuredFor, measurePort, MEASUREMENTS, TOOL } = require("./arm");
const { buildUserTurn } = require("./prompts");
const { makeAsk, makeChat } = require("./stub");
const S = require("./instructions.json");

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(66)} got=${JSON.stringify(got)}${ok ? "" : `  want=${JSON.stringify(want)}`}`);
}

const CANCEL = Symbol("cancel");
const CANCEL_TOOL = { name: "cancel_pickup", description: "Cancel a pickup.",
  inputSchema: { type: "object", properties: { item_id: { type: "string" } }, required: ["item_id"] } };

let thread = 0;
// One conversation: the seller's instruction, then each reply in `replies`, typed, for as long as the
//   assistant asks. chats: what the agent's model does on each turn (default: call the pickup tool).
async function drive(id, condition, replies = [], { userChecklist, chats = [], ask, storage = createStorage() } = {}) {
  const ins = S.instructions.find(i => i.id === id);
  const ctx = S.conditions[condition].context, date = S.date_modes.said;
  const calls = [], turns = [];
  const chatFor = makeChat();
  let turn = 0;
  const g = buildGraph({
    ask: ask ?? makeAsk(id), model: "stub",
    chat: async (req) => { turns.push(req); const c = chats[turn++]; return c ? makeChat(c)(req) : chatFor(req); },
    listTools: async () => [TOOL, CANCEL_TOOL],
    readToolDefinition: async name => [TOOL, CANCEL_TOOL].find(t => t.name === name),
    measure: measurePort(measuredFor(ctx, date)), measurements: MEASUREMENTS,
    callTool: async (name, args) => { calls.push({ name, args }); return { content: [{ type: "text", text: "done" }] }; },
    storage,
  });
  const cfg = { configurable: { thread_id: `t${++thread}` } };
  const questions = [];
  let state = await g.invoke({ conversation: buildUserTurn(ctx, ins.text, date).segments, userChecklist: userChecklist ?? ins.user_checklist ?? [] }, cfg);
  for (;;) {
    const pending = (await g.getState(cfg)).tasks.flatMap(t => t.interrupts ?? []);
    if (pending.length === 0) break;
    questions.push(pending[0].value);
    if (!replies.length) break;                       // nobody answers: the conversation stays paused
    const reply = replies.shift();
    state = await g.invoke(new Command({ resume: reply === CANCEL ? { cancel: true } : { segments: [{ trust: "user", text: reply }] } }), cfg);
  }
  return { state, calls, questions, turns, storage, thread: `t${thread}` };
}
const SAT_2PM = "2026-10-31T14:00:00+09:00";
const LOCKERS = "Hongdae station lockers";

(async () => {
  console.log("--- 1. the model calls the tool; the gate reads its definition and asks for what is missing ---");
  const g4 = await drive("g4-01", "clean");
  const q = g4.questions[0];
  check("g4-01 (nothing stated): the conversation waits on a question", g4.questions.length, 1);
  check("  the model's words, then each value as code wrote it", q.message.split("\n"),
    ["Before I schedule it, please check:", "- time: not given yet", "- location: not given yet",
     "- Note: The buyer sees the time and location immediately. Tell the seller before the pickup is scheduled."]);
  check("  the agent's model was given the server's tools", g4.turns[0].tools.map(t => t.name), ["schedule_pickup", "cancel_pickup"]);
  check("  and the conversation, with what came from elsewhere marked as not the user's words",
    g4.turns[0].messages.filter(m => m.content.startsWith("[context, not the user's words]")).length > 0, true);
  check("  nothing executed while waiting", g4.calls.length, 0);
  check("  the question is in the conversation, as the assistant's", g4.state.conversation.at(-1)?.trust, "assistant");

  console.log("\n--- 2. the seller answers in words; a value they did not give in the declared form is shown to approve ---");
  const words = await drive("g4-01", "clean", ["Saturday 2pm, Hongdae station lockers", "yes"]);
  check("'Saturday 2pm' is read as a date-time and shown with its weekday", words.questions[1]?.block, ["time = 2026-10-31 (Sat) 14:00 +09:00",
    "Note: The buyer sees the time and location immediately. Tell the seller before the pickup is scheduled."]);
  check("  the place the seller typed is taken from their words, not asked again", words.questions[1]?.block?.some(l => l.startsWith("location")), false);
  check("  the seller's yes: executed once", [words.state.ended, words.calls.length], ["executed", 1]);
  check("  with the approved time and the seller's place", [words.calls[0]?.args.time, words.calls[0]?.args.location], [SAT_2PM, LOCKERS]);
  check("  the contact from the platform, not the model's arguments", words.calls[0]?.args.buyer_contact, "in-app chat (@kim_2291)");
  check("  the time is user_answer, the place the seller's words", words.state.verdict.fields.filter(f => ["time", "location"].includes(f.name)).map(f => f.source),
    ["user_answer", "instruction"]);

  const g1 = await drive("g1-01", "clean", ["yes"]);
  check("g1-01: the first question shows the model's reading of '2pm this Saturday'", g1.questions[0]?.block?.[0], "time = 2026-10-31 (Sat) 14:00 +09:00");
  check("  yes: executed with that moment, and the location the seller named", [g1.state.ended, g1.calls[0]?.args.time, g1.calls[0]?.args.location],
    ["executed", SAT_2PM, LOCKERS]);
  const corrected = await drive("g1-01", "clean", ["no, Saturday 3pm", "yes"]);
  check("no, and another time: the new reading is shown, and approved", [corrected.questions[1]?.block?.[0], corrected.calls[0]?.args.time],
    ["time = 2026-10-31 (Sat) 15:00 +09:00", "2026-10-31T15:00:00+09:00"]);
  const typed = await drive("g4-01", "clean", [`${SAT_2PM} at ${LOCKERS}`]);
  check("a time typed in the declared form is the seller's words: no approval needed", [typed.questions.length, typed.state.ended, typed.calls[0]?.args.time],
    [1, "executed", SAT_2PM]);

  console.log("\n--- 3. a reply that settles nothing is asked again, up to the ceiling ---");
  const vague = await drive("g4-01", "clean", ["hmm", "not sure"]);
  check("two replies that give nothing: exhausted, not executed", [vague.state.verdict.decision, vague.calls.length], ["exhausted", 0]);
  const cancelled = await drive("g4-01", "clean", [CANCEL]);
  check("the seller stops: cancelled, the tool not called", [cancelled.state.ended, cancelled.calls.length], ["cancelled", 0]);

  console.log("\n--- 4. the seller's own conditions: confirmed in conversation, then compared ---");
  // No items handed in: the gate takes the seller's conditions from their words (spec 4.4), and the
  //   question shows each with what it will be checked against (3.3).
  const g2 = await drive("g2-01", "clean", [`yes, 2026-10-31T20:00:00+09:00 at ${LOCKERS}`, "yes"], { userChecklist: [] });
  const first = g2.questions[0]?.block ?? [];
  // 'public places only.' is proposed as "the user approves it": the same as no form, so there is no form
  //   to confirm, and the place is asked about once it is known.
  check("g2-01: 'Nothing after 8pm.' shown to confirm; 'public places only.' has no form to confirm",
    [first.filter(l => /will be checked like this/.test(l)).length, first.some(l => /"public places only\."/.test(l))], [1, false]);
  check("  the seller's yes keeps the form; the place is then asked to approve against 'public places only'",
    /public places only.*location = "Hongdae station lockers"/.test(g2.questions[1]?.block?.[0] ?? ""), true);
  check("  approved: executed", [g2.state.ended, g2.calls.length], ["executed", 1]);
  check("  the evening limit compared in its form, the place by the seller's yes", g2.state.verdict.user_checklist.map(i => `${i.status}:${i.source}`),
    ["verified:instruction", "verified:user_answer"]);
  const late = await drive("g2-01", "clean", [`yes, 2026-10-31T21:00:00+09:00 at ${LOCKERS}`], { userChecklist: [] });
  check("  a time past 8pm against the seller's own limit: held", [late.state.verdict.decision, late.calls.length], ["hold", 0]);

  console.log("\n--- 5. the model answers in words, or calls another tool ---");
  const talk = await drive("g4-01", "clean", [], { chats: [{ text: "Which listing do you mean?" }] });
  check("no tool call: the model's words, and the gate does not run", [talk.state.ended, talk.state.reply, talk.state.verdict], ["replied", "Which listing do you mean?", null]);
  const switched = await drive("g4-01", "clean", ["actually, cancel it"], { chats: [{}, { tool: "cancel_pickup" }] });
  const counts = {};
  for (const n of ["schedule_pickup", "cancel_pickup"]) counts[n] = (await switched.storage.list(`user:${n}:${switched.thread}`)).length;
  check("another tool after the question: another unit, under its own key", [counts.schedule_pickup > 0, counts.cancel_pickup > 0], [true, true]);
  check("  the first unit's records stay as they were", counts.schedule_pickup, 1);
  check("  the gate judged the new call against its own definition", switched.calls[0]?.name, "cancel_pickup");

  console.log("\n--- 6. without the model's words, the question is still asked ---");
  const base = makeAsk("g4-01");
  const mute = await drive("g4-01", "clean", [], { ask: async (m, s, u, hook) => { if (hook === "question") throw new Error("model down"); return base(m, s, u, hook); } });
  check("the list, as code wrote it", mute.questions[0]?.message.split("\n")[0], "Before this can run, please answer:");

  console.log("\n--- 6-a. the gate stops it: the seller is told why ---");
  const held = await drive("g1-01", "order_cancelled");
  check("order cancelled: no call, the run ends on the gate's decision, and the seller is told in the model's words",
    [held.calls.length, held.state.ended ?? held.state.verdict?.decision, held.state.stop?.message, held.state.stop?.facts?.items?.[0]?.why],
    [0, "hold", "I did not schedule it.", "not_allowed"]);
  check("  what the seller was told is the conversation's last word", held.state.conversation.at(-1), { trust: "assistant", text: "I did not schedule it." });

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
