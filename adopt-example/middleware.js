"use strict";

/**
 * The gate as LangChain middleware: createAgent({ model, tools, checkpointer, middleware: [preflightMiddleware()] }).
 *
 * It has the shape of LangChain's own human-in-the-loop middleware in its per_call mode: each tool call
 * is caught in wrapToolCall, judged by judge-only.js, and paused with interrupt() when the user has to
 * answer. The call waits there for the answer, so the model does not have to call again after it.
 *
 *   ask       interrupt({ type: "preflight_question", message, block, questions, notices, … },
 *                       { responseSchema: answerSchema(questions) }), then judged again with the answer
 *   ready     the tool runs with the record's call_arguments, not the model's arguments (spec 3.5)
 *   not ready the user is told why (writeStop), as the call's result with status "error"
 *
 * Resume with Command({ resume }): the form's answers ({ "value:time": true }), MCP elicitation's
 * { action, content }, or words typed ({ typed: "yes" }). Declined, cancelled or empty: no answer. The
 * call ends without running, and the question stays open: the next call is asked it again.
 *
 * The agent needs a checkpointer: interrupt() does not run without one.
 */

const { createMiddleware, ToolMessage, HumanMessage, AIMessage } = require("langchain");
const { interrupt, Command } = require("@langchain/langgraph");
const { z } = require("zod");
const { createJudge, writeQuestion, writeStop, answerSchema, afterCall } = require("./judge-only");
const { whyNotReady } = require("./judge-only-example");   // the executing side's own reading of the record
const defaultConnect = require("./connect");

const textOf = m => (typeof m?.content === "string" ? m.content
  : Array.isArray(m?.content) ? m.content.map(c => (typeof c === "string" ? c : c?.type === "text" ? c.text : "")).join("") : "");

// Who wrote each part, read from the kind of message (rule 1 of judge-only-example.js): a HumanMessage is
//   the user's, the assistant's words are its own, and another tool's result is not the user's. Words of
//   someone else inside a HumanMessage are yours to label when they come in: labelMessage(message, index)
//   returns the segments for one HumanMessage.
const userSegments = m => [{ trust: "user", text: textOf(m) }];

// The gate's conversation, from the agent's messages and what the gate asked and was answered inside
//   its own calls (state preflightCalls, by tool call id). Those go right after the message that made
//   the call: putting them into messages would come between a call and its result, which models refuse.
function segmentsFor(messages, calls, labelMessage) {
  const out = [];
  (messages ?? []).forEach((m, i) => {
    if (HumanMessage.isInstance(m)) out.push(...labelMessage(m, i));
    else if (AIMessage.isInstance(m)) {
      const t = textOf(m);
      if (t) out.push({ trust: "assistant", text: t });
      for (const tc of m.tool_calls ?? []) if (Array.isArray(calls[tc.id])) out.push(...calls[tc.id]);
    } else if (ToolMessage.isInstance(m)) {
      out.push(m.tool_call_id in calls ? { trust: "assistant", text: textOf(m) } : { trust: "untrusted", text: textOf(m) });
    }
  });
  return out;
}

const NOT_ANSWERED = "Not run, and nothing has been sent: the user did not answer. The question stays open; " +
  "if the user still wants this, call the tool again and the system asks again. The user was shown:";
const NOT_RUN = "Not run. The user was told:";
const RAN_WITH = "Note: the system ran this call with the values the user confirmed, not the arguments in your " +
  "message. Do not issue your original call again. Executed:";

