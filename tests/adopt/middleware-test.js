"use strict";

/**
 * Checks adopt-example/middleware.js: the gate as LangChain middleware, in createAgent, with the stand-in
 * models of this folder for the gate and a fake chat model for the agent.
 *
 *   node middleware-test.js
 */

const path = require("path");
const ADOPT = path.join(__dirname, "..", "..", "adopt-example");
const { createAgent, tool, HumanMessage, FakeToolCallingModel } = require(path.join(ADOPT, "node_modules", "langchain"));
const { MemorySaver, Command } = require(path.join(ADOPT, "node_modules", "@langchain/langgraph"));
const { preflightMiddleware, segmentsFor } = require(path.join(ADOPT, "middleware"));
const { createStorage } = require(path.join(ADOPT, "judge-only"));
const realConnect = require(path.join(ADOPT, "connect"));
const { measuredFor, measurePort, MEASUREMENTS } = require("./arm");
const TOOL = require("./tool.json");
const { buildUserTurn } = require("./prompts");
const { makeAsk } = require("./stub");
const shapes = require("./shape-check");
const { recordStore } = require(path.join(__dirname, "..", "..", "adopt-example", "records"));
const { InMemoryStore } = require(path.join(__dirname, "..", "..", "adopt-example", "node_modules", "@langchain/langgraph"));
// Records in a LangGraph BaseStore, as connect.js keeps them.
const baseStoreRecords = () => recordStore(new InMemoryStore());
const S = require("./instructions.json");

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(68)} got=${JSON.stringify(got)}${ok ? "" : `  want=${JSON.stringify(want)}`}`);
}
const SAT_2PM = "2026-10-31T14:00:00+09:00";
const ALL_GIVEN = "Set up the pickup for listing LST-2291 at 2026-10-31T14:00:00+09:00 at the Hongdae station lockers.";
function askAllGiven(id) {
  const inner = makeAsk(id);
  return async (m, system, user, hook) => {
    const out = await inner(m, system, user, hook);
    if (hook === "extraction") {
      const segs = JSON.parse(user.slice(user.indexOf("[", user.indexOf("Segments:")), user.indexOf("\n\nFields to locate")));
      out.time = { found: true, value: SAT_2PM, segment_index: segs.findIndex(s => s.trust === "user" && s.text.includes("2026-10-31T14")) };
    }
    return out;
  };
}

let thread = 0;
// One conversation: the agent, its tool (it only records), and what the gate's models were asked.
function setup(id, condition, over = {}) {
  const ctx = S.conditions[condition].context, date = S.date_modes.said;
  const ins = S.instructions.find(i => i.id === id), text = over.text ?? ins.text;
  const prompts = [], calls = [], events = [];
  const askInner = over.ask ?? makeAsk(id);
  const store = baseStoreRecords();
  const connect = {
    ask: shapes.watch(async (m, system, user, hook, schema) => { prompts.push(hook); return askInner(m, system, user, hook, schema); }),
    readToolDefinition: async name => [TOOL].find(t => t.name === name),
    measure: measurePort(measuredFor(ctx, date)),
    labelInput: realConnect.labelInput,
    ...(over.notify === null ? {} : { notify: async lines => { events.push(["notify", lines]); } }),
    store,
    readPreSet: async () => ins.pre_set ?? {},
    MEASUREMENTS: Object.fromEntries(MEASUREMENTS.map(n => [n, async () => undefined])),
    MODEL_NAME: "stub",
  };
  const pickup = tool(async args => { events.push("call"); calls.push(args); return "scheduled"; },
    { name: TOOL.name, description: TOOL.description, schema: TOOL.inputSchema });
  // The agent's model: the tool calls it makes, one list per turn of the model.
  const model = new FakeToolCallingModel({ toolCalls: over.toolCalls ?? [[{ name: TOOL.name, args: { item_id: "LST-2291" }, id: "call_1" }], []] });
  // The first message carries the scenario's context, labelled as the stand-in's input is elsewhere.
  const labelMessage = (m, i) => (i === 0 ? buildUserTurn(ctx, text, date).segments : [{ trust: "user", text: String(m.content) }]);
  const agent = createAgent({ model, tools: [pickup], checkpointer: new MemorySaver(),
    middleware: [preflightMiddleware({ connect, labelMessage, userChecklist: ins.user_checklist ?? [] })] });
  const config = { configurable: { thread_id: `m${++thread}` } };
  const key = `user:${TOOL.name}:${config.configurable.thread_id}`;
  const waiting = async () => (await agent.graph.getState(config)).tasks.flatMap(t => t.interrupts ?? []).map(x => x.value);
  return {
    agent, config, prompts, calls, events, store, key, waiting,
    start: () => agent.invoke({ messages: [new HumanMessage("(stand-in)")] }, config),
    resume: value => agent.invoke(new Command({ resume: value }), config),
    say: words => agent.invoke({ messages: [new HumanMessage(words)] }, config),
    toolResult: state => [...(state.messages ?? [])].reverse().find(m => m.getType?.() === "tool" || m._getType?.() === "tool"),
    decisions: async () => (await store.list(key)).filter(x => x && "execution_decision" in x).map(x => x.execution_decision),
  };
}
const count = (list, hook) => list.filter(h => h === hook).length;

(async () => {
  console.log("--- 1. a call that has to ask: it waits in the call, and runs with what the record holds ---");
  {
    const t = setup("g1-01", "clean");
    await t.start();
    const [q] = await t.waiting();
    check("the call waits on the user, with the form's schema and the notices",
      [q?.type, (q?.questions ?? []).map(x => x.target), typeof q?.message, (q?.notices ?? []).length > 0, t.calls.length],
      ["preflight_question", ["value:time"], "string", true, 0]);
    const asked = t.prompts.length;
    const state = await t.resume({ "value:time": true });
    check("answered in the form: it runs at the time shown, the record says so",
      [t.calls.length, t.calls[0]?.time, (await t.decisions()).slice(-2)], [1, SAT_2PM, ["execute", "executed"]]);
    // On resume LangGraph runs the call again from the top: the first judging is taken as kept.
    check("  the first judging is not made again: one question written, two rounds read",
      [count(t.prompts, "question"), count(t.prompts, "when_case"), t.prompts.length > asked], [1, 2, true]);
    check("  the model is told the call ran with other values than its own", /\n\nNote: the system ran this call with the values/.test(String(t.toolResult(state)?.content)), true);
  }

  console.log("\n--- 2. the model's arguments are not the values ---");
  {
    const t = setup("g1-01", "clean", { toolCalls: [[{ name: TOOL.name, args: { item_id: "LST-2291", time: "2026-11-01T10:00:00+09:00", location: "my place" }, id: "call_1" }], []] });
    await t.start();
    await t.resume({ "value:time": true });
    check("the tool gets the record's arguments, not the call's", [t.calls[0]?.time, t.calls[0]?.location], [SAT_2PM, "Hongdae station lockers"]);
  }

  console.log("\n--- 3. not ready: not run, and the user is told why ---");
  {
    const t = setup("g1-01", "order_cancelled");
    let state = await t.start();
    if ((await t.waiting()).length) state = await t.resume({ "value:time": true });
    const m = t.toolResult(state);
    check("a cancelled order: the tool is not called, the result is an error with what the user was told",
      [t.calls.length, m?.status, /^Not run\. The user was told:/.test(String(m?.content)), (await t.decisions()).at(-1)], [0, "error", true, "not_executed"]);
  }

  console.log("\n--- 4. declined or cancelled: no answer, and the question stays open ---");
  {
    const t = setup("g1-01", "clean", { toolCalls: [[{ name: TOOL.name, args: { item_id: "LST-2291" }, id: "call_1" }], [],
                                                     [{ name: TOOL.name, args: { item_id: "LST-2291" }, id: "call_2" }], []] });
    await t.start();
    const first = (await t.waiting())[0];
    const state = await t.resume({ action: "decline" });
    const m = t.toolResult(state);
    check("declined: not run, nothing written as an answer", [t.calls.length, m?.status, /did not answer/.test(String(m?.content))], [0, "error", true]);
    await t.say("go ahead with the pickup");
    const again = (await t.waiting())[0];
    check("  the next call is asked the same question", (again?.questions ?? []).map(x => x.target), (first?.questions ?? []).map(x => x.target));
  }

  console.log("\n--- 5. an answer in words ---");
  {
    const t = setup("g1-01", "clean");
    await t.start();
    await t.resume({ typed: "yes" });
    check("typed yes: it runs at the time shown", [t.calls.length, t.calls[0]?.time], [1, SAT_2PM]);
  }

  console.log("\n--- 6. notices, when nothing is asked ---");
  {
    const t = setup("g1-01", "clean", { text: ALL_GIVEN, ask: askAllGiven("g1-01") });
    await t.start();
    check("nothing to ask: the notice is told, then the tool runs", [(await t.waiting()).length, t.events.map(e => (Array.isArray(e) ? e[0] : e))], [0, ["notify", "call"]]);
    const mute = setup("g1-01", "clean", { text: ALL_GIVEN, ask: askAllGiven("g1-01"), notify: null });
    const state = await mute.start();
    check("  no way to tell it: not run", [mute.calls.length, mute.toolResult(state)?.status], [0, "error"]);
  }

  // The agent's model does not see the questions and answers inside a call; the result tells it what
  //   was asked and answered. A real model (Opus 5.5), told only "Executed: …", told the seller
  //   "You didn't give me that time." It had not seen the answer.
  const ASKED_LINE = "The system asked the user:\n";
  console.log("\n--- 7. the call's result says what the user was asked and answered ---");
  {
    const t = setup("g1-01", "clean");
    await t.start();
    const [q] = await t.waiting();
    const state = await t.resume({ typed: "yes" });
    const c = String(t.toolResult(state)?.content);
    check("typed: the question and the answer, before the result",
      [c.includes(`The system asked the user:\n${q?.message}`), c.includes("The user answered: yes\n"),
       c.indexOf("The user answered") < c.indexOf("Note: the system ran this call")], [true, true, true]);
    const f = setup("g1-01", "clean");
    await f.start();
    const fc = String(f.toolResult(await f.resume({ "value:time": true }))?.content);
    check("  in the form: each field as answered", fc.includes("The user answered: [answered in the form] value:time: yes"), true);
    // "no" each time, until the asks run out: every question and answer, in order.
    const n = setup("g1-01", "clean");
    let ns = await n.start(), asks = 0;
    while ((await n.waiting()).length && asks < 6) { ns = await n.resume({ "value:time": false }); asks++; }
    const nc = String(n.toolResult(ns)?.content);
    check("  not run: each question and answer, before what the user was told",
      [n.calls.length, nc.split(ASKED_LINE).length - 1, nc.split("The user answered: [answered in the form] value:time: no").length - 1,
       nc.lastIndexOf("The user answered") < nc.indexOf("Not run.")], [0, asks, asks, true]);
    const d = setup("g1-01", "clean");
    await d.start();
    const [dq] = await d.waiting();
    const dc = String(d.toolResult(await d.resume({ action: "decline" }))?.content);
    check("  not answered: the open question is shown once", dc.split(dq?.message).length - 1, 1);
    const a = setup("g1-01", "clean", { text: ALL_GIVEN, ask: askAllGiven("g1-01") });
    const ac = String(a.toolResult(await a.start())?.content);
    check("  nothing asked: nothing added", ac.includes("The system asked the user"), false);
    // The gate reads the call's questions and answers from the middleware's state, not again from the result.
    //   (The stand-in model's last turn repeats every message it was given: it is left out.)
    const upTo = state.messages.findIndex(m => m.getType() === "tool") + 1;
    const later = segmentsFor(state.messages.slice(0, upTo), state.preflightCalls ?? {}, m => [{ trust: "user", text: String(m.content) }]);
    check("  the gate reads the answer once", later.filter(s => /\byes\b/.test(s.text ?? "")).length, 1);
  }

  // Calls the model makes in one message run side by side: two calls, two gates (spec 1.1). Each writes
  //   the middleware's state in the same step; before 1.44 LangGraph refused that step after both tools
  //   had run, and neither result reached the conversation.
  console.log("\n--- 8. two calls in one message: each judged, each run from its own verdict ---");
  {
    const two = [[{ name: TOOL.name, args: { item_id: "LST-2291" }, id: "call_1" }, { name: TOOL.name, args: { item_id: "LST-2291" }, id: "call_2" }], []];
    const t = setup("g1-01", "clean", { text: ALL_GIVEN, ask: askAllGiven("g1-01"), toolCalls: two });
    let threw = null, state = null;
    try { state = await t.start(); } catch (e) { threw = e.message.split("\n")[0]; }
    const results = (state?.messages ?? []).filter(m => m.getType?.() === "tool").map(m => m.tool_call_id);
    check("the step is not refused, and both results reach the conversation", [threw, results], [null, ["call_1", "call_2"]]);
    const recs = await t.store.list(t.key);
    check("  one verdict and one result for each call, by its id",
      ["call_1", "call_2"].map(id => recs.filter(r => r.tool_call?.id === id).map(r => r.execution_decision)), [["execute", "executed"], ["execute", "executed"]]);
    check("  the middleware's state keeps both calls", Object.keys(state?.preflightCalls ?? {}).sort(), ["call_1", "call_2"]);

    // Another call's verdict, written under the same key after this one's: not this call's to run on.
    const o = setup("g1-01", "clean", { text: ALL_GIVEN, ask: askAllGiven("g1-01") });
    const persist = o.store.persist;
    o.store.persist = async (key, record) => {
      await persist(key, record);
      if (record?.actor !== "executor" && record?.tool_call?.id === "call_1") {
        await persist(key, { ...record, tool_call: { ...record.tool_call, id: "call_other" }, call_arguments: { ...record.call_arguments, time: "2026-11-01T09:00:00+09:00" } });
      }
      return record;
    };
    await o.start();
    check("  a later verdict for another call is not read: it runs on its own", [o.calls.length, o.calls[0]?.time], [1, SAT_2PM]);
  }

  console.log("\n--- [ANSWER SHAPES] ---");
  shapes.report(check);

  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("THREW:", e); process.exit(1); });
