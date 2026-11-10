"use strict";

/**
 * Checks adopt-example/judge-only.js and judge-only-example.js: the path for an agent that already
 * exists. The gate judges and records; the agent's side reads the record and executes.
 *
 * The flow under test is judge-only-example.js itself, run with stand-in connections: the stub models,
 * this folder's tool.json, the same measurements and user turns as the other checks, a tool call that
 * only records.
 *
 *   npm run check
 */

const path = require("path");
const ADOPT = path.join(__dirname, "..", "adopt-example");
const { createMain, readyToExecute } = require(path.join(ADOPT, "judge-only-example"));
const { createJudge, createStorage } = require(path.join(ADOPT, "judge-only"));
const realConnect = require(path.join(ADOPT, "connect"));
const { runArm, measuredFor, measurePort, MEASUREMENTS } = require("./arm");
const TOOL = require("./tool.json");
const { buildUserTurn } = require("./prompts");
const { makeAsk, makeChat } = require("./stub");
const S = require("./instructions.json");

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(68)} got=${JSON.stringify(got)}${ok ? "" : `  want=${JSON.stringify(want)}`}`);
}
const SAT_2PM = "2026-10-31T14:00:00+09:00";
const VERDICTS = ["execute", "ask_user", "system_lookup", "definition_repair", "exhausted", "hold", "deferred"];
let thread = 0;

function standIn(id, condition, over = {}) {
  const ctx = S.conditions[condition].context, date = S.date_modes.said;
  const calls = [];
  const text = S.instructions.find(i => i.id === id).text;
  let first = true;
  const store = createStorage();
  return {
    calls, store,
    connect: {
      ask: makeAsk(id),
      chat: makeChat(),
      listTools: async () => [TOOL],
      readToolDefinition: async name => [TOOL].find(t => t.name === name),
      measure: measurePort(measuredFor(ctx, date)),
      // The first message arrives with the condition's context; later ones are what the seller typed.
      labelInput: msg => {
        if (first) { first = false; return buildUserTurn(ctx, text, date).segments; }
        return realConnect.labelInput(msg);
      },
      callTool: over.callTool ?? (async (name, args) => { calls.push({ name, args }); return { ok: true }; }),
      store,
      MEASUREMENTS: Object.fromEntries(MEASUREMENTS.map(n => [n, async () => undefined])),
      MODEL_NAME: "stub",
    },
  };
}
async function run(id, condition, replies = [], over = {}) {
  const s = standIn(id, condition, over);
  const main = createMain({ connect: s.connect });
  const threadId = `j${++thread}`;
  const userChecklist = S.instructions.find(i => i.id === id).user_checklist ?? [];
  const first = await main.turn({ threadId, message: { typed: "(stand-in)" }, userChecklist });
  let last = first;
  for (const r of replies) last = await main.turn({ threadId, message: { typed: r }, userChecklist });
  const records = await s.store.list(`user:${TOOL.name}:${threadId}`);
  return { first, last, calls: s.calls, store: s.store, key: `user:${TOOL.name}:${threadId}`, records };
}

(async () => {
  console.log("--- 1. ask, reply, and the agent's side executes from the record ---");
  const g1 = await run("g1-01", "clean", ["yes"]);
  check("g1-01: waits on a question, the value shown as code wrote it", [g1.first.status, g1.first.question?.block?.[0]],
    ["waiting", "time = 2026-10-31 (Sat) 14:00 +09:00"]);
  check("  the provider's notice goes with it", g1.first.question?.block?.some(l => l.startsWith("Note: The buyer sees")), true);
  check("  the seller's yes: executed once", [g1.last.status, g1.calls.length, g1.calls[0]?.args.time], ["executed", 1, SAT_2PM]);
  const verdict = g1.records.filter(r => VERDICTS.includes(r.execution_decision)).at(-1);
  check("  the arguments sent are the record's", g1.calls[0]?.args, verdict?.call_arguments);
  // The stub model puts "made up" in its own call; the record's value is the platform's.
  check("  not the ones the model put in its call", [verdict?.tool_call?.arguments?.buyer_contact, g1.calls[0]?.args.buyer_contact !== "made up"], ["made up", true]);
  check("  what happened is written back: the unit's last record is executed", g1.records.at(-1)?.execution_decision, "executed");
  check("  and it is what a later run may carry values from", (await g1.store.load(g1.key))?.execution_decision, "executed");

  console.log("\n--- 2. what judge.run returns cannot be executed from ---");
  {
    const s = standIn("g1-01", "clean");
    const judge = createJudge({ ask: s.connect.ask, measure: s.connect.measure, readToolDefinition: s.connect.readToolDefinition,
      measurements: MEASUREMENTS, storage: s.store });
    const conversation = s.connect.labelInput({ typed: "x" });
    const toolCall = (await s.connect.chat()).toolCall;
    const r1 = await judge.run({ unitKey: "u1", conversation, toolCall });
    check("it returns the key, what to ask, the block, the notices and the reason", Object.keys(r1), ["key", "questions", "block", "notices", "reason"]);
    conversation.push({ trust: "assistant", text: ["q", ...r1.block.map(l => `- ${l}`)].join("\n") }, ...realConnect.labelInput({ typed: "yes" }));
    const r2 = await judge.run({ unitKey: "u1", conversation, toolCall });
    const rec = (await s.store.list(r2.key)).at(-1);
    check("the round that is ready returns nothing to ask, and the record is ready", [r2.questions.length, readyToExecute(rec, TOOL.name)], [0, true]);
    const text = JSON.stringify(r2);
    check("  no arguments and no decision in what it returned", [text.includes(SAT_2PM), "call_arguments" in r2, "execution_decision" in r2, "decision" in r2], [false, false, false, false]);
    check("  nothing was executed by judging", s.calls.length, 0);
    let threw = null;
    try { await judge.recordResult({ reason: "hand-built" }, { ok: true }); } catch (e) { threw = e.message; }
    check("recordResult takes a record read from storage, not a hand-built one", typeof threw, "string");
    let refused = null;
    try { createJudge({ ask: s.connect.ask, readToolDefinition: s.connect.readToolDefinition, storage: { persist() {}, load() {} } }); } catch (e) { refused = e.message; }
    check("a storage without list is refused: the record could not be read back", typeof refused, "string");
  }

  console.log("\n--- 3. a record that is not ready is not executed ---");
  const held = await run("g5-01", "offer_out_of_range");
  check("a condition prohibits it: not executed, with the reason", [held.first.status, held.calls.length, typeof held.first.reason], ["not_executed", 0, "string"]);
  const asking = g1.records.find(r => r.execution_decision === "ask_user");
  check("a record that still asks carries the values known so far, and is not ready",
    [asking?.call_arguments && typeof asking.call_arguments, readyToExecute(asking, TOOL.name)], ["object", false]);
  check("a result already written is not ready: nothing runs twice from it", readyToExecute(g1.records.at(-1), TOOL.name), false);
  check("a record for another tool is not ready", readyToExecute(verdict, "another_tool"), false);
  check("no record is not ready", [readyToExecute(null, TOOL.name), readyToExecute(undefined, TOOL.name)], [false, false]);
  // The record that was ready, with one thing changed at a time: each thing the agent's side reads counts.
  const changed = {
    "a condition that prohibits (gate.kind)": { gate: { ...verdict.gate, kind: "unmet" } },
    "no gate result": { gate: null },
    "a verdict not made for this moment (phase)": { phase: "at_instruction" },
    "a slot not counted (unknown_count null)": { unknown_count: null },
    "an item of the user's unconfirmed": { unverified_checklist_count: 1 },
    "a line of the provider's unconfirmed": { unverified_provider_count: 1 },
    "a value check unconfirmed": { unverified_value_check_count: 1 },
    "no arguments recorded": { call_arguments: null },
  };
  check("the ready record is ready as it stands", readyToExecute(verdict, TOOL.name), true);
  check("  and not with any one of these changed", Object.entries(changed).filter(([, c]) => readyToExecute({ ...verdict, ...c }, TOOL.name)).map(([l]) => l), []);

  console.log("\n--- 4. a call that does not complete is recorded as failed ---");
  for (const [label, result, want] of [
    ["the call throws: reported, recorded as failed", async () => { throw new Error("connection reset"); }, "call_failed"],
    ["the tool reports an error: recorded as failed", async () => ({ isError: true, content: [{ type: "text", text: "slot taken" }] }), "tool_error"],
    ["the server asked for input instead of completing: recorded as failed", async () => ({ inputRequired: { pin: {} } }), "tool_error"],
  ]) {
    let n = 0;
    const f = await run("g1-01", "clean", ["yes"], { callTool: async () => { n++; return result(); } });
    check(label, [f.last.status, n, f.records.at(-1)?.execution_decision, await f.store.load(f.key)], [want, 1, "failed", null]);
  }

  console.log("\n--- 5. the agent's side reads the record the same way the gate decided ---");
  // Every verdict record of the 35 runs, each carried on through the seller's yes. The agent's side does
  //   not read execution_decision; this checks that what it does read comes to the same thing.
  const disagree = [], firstMismatch = [];
  let verdicts = 0, ready = 0;
  for (const ins of S.instructions) {
    for (const condition of S.instruction_conditions[String(ins.group)] ?? []) {
      const ctx = S.conditions[condition].context, date = S.date_modes.said;
      const arm = await runArm({ ctx, instructionText: ins.text, userChecklist: ins.user_checklist ?? [], date, ask: makeAsk(ins.id), runId: `j-${ins.id}` });
      const r = await run(ins.id, condition, ["yes", "yes"]);
      const recs = r.records.filter(x => VERDICTS.includes(x.execution_decision));
      if (recs[0]?.execution_decision !== arm.decision) firstMismatch.push(`${ins.id}/${condition}: ${arm.decision} vs ${recs[0]?.execution_decision}`);
      for (const rec of recs) {
        verdicts++;
        const mine = readyToExecute(rec, TOOL.name), gates = rec.execution_decision === "execute";
        if (mine) ready++;
        if (mine !== gates) disagree.push(`${ins.id}/${condition}: ${rec.execution_decision} read as ${mine ? "ready" : "not ready"}`);
      }
      const executedRecords = r.records.filter(x => x.execution_decision === "executed").length;
      if (executedRecords !== r.calls.length) disagree.push(`${ins.id}/${condition}: ${r.calls.length} calls, ${executedRecords} executed records`);
    }
  }
  check("35 runs: the first verdict is the arm's", firstMismatch, []);
  check("every verdict record: ready exactly when the gate decided execute", disagree, []);
  check("  and some of them were ready (the check is not empty)", [verdicts > 35, ready > 0], [true, true]);

  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("THREW:", e.stack); process.exit(1); });
