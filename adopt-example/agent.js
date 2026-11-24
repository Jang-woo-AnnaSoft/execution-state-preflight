"use strict";

/**
 * A demonstration: a whole agent to run and watch. LangChain's createAgent, with your model and your
 * tools (connect.js, tool.json), the gate as its middleware (middleware.js), and your principles
 * (principles-gated.md) as its system prompt. You should not need to edit this file.
 *
 * The gate and the executing side are apart, as spec 3.5 has them: the gate (judge-only.js) ends with the
 * record, and the middleware's own code reads the record and decides from it alone, never from what
 * judging returned. That code runs in the agent's graph, where an executing party usually is. Other code
 * there (another middleware, the tool node) could still call a tool without reading the record; nothing
 * but review keeps it from doing so (spec 8.6), here as in any loop. To use the gate in your own loop,
 * start from judge-only-example.js instead.
 *
 *   const { createAgent } = require("./agent");
 *   const agent = createAgent();
 *   let r = await agent.start({ threadId, message: { typed: "Set up the pickup for LST-2291 …" } });
 *   // r.status "waiting": show r.question.message to the user — the model's words, then the values as
 *   //   code wrote them. The user answers in words, or in a form (answerSchema(r.question.questions)):
 *   r = await agent.reply({ threadId, message: { typed: "yes" } });   // or reply({ threadId, answers })
 *   // r.status "executed", or why not: "replied" (the model answered without calling a tool), "hold",
 *   //   "definition_repair", "exhausted", "not_executed", "cancelled", "input_required" (the server asked
 *   //   for more input; nothing was executed), "call_failed" (the call threw) or "tool_error" (the tool
 *   //   reported a failure). When nothing was executed because of the gate, r.stop.message says why, in
 *   //   words for the user.
 *   // Calls the model makes in one message are judged each on its own (spec 1.1). r.waiting has every
 *   //   call that waits, each with its question, and r.question.message shows them all; words typed answer
 *   //   them all, and a form's answers go by call: reply({ threadId, answers: { [tool_call_id]: fields } }).
 *   //   r.results has how each call of the model's last message ended; with several, r.status is "several".
 *
 * Or from a terminal: node agent.js "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae
 * station lockers." It prints each question and reads your answer as one line.
 */

const fs = require("fs");
const path = require("path");
const { createAgent: createLangChainAgent, tool } = require("langchain");
const { Command } = require("@langchain/langgraph");
const { preflightMiddleware, humanMessage } = require("./middleware");
const { toolsForModel } = require("./judge-only");
const defaultConnect = require("./connect");

// The agent's system prompt: an assistant that uses its tools, and the specification's principles.
function systemPrompt(file = "principles-gated.md") {
  // principles-gated.md, by default: what a model needs to know when a gate judges its calls (spec 6.2,
  //   last paragraph). principles.md: the specification's 6.2 itself, for a model with no gate. A line's
  //   "(spec …)" is for whoever reads the file, not sent to the model.
  const principles = fs.readFileSync(path.join(__dirname, file), "utf8")
    .split("\n").filter(l => l.startsWith("- ")).map(l => l.replace(/\s*\(spec [^)]*\)\s*$/, "")).join("\n");
  return "You are an assistant. You have tools; use them to carry out what the user asks.\n\n" + principles;
}

// Your declared tools (MCP tool definitions) as LangChain tools, one line each: tool(fn, { name,
//   description, schema: inputSchema }). The model sees them without the provider's labelled lines
//   (toolsForModel); the gate reads the full definition itself. Each calls connect.callTool with the
//   arguments the middleware hands it, which are the record's. A server's request for more input, or a
//   tool's reported failure, is not a result: nothing ran as asked.
async function langChainTools(connect) {
  const listed = await connect.listTools();
  return toolsForModel(listed).map(t => tool(async args => {
    const result = await connect.callTool(t.name, args);
    if (result && typeof result === "object" && result.inputRequired) {
      throw Object.assign(new Error("the tool asked for more input instead of completing"), { kind: "input_required", serverRequests: result.inputRequired });
    }
    if (result && typeof result === "object" && result.isError === true) {
      throw Object.assign(new Error((result.content ?? []).map(c => c?.text ?? "").join(" ").trim() || "the tool reported an error"), { kind: "tool_error" });
    }
    const text = Array.isArray(result?.content) ? result.content.map(c => c?.text ?? "").join("\n").trim() : "";
    return text || JSON.stringify(result ?? null);
  }, { name: t.name, description: t.description ?? "", schema: t.inputSchema ?? { type: "object", properties: {} } }));
}

