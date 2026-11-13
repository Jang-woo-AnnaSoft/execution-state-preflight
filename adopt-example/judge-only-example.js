"use strict";

/**
 * An example of YOUR agent's side. Copy what it does into your own loop:
 * this file is to be read and adapted, unlike judge-only.js, which you leave as it is.
 *
 * Your agent keeps its loop and executes the tool itself. judge-only.js judges and writes the record, and
 * nothing else. Six things are yours to keep, and nothing checks them for you:
 *
 *   1. Label who wrote each part of a message when it arrives, before the model sees it (labelInput).
 *      Only what the user typed is the user's.
 *   2. Show the values under a question exactly as judge.run returned them (r.block). A yes approves
 *      those lines, so the model must not rewrite them.
 *   3. Add the user's reply to the conversation as the user's words, and judge again under the same
 *      unitKey.
 *   4. Execute from the record, never from what judge.run returned or from the model's own arguments.
 *      Read the record from storage, decide for yourself (readyToExecute), and send its call_arguments.
 *   5. Keep the record where the agent cannot rewrite it, and write what happened back onto it
 *      (judge.recordResult).
 *   6. Tell your model how its calls are judged, and what happened to each: principles-gated.md as its
 *      system prompt, and the gate's answer as its call's result (messagesFor, afterCall). Where you
 *      hand it the tool list, you may also take the labelled lines out (judge.toolsForModel, hideLines).
 *
 *   const { createMain } = require("./judge-only-example");
 *   const main = createMain();
 *   let r = await main.turn({ threadId, message: { typed: "Set up the pickup for LST-2291 …" } });
 *   // r.status "waiting": show r.question.message, then pass the user's answer as the next turn
 *   r = await main.turn({ threadId, message: { typed: "yes" } });
 *   // r.status "executed", or "replied", "not_executed" (r.message tells the user why), "call_failed", "tool_error"
 *
 * Or from a terminal: node judge-only-example.js "Set up the pickup for LST-2291, 2pm this Saturday,
 * Hongdae station lockers."
 */

const fs = require("fs");
const path = require("path");
const { createJudge, writeQuestion, writeStop, messagesFor, afterCall } = require("./judge-only");
const defaultConnect = require("./connect");

function systemPrompt(file = "principles-gated.md") {
  // principles-gated.md, by default: what a model needs to know when a gate judges its calls (spec 6.2,
  //   last paragraph). principles.md: the specification's 6.2 itself, for a model with no gate. A line's
  //   "(spec …)" is for whoever reads the file, not sent to the model.
  const principles = fs.readFileSync(path.join(__dirname, file), "utf8")
    .split("\n").filter(l => l.startsWith("- ")).map(l => l.replace(/\s*\(spec [^)]*\)\s*$/, "")).join("\n");
  return "You are an assistant. You have tools; use them to carry out what the user asks.\n\n" + principles;
}

// The executing side's own decision, read from the record (spec 3.5). It does not follow the gate's
//   execution_decision: it reads what was counted. A record is ready when
//     it is a verdict made for this moment, not a result already written and not a deferred one
//     nothing is unconfirmed: no slot, no item of the user's, no line of the provider's, no value check
//     nothing confirmed prohibits it, and no route is still open (gate.kind is set for each of those)
//     it is for the tool about to be called, and it carries the arguments to send
//   call_arguments alone is not a sign of readiness: a record that still asks carries the values known
//   so far.
function readyToExecute(record, toolName) {
  if (!record || typeof record !== "object") return false;
  if (record.execution_decision === "executed" || record.execution_decision === "failed") return false;
  if (record.phase !== "at_trigger") return false;
  if (record.unknown_count !== 0) return false;
  if (record.unverified_checklist_count !== 0 || record.unverified_provider_count !== 0 ||
      record.unverified_value_check_count !== 0) return false;
  if (!record.gate || record.gate.kind) return false;
  if (!record.tool_call || record.tool_call.name !== toolName) return false;
  const args = record.call_arguments;
  return Boolean(args) && typeof args === "object" && !Array.isArray(args);
}

// How the conversation is shown to your model is messagesFor (judge-only.js): what the gate said after a
//   call goes back as that call's result.

