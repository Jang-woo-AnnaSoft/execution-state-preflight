"use strict";

/**
 * One run with a real model, through adopt-example/agent.js: LangChain's createAgent with the gate as its
 * middleware (middleware.js). --loop runs it through judge-only-example.js instead, the path the runs
 * before E2 took, to compare with them.
 *
 * The model is real (adopt-example/connect.js: MODEL, and that provider's API key in the environment).
 * The tool is read from adopt-example/tool.md, as in use. The system's data and the tool call are
 * stand-ins, the same as the tests': the measurements of the chosen condition, and a tool call that
 * only prints. So this shows what the tests cannot: what a real model answers to the gate's prompts.
 *
 *   cd adopt-example && npm install && npm install --no-save @langchain/anthropic
 *   cd ../provider-checklist-example
 *   MODEL=anthropic:<model-name> node trial-real-model.js
 *   MODEL=anthropic:<model-name> node trial-real-model.js --id g1-01 --condition clean --reply yes
 *   MODEL=... node trial-real-model.js --id g2-01 --reply "Saturday at 3pm, Hongdae station lockers" --reply yes --reply yes
 *     each --reply is what the seller says next, whether the gate asked or the assistant did; a
 *     verdict not to execute ends the run, and the replies left are not sent
 *   add --no-checklist to have the seller's conditions taken from their words and put into a form by
 *     the model, instead of handed in with the forms the test data already wrote
 *   add --form to answer the gate's questions through the form (answerSchema; each field a segment of the user's), not in words.
 *     A --reply is then "yes" or "no" (every yes-or-no field), or JSON: a slot's name with the value
 *     typed for it ("time": "Saturday 3pm"), a target with its answer, a condition's words for whether it
 *     holds for the values shown and whether it goes ("Nothing after 8pm": false: it does not hold, and it
 *     stays), and "*" for every other yes-or-no field, a form to confirm included.
 *     A choice is the value of its slot, matched to a choice shown. When the gate asked nothing (the
 *     assistant asked or answered itself), the reply goes in as words.
 *   add --show-lines, --no-label-note and --principles spec to change what the agent's model is shown
 *     (see below), and compare how it calls
 *   node trial-real-model.js --stub          # the stand-in model, to check this script itself
 *
 * Prints every model call (which prompt, how long, what came back), each turn, and the last record.
 * Writes the same, with the full prompts, to trial-log.json. No key is read or written by this file.
 */

const fs = require("fs");
const path = require("path");
const ADOPT = path.join(__dirname, "..", "adopt-example");
const { createMain, systemPrompt } = require(path.join(ADOPT, "judge-only-example"));
const { createAgent } = require(path.join(ADOPT, "agent"));
const { StubChatModel } = require("./stub-chat-model");
const { BaseCallbackHandler } = require(path.join(ADOPT, "node_modules", "@langchain/core/callbacks/base"));
const { createStorage } = require(path.join(ADOPT, "judge-only"));
const { keepForPrior } = require(path.join(__dirname, "..", "execution-state-preflight"));
const real = require(path.join(ADOPT, "connect"));
const { measuredFor, measurePort, MEASUREMENTS } = require("./arm");
const { buildUserTurn } = require("./prompts");
const S = require("./instructions.json");

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const all = name => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const STUB = argv.includes("--stub");
const id = opt("id", "g1-01"), condition = opt("condition", "clean"), dateMode = opt("date", "said");
const replies = all("reply").length ? all("reply") : ["yes"];
// --no-checklist: the seller's conditions are not handed in pre-translated (instructions.json carries
//   them with their comparison forms already written). The gate then takes them from the seller's words,
//   and the model puts each into a form for the seller to confirm: the path a real conversation takes.
const NO_CHECKLIST = argv.includes("--no-checklist");
const FORM = argv.includes("--form");
const LOOP = argv.includes("--loop");
// A scripted reply as the form's answers, for the questions the gate is waiting on.
function formAnswers(questions, reply) {
  let o;
  try { o = reply.trim().startsWith("{") ? JSON.parse(reply) : null; } catch { o = null; }
  if (!o) o = /^yes\b/i.test(reply.trim()) ? { "*": true, __text: reply } : /^no\b/i.test(reply.trim()) ? { "*": false, __text: reply } : { __text: reply };
  const out = {};
  for (const q of questions) {
    if (q.target in o) { out[q.target] = o[q.target]; continue; }
    const about = [q.description, q.stated_as, q.wording].find(w => typeof w === "string" && typeof o[w] === "boolean");
    if (about !== undefined && (q.kind === "approve" || q.kind === "withdraw")) { out[q.target] = o[about]; continue; }
    const typed = q.kind === "value" ? o[q.slot] : undefined;
    if (q.kind === "value" && Array.isArray(q.choices)) {
      const want = typeof typed === "string" ? typed : o.__text;
      const i = typeof want === "string" ? q.choices.findIndex(c => [c.value, c.shown_text].some(v => typeof v === "string" && want.includes(v))) : -1;
      if (i >= 0) out[q.target] = i;
    } else if (typeof typed === "string") out[q.target] = typed;
    else if (typeof o["*"] === "boolean" && !(q.kind === "value" && !q.candidate)) out[q.target] = o["*"];
  }
  return out;
}
const EXPECT_TIME = "2026-10-31T14:00:00+09:00";
// What the agent's model is shown, to compare how it calls:
//   --show-lines         the tool's whole description, labelled lines included, as a host that lists a
//                        server's tools itself would show it (default: the lines taken out, toolsForModel)
//   --no-label-note      the description without its line saying when the labelled lines are checked
//                        (tool.md has it, spec 4.2.1). Both the model and the gate read it; the gate as prose
//   --principles spec    the system prompt from principles.md, spec 6.2 itself (default: gated,
//                        principles-gated.md)
const SHOW_LINES = argv.includes("--show-lines"), LABEL_NOTE = !argv.includes("--no-label-note");
const PRINCIPLES = opt("principles", "gated");
const NOTE_LINE = /^The lines below are checked after this tool is called.*\n/m;
const withNote = t => (!LABEL_NOTE && t?.description ? { ...t, description: t.description.replace(NOTE_LINE, "") } : t);