/**
 * @param userChecklist  (on start) the user's standing settings, already confirmed by the user: items
 *                       with a JSON Schema the slot's value must satisfy (spec 3.3, 4.4). See README.
 * @param callbacks      LangChain callbacks for every run, to watch the model's turns (optional)
 */
function createAgent({ connect = defaultConnect, userId = "user", system = systemPrompt(), callbacks } = {}) {
  let built = null;
  const agent = () => (built ??= (async () => createLangChainAgent({
    model: await connect.chatModel(), tools: await langChainTools(connect), systemPrompt: system,
    checkpointer: connect.checkpointer, middleware: [preflightMiddleware({ connect, userId })],
  }))());
  const checklists = new Map();
  const configOf = threadId => ({ configurable: { thread_id: threadId }, context: { userChecklist: checklists.get(threadId) ?? [] },
                                  ...(callbacks ? { callbacks } : {}) });

  // The calls waiting on the user: one interrupt each, with its own question (middleware.js).
  const interruptsOf = async (a, config) => (await a.graph.getState(config)).tasks.flatMap(t => t.interrupts ?? []).filter(x => x?.value);
  // How one call ended, as the middleware kept it (preflightResults, preflightLast).
  const resultOf = last => ({
    tool_call_id: last.tool_call_id ?? null, name: last.name ?? null,
    status: last.status === "not_executed"
      ? (last.decision && !["execute", "ask_user"].includes(last.decision) ? last.decision : "not_executed") : last.status,
    executedWith: last.executedWith ?? null, disclosures: (last.told ?? []).map(d => d.description),
    serverRequests: last.serverRequests ?? null, callError: last.callError ?? null, stop: last.stop ?? null,
    why: last.why ?? null, verdict: { decision: last.decision ?? null, reason: last.reason ?? null },
  });

  async function report(a, config, before) {
    const snapshot = await a.graph.getState(config);
    const interrupts = snapshot.tasks.flatMap(t => t.interrupts ?? []).filter(x => x?.value);
    const state = snapshot.values ?? {};
    if (interrupts.length > 0) {
      // What the gate decided for each, read from its record for that call, as the app may read it.
      const waiting = [];
      for (const { value: w } of interrupts) {
        const rec = w.record_key ? (await connect.store.list(w.record_key))
          .filter(x => x && "execution_decision" in x && x.tool_call?.id === w.tool_call_id).at(-1) ?? null : null;
        waiting.push({ tool_call_id: w.tool_call_id, name: w.name, verdict: { decision: rec?.execution_decision ?? null, reason: rec?.reason ?? null },
                       question: { text: w.text, block: w.block, message: w.message, questions: w.questions, ...(w.options ? { options: w.options } : {}) },
                       disclosures: w.notices ?? [] });
      }
      // Every question is shown: an answer counts only for a question the user was shown (spec 6.3).
      const one = waiting.length === 1 ? waiting[0] : null;
      return { status: "waiting", verdict: one ? one.verdict : null,
               question: one ? one.question : { message: waiting.map(w => w.question.message).join("\n\n"), calls: waiting.map(w => w.tool_call_id) },
               waiting, disclosures: one ? one.disclosures : [...new Set(waiting.flatMap(w => w.disclosures))],
               reply: null, executedWith: null, stop: null };
    }
    const last = state.preflightLast;
    if (!last || last.n === before) {
      // The model answered in words without calling a tool the gate judges.
      const ai = [...(state.messages ?? [])].reverse().find(m => m.getType?.() === "ai");
      const reply = typeof ai?.content === "string" ? ai.content : (ai?.content ?? []).map(c => c?.text ?? "").join("");
      return { status: "replied", reply, disclosures: [], executedWith: null, stop: null, results: [] };
    }
    // Each call of the model's last message with tool calls that the gate judged, in order.
    const calling = [...(state.messages ?? [])].reverse().find(m => m.getType?.() === "ai" && (m.tool_calls ?? []).length > 0);
    const results = (calling?.tool_calls ?? []).map(c => state.preflightResults?.[c.id]).filter(Boolean).map(resultOf);
    if (results.length > 1) {
      return { status: "several", results, reply: null, executedWith: null, disclosures: results.flatMap(r => r.disclosures), stop: null, verdict: null };
    }
    return { ...resultOf(last), reply: null, results };
  }
  const nOf = async (a, config) => (await a.graph.getState(config)).values?.preflightLast?.n;
  const isWaiting = async (a, config) => (await interruptsOf(a, config)).length > 0;

  // The answer for each waiting call, by its interrupt. Words typed go to every call that waits: the gate
  //   reads, question by question, what they answer (all were shown). A form's answers go by call: with one
  //   call waiting, its fields as they are; with several, { [tool_call_id]: fields }. A call given no
  //   answer ends as declined: nothing runs, and its question stays open.
  function resumeFor(interrupts, { message, answers }) {
    const ids = interrupts.map(x => x.value.tool_call_id);
    const keyed = answers !== null && typeof answers === "object" && !Array.isArray(answers)
      && Object.keys(answers).length > 0 && Object.keys(answers).every(k => ids.includes(k));
    if (answers !== undefined && !keyed && interrupts.length > 1) {
      throw new Error("several calls are waiting: give the answers by tool call id, { [tool_call_id]: answers }");
    }
    return Object.fromEntries(interrupts.map(x => [x.id, answers === undefined ? { typed: message?.typed ?? "" }
      : keyed ? (answers[x.value.tool_call_id] ?? { action: "decline" }) : answers]));
  }

  // A new message in a conversation. The same threadId for every turn of one conversation: the gate
  //   reads what it asked in it, and a reply counts only for a question asked there. A message while a
  //   question waits is the answer to it.
  async function start({ threadId, message, userChecklist = [] }) {
    checklists.set(threadId, userChecklist);
    const a = await agent(), config = configOf(threadId);
    if (await isWaiting(a, config)) return reply({ threadId, message });
    const before = await nOf(a, config);
    await a.invoke({ messages: [humanMessage(connect.labelInput(message))] }, config);
    return report(a, config, before);
  }

  // The user's answer: in their own words (message), or from the form (answers). When nothing waits,
  //   it is a new message.
  async function reply({ threadId, message, answers }) {
    const a = await agent(), config = configOf(threadId);
    const before = await nOf(a, config);
    const interrupts = await interruptsOf(a, config);
    if (interrupts.length === 0) {
      if (answers !== undefined) return report(a, config, before);
      await a.invoke({ messages: [humanMessage(connect.labelInput(message))] }, config);
    } else {
      await a.invoke(new Command({ resume: resumeFor(interrupts, { message, answers }) }), config);
    }
    return report(a, config, before);
  }

  // The user stops: nothing runs.
  async function cancel({ threadId }) {
    const a = await agent(), config = configOf(threadId);
    const before = await nOf(a, config);
    const interrupts = await interruptsOf(a, config);
    if (interrupts.length > 0) await a.invoke(new Command({ resume: Object.fromEntries(interrupts.map(x => [x.id, { action: "cancel" }])) }), config);
    return report(a, config, before);
  }

  return { start, reply, cancel };
}

module.exports = { createAgent, systemPrompt };

if (require.main === module) {
  const readline = require("readline");
  (async () => {
    const typed = process.argv.slice(2).join(" ");
    if (!typed) { console.error('usage: node agent.js "<what the user typed>"'); process.exit(2); }
    const agent = createAgent();
    const threadId = `cli-${Date.now()}`;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let r = await agent.start({ threadId, message: { typed } });
    while (r.status === "waiting") {
      console.log("\n" + r.question.message);
      const line = await new Promise(res => rl.question("\n> ", res));
      r = await agent.reply({ threadId, message: { typed: line } });
    }
    rl.close();
    if (r.reply) console.log(`\n${r.reply}`);
    for (const x of r.status === "several" ? r.results : [r]) {
      if (x.stop?.message) console.log(`\n${x.stop.message}`);
      console.log(`\n${x.status}`, x.executedWith ? JSON.stringify(x.executedWith) : (x.verdict?.reason ?? ""));
    }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
