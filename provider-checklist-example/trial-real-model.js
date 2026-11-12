"use strict";

/**
 * One run with a real model, through adopt-example/judge-only-example.js.
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
 *     each --reply is what the seller says next, whether the gate asked or the assistant did
 *   add --no-checklist to have the seller's conditions taken from their words and put into a form by
 *     the model, instead of handed in with the forms the test data already wrote
 *   node trial-real-model.js --stub          # the stand-in model, to check this script itself
 *
 * Prints every model call (which prompt, how long, what came back), each turn, and the last record.
 * Writes the same, with the full prompts, to trial-log.json. No key is read or written by this file.
 */

const fs = require("fs");
const path = require("path");
const ADOPT = path.join(__dirname, "..", "adopt-example");
const { createMain } = require(path.join(ADOPT, "judge-only-example"));
const { createStorage } = require(path.join(ADOPT, "judge-only"));
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
const EXPECT_TIME = "2026-10-31T14:00:00+09:00";

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
  const log = { model: STUB ? "stub" : process.env.MODEL, id, condition, date: dateMode, started: new Date().toISOString(), calls: [], turns: [] };

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
    chat: a => timed("agent_chat", { system: a?.system, messages: a?.messages }, () => chatInner(a)),
    listTools: real.listTools,
    readToolDefinition: real.readToolDefinition,
    measure: measurePort(measuredFor(ctx, date)),
    // The first message arrives with the condition's context, as in the tests; later ones are typed.
    labelInput: msg => {
      if (first) { first = false; return buildUserTurn(ctx, instruction.text, date).segments; }
      return real.labelInput(msg);
    },
    callTool: async (name, args) => { calls.push({ name, args }); return { ok: true }; },
    store,
    MEASUREMENTS: Object.fromEntries(MEASUREMENTS.map(n => [n, async () => undefined])),
    MODEL_NAME: log.model,
  };

  const main = createMain({ connect });
  const threadId = `trial-${Date.now()}`;
  console.log(`model: ${log.model}   run: ${id} / ${condition} / date ${dateMode}`);
  console.log(`\nThe seller: ${instruction.text}\n`);

  let r = await main.turn({ threadId, message: { typed: instruction.text }, userChecklist: NO_CHECKLIST ? [] : (instruction.user_checklist ?? []) });
  log.turns.push({ said: instruction.text, result: r });
  // A turn ends waiting on the gate's question, with the assistant's own words (it asked or answered
  //   without calling the tool), or not executed, with what the seller is told. Each way the seller's
  //   next reply, if one was given, goes in.
  const indent = t => String(t ?? "").split("\n").map(l => "    " + l).join("\n");
  const show = res => {
    if (res.status === "waiting") console.log(`\n→ waiting. The gate's question, as shown to the seller:\n${indent(res.question.message)}`);
    else if (res.status === "replied") console.log(`\n→ the assistant answered in words, without calling the tool (the gate did not run):\n${indent(res.reply)}`);
    else if (res.status === "not_executed") console.log(`\n→ not executed. What the seller is told:\n${indent(res.message)}`);
  };
  let n = 0;
  show(r);
  while (["waiting", "replied", "not_executed"].includes(r.status) && n < replies.length) {
    console.log(`\nThe seller: ${replies[n]}\n`);
    r = await main.turn({ threadId, message: { typed: replies[n] }, userChecklist: NO_CHECKLIST ? [] : (instruction.user_checklist ?? []) });
    log.turns.push({ said: replies[n], result: r });
    n++;
    show(r);
  }

  const tool = (await real.listTools())[0];
  const records = await store.list(`user:${tool.name}:${threadId}`);
  const rec = records.filter(x => x && "execution_decision" in x && x.execution_decision !== "executed" && x.execution_decision !== "failed").at(-1) ?? null;
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