// gated(name): which tools are judged. All of them, unless you say otherwise.
// userChecklist: the user's standing settings, already confirmed by them (spec 4.4).
function preflightMiddleware({ connect = defaultConnect, userId = "user", gated = () => true, userChecklist = [],
                               labelMessage = userSegments } = {}) {
  const model = connect.MODEL_NAME ?? "model";
  const store = connect.store;
  const judge = createJudge({
    ask: connect.ask, measure: connect.measure, readToolDefinition: connect.readToolDefinition,
    measurements: Object.keys(connect.MEASUREMENTS ?? {}), storage: store, userId, model, readPreSet: connect.readPreSet,
  });

  async function askUser(conversation, r) {
    const words = (await writeQuestion({ ask: connect.ask, say: connect.say, model }, { questions: r.questions, conversation }))
      ?? "Before this can run, please answer:";
    return { text: words, block: r.block, message: [words, ...r.block.map(l => `- ${l}`)].join("\n") };
  }

  return createMiddleware({
    name: "PreflightMiddleware",
    stateSchema: z.object({ preflightCalls: z.record(z.string(), z.array(z.any())).default({}) }),
    wrapToolCall: async (request, handler) => {
      const { toolCall } = request;
      if (!gated(toolCall.name)) return handler(request);
      if (toolCall.id == null) throw new Error(`Tool call \`${toolCall.name}\` has no ID, so its result can't be matched to it.`);
      const unitKey = request.runtime?.configurable?.thread_id ?? "thread";
      const calls = request.state?.preflightCalls ?? {};
      const base = segmentsFor(request.state?.messages, calls, labelMessage);
      const call = { name: toolCall.name, arguments: toolCall.args ?? null, id: toolCall.id };
      const mine = [];
      const done = message => new Command({ update: { messages: [message], preflightCalls: { ...calls, [toolCall.id]: mine } } });
      const reply = (content, status) => new ToolMessage({ content, name: toolCall.name, tool_call_id: toolCall.id, status });

      // LangGraph runs this node again from the top when it resumes. Each judging step is kept, in order,
      //   under the call's id, and taken from there on the way back: the gate's model calls are not made
      //   again, and no record is written twice. The answers come back in the same order.
      const stepsKey = `preflight-steps:${unitKey}:${toolCall.id}`;
      const kept = await store.list(stepsKey);
      let r;
      for (let k = 0; ; k++) {
        let step = kept[k];
        if (!step) {
          const conversation = [...base, ...mine];
          const judged = await judge.run({ unitKey, conversation, toolCall: call, userChecklist });
          const question = judged.questions.length > 0 ? await askUser(conversation, judged)
            // The gate could not tell what is wanted, or which tool: its own words, to be answered in words.
            : judged.ask && judged.message ? { text: judged.message, block: [], message: judged.message, options: judged.options ?? null }
            : null;
          step = { k, r: judged, question };
          await store.persist(stepsKey, step);
        }
        r = step.r;
        const q = step.question;
        if (!q) break;
        mine.push(afterCall(call, "waiting", q.message, r.settled));
        const answer = interrupt({
          type: "preflight_question", tool_call_id: toolCall.id, name: toolCall.name,
          message: q.message, text: q.text, block: q.block, questions: r.questions, notices: r.notices,
          ...(q.options ? { options: q.options } : {}),
        }, r.questions.length > 0 ? { responseSchema: answerSchema(r.questions) } : undefined);
        const segments = answer && typeof answer === "object" && typeof answer.typed === "string"
          ? connect.labelInput({ typed: answer.typed }) : connect.labelInput({ form: answer });
        if (segments.length === 0) return done(reply(`${NOT_ANSWERED}\n${q.message}`, "error"));
        mine.push(...segments);
      }

      // Nothing to ask. The executing side decides from the record this step wrote (spec 3.5).
      const record = r.key ? (await store.list(r.key)).filter(x => x && "execution_decision" in x).at(-1) : null;
      const notRun = async (why, extra = {}) => {
        const stop = r.message ? { message: r.message }
          : await writeStop({ ask: connect.ask, say: connect.say, model }, { record, conversation: [...base, ...mine] });
        if (record?.action_key) await judge.recordResult(record, { executed: false, why, ...extra });
        return done(reply(`${NOT_RUN}\n${stop.message}`, "error"));
      };
      const why = whyNotReady(record, toolCall.name);
      if (why !== null) return notRun(why);
      // The provider's notices, told before the tool runs (spec 3.3): those not shown with a question.
      const notice = await judge.notices(record);
      const told = notice.shown.map(d => ({ id: d.id, description: d.description, when: "with_question" }));
      if (notice.toShow.length > 0) {
        if (typeof connect.notify !== "function") return notRun("a notice could not be shown to the user before the call: connect.notify is not connected", { told });
        await connect.notify(notice.toShow.map(d => d.description));
        told.push(...notice.toShow.map(d => ({ id: d.id, description: d.description, when: "before_call" })));
      }
      const args = record.call_arguments;
      let result;
      try { result = await handler({ ...request, toolCall: { ...toolCall, args } }); }
      catch (e) {
        const error = String(e?.message ?? e);
        await judge.recordResult(record, { ok: false, error, told });
        return done(reply(`The call failed: ${error}`, "error"));
      }
      const message = ToolMessage.isInstance(result) ? result
        : (result?.update?.messages ?? []).find(m => ToolMessage.isInstance(m) && m.tool_call_id === toolCall.id);
      if (message?.status === "error") await judge.recordResult(record, { ok: false, error: textOf(message) || "the tool reported an error", told });
      else await judge.recordResult(record, { ok: true, told });
      const sameArgs = JSON.stringify(args) === JSON.stringify(toolCall.args ?? null);
      const shown = !message || sameArgs ? message
        : new ToolMessage({ ...message, content: `${RAN_WITH} ${toolCall.name} with arguments ${JSON.stringify(args)}.\n\nTool response:\n${textOf(message)}` });
      if (ToolMessage.isInstance(result)) return done(shown);
      return new Command({ ...result, update: { ...result.update, preflightCalls: { ...calls, [toolCall.id]: mine },
        messages: (result.update?.messages ?? []).map(m => (m === message ? shown : m)) } });
    },
  });
}

module.exports = { preflightMiddleware, segmentsFor };
