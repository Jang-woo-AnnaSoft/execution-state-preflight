"use strict";

/**
 * An example of YOUR agent's side. Copy what it does into your own loop:
 * this file is to be read and adapted, unlike judge-only.js, which you leave as it is.
 *
 * Your agent keeps its loop and executes the tool itself. judge-only.js judges and writes the record, and
 * nothing else. Eight things are yours to keep, and nothing checks them for you:
 *
 *   1. Label who wrote each part of a message when it arrives, before the model sees it (labelInput).
 *      Only what the user typed is the user's.
 *   2. Show the values under a question exactly as judge.run returned them (r.block). A yes approves
 *      those lines, so the model must not rewrite them.
 *   3. Add the user's reply to the conversation as the user's words, and judge again under the same
 *      unitKey.
 *   4. Execute from the record, never from what judge.run returned or from the model's own arguments.
 *      Read the record from storage, decide for yourself (readyToExecute), and send its call_arguments.
 *   5. Keep the record where the agent cannot rewrite it, and write your own decision back as a record
 *      of its own (judge.recordResult): executed, failed, or read and not run.
 *   6. Tell your model how its calls are judged, and what happened to each: principles-gated.md as its
 *      system prompt, and the gate's answer as its call's result (messagesFor, afterCall). Where you
 *      hand it the tool list, you may also take the labelled lines out (judge.toolsForModel, hideLines).
 *   7. Show the provider's notices to the user before the tool runs (spec 3.3). They go with every
 *      question; when nothing was asked, show them before the call (judge.notices, connect.notify).
 *   8. When the user answers a question, put the call that waits on it to the gate again, whether or not
 *      the model calls (waitingCall). Show the gate's verdict, not the model's words.
 *
 *   const { createMain } = require("./judge-only-example");
 *   const main = createMain();
 *   let r = await main.turn({ threadId, message: { typed: "Set up the pickup for LST-2291 …" } });
 *   // r.status "waiting": show r.question.message, then pass the user's answer as the next turn
 *   r = await main.turn({ threadId, message: { typed: "yes" } });
 *   // r.status "executed", or "replied", "not_executed" (r.message tells the user why), "call_failed", "tool_error"
 *   // r.resubmitted: the model did not call again after the answer, and the waiting call was judged again
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
//   whyNotReady says which of these failed, for the executing side's own record; null when ready.
function whyNotReady(record, toolName) {
  if (!record || typeof record !== "object") return "no record was read";
  if (record.actor === "executor" || ["executed", "failed", "not_executed"].includes(record.execution_decision)) return "the record is a result, not a verdict";
  if (record.phase !== "at_trigger") return "the verdict is not one made for this moment";
  if (!record.gate) return "the record carries no verdict";
  if (record.gate.kind) return `the verdict is ${record.gate.kind}`;
  if (record.unknown_count !== 0) return "a value is not confirmed";
  if (record.unverified_checklist_count !== 0 || record.unverified_provider_count !== 0 ||
      record.unverified_value_check_count !== 0) return "a condition or a check is not confirmed";
  if (!record.tool_call || record.tool_call.name !== toolName) return "the verdict is for another tool";
  const args = record.call_arguments;
  return Boolean(args) && typeof args === "object" && !Array.isArray(args) ? null : "the record carries no arguments";
}
const readyToExecute = (record, toolName) => whyNotReady(record, toolName) === null;

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
    // The user's settings for a tool, from your store, if connect.js has one (spec 5.2). How they come to
    //   be stored, and the user's consent, is yours.
    readPreSet: connect.readPreSet,
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
    let toolCall, resubmitted = false;
    if (!out?.toolCall || typeof out.toolCall.name !== "string") {
      // 8. A call the gate is waiting on, and the user has answered: it goes to the gate again, whether
      //   or not the model calls. A real model (Opus 5.5) took the user's yes as the end of it, did not
      //   call, and told the user the pickup had been sent; nothing had run. Only the gate's verdict says
      //   what happens next, so the model's words are not shown: the user sees what the gate decides
      //   (it runs, it asks, or it tells why not). A user who asked something else in between gets the
      //   gate's question again, not the model's answer: that is the cost of not showing words that
      //   may say something ran. Change it here if your app shows both.
      const pending = waitingCall(conversation);
      if (!pending) {
        const text = typeof out?.text === "string" ? out.text : "";
        if (text) conversation.push({ trust: "assistant", text });
        return { status: "replied", reply: text };
      }
      toolCall = pending;
      resubmitted = true;
    } else {
      toolCall = { name: out.toolCall.name, arguments: out.toolCall.arguments ?? null, id: out.toolCall.id ?? null };
    }

    const r = await judge.run({ unitKey: threadId, conversation, toolCall, userChecklist });   // 3
    if (r.questions.length > 0) {
      const question = await askUser(conversation, r);                                         // 2
      conversation.push(afterCall(toolCall, "waiting", question.message, r.settled));
      return { status: "waiting", question, notices: r.notices, ...(resubmitted ? { resubmitted } : {}) };
    }
    // The gate could not tell what is wanted, or which tool it maps to. Its own words are shown as they
    //   are; the user says it again, and the next turn judges again.
    if (r.ask && r.message) {
      conversation.push(afterCall(toolCall, "waiting", r.message));
      return { status: "waiting", question: { text: r.message, block: [], message: r.message, options: r.options }, notices: r.notices,
               ...(resubmitted ? { resubmitted } : {}) };
    }

    // 4. Nothing to ask. Read the record this round wrote, and decide from it.
    const record = r.key ? (await connect.store.list(r.key)).filter(x => x && "execution_decision" in x).at(-1) : null;
    // Not ready: the user is told why, from the record this round wrote (writeStop). The words go into the
    //   conversation as the call's result, so the next turn starts from what the user was told.
    //   The decision is the executing side's own, so it is recorded as its own (spec 6.4), executed or not.
    const notRun = async (why, extra = {}) => {
      const stop = r.message ? { message: r.message, facts: null }
        : await writeStop({ ask: connect.ask, say: connect.say, model }, { record, conversation });
      if (record?.action_key) await judge.recordResult(record, { executed: false, why, ...extra });      // 5
      conversation.push(afterCall(toolCall, "not_executed", stop.message));
      return { status: "not_executed", reason: record?.reason ?? r.reason, message: stop.message, stop: stop.facts, notices: r.notices,
               ...(resubmitted ? { resubmitted } : {}) };
    };
    const why = whyNotReady(record, toolCall.name);
    if (why !== null) return notRun(why);
    // 7. The provider's notices are told to the user before the tool runs (spec 3.3). One that went with
    //   a question of this unit has been shown; the rest are shown now (connect.notify), and then the
    //   tool runs: a notice is told, not acknowledged. With no way to show one, the tool does not run.
    const notice = await judge.notices(record);
    const told = notice.shown.map(d => ({ id: d.id, description: d.description, when: "with_question" }));
    if (notice.toShow.length > 0) {
      if (typeof connect.notify !== "function") return notRun("a notice could not be shown to the user before the call: connect.notify is not connected", { told });
      await connect.notify(notice.toShow.map(d => d.description));
      told.push(...notice.toShow.map(d => ({ id: d.id, description: d.description, when: "before_call" })));
    }
    const name = record.tool_call.name, args = record.call_arguments;
    let result;
    // A call that fails is reported, not retried: whether the tool did anything is for you to find out
    //   from the tool's side.
    try { result = await connect.callTool(name, args); }
    catch (e) {
      const error = String(e?.message ?? e);
      await judge.recordResult(record, { ok: false, error, told });                            // 5
      conversation.push(afterCall(toolCall, "failed", error));
      return { status: "call_failed", callError: error };
    }
    if (result && typeof result === "object" && (result.isError === true || result.inputRequired)) {
      const error = result.inputRequired ? "the tool asked for more input instead of completing"
        : ((result.content ?? []).map(c => c?.text ?? "").join(" ").trim() || "the tool reported an error");
      await judge.recordResult(record, { ok: false, error, told });
      conversation.push(afterCall(toolCall, "failed", error));
      return { status: "tool_error", callError: error };
    }
    await judge.recordResult(record, { ok: true, told });                                      // 5
    conversation.push(afterCall(toolCall, "executed"));
    return { status: "executed", executedWith: args, notices: r.notices, told, ...(resubmitted ? { resubmitted } : {}) };
  }

  return { turn };
}

// The call the gate is waiting on (8): the latest call's result is "waiting", and only the user has
//   written since. Its name, arguments and id are the model's call as it was made; nothing is added.
function waitingCall(conversation) {
  for (let i = (conversation ?? []).length - 1; i >= 0; i--) {
    const s = conversation[i];
    if (s?.after_call) {
      const c = s.after_call;
      return c.status === "waiting" && typeof c.name === "string" && i < conversation.length - 1
        ? { name: c.name, arguments: c.arguments ?? null, id: c.id ?? null } : null;
    }
    if (s?.trust === "assistant") return null;
  }
  return null;
}

module.exports = { createMain, readyToExecute, whyNotReady, systemPrompt };

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
    // A run that executed has shown its notices already, with a question or before the call (connect.notify).
    if (r.status !== "executed") for (const n of r.notices ?? []) console.log(`Note: ${n}`);
    console.log(`\n${r.status}`, r.executedWith ? JSON.stringify(r.executedWith) : (r.reason ?? r.callError ?? ""));
  })().catch(e => { console.error(e.message); process.exit(1); });
}