const short = (v, n = 400) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + " …" : s; };

(async () => {
  const instruction = S.instructions.find(i => i.id === id);
  const cond = S.conditions[condition];
  if (!instruction || !cond) throw new Error(`unknown --id ${id} or --condition ${condition}`);
  if (!STUB && !process.env.MODEL) throw new Error("set MODEL, e.g. MODEL=anthropic:<model-name> (or pass --stub)");
  const ctx = cond.context, date = S.date_modes[dateMode];

  const stub = STUB ? require("./stub") : null;
  const askInner = STUB ? stub.makeAsk(id) : real.ask;
  const chatInner = STUB ? stub.makeChat() : real.chat;
  const log = { model: STUB ? "stub" : process.env.MODEL, id, condition, date: dateMode, form: FORM,
    shown: { lines: SHOW_LINES, label_note: LABEL_NOTE, principles: PRINCIPLES }, started: new Date().toISOString(), calls: [], turns: [] };

  async function timed(hook, prompt, fn) {
    const t0 = Date.now();
    const entry = { hook, ...prompt, seconds: null, reply: null, error: null };
    log.calls.push(entry);
    try { entry.reply = await fn(); return entry.reply; }
    catch (e) { entry.error = String(e?.message ?? e); throw e; }
    finally {
      entry.seconds = (Date.now() - t0) / 1000;
      console.log(`  [${String(log.calls.length).padStart(2)}] ${hook.padEnd(16)} ${entry.seconds.toFixed(1).padStart(5)}s  ${entry.error ? "ERROR " + short(entry.error) : short(entry.reply)}`);
    }
  }

  let first = true;
  const calls = [];
  const store = createStorage();
  const connect = {
    ask: (model, system, user, hook) => timed(hook ?? "ask", { system, user }, () => askInner(model, system, user, hook)),
    ...(STUB ? {} : { say: (model, system, user, hook) => timed(hook ?? "say", { system, user }, () => real.say(model, system, user, hook)) }),
    chat: a => timed("agent_chat", { system: a?.system, messages: a?.messages, tools: a?.tools }, () => chatInner(a)),
    // agent.js: the stand-in as a LangChain chat model (timed through chat), or the real one (timed
    //   through the agent's callbacks, below).
    chatModel: async () => (STUB ? new StubChatModel(a => connect.chat(a)) : real.chatModel()),
    checkpointer: real.checkpointer,
    listTools: async () => (await real.listTools()).map(withNote),
    readToolDefinition: async name => withNote(await real.readToolDefinition(name)),
    measure: measurePort(measuredFor(ctx, date)),
    // The first message arrives with the condition's context, as in the tests; later ones are typed.
    labelInput: msg => {
      if (first) { first = false; return buildUserTurn(ctx, instruction.text, date).segments; }
      return real.labelInput(msg);
    },
    callTool: async (name, args) => { calls.push({ name, args }); return { ok: true }; },
    // The provider's notices, shown to the seller before the call when no question carried them.
    notify: async lines => { for (const l of lines) console.log(`\n→ shown to the seller before the call:\n    Note: ${l}`); (log.notified ??= []).push(...lines); },
    store,
    // The seller's settings, when the scenario has them (pre_set): a setting the seller approved, or a
    //   value a model remembered on its own (spec 5.2).
    readPreSet: async () => instruction.pre_set ?? {},
    MEASUREMENTS: Object.fromEntries(MEASUREMENTS.map(n => [n, async () => undefined])),
    MODEL_NAME: log.model,
  };

  // A pickup executed before (before): kept for this seller and tool, as the executing side keeps one
  //   (keepForPrior), so the run can carry its values over as candidates (prior_state).
  if (instruction.before) {
    const toolName = (await real.listTools())[0].name;
    await keepForPrior(store, {
      execution_decision: "executed", action_key: `user:${toolName}:earlier`, tool_call: { name: toolName, arguments: instruction.before },
      fields: Object.entries(instruction.before).map(([name, value]) => ({ name, value, status: "known", source: "instruction", origin_source: "instruction" })),
      reason: "an earlier pickup, executed", timestamp: "2026-10-23T10:00:00+09:00",
    }, { userId: "user" });
  }
  if (!["spec", "gated"].includes(PRINCIPLES)) throw new Error("--principles is spec or gated");
  const system = systemPrompt(PRINCIPLES === "gated" ? "principles-gated.md" : "principles.md");
  // The real agent model's turns, logged as agent_chat: its own node only, not the gate's calls inside
  //   the tool node (those are logged through ask and say).
  const turnsOf = new Map();
  const callbacks = STUB ? undefined : [BaseCallbackHandler.fromMethods({
    handleChatModelStart(llm, msgs, runId, parent, extra, tags, metadata) {
      if (metadata?.langgraph_node !== "model_request") return;
      const entry = { hook: "agent_chat", messages: (msgs[0] ?? []).map(m => ({ type: m.getType?.(), content: m.content, tool_calls: m.tool_calls })), seconds: null, reply: null, error: null };
      log.calls.push(entry); turnsOf.set(runId, { entry, t0: Date.now() });
    },
    handleLLMEnd(out, runId) {
      const t = turnsOf.get(runId); if (!t) return;
      const m = out.generations?.[0]?.[0]?.message;
      t.entry.seconds = (Date.now() - t.t0) / 1000;
      t.entry.reply = m?.tool_calls?.length ? { toolCall: { name: m.tool_calls[0].name, arguments: m.tool_calls[0].args, id: m.tool_calls[0].id } } : { text: m?.content };
      console.log(`  [${String(log.calls.indexOf(t.entry) + 1).padStart(2)}] ${"agent_chat".padEnd(16)} ${t.entry.seconds.toFixed(1).padStart(5)}s  ${short(t.entry.reply)}`);
    },
    handleLLMError(e, runId) { const t = turnsOf.get(runId); if (t) { t.entry.error = String(e?.message ?? e); t.entry.seconds = (Date.now() - t.t0) / 1000; } },
  })];
  if (!LOOP && SHOW_LINES) throw new Error("--show-lines is for --loop: agent.js always gives the model the tools without the labelled lines");
  const main = LOOP ? createMain({ connect, hideLines: !SHOW_LINES, system }) : (() => {
    // agent.js, with what it returns put the way judge-only-example.js puts it: a verdict not to run is
    //   not_executed, with what the seller is told.
    const agent = createAgent({ connect, system, callbacks });
    const norm = res => (["executed", "waiting", "replied", "call_failed", "tool_error"].includes(res.status) ? res
      : { ...res, status: "not_executed", decision: res.status, message: res.stop?.message ?? "", reason: res.verdict?.reason ?? null });
    let started = false;
    return { turn: async ({ threadId, message, answers, userChecklist }) => {
      if (!started) { started = true; return norm(await agent.start({ threadId, message, userChecklist })); }
      return norm(await agent.reply({ threadId, message, answers }));
    } };
  })();
  const threadId = `trial-${Date.now()}`;
  log.path = LOOP ? "judge-only-example" : "agent (createAgent + middleware)";
  console.log(`model: ${log.model}   path: ${log.path}   run: ${id} / ${condition} / date ${dateMode}   ` +
    `shown: ${SHOW_LINES ? "whole description" : "labelled lines taken out"}${LABEL_NOTE ? " + label note" : ""}   principles: ${PRINCIPLES}`);
  console.log(`\nThe seller: ${instruction.text}\n`);

  let r = await main.turn({ threadId, message: { typed: instruction.text }, userChecklist: NO_CHECKLIST ? [] : (instruction.user_checklist ?? []) });
  log.turns.push({ said: instruction.text, result: r });
  // A turn ends waiting on the gate's question, with the assistant's own words (it asked or answered
  //   without calling the tool), or not executed, with what the seller is told. Each way the seller's
  //   next reply, if one was given, goes in.
  const indent = t => String(t ?? "").split("\n").map(l => "    " + l).join("\n");
  const show = res => {
    if (res.resubmitted) console.log("\n→ the model did not call again after the answer; the waiting call was judged again");
    if (res.status === "waiting") console.log(`\n→ waiting. The gate's question, as shown to the seller:\n${indent(res.question.message)}`);
    else if (res.status === "replied") console.log(`\n→ the assistant answered in words, without calling the tool (the gate did not run):\n${indent(res.reply)}`);
    else if (res.status === "not_executed") console.log(`\n→ not executed. What the seller is told:\n${indent(res.message)}`);
  };
  let n = 0;
  show(r);
  // A verdict not to execute ends the run: the replies are written ahead and do not read it, so one sent
  //   after it would be the script's words put in the seller's mouth, not the seller's answer to it.
  //   The assistant's words without a tool call are not a verdict: the seller answers them.
  while (["waiting", "replied"].includes(r.status) && n < replies.length) {
    const qs = r.status === "waiting" ? (r.question?.questions ?? []) : [];
    // Nothing in the reply fits a field (the seller restates the act), or a field wants a value typed and
    //   the reply is words, not JSON (its value is in the words, not in a field): words.
    const wantsTyped = qs.some(q => q.kind === "value" && !q.candidate && !Array.isArray(q.choices));
    const fa = FORM && qs.length && !(wantsTyped && !replies[n].trim().startsWith("{")) ? formAnswers(qs, replies[n]) : null;
    const answers = fa && Object.keys(fa).length ? fa : undefined;
    console.log(`\nThe seller${answers ? " (form)" : ""}: ${answers ? JSON.stringify(answers) : replies[n]}\n`);
    r = await main.turn({ threadId, ...(answers ? { answers } : { message: { typed: replies[n] } }), userChecklist: NO_CHECKLIST ? [] : (instruction.user_checklist ?? []) });
    log.turns.push({ said: replies[n], ...(answers ? { answers } : {}), result: r });
    if (r.status === "answers_not_taken") console.log(`\n→ the form's answers were not taken: ${r.why}`);
    n++;
    show(r);
  }

  const tool = (await real.listTools())[0];
  const records = await store.list(`user:${tool.name}:${threadId}`);
  const rec = records.filter(x => x && "execution_decision" in x && x.actor !== "executor").at(-1) ?? null;
  log.records = records;
  log.tool_calls = calls;

  console.log("\n─── result ───");
  console.log(`status:            ${r.status}${r.reason ? `   (${short(r.reason, 300)})` : ""}`);
  console.log(`model calls:       ${log.calls.length}, ${log.calls.reduce((s, c) => s + (c.seconds ?? 0), 0).toFixed(1)}s in all, ${log.calls.filter(c => c.error).length} failed`);
  console.log(`records written:   ${records.length}  (${records.map(x => x.execution_decision).join(" → ")})`);
  if (rec) {
    console.log(`last verdict:      ${rec.execution_decision}   unknown_count=${rec.unknown_count}   gate.kind=${rec.gate?.kind ?? "-"}`);
    console.log("values:");
    for (const f of rec.fields ?? []) console.log(`    ${String(f.name).padEnd(14)} ${String(f.status).padEnd(8)} ${String(f.source ?? "-").padEnd(16)} ${String(f.status).toLowerCase() === "known" ? short(f.value, 60) : ""}`);
    console.log("the provider's lines:");
    for (const c of rec.provider_checklist ?? []) console.log(`    [${c.label}] ${String(c.status).padEnd(22)} ${short(c.description ?? c.wording ?? "", 70)}\n        form: ${c.compare ? short(c.compare, 200) : "(none)"}` +
      (c.form_translation?.review ? `\n        review: also measured: ${c.form_translation.review.also_measured.join(", ")}` : ""));
    if ((rec.user_checklist ?? []).length) {
      console.log("the user's conditions:");
      for (const c of rec.user_checklist) console.log(`    ${String(c.status).padEnd(22)} ${short(c.stated_as ?? c.description ?? "", 70)}`);
    }
  }
  console.log(`tool called:       ${calls.length ? short(calls[0].args, 300) : "no"}`);
  if (id === "g1-01" && condition === "clean") {
    const got = calls[0]?.args?.time ?? null;
    console.log(`expected:          executed, time ${EXPECT_TIME}`);
    console.log(`same as expected:  ${r.status === "executed" && got === EXPECT_TIME ? "yes" : "NO"}`);
  }

  fs.writeFileSync(path.join(__dirname, "trial-log.json"), JSON.stringify(log, null, 2));
  console.log("\nfull log: trial-log.json");
})().catch(e => { console.error("\nstopped:", e?.message ?? e); if (process.env.TRIAL_DEBUG) console.error(e?.stack); process.exit(1); });
