"use strict";

/**
 * A demonstration: a whole agent to run and watch. LangChain's createAgent, with your model and your
 * tools (connect.js, tool.md), the gate as its middleware (middleware.js), and your principles
 * (principles-gated.md) as its system prompt. You should not need to edit this file.
 *
 * This departs from spec 3.5, as the flow before it did. The gate ends with the record and the executing
 * code reads it, but both run inside the agent's graph: the specification has the executing party outside
 * the gate. To use the gate in your own loop, start from judge-only-example.js instead.
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

// Your declared tools as LangChain tools: the model sees them without the provider's labelled lines
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

  async function report(a, config, before) {
    const snapshot = await a.graph.getState(config);
    const waiting = snapshot.tasks.flatMap(t => t.interrupts ?? [])[0]?.value;
    const state = snapshot.values ?? {};
    if (waiting) {
      // What the gate decided, read from its record, as the app may read it.
      const rec = waiting.record_key ? (await connect.store.list(waiting.record_key)).filter(x => x && "execution_decision" in x).at(-1) : null;
      return { status: "waiting", verdict: { decision: rec?.execution_decision ?? null, reason: rec?.reason ?? null }, question: { text: waiting.text, block: waiting.block, message: waiting.message,
                                              questions: waiting.questions, ...(waiting.options ? { options: waiting.options } : {}) },
               disclosures: waiting.notices ?? [], reply: null, executedWith: null, stop: null };
    }
    const last = state.preflightLast;
    if (!last || last.n === before) {
      // The model answered in words without calling a tool the gate judges.
      const ai = [...(state.messages ?? [])].reverse().find(m => m.getType?.() === "ai");
      const reply = typeof ai?.content === "string" ? ai.content : (ai?.content ?? []).map(c => c?.text ?? "").join("");
      return { status: "replied", reply, disclosures: [], executedWith: null, stop: null };
    }
    const status = last.status === "not_executed"
      ? (last.decision && !["execute", "ask_user"].includes(last.decision) ? last.decision : "not_executed") : last.status;
    return { status, reply: null, executedWith: last.executedWith ?? null, disclosures: (last.told ?? []).map(d => d.description),
             serverRequests: last.serverRequests ?? null, callError: last.callError ?? null, stop: last.stop ?? null,
             verdict: { decision: last.decision ?? null, reason: last.reason ?? null } };
  }
  const nOf = async (a, config) => (await a.graph.getState(config)).values?.preflightLast?.n;
  const isWaiting = async (a, config) => (await a.graph.getState(config)).tasks.some(t => (t.interrupts ?? []).length > 0);

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
    if (!(await isWaiting(a, config))) {
      if (answers !== undefined) return report(a, config, before);
      await a.invoke({ messages: [humanMessage(connect.labelInput(message))] }, config);
    } else {
      await a.invoke(new Command({ resume: answers !== undefined ? answers : { typed: message?.typed ?? "" } }), config);
    }
    return report(a, config, before);
  }

  // The user stops: nothing runs.
  async function cancel({ threadId }) {
    const a = await agent(), config = configOf(threadId);
    const before = await nOf(a, config);
    if (await isWaiting(a, config)) await a.invoke(new Command({ resume: { action: "cancel" } }), config);
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
    if (r.stop?.message) console.log(`\n${r.stop.message}`);
    console.log(`\n${r.status}`, r.executedWith ? JSON.stringify(r.executedWith) : (r.verdict?.reason ?? ""));
  })().catch(e => { console.error(e.message); process.exit(1); });
}
