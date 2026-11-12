"use strict";

/**
 * A demonstration: a whole agent to run and watch. Your model and your tools (connect.js, tool.md), the
 * gate (judge-only.js) with the flow around it (gate.js), your principles (principles.md) in the system
 * prompt. You should not need to edit this file.
 *
 * This departs from spec 3.5. The one difference left is that the gate and the executing step are in one
 * graph: the step reads the record and decides from it, but the specification has the executing party
 * outside the gate. To use the gate in your own agent, start from judge-only-example.js instead.
 *
 *   const { createAgent } = require("./agent");
 *   const agent = createAgent();
 *   let r = await agent.start({ threadId, message: { typed: "Set up the pickup for LST-2291 …" } });
 *   // r.status "waiting": show r.question.message to the user — the model's words, then the values as
 *   //   code wrote them. The user answers in words:
 *   r = await agent.reply({ threadId, message: { typed: "yes" } });
 *   // r.status "executed", or why not: "replied" (the model answered without calling a tool), "hold",
 *   //   "definition_repair", "exhausted", "cancelled", "input_required" (the server asked for more input;
 *   //   nothing was executed), "call_failed" (the call threw) or "tool_error" (the tool reported a failure).
 *   //   When nothing was executed because of the gate, r.stop.message says why, in words for the user.
 *
 * Or from a terminal: node agent.js "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae
 * station lockers." It prints each question and reads your answer as one line.
 */

const fs = require("fs");
const path = require("path");
const gate = require("./gate");
const defaultConnect = require("./connect");

// The agent's system prompt: an assistant that uses its tools, and the specification's principles.
function systemPrompt() {
  const principles = fs.readFileSync(path.join(__dirname, "principles.md"), "utf8")
    .split("\n").filter(l => l.startsWith("- ")).join("\n");
  return "You are an assistant. You have tools; use them to carry out what the user asks.\n\n" + principles;
}

/**
 * @param userChecklist  (on start) the user's standing settings, already confirmed by the user: items
 *                       with a JSON Schema the slot's value must satisfy (spec 3.3, 4.4). See README.
 */
function createAgent({ connect = defaultConnect, userId = "user", system = systemPrompt() } = {}) {
  const graph = gate.buildGraph({
    ask: connect.ask, say: connect.say, chat: connect.chat, listTools: connect.listTools, readToolDefinition: connect.readToolDefinition,
    measure: connect.measure, callTool: connect.callTool, measurements: Object.keys(connect.MEASUREMENTS ?? {}),
    model: connect.MODEL_NAME ?? "model", system, checkpointer: connect.checkpointer, storage: connect.store, userId,
  });

  async function report(state, config) {
    const waiting = (await graph.getState(config)).tasks.flatMap(t => t.interrupts ?? [])[0];
    return {
      status: waiting ? "waiting" : (state.ended ?? state.verdict?.decision),
      question: waiting ? state.question : null,
      reply: state.reply ?? null,                      // the model's words, when it called no tool
      executedWith: state.executedWith ?? null,
      disclosures: state.verdict?.disclosures ?? [],   // the provider's notices: show them to the user
      serverRequests: state.serverRequests ?? null,    // the server asked for input instead of completing
      callError: state.callError ?? null,              // the call itself failed
      stop: state.stop ?? null,                        // not executed: stop.message is what to show the user
      verdict: state.verdict,
    };
  }

  // A new message in a conversation. The same threadId for every turn of one conversation: the gate
  //   reads what it asked in it, and a reply counts only for a question asked there.
  async function start({ threadId, message, userChecklist = [] }) {
    const config = { configurable: { thread_id: threadId } };
    const state = await graph.invoke({ conversation: connect.labelInput(message), userChecklist }, config);
    return report(state, config);
  }

  // The user's answer to the question the conversation is waiting on, in their own words.
  async function reply({ threadId, message }) {
    const config = { configurable: { thread_id: threadId } };
    const state = await graph.invoke(new gate.Command({ resume: { segments: connect.labelInput(message) } }), config);
    return report(state, config);
  }

  // The user stops: nothing runs.
  async function cancel({ threadId }) {
    const config = { configurable: { thread_id: threadId } };
    const state = await graph.invoke(new gate.Command({ resume: { cancel: true } }), config);
    return report(state, config);
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
    for (const d of r.disclosures) console.log(`Note: ${d}`);
    console.log(`\n${r.status}`, r.executedWith ? JSON.stringify(r.executedWith) : (r.verdict?.reason ?? ""));
  })().catch(e => { console.error(e.message); process.exit(1); });
}
