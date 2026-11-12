"use strict";

/**
 * Checks adopt-example/judge-only.js and judge-only-example.js: the structure to adopt (spec 3.5).
 * The gate judges and records; the agent's side reads the record and executes.
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
const { createJudge, createStorage, toolsForModel, writeQuestion } = require(path.join(ADOPT, "judge-only"));
const fs = require("fs");
const graphSide = require(path.join(ADOPT, "gate"));
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
  const calls = [], shown = [], prompts = [];
  const chatInner = makeChat();
  const askInner = over.ask ?? makeAsk(id);
  const text = S.instructions.find(i => i.id === id).text;
  let first = true;
  const store = createStorage();
  return {
    calls, store, shown, prompts,
    connect: {
      // Every prompt the gate's model calls were sent, kept for the checks.
      ask: async (m, system, user, hook) => { prompts.push({ hook, system, user }); return askInner(m, system, user, hook); },
      // What the agent's model is given, kept for the checks.
      chat: async a => { shown.push(a?.tools ?? null); return chatInner(a); },
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
  const userChecklist = over.userChecklist ?? S.instructions.find(i => i.id === id).user_checklist ?? [];
  const first = await main.turn({ threadId, message: { typed: "(stand-in)" }, userChecklist });
  let last = first;
  for (const r of replies) last = await main.turn({ threadId, message: { typed: r }, userChecklist });
  const records = await s.store.list(`user:${TOOL.name}:${threadId}`);
  return { first, last, calls: s.calls, shown: s.shown, prompts: s.prompts, store: s.store, key: `user:${TOOL.name}:${threadId}`, records };
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

  console.log("\n--- 1-a. the agent's model is not shown the provider's labelled lines ---");
  {
    const lines = TOOL.description.split("\n");
    const forModel = toolsForModel([TOOL])[0];
    check("it is the skeleton's function: judge-only.js only hands it on",
      [toolsForModel === require("../execution-state-preflight").toolsForModel, createJudge({ ask() {}, readToolDefinition() {}, storage: createStorage() }).toolsForModel === toolsForModel], [true, true]);
    check("the tool has labelled lines, and the gate read all of them", [lines.filter(l => /^\[/.test(l)).length, verdict?.provider_checklist?.length], [7, 7]);
    check("what the model is given keeps the prose and the input schema", [forModel.description, forModel.inputSchema, forModel.name],
      [lines.filter(l => !/^\s*\[/.test(l)).join("\n").trim(), TOOL.inputSchema, TOOL.name]);
    check("  and none of the labels", ["[Required]", "[Verify]", "[Notice]"].filter(l => forModel.description.includes(l)), []);
    check("a label the gate does not know is taken out too: the gate holds it, the model does not judge it",
      toolsForModel([{ name: "t", description: "Does a thing.\n[Requried] Must be agreed.\n  [Beta] Indented." }])[0].description, "Does a thing.");
    check("a tool with no description is left as it is", toolsForModel([{ name: "t" }]), [{ name: "t", description: "" }]);
    const seen = g1.shown.flat().map(t => t?.description ?? "");
    check("in the run, every list the model was given had no labelled line", [g1.shown.length > 0, seen.some(d => /\[(Required|Verify|Notice)\]/.test(d))], [true, false]);
    // Whether the act the user named is what the tool does is asked without the lines too: a real model
    //   handed them judged them there, and refused the match.
    const match = g1.prompts.filter(p => p.hook === "tool_match");
    check("the tool-match question is asked with the tool's prose and without its labelled lines",
      [match.length > 0, match.every(p => p.user.includes("Schedule an in-person pickup")), match.some(p => /\[(Required|Verify|Notice)\]/.test(p.user))], [true, true, false]);
  }

  console.log("\n--- 1-c. the seller's own condition, put into a form by the model, is tried on the value shown ---");
  {
    // The form a real model wrote for "Nothing after 8pm": it matches a bare time of day, never a
    //   date-time, so no time could ever pass. The seller was shown only the form, and said yes.
    const BAD = { type: "string", pattern: "^(([01][0-9]:[0-5][0-9](:[0-5][0-9])?)|(20:00(:00)?))$" };
    const stub = makeAsk("g2-01");
    const ask = (m, s, u, h) => {
      if (h === "comparable_form" && /Declared by: user/.test(u)) {
        if (/Condition: Nothing after 8pm/.test(u)) return { form: { compare: BAD, constrains: ["time"] } };
        if (/Condition: public places only/.test(u)) return { form: null };
      }
      if (h === "propose_value") return { value: "2026-10-31T15:00:00+09:00" };
      return stub(m, s, u, h);
    };
    const r = await run("g2-01", "clean", [], { ask, userChecklist: [] });
    const line = (r.first.question?.block ?? []).find(l => l.startsWith('"Nothing after 8pm"')) ?? "";
    check("the form is shown with what it says about the time shown above: does not hold",
      line.endsWith("for time = 2026-10-31 (Sat) 15:00 +09:00 (shown above): does not hold"), true);
    const formPrompt = r.prompts.find(p => p.hook === "comparable_form" && /Condition: Nothing after 8pm/.test(p.user))?.user ?? "";
    check("the model putting it into a form is told each field's declared form", /time: string, format date-time/.test(formPrompt), true);
    const rec = r.records.at(-1);
    const pub = (rec?.user_checklist ?? []).find(i => i.stated_as === "public places only") ?? {};
    check("'public places only', no form fits: not pending a form, waiting on the place to approve it for",
      [Boolean(pub.form_pending), typeof pub.form_none?.why, pub.status], [false, "string", "pending_on_slot"]);
  }

  console.log("\n--- 1-e. the real run replayed: the conditions split differently in a later round, one yes for all ---");
  {
    // What the real model did in g2-01: the seller's two conditions taken as two, then as one quote in the
    //   next round; one "yes" under four questions. The fix: words already read are not read again, and
    //   the reply reader is told one yes answers every question it follows.
    const GOOD = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d:[0-5]\\d:[0-5]\\d|20:00:00)(?:Z|[+-]\\d{2}:\\d{2})$" };
    const stub = makeAsk("g2-01");
    let round = 0;
    const said = "[Seller to you]\nArrange the pickup for LST-2291. Nothing after 8pm, and public places only.";
    const ask = (m, sys, u, h) => {
      if (h === "user_conditions") {
        round++;
        return round === 1
          ? { conditions: [{ quote: "Nothing after 8pm", segment_index: 3, constrains: ["time"] }, { quote: "public places only", segment_index: 3, constrains: ["location"] }] }
          : { conditions: [{ quote: "Nothing after 8pm, and public places only.", segment_index: 3, constrains: ["time", "location"] }] };
      }
      if (h === "comparable_form" && /Declared by: user/.test(u)) {
        if (/Condition: Nothing after 8pm$/m.test(u)) return { form: { compare: GOOD, constrains: ["time"] } };
        return { form: null };
      }
      if (h === "extraction") {
        const segs = JSON.parse(u.slice(u.indexOf("Segments:\n") + 10, u.indexOf("\n\nFields to locate")));
        const at = segs.findIndex(x => x.trust === "user" && x.text.includes("This Saturday at 3pm"));
        return { item_id: { found: true, value: "LST-2291", segment_index: 3 },
          ...(at >= 0 ? { time: { found: true, value: "This Saturday at 3pm", segment_index: at }, location: { found: true, value: "Hongdae station lockers", segment_index: at } }
                      : { time: { found: false }, location: { found: false } }),
          buyer_contact: { found: false } };
      }
      if (h === "propose_value") return { value: /^Field: time:/m.test(u) && /This Saturday at 3pm/.test(u) ? "2026-10-31T15:00:00+09:00" : null };
      if (h === "replies") {
        const targets = [...u.matchAll(/"target": "((?:value|approve|form):[^"]+)"/g)].map(x => x[1]);
        const segs = JSON.parse(u.slice(u.indexOf("Segments:\n") + 10, u.indexOf("\n\nFor each question")));
        const at = segs.length - 1;
        return { replies: segs[at]?.text === "yes" ? targets.map(t => ({ target: t, answer: true, quote: "yes", segment_index: at })) : [] };
      }
      return stub(m, sys, u, h);
    };
    const r = await run("g2-01", "clean", ["This Saturday at 3pm at the Hongdae station lockers.", "yes"], { ask, userChecklist: [] });
    check("it executes at 15:00 on the one yes, and the two conditions of round 1 are the ones the record holds",
      [r.last.status, r.calls[0]?.args.time, (r.records.at(-1)?.user_checklist ?? []).filter(i => i.extracted).map(i => [i.stated_as, i.status])],
      ["executed", "2026-10-31T15:00:00+09:00", [["Nothing after 8pm", "verified"], ["public places only", "verified"]]]);
    const prompt = r.prompts.find(p => p.hook === "replies")?.system ?? "";
    check("the reply reader is told one yes after several questions answers each", /One yes or no after several questions answers each/.test(prompt), true);
  }

  console.log("\n--- 1-f. the seller takes a condition back: asked, confirmed, recorded as withdrawn ---");
  {
    // The real run: the seller said "Nothing after 8pm", then "Keep 9pm and drop the 8pm limit". The model
    //   reading the conditions left the 8pm one out, and the record showed no trace of it.
    const GOOD = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d:[0-5]\\d:[0-5]\\d|20:00:00)(?:Z|[+-]\\d{2}:\\d{2})$" };
    const stub = makeAsk("g2-01");
    const segsOf = (u, until) => JSON.parse(u.slice(u.indexOf("Segments:\n") + 10, u.indexOf(until)));
    const ask = (m, sys, u, h) => {
      if (h === "user_conditions") {
        const segs = segsOf(u, "\n\nReply as");
        const back = segs.findIndex(x => x.trust === "user" && x.text.includes("drop the 8pm limit"));
        return { conditions: [
          { quote: "Nothing after 8pm", segment_index: 3, constrains: ["time"], ...(back >= 0 ? { withdrawn_by: { quote: "drop the 8pm limit", segment_index: back } } : {}) },
          { quote: "public places only", segment_index: 3, constrains: ["location"] }] };
      }
      if (h === "comparable_form" && /Declared by: user/.test(u)) return /Condition: Nothing after 8pm$/m.test(u) ? { form: { compare: GOOD, constrains: ["time"] } } : { form: null };
      if (h === "extraction") {
        const segs = segsOf(u, "\n\nFields to locate");
        const at = segs.findIndex(x => x.trust === "user" && x.text.includes("This Saturday at 9pm"));
        return { item_id: { found: true, value: "LST-2291", segment_index: 3 },
          ...(at >= 0 ? { time: { found: true, value: "This Saturday at 9pm", segment_index: at }, location: { found: true, value: "Hongdae station lockers", segment_index: at } }
                      : { time: { found: false }, location: { found: false } }), buyer_contact: { found: false } };
      }
      if (h === "propose_value") return { value: /^Field: time:/m.test(u) && /This Saturday at 9pm/.test(u) ? "2026-10-31T21:00:00+09:00" : null };
      if (h === "replies") {
        const targets = [...u.matchAll(/"target": "((?:value|approve|form|withdraw):[^"]+)"/g)].map(x => x[1]);
        const segs = segsOf(u, "\n\nFor each question");
        const at = segs.length - 1;
        return { replies: segs[at]?.text === "yes" ? targets.map(t => ({ target: t, answer: true, quote: "yes", segment_index: at })) : [] };
      }
      return stub(m, sys, u, h);
    };
    const r = await run("g2-01", "clean", ["This Saturday at 9pm at the Hongdae station lockers. Keep 9pm and drop the 8pm limit.", "yes"], { ask, userChecklist: [] });
    const asked = r.records.find(x => (x.gate?.questions ?? []).some(q => q.kind === "withdraw"));
    check("the taking back is asked about, with the seller's words", ((asked?.gate?.question_block ?? []).find(l => l.includes("remove this condition")) ?? ""),
      '"Nothing after 8pm" — remove this condition? (you said: "drop the 8pm limit")');
    const done = r.records.filter(x => x.execution_decision === "execute").at(-1);
    const eight = (done?.user_checklist ?? []).find(i => i.stated_as === "Nothing after 8pm") ?? {};
    check("  the seller's yes: 21:00 executes, and the record keeps the condition as withdrawn, with the words",
      [r.last.status, r.calls[0]?.args.time, eight.status, eight.withdrawal?.quote], ["executed", "2026-10-31T21:00:00+09:00", "withdrawn", "drop the 8pm limit"]);
    const prompt = r.prompts.find(p => p.hook === "user_conditions")?.system ?? "";
    check("  the model finding conditions is told never to leave one out that was taken back", /also one they later took back: never leave it out/.test(prompt), true);
  }

  console.log("\n--- 1-d. the words of a question: one writer, plain text taken as it is ---");
  {
    const qs = [{ kind: "value", slot: "time", lines: [] }];
    const conv = [{ trust: "user", text: "Arrange it." }];
    const viaSay = await writeQuestion({ ask: () => { throw new Error("not used"); }, say: async () => "  Is this time right?  " }, { questions: qs, conversation: conv });
    const jsonAnyway = await writeQuestion({ ask: null, say: async () => '{"message": "Is this right?"}' }, { questions: qs, conversation: conv });
    const viaAsk = await writeQuestion({ ask: async () => ({ message: "Right?" }) }, { questions: qs, conversation: conv });
    const nothing = await writeQuestion({ say: async () => { throw new Error("down"); } }, { questions: qs, conversation: conv });
    check("plain text from say is the message; JSON from say is read; without say, ask; a failure is null",
      [viaSay, jsonAnyway, viaAsk, nothing], ["Is this time right?", "Is this right?", "Right?", null]);
    const strip = f => fs.readFileSync(path.join(ADOPT, f), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
    check("the question prompt is written in one place: judge-only.js, not in either flow",
      ["judge-only.js", "gate.js", "judge-only-example.js"].map(f => strip(f).includes("You ask the user, in conversation")), [true, false, false]);
    // Both flows ask through it: with say connected, its words head the question.
    const s = standIn("g1-01", "clean");
    s.connect.say = async (m, sys, u, h) => (h === "question" ? "Plain words from say." : "");
    const main = createMain({ connect: s.connect });
    const r1 = await main.turn({ threadId: "say-1", message: { typed: "x" } });
    check("the agent's side: the question starts with what say wrote", r1.question?.message.split("\n")[0], "Plain words from say.");
  }

  console.log("\n--- 1-b. the gate could not tell what is wanted: its own words are shown, and the user says it again ---");
  {
    const stub = makeAsk("g1-01");
    // The tool is not matched the first time, then it is.
    let n = 0;
    const once = await run("g1-01", "clean", ["Schedule the pickup, as I said.", "yes"],
      { ask: (m, s, u, h) => (h === "tool_match" ? { approved: n++ >= 1, reason: "stand-in" } : stub(m, s, u, h)) });
    check("the tool is not matched: waiting, with the gate's own words and no values",
      [once.first.status, once.first.question?.message, once.first.question?.block], ["waiting", "I could not tell which action this maps to. Please describe what you want done, in your own words.", []]);
    check("  the user says it again: the run goes on to the values, and executes on yes", [once.last.status, once.calls.length, once.calls[0]?.args.time], ["executed", 1, SAT_2PM]);
    // Never matched: the skeleton counts the asks from the unit's records and stops.
    const never = await run("g1-01", "clean", ["again", "again", "again"],
      { ask: (m, s, u, h) => (h === "tool_match" ? { approved: false, reason: "stand-in" } : stub(m, s, u, h)) });
    check("  never matched: it stops asking, nothing runs, and the gate's last words are passed on",
      [never.last.status, never.calls.length, never.last.message], ["not_executed", 0, "I still could not match this to an action I can perform. Let us sort it out in conversation."]);
    // What is wanted is never named: the caller carries that count (those records have no key).
    const s = standIn("g1-01", "clean", { ask: (m, sy, u, h) => (h === "action_name" ? { action_name: null } : stub(m, sy, u, h)) });
    const main = createMain({ connect: s.connect });
    const statuses = [];
    for (const typed of ["x", "again", "again", "again"]) statuses.push((await main.turn({ threadId: "intent-1", message: { typed } })).status);
    check("what is wanted is never named: asked to restate twice, then it stops", [statuses.slice(0, 3), s.calls.length], [["waiting", "waiting", "not_executed"], 0]);
  }

  console.log("\n--- 2. what judge.run returns cannot be executed from ---");
  {
    const s = standIn("g1-01", "clean");
    const judge = createJudge({ ask: s.connect.ask, measure: s.connect.measure, readToolDefinition: s.connect.readToolDefinition,
      measurements: MEASUREMENTS, storage: s.store });
    const conversation = s.connect.labelInput({ typed: "x" });
    const toolCall = (await s.connect.chat()).toolCall;
    const r1 = await judge.run({ unitKey: "u1", conversation, toolCall });
    check("it returns the key, what to ask, the gate's own words, the notices and the reason", Object.keys(r1),
      ["key", "ask", "questions", "block", "message", "options", "notices", "reason"]);
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
  // gate.js (the whole agent) reads the record with its own copy of the same reading.
  check("  gate.js reads each of them the same way", [graphSide.readyToExecute(verdict, TOOL.name),
    Object.entries(changed).filter(([, c]) => graphSide.readyToExecute({ ...verdict, ...c }, TOOL.name)).map(([l]) => l)], [true, []]);

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
        if (graphSide.readyToExecute(rec, TOOL.name) !== mine) disagree.push(`${ins.id}/${condition}: gate.js and the example read ${rec.execution_decision} differently`);
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