// hideLines: give your model the tools without the provider's labelled lines (toolsForModel). Yours to
//   choose only where you hand the model its tool list; a host that lists a server's tools itself shows
//   the whole description. Either way the gate reads the full definition.
function createMain({ connect = defaultConnect, userId = "user", system = systemPrompt(), hideLines = true } = {}) {
  const model = connect.MODEL_NAME ?? "model";
  const judge = createJudge({
    ask: connect.ask, measure: connect.measure, readToolDefinition: connect.readToolDefinition,
    measurements: Object.keys(connect.MEASUREMENTS ?? {}), storage: connect.store, userId, model,
  });
  // Your agent's own state: each conversation, in order, with who wrote each part.
  const conversations = new Map();

  // Your model writes the words of the question (writeQuestion). The values are not its to write: they
  //   go under its words as code wrote them.
  async function askUser(conversation, r) {
    const words = (await writeQuestion({ ask: connect.ask, say: connect.say, model }, { questions: r.questions, conversation }))
      ?? "Before this can run, please answer:";
    return { text: words, block: r.block, message: [words, ...r.block.map(l => `- ${l}`)].join("\n") };
  }

  // One message from the user: the first of a conversation, or the answer to a question. The same
  //   threadId for every turn of one conversation.
  async function turn({ threadId, message, userChecklist = [] }) {
    const conversation = conversations.get(threadId) ?? [];
    conversations.set(threadId, conversation);
    conversation.push(...connect.labelInput(message));                                      // 1

    const listed = await connect.listTools();
    const tools = hideLines ? judge.toolsForModel(listed) : listed;                           // 6
    const out = await connect.chat({ system, messages: messagesFor(conversation), tools });
    if (!out?.toolCall || typeof out.toolCall.name !== "string") {
      const text = typeof out?.text === "string" ? out.text : "";
      if (text) conversation.push({ trust: "assistant", text });
      return { status: "replied", reply: text };
    }
    const toolCall = { name: out.toolCall.name, arguments: out.toolCall.arguments ?? null, id: out.toolCall.id ?? null };

    const r = await judge.run({ unitKey: threadId, conversation, toolCall, userChecklist });   // 3
    if (r.questions.length > 0) {
      const question = await askUser(conversation, r);                                         // 2
      conversation.push(afterCall(toolCall, "waiting", question.message));
      return { status: "waiting", question, notices: r.notices };
    }
    // The gate could not tell what is wanted, or which tool it maps to. Its own words are shown as they
    //   are; the user says it again, and the next turn judges again.
    if (r.ask && r.message) {
      conversation.push(afterCall(toolCall, "waiting", r.message));
      return { status: "waiting", question: { text: r.message, block: [], message: r.message, options: r.options }, notices: r.notices };
    }

    // 4. Nothing to ask. Read the record this round wrote, and decide from it.
    const record = r.key ? (await connect.store.list(r.key)).filter(x => x && "execution_decision" in x).at(-1) : null;
    // Not ready: the user is told why, from the record this round wrote (writeStop). The words go into the
    //   conversation as the call's result, so the next turn starts from what the user was told.
    if (!readyToExecute(record, toolCall.name)) {
      const stop = r.message ? { message: r.message, facts: null }
        : await writeStop({ ask: connect.ask, say: connect.say, model }, { record, conversation });
      conversation.push(afterCall(toolCall, "not_executed", stop.message));
      return { status: "not_executed", reason: record?.reason ?? r.reason, message: stop.message, stop: stop.facts, notices: r.notices };
    }
    const name = record.tool_call.name, args = record.call_arguments;
    let result;
    // A call that fails is reported, not retried: whether the tool did anything is for you to find out
    //   from the tool's side.
    try { result = await connect.callTool(name, args); }
    catch (e) {
      const error = String(e?.message ?? e);
      await judge.recordResult(record, { ok: false, error });                                  // 5
      conversation.push(afterCall(toolCall, "failed", error));
      return { status: "call_failed", callError: error };
    }
    if (result && typeof result === "object" && (result.isError === true || result.inputRequired)) {
      const error = result.inputRequired ? "the tool asked for more input instead of completing"
        : ((result.content ?? []).map(c => c?.text ?? "").join(" ").trim() || "the tool reported an error");
      await judge.recordResult(record, { ok: false, error });
      conversation.push(afterCall(toolCall, "failed", error));
      return { status: "tool_error", callError: error };
    }
    await judge.recordResult(record, { ok: true });                                            // 5
    conversation.push(afterCall(toolCall, "executed"));
    return { status: "executed", executedWith: args, notices: r.notices };
  }

  return { turn };
}

module.exports = { createMain, readyToExecute, systemPrompt };

if (require.main === module) {
  const readline = require("readline");
  (async () => {
    const typed = process.argv.slice(2).join(" ");
    if (!typed) { console.error('usage: node judge-only-example.js "<what the user typed>"'); process.exit(2); }
    const main = createMain();
    const threadId = `cli-${Date.now()}`;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let r = await main.turn({ threadId, message: { typed } });
    while (r.status === "waiting") {
      console.log("\n" + r.question.message);
      const line = await new Promise(res => rl.question("\n> ", res));
      r = await main.turn({ threadId, message: { typed: line } });
    }
    rl.close();
    if (r.reply) console.log(`\n${r.reply}`);
    if (r.message) console.log(`\n${r.message}`);
    for (const n of r.notices ?? []) console.log(`Note: ${n}`);
    console.log(`\n${r.status}`, r.executedWith ? JSON.stringify(r.executedWith) : (r.reason ?? r.callError ?? ""));
  })().catch(e => { console.error(e.message); process.exit(1); });
}
