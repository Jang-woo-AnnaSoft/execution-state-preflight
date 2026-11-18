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
const { keepForPrior, loadPrior } = require(path.join(__dirname, "..", "execution-state-preflight"));
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
  const calls = [], shown = [], prompts = [], heard = [], events = [];
  const chatInner = makeChat();
  const askInner = over.ask ?? makeAsk(id);
  const ins = S.instructions.find(i => i.id === id), text = over.text ?? ins.text;
  let first = true;
  const store = over.store ?? createStorage();
  return {
    calls, store, shown, prompts, heard, events,
    connect: {
      // Every prompt the gate's model calls were sent, kept for the checks.
      ask: async (m, system, user, hook) => { prompts.push({ hook, system, user }); return askInner(m, system, user, hook); },
      // What the agent's model is given, kept for the checks.
      chat: async a => { shown.push(a?.tools ?? null); heard.push(a?.messages ?? null); return over.chat ? over.chat(a, chatInner) : chatInner(a); },
      listTools: async () => [over.tool ?? TOOL],
      readToolDefinition: async name => [over.tool ?? TOOL].find(t => t.name === name),
      measure: measurePort(measuredFor(ctx, date)),
      // The first message arrives with the condition's context; later ones are what the seller typed.
      labelInput: msg => {
        if (first) { first = false; return buildUserTurn(ctx, text, date).segments; }
        return realConnect.labelInput(msg);
      },
      callTool: over.callTool ?? (async (name, args) => { events.push("call"); calls.push({ name, args }); return { ok: true }; }),
      // The provider's notices, shown before the call when no question carried them. In order with the call.
      ...(over.notify === null ? {} : { notify: async lines => { events.push(["notify", lines]); } }),
      store,
      // The seller's settings, when the scenario has them (spec 5.2).
      readPreSet: async () => over.preSet ?? ins.pre_set ?? {},
      MEASUREMENTS: Object.fromEntries(MEASUREMENTS.map(n => [n, async () => undefined])),
      MODEL_NAME: "stub",
    },
  };
}
async function run(id, condition, replies = [], over = {}) {
  const s = standIn(id, condition, over);
  // A pickup executed before (the scenario's before), kept as the executing side keeps one.
  const before = S.instructions.find(i => i.id === id).before;
  if (before && !over.noBefore) {
    await keepForPrior(s.store, { execution_decision: "executed", action_key: `user:${TOOL.name}:earlier`, tool_call: { name: TOOL.name, arguments: before },
      fields: Object.entries(before).map(([name, value]) => ({ name, value, status: "known", source: "instruction", origin_source: "instruction" })) }, { userId: "user" });
  }
  const main = createMain({ connect: s.connect, ...(over.hideLines === false ? { hideLines: false } : {}) });
  const threadId = `j${++thread}`;
  const userChecklist = over.userChecklist ?? S.instructions.find(i => i.id === id).user_checklist ?? [];
  const first = await main.turn({ threadId, message: { typed: "(stand-in)" }, userChecklist });
  let last = first;
  for (const r of replies) last = await main.turn({ threadId, message: { typed: r }, userChecklist });
  const records = await s.store.list(`user:${TOOL.name}:${threadId}`);
  return { first, last, calls: s.calls, events: s.events, shown: s.shown, heard: s.heard, prompts: s.prompts, store: s.store, key: `user:${TOOL.name}:${threadId}`, records };
}


// A seller who types every value in its declared form: nothing is left to ask. The stand-in extractor
//   reads the time from the typed date-time.
const ALL_GIVEN = "Set up the pickup for listing LST-2291 at 2026-10-31T14:00:00+09:00 at the Hongdae station lockers.";
function askAllGiven(id) {
  const inner = makeAsk(id);
  return async (m, system, user, hook) => {
    const out = await inner(m, system, user, hook);
    if (hook === "extraction") {
      const segs = JSON.parse(user.slice(user.indexOf("[", user.indexOf("Segments:")), user.indexOf("\n\nFields to locate")));
      out.time = { found: true, value: "2026-10-31T14:00:00+09:00", segment_index: segs.findIndex(s => s.trust === "user" && s.text.includes("2026-10-31T14")) };
    }
    return out;
  };
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
    check("it is the library's function: judge-only.js only hands it on",
      [toolsForModel === require("../execution-state-preflight").toolsForModel, createJudge({ ask() {}, readToolDefinition() {}, storage: createStorage() }).toolsForModel === toolsForModel], [true, true]);
    check("the tool has labelled lines, and the gate read all of them", [lines.filter(l => /^\[/.test(l)).length, verdict?.provider_checklist?.length], [7, 7]);
    check("what the model is given keeps the prose and the input schema", [forModel.description, forModel.inputSchema, forModel.name],
      [lines.filter(l => !/^\s*\[/.test(l)).join("\n").trim(), TOOL.inputSchema, TOOL.name]);
    check("  and no line that starts with a label; the prose line that says when they are checked stays",
      [forModel.description.split("\n").filter(l => /^\s*\[/.test(l)), forModel.description.includes("The lines below are checked after this tool is called")], [[], true]);
    check("a label the gate does not know is taken out too: the gate holds it, the model does not judge it",
      toolsForModel([{ name: "t", description: "Does a thing.\n[Requried] Must be agreed.\n  [Beta] Indented." }])[0].description, "Does a thing.");
    check("lines written as a list, or with the label in bold, are taken out the same way; a task-list box is prose and stays",
      toolsForModel([{ name: "t", description: "Does a thing.\n- [Required] Must be agreed.\n1. **[Verify]** The place.\n**[Notice] Told.**\n- [x] shipped" }])[0].description,
      "Does a thing.\n- [x] shipped");
    check("lines behind a quote or heading mark, or with escaped or full-width brackets, are taken out too",
      toolsForModel([{ name: "t", description: "Does a thing.\n> [Required] Must be agreed.\n### \\[Verify\\] The place.\n\uff3bNotice\uff3d Told.\nConditions: [Required] stays." }])[0].description,
      "Does a thing.\nConditions: [Required] stays.");
    check("a tool with no description is left as it is", toolsForModel([{ name: "t" }]), [{ name: "t", description: "" }]);
    // Through judge-only-example: a line dressed by an editor is still the condition, and one written
    //   under an argument stops the run. Before 1.37 both tools ran.
    const quoted = { ...TOOL, description: TOOL.description.split("\n").map(l => (/^\[Required\] The sale/.test(l) ? `> ${l.replace("[", "\\[").replace("]", "\\]")}` : l)).join("\n") };
    const qc = await run("g1-01", "order_cancelled", ["yes"], { tool: quoted });
    check("a [Required] line behind a quote mark with escaped brackets: a cancelled order does not run",
      [qc.last.status, qc.calls.length, qc.records.filter(x => x.actor !== "executor").at(-1)?.execution_decision], ["not_executed", 0, "hold"]);
    const under = { ...TOOL, inputSchema: { ...TOOL.inputSchema, properties: { ...TOOL.inputSchema.properties,
      item_id: { ...TOOL.inputSchema.properties.item_id, description: "[Required] The listing must not be archived." } } } };
    const uc = await run("g1-01", "clean", ["yes"], { tool: under });
    check("a labelled line in an argument's description: the run stops for definition repair, nothing called",
      [uc.last.status, uc.calls.length, uc.records.filter(x => x.actor !== "executor").at(-1)?.execution_decision], ["not_executed", 0, "definition_repair"]);
    const seen = g1.shown.flat().map(t => t?.description ?? "");
    check("in the run, every list the model was given had no labelled line", [g1.shown.length > 0, seen.some(d => /^\[(Required|Verify|Notice)\]/m.test(d))], [true, false]);
    // Where a host lists the server's tools itself, the model sees the whole description. The gate reads
    //   the same full definition either way, so the verdict is the same.
    const whole = await run("g1-01", "clean", ["yes"], { hideLines: false });
    check("hideLines false: the model is given the whole description; the run judges and executes the same",
      [whole.shown.every(l => l?.[0]?.description === TOOL.description), whole.last.status, whole.calls[0]?.args, whole.records.map(r => r.execution_decision)],
      [true, g1.last.status, g1.calls[0]?.args, g1.records.map(r => r.execution_decision)]);
    // Whether the act the user named is what the tool does is asked without the lines too: a real model
    //   handed them judged them there, and refused the match.
    const match = g1.prompts.filter(p => p.hook === "tool_match");
    check("the tool-match question is asked with the tool's prose and without its labelled lines",
      [match.length > 0, match.every(p => p.user.includes("Schedule an in-person pickup")), match.some(p => /^\[(Required|Verify|Notice)\]/m.test(p.user))], [true, true, false]);
    // The location is also a measurement. A real model, told so, put its line into user_approval or no
    //   form at all, where the same line for the item was value_source.
    const place = g1.prompts.find(p => p.hook === "comparable_form" && p.user.includes("Condition: The location is the place the seller names, not a place read from the platform."));
    check("the form for a line on a field that is also a measurement: the prompt says who gives the value is value_source",
      [Boolean(place), place?.user.includes("Measurements this system can read: order_status, listing_owned_by_seller, buyer_contact, time, location"),
       place?.user.includes("A line that says who gives a field's value is this kind, also for a field that is also a measurement"),
       place?.user.includes("Not for a line that only says who gives a value")], [true, true, true, true]);
    // And the kept translations of those lines are marked for review: judge-only.js hands the library
    //   the names connect.js can measure ([ALSO MEASURED]).
    const reviewed = (verdict?.provider_checklist ?? []).filter(c => c.form_translation?.review).map(c => [c.label, c.form_translation.review.also_measured]);
    check("  the [Verify] lines on time and location are marked for review; the item, not measured, and [Required] lines are not",
      reviewed, [["Verify", ["time"]], ["Verify", ["location"]]]);
    // Finding and writing a value. With a stricter model the time was never settled: it found no time in
    //   "2pm this Saturday" because the field's form is a date-time, and would not write one because the
    //   year and time zone were only in the context the system gave.
    const found = g1.prompts.find(p => p.hook === "extraction"), proposed = g1.prompts.find(p => p.hook === "propose_value");
    check("the extraction prompt: report the user's words for a field even when they are not in its form",
      found?.user.includes("Report the user's words for a field even when they are not in the field's declared form"), true);
    check("  and words that point to a value kept elsewhere are not the value",
      found?.user.includes('Words that point to a value given elsewhere are not the value: "my usual spot", "same place as last time", "the usual". For such a field report {"found": false}'), true);
    check("  the proposal prompt: the value from the user's words, what the form needs beyond it from the other segments",
      [Boolean(proposed), /The value itself, which moment or which thing, comes only from the user's words/.test(proposed?.system ?? ""),
       /such as the year, or the time zone the tool's description points to, may be taken from the other segments/.test(proposed?.system ?? ""),
       /If the user named a day of the week, the date you write falls on that day/.test(proposed?.system ?? "")],
      [true, true, true, true]);
    // A smaller model quoted the whole request as the action's name, and took the values for conditions.
    const named = g1.prompts.find(p => p.hook === "action_name"), conds = g1.prompts.find(p => p.hook === "user_conditions");
    check("  the action-name prompt: the few words that name the act, not the whole request",
      /Quote only the few words that name the act/.test(named?.system ?? ""), true);
    check("  the conditions prompt: words that give a field its value are values, not conditions, with an example of each",
      [/words that give a field its value \(a time, a place, a way to reach someone\) are values/.test(conds?.system ?? ""),
       /"nothing after 8pm" and "public places only" do/.test(conds?.system ?? "")], [true, true]);
    // The gate's question goes back to the model as its call's result, and the messages are ones the
    //   model library takes as a call and its result.
    const heard = g1.heard[1] ?? [];
    const at = heard.findIndex(m => m.role === "assistant" && m.tool_calls?.length);
    check("the gate asked: the model's next turn has its call, then the result: the question the seller was shown",
      [at >= 0, heard[at + 1]?.role, String(heard[at + 1]?.content).startsWith("Not run yet, and nothing has been sent. The system is asking the user first. When the user answers, call the tool again with the same request: the system reads the answer then. The user was shown:\n"), heard.at(-1)],
      [true, "tool", true, { role: "user", content: "yes" }]);
    const { coerceMessageLikeToMessage } = require(path.join(__dirname, "..", "adopt-example", "node_modules", "@langchain", "core", "messages"));
    const lc = heard.map(m => coerceMessageLikeToMessage(m));
    check("  as LangChain messages: an AI message with the tool call, then a tool message under its id",
      [lc[at]?._getType(), lc[at]?.tool_calls?.[0]?.name, lc[at + 1]?._getType(), lc[at + 1]?.tool_call_id === lc[at]?.tool_calls?.[0]?.id],
      ["ai", "schedule_pickup", "tool", true]);
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
    const qPrompt = r.prompts.find(p => p.hook === "question" && /"kind": "withdraw"/.test(p.user))?.user ?? "";
    check("  the model writing the question is told what the withdraw item is: the condition and the words",
      [/"remove_condition": "Nothing after 8pm"/.test(qPrompt), /"because_you_said": "drop the 8pm limit"/.test(qPrompt)], [true, true]);
  }

  console.log("\n--- 1-g. the seller says the proposed form is wrong: the condition is approved for the time instead ---");
  {
    const GOOD = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d:[0-5]\\d:[0-5]\\d|20:00:00)(?:Z|[+-]\\d{2}:\\d{2})$" };
    const stub = makeAsk("g2-01");
    const segsOf = (u, until) => JSON.parse(u.slice(u.indexOf("Segments:\n") + 10, u.indexOf(until)));
    let formProposals = 0;
    const ask = (m, sys, u, h) => {
      if (h === "user_conditions") return { conditions: [{ quote: "Nothing after 8pm", segment_index: 3, constrains: ["time"] }, { quote: "public places only", segment_index: 3, constrains: ["location"] }] };
      if (h === "comparable_form" && /Declared by: user/.test(u)) {
        if (/Condition: Nothing after 8pm$/m.test(u)) { formProposals++; return { form: { compare: GOOD, constrains: ["time"] } }; }
        return { form: null };
      }
      if (h === "extraction") {
        const segs = segsOf(u, "\n\nFields to locate");
        const at = segs.findIndex(x => x.trust === "user" && x.text.includes("This Saturday at 3pm"));
        return { item_id: { found: true, value: "LST-2291", segment_index: 3 },
          ...(at >= 0 ? { time: { found: true, value: "This Saturday at 3pm", segment_index: at }, location: { found: true, value: "Hongdae station lockers", segment_index: at } }
                      : { time: { found: false }, location: { found: false } }), buyer_contact: { found: false } };
      }
      if (h === "propose_value") return { value: /^Field: time:/m.test(u) && /This Saturday at 3pm/.test(u) ? "2026-10-31T15:00:00+09:00" : null };
      if (h === "replies") {
        // As a real reader does: each question answered by the seller's first reply after it was asked.
        const qs = JSON.parse(u.slice(u.indexOf("Questions:\n") + 11, u.indexOf("\n\nSegments:")));
        const segs = segsOf(u, "\n\nFor each question");
        const replies = [];
        for (const q of qs) {
          const at = segs.findIndex((x, i) => i > q.asked_after_segment && x.trust === "user");
          if (at < 0) continue;
          const text = segs[at].text;
          if (/check is wrong/.test(text)) replies.push(q.target.startsWith("form:")
            ? { target: q.target, answer: false, quote: "that 8pm check is wrong", segment_index: at }
            : { target: q.target, answer: true, quote: "The time and place are fine", segment_index: at });
          else if (text === "yes") replies.push({ target: q.target, answer: true, quote: "yes", segment_index: at });
        }
        return { replies };
      }
      return stub(m, sys, u, h);
    };
    // As the real model did: it asks in words for the time and place first, and calls the tool once given them.
    let turns = 0;
    const chat = (a, inner) => (++turns === 1 ? { text: "When and where should the pickup be?" } : inner(a));
    const r = await run("g2-01", "clean", ["This Saturday at 3pm at the Hongdae station lockers.", "The time and place are fine, but that 8pm check is wrong.", "yes"], { ask, chat, userChecklist: [] });
    const afterNo = r.records.find(x => (x.gate?.questions ?? []).some(q => q.kind === "approve" && /^uc:/.test(q.id) && x.user_checklist?.some(i => i.id === q.id && i.stated_as === "Nothing after 8pm")));
    check("after the no: 'Nothing after 8pm' is asked to approve for the time, and its form is not proposed again",
      [((afterNo?.gate?.question_block ?? []).find(l => l.startsWith("Nothing after 8pm")) ?? ""), formProposals],
      ["Nothing after 8pm — for time = 2026-10-31 (Sat) 15:00 +09:00", 1]);
    const eight = (r.records.filter(x => x.execution_decision === "execute").at(-1)?.user_checklist ?? []).find(i => i.stated_as === "Nothing after 8pm") ?? {};
    check("  the seller's yes: 15:00 executes, the condition verified by the seller, the declined form in the record",
      [r.last.status, r.calls[0]?.args.time, eight.status, eight.source, Boolean(eight.form_none?.declined)], ["executed", "2026-10-31T15:00:00+09:00", "verified", "user_answer", true]);
  }

  console.log("\n--- 1-h. the system's data does not meet a [Required] line: the gate stops, and asks nothing ---");
  {
    // The conversation is the clean one. Only the platform's order status is "cancelled", and the
    //   agent's model sees neither the status nor the [Required] lines: it has no reason to stop.
    const r = await run("g1-01", "order_cancelled", ["yes"]);
    const v = r.records.filter(x => VERDICTS.includes(x.execution_decision)).at(-1) ?? {};
    const agreed = (v.provider_checklist ?? []).find(l => String(l.description).startsWith("The sale must be agreed")) ?? {};
    check("g1-01, order cancelled: not executed, no call, and no question", [r.first.status, r.calls.length, Boolean(r.first.question)], ["not_executed", 0, false]);
    check("  the line that stopped it: [Required] sale agreed, unmet from the measured order status",
      [v.execution_decision, v.gate?.kind, agreed.label, agreed.status, String(r.first.reason).includes('order_status = "cancelled"')], ["hold", "unmet", "Required", "unmet", true]);
    check("  the seller's yes changes nothing: no reply can meet a line read from the system", [r.last.status, r.calls.length, r.records.some(x => x.execution_decision === "execute")], ["not_executed", 0, false]);

    // The seller is told. A real run ended here with nothing said: message null, the reason an internal string.
    const stops = r.prompts.filter(p => p.hook === "stop");
    check("  the seller is told why, in the model's words: one writer call each time it stops",
      [r.first.message, stops.length], ["I did not schedule it.", 2]);
    check("  the writer is given the library's facts: the condition's words, whose, what was found",
      r.first.stop, { decision: "hold", items: [{ why: "not_allowed", condition: agreed.description, set_by: "provider", found: 'order_status = "cancelled": data must be equal to constant' }] });
    check("  no ids or hashes in what the writer is given", [stops[0].user.includes("The sale must be agreed"), /schedule_pickup:\d|\d+-[0-9a-z]{8,}/.test(stops[0].user)], [true, false]);
    check("  what the seller was told is in the conversation the next turn starts from",
      stops[1].user.includes("I did not schedule it."), true);
    // The agent's model is given its own call and, as that call's result, what the seller was told: not
    //   the gate's words as its own. A real model, given them as its own, took them back as made up.
    const next = r.heard[1] ?? [];
    const callAt = next.findIndex(m => m.role === "assistant" && m.tool_calls?.length);
    check("  the model's next turn: its call, then the call's result with what the seller was told",
      [next[callAt]?.tool_calls?.[0]?.name, next[callAt + 1]?.role, next[callAt + 1]?.tool_call_id === next[callAt]?.tool_calls?.[0]?.id,
       next[callAt + 1]?.content, next.some(m => m.role === "assistant" && m.content === "I did not schedule it.")],
      ["schedule_pickup", "tool", true, "Not run. The user was told:\nI did not schedule it.", false]);
    // Without the model's words, the seller is still told.
    const base = makeAsk("g1-01");
    const silent = await run("g1-01", "order_cancelled", [], { ask: async (m, s, u, hook) => { if (hook === "stop") throw new Error("down"); return base(m, s, u, hook); } });
    check("  the writer fails: a plain sentence, not nothing", silent.first.message, "This was not carried out.");
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
    // Never matched: the library counts the asks from the unit's records and stops.
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

  console.log("\n--- 1-i. stored and earlier values: pre_set_data and prior_state reach the gate (5.2) ---");
  {
    const loc = rec => (rec?.fields ?? []).find(f => f.name === "location") ?? {};
    const verdicts = r => r.records.filter(x => VERDICTS.includes(x.execution_decision));
    // A setting the seller approved: it settles the place, recorded with who approved it and when.
    const set = await run("g6-01", "clean", ["yes"]);
    check("g6-01, a setting the seller approved: executes with it, recorded with who approved it, when and where",
      [set.last.status, set.calls[0]?.args.location, loc(verdicts(set).at(-1)).source, loc(verdicts(set).at(-1)).pre_set],
      ["executed", "Hongdae station lockers", "pre_set_data", S.instructions.find(i => i.id === "g6-01").pre_set.location && { approved_by: "seller", approved_at: "2026-10-20T09:00:00+09:00", approved_in: "settings: default pickup place" }]);
    // The same place, remembered by a model on its own: shown, and used only once the seller approves it.
    const mem = await run("g6-02", "clean", ["yes"]);
    const memFirst = verdicts(mem)[0];
    check("g6-02, a value a model remembered: not a setting, shown to the seller, used once approved",
      [loc(memFirst).status, loc(memFirst).stored_candidate?.stored_by, (memFirst?.gate?.question_block ?? []).includes('location = "Hongdae station lockers" (remembered, not saved by you)'),
       mem.last.status, loc(verdicts(mem).at(-1)).source],
      ["unknown", "model_memory", true, "executed", "user_answer"]);
    // A candidate made from the seller's words now carries no origin: it is their words, put in the form.
    {
      const g1 = await run("g1-01", "clean", ["yes"]);
      check("  a proposal from the seller's words is shown without an origin",
        (verdicts(g1)[0]?.gate?.question_block ?? []).includes("time = 2026-10-31 (Sat) 14:00 +09:00"), true);
    }
    // [SETTLED] What the gate already holds goes back to the model with its call's result. A real model,
    //   its call saying "my usual spot" and the place settled from the seller's setting, asked the seller
    //   where that was, outside the gate.
    {
      const usual = await run("g6-01", "clean", ["yes"], {
        chat: async () => ({ toolCall: { name: TOOL.name, arguments: { item_id: "LST-2291", time: "2026-10-31T14:00:00+09:00", location: "my usual spot" } } }) });
      const first = verdicts(usual)[0];
      const told = JSON.stringify(usual.heard.at(-1) ?? []);
      check("g6-01, the call says \"my usual spot\": the place settled from the setting is told to the model with the call's result",
        [(first?.gate?.settled_block ?? []).includes('location = "Hongdae station lockers" (your saved setting)'),
         told.includes('Already settled, not to be asked:\\n- location = \\"Hongdae station lockers\\" (your saved setting)')],
        [true, true]);
      check("  a value the call carries as it is is not listed; the user is not shown the list",
        [(first?.gate?.settled_block ?? []).some(l => l.startsWith("item_id")), usual.first.question?.message?.includes("Already settled") ?? false],
        [false, false]);
    }
    // A real model,
    //   after the seller approved the remembered place, called again with the seller's "my usual spot".
    const pointing = async () => ({ toolCall: { name: TOOL.name, arguments: { time: "2026-10-31T14:00:00+09:00", location: "my usual spot" } } });
    const memCall = await run("g6-02", "clean", ["yes"], { chat: pointing });
    check("  the call says \"my usual spot\" after the remembered place was approved: not asked again, runs with the approved place",
      [memCall.last.status, memCall.calls[0]?.args.location, loc(verdicts(memCall).at(-1)).approval?.shown_from, Boolean(loc(verdicts(memCall).at(-1)).call_disagrees)],
      ["executed", "Hongdae station lockers", "stored", false]);
    // A pickup executed before: the round trip through the executing side, not a seeded record.
    const shared = createStorage();
    const earlier = await run("g1-01", "clean", ["yes"], { store: shared });
    const kept = await loadPrior(shared, { userId: "user", tool: TOOL.name });
    check("an executed pickup is kept for the next run of this seller and tool",
      [earlier.last.status, kept?.execution_decision, loc(kept).value], ["executed", "executed", "Hongdae station lockers"]);
    const again = await run("g6-03", "clean", ["yes"], { store: shared, noBefore: true,
      chat: async () => ({ toolCall: { name: TOOL.name, arguments: { time: "2026-10-31T14:00:00+09:00", location: "same place as last time" } } }) });
    const againFirst = verdicts(again)[0];
    check("g6-03, \"same place as last time\": the last pickup's place shown as a candidate, used once approved",
      [loc(againFirst).prior_candidate?.value, loc(againFirst).prior_candidate?.action_key === earlier.key,
       (againFirst?.gate?.question_block ?? []).includes('location = "Hongdae station lockers" (the last time)'), again.last.status, loc(verdicts(again).at(-1)).source],
      ["Hongdae station lockers", true, true, "executed", "user_answer"]);
    const none = await loadPrior(createStorage(), { userId: "user", tool: TOOL.name });
    check("  nothing executed before: the caller looked, none (not \"no report\")", none, { none: "absent" });
    const failedStore = createStorage();
    const failing = await run("g1-01", "clean", ["yes"], { store: failedStore, callTool: async () => { throw new Error("down"); } });
    check("  a call that failed is not kept to carry from", [failing.last.status === "executed", await loadPrior(failedStore, { userId: "user", tool: TOOL.name })],
      [false, { none: "absent" }]);
    // An extractor that reads the pointing words as the place ("my usual spot", what real models did):
    //   a setting or a remembered value holds another, so both are shown and the seller chooses.
    for (const [id, from, text] of [["g6-01", "pre_set_data", "your saved setting"], ["g6-02", "stored", "remembered, not saved by you"]]) {
      const eager = await run(id, "clean", ["Hongdae station lockers, yes"], { ask: makeAsk(id, "over_eager"),
        // The model keeps calling with the seller's pointing words: a choice the seller made is not asked again.
        chat: async () => ({ toolCall: { name: TOOL.name, arguments: { time: "2026-10-31T14:00:00+09:00", location: "my usual spot" } } }) });
      const first = verdicts(eager)[0];
      check(`${id}, "my usual spot" read as the place: not run with it, both shown (${from})`,
        [loc(first).status, loc(first).lower_differs?.other?.from,
         (first?.gate?.question_block ?? []).includes(`location: "my usual spot" (your words) or "Hongdae station lockers" (${text}) — which one?`)],
        ["unknown", from, true]);
      check(`  the seller chooses the saved place, and it runs with it`,
        [eager.last.status, eager.calls[0]?.args.location, loc(verdicts(eager).at(-1)).approval?.chosen_from?.[1]?.from], ["executed", "Hongdae station lockers", from]);
    }
    // A yes to a question with choices chooses none: the claim is set aside, and it does not run.
    {
      const base = makeAsk("g6-01", "over_eager");
      const yesAsk = async (m, s, u, hook) => {
        const out = await base(m, s, u, hook);
        if (hook !== "replies") return out;
        const seg = (out?.replies ?? [])[0]?.segment_index;
        return { replies: [...(out?.replies ?? []), { target: "value:location", answer: true, quote: "yes", segment_index: seg }] };
      };
      const yes = await run("g6-01", "clean", ["yes"], { ask: yesAsk });
      const second = verdicts(yes)[1];
      check("  a yes to a choice question chooses none: set aside, not run",
        [yes.last.status === "executed", yes.calls.length, loc(second).status, Boolean(loc(second).lower_differs)], [false, 0, "unknown", true]);
    }
    // The seller typed the place after being shown the two: those words settle it, not asked again.
    {
      const after = await run("g6-01", "clean", ["neither, make it Gangnam station exit 3", "yes"], { ask: makeAsk("g6-01", "over_eager") });
      const last = verdicts(after).at(-1);
      check("  words typed after the two were shown settle it as they are",
        [after.calls[0]?.args.location, loc(last).source, loc(last).lower_differs ?? null], ["Gangnam station exit 3", "instruction", null]);
    }
    // Words not yet in the field's form are not compared with a setting: they go to the proposal, which
    //   the seller sees anyway ("2pm this Saturday" against a saved time).
    {
      const t = await run("g1-01", "clean", ["yes"], { preSet: { time: { value: "2026-10-31T10:00:00+09:00", trust: "user" } } });
      const first = verdicts(t)[0], time = (first?.fields ?? []).find(f => f.name === "time") ?? {};
      check("  words not in the field's form: not compared with the setting, proposed as before",
        [Boolean(time.lower_differs), (first?.gate?.question_block ?? []).some(l => l.startsWith("time = 2026-10-31 (Sat) 14:00")), t.last.status],
        [false, true, "executed"]);
    }
    // The seller names a place and a setting holds another: both are shown, and the seller chooses
    //   ([LOWER DIFFERS], 5.2). A real model read "my usual spot" as a place, and it ran.
    const named = await run("g6-04", "clean", ["Gangnam station exit 3, yes"]);
    const namedFirst = verdicts(named)[0];
    check("g6-04, the seller names a place, a setting holds another: not settled, both shown, the seller chooses",
      [loc(namedFirst).status, loc(namedFirst).lower_differs?.other?.from,
       (namedFirst?.gate?.question_block ?? []).includes('location: "Gangnam station exit 3" (your words) or "Hongdae station lockers" (your saved setting) — which one?')],
      ["unknown", "pre_set_data", true]);
    check("  the seller's choice settles it, bound to what was shown, and it runs",
      [named.last.status, named.calls[0]?.args.location, loc(verdicts(named).at(-1)).source, loc(verdicts(named).at(-1)).approval?.chosen_from?.map(c => c.from)],
      ["executed", "Gangnam station exit 3", "user_answer", ["instruction", "pre_set_data"]]);
  }

  console.log("\n--- 1-j. a value the user approved, then changed in later words: the later words are read ([SAID AFTER]) ---");
  {
    // Through this example, an approval and a change in a later message no longer meet: the waiting call is
    //   judged on the reply itself (judge-only-example, 8), so a yes runs before a later message arrives.
    //   (Before this change to the example, the assistant could answer the yes in words, the seller then typed
    //   another time, and the next call met both.) The library's own case, approval then later words, is
    //   hooks-example/value-source-test.js part 13; the same message, below.
    // Words before the approval change nothing: the plain run still settles on the approved value.
    const plain = await run("g1-01", "clean", ["yes"]);
    const pt = plain.records.filter(x => x.execution_decision === "execute").at(-1)?.fields?.find(f => f.name === "time");
    check("an approval with no later words about the value stands", [pt?.source, pt?.lookup_trace?.[0]?.result, "answer_superseded" in (pt ?? {})],
      ["user_answer", "found", false]);
    // The validator reads a tool's schema as MCP says: JSON Schema 2020-12 when it names no $schema,
    //   draft-07 when it says so, and no other. "date-time" is RFC 3339's: a "T", seconds, and an offset.
    const { checkAgainst } = require(path.join(ADOPT, "judge-only"));
    const DT = { type: "string", format: "date-time" };
    check("date-time as RFC 3339 writes it: with an offset, a T, seconds; a real date",
      ["2026-10-31T14:00:00+09:00", "2026-10-31T05:00:00Z", "2026-10-31T14:00:00", "2026-10-31T14:00:00+0900",
       "2026-10-31 14:00:00+09:00", "2026-10-31T14:00+09:00", "2026-02-29T14:00:00Z"].map(v => checkAgainst(DT, v).ok),
      [true, true, false, false, false, false, false]);
    const tuple = { type: "array", prefixItems: [{ type: "string" }], items: false, minItems: 1 };
    check("no $schema: 2020-12, so its keywords are run, not refused",
      [checkAgainst(tuple, ["a"]).ok, checkAgainst(tuple, ["a", "b"]).ok], [true, false]);
    check("  draft-07 when the schema says so; another dialect is not run (unverified, not passed)",
      [checkAgainst({ $schema: "http://json-schema.org/draft-07/schema#", type: "array", items: { type: "string" } }, ["a"]).ok,
       /dialect this validator does not run/.test(checkAgainst({ $schema: "https://json-schema.org/draft/2019-09/schema", type: "string" }, "a").error ?? "")],
      [true, true]);
    // A proposal outside the form is not shown: the seller is asked for the time with nothing to approve.
    const loose = inner => async (m, system, user, hook) => (hook === "propose_value" ? { value: "2026-10-31 14:00:00+09:00" } : inner(m, system, user, hook));
    const lp = await run("g1-01", "clean", [], { ask: loose(makeAsk("g1-01")) });
    const lpv = lp.records.filter(x => x.actor !== "executor").at(-1);
    check("  a proposed date-time with a space for the T is not shown: the time is asked with nothing to approve",
      [lp.first.status, lp.first.question?.block?.[0], lpv?.value_checks?.find(c => c.id === "time:candidate")?.status], ["waiting", "time: not given yet", "rejected"]);
    // A real run (Opus 5.5, 1.37): after the seller's yes the model did not call again, and said the
    //   pickup had been sent. The waiting call goes to the gate again (judge-only-example, 8).
    const SAID_SENT = "You've confirmed the time, so the pickup request is going ahead. Here's what I sent.";
    const noRecall = (a, inner) => (a?.messages?.at(-1)?.content === "yes" && a.messages.at(-2)?.role === "tool" ? { text: SAID_SENT } : inner(a));
    const rs = await run("g1-01", "clean", ["yes"], { chat: noRecall });
    check("the model answers the seller's yes in words, without calling: the waiting call is judged again and runs",
      [rs.last.status, rs.last.resubmitted, rs.calls.map(c => c.args.time), rs.records.filter(x => x.actor !== "executor").map(x => x.execution_decision)],
      ["executed", true, ["2026-10-31T14:00:00+09:00"], ["ask_user", "execute"]]);
    check("  and what the model said is not shown or kept: it said the pickup had been sent before anything ran",
      [rs.last.reply, rs.heard.flat().some(m => String(m?.content ?? "").includes("going ahead"))], [undefined, false]);
    const rc = await run("g1-01", "order_cancelled", ["yes"], { chat: noRecall });
    check("  after a call that did not run, nothing waits: the model's words are its reply, nothing judged again",
      [rc.last.status, rc.last.resubmitted, rc.calls.length, rc.records.filter(x => x.actor !== "executor").length], ["replied", undefined, 0, 1]);
    // [ANSWER CARRIED] A real run (Haiku 5.5, 1.37): the item line was put in the form of a user approval,
    //   asked with the time, and approved in "yes, but make it Saturday 7pm". The next round asked the new
    //   time only. In the round after, the reader placed the item's yes on the last "yes", which answered
    //   the time question: rejected, the first one not reported again, and the run ended at the ceiling.
    //   The stand-in reader places every answer on the latest yes, the same way.
    const itemByApproval = inner => async (m, system, user, hook) => (hook === "comparable_form" && /The item is the listing/.test(user)
      ? { form: { compare: { kind: "user_approval" }, constrains: ["item_id"] } } : inner(m, system, user, hook));
    const carried = await run("g1-01", "clean", ["yes, but make it Saturday 7pm", "yes"], { ask: itemByApproval(makeAsk("g1-01")) });
    const cg = carried.records.filter(x => x.actor !== "executor");
    const itemAnswer = cg.at(-1)?.value_checks?.find(c => c.kind === "answer" && c.status === "checked" && /^approve:/.test(c.target));
    check("an approval given in an earlier round, its yes placed later by the reader: carried, run at 19:00",
      [cg.map(x => x.execution_decision), carried.calls.map(c => c.args.time), itemAnswer?.carried, cg[0]?.gate?.question_block?.length],
      [["ask_user", "ask_user", "execute"], ["2026-10-31T19:00:00+09:00"], true, 2]);
    // The same, but in the last round the reader reports a no for that question, misplaced too: the yes is
    //   not carried over it.
    const noInLastRound = inner => async (m, system, user, hook) => {
      const out = await inner(m, system, user, hook);
      // the round after the plain "yes" was typed: its claim for the item says no
      if (hook === "replies" && /"text":\s*"yes"/.test(user)) for (const r of out.replies ?? []) if (/^approve:/.test(r.target)) r.answer = false;
      return out;
    };
    const contrary = await run("g1-01", "clean", ["yes, but make it Saturday 7pm", "yes"], { ask: noInLastRound(itemByApproval(makeAsk("g1-01"))) });
    check("  this round's reader gives that question another answer: nothing carried, nothing run",
      [contrary.calls.length, contrary.records.filter(x => x.actor !== "executor").at(-1)?.value_checks?.some(c => /not carried/.test(c.note ?? ""))],
      [0, true]);
    // The approval and the change in one message. Before 1.36 only a later segment was read, and the
    //   pickup ran at 2pm.
    const both = await run("g1-01", "clean", ["yes, but make it Saturday 7pm", "yes"]);
    const bAsks = both.records.filter(x => x.execution_decision === "ask_user");
    const bt = bAsks.at(-1)?.fields?.find(f => f.name === "time");
    check("'yes, but make it Saturday 7pm': asked again with the new time, nothing run at 2pm",
      [both.first.status, bAsks.length, bAsks.at(-1)?.gate?.question_block?.[0], both.calls.map(c => c.args.time)],
      ["waiting", 2, "time = 2026-10-31 (Sat) 19:00 +09:00", ["2026-10-31T19:00:00+09:00"]]);
    check("  superseded by words in the message that approved",
      [bt?.lookup_trace?.[0]?.result, bt?.answer_superseded?.by?.segment_index === bt?.answer_superseded?.approval?.located_at?.segment_index],
      ["superseded", true]);
  }

  console.log("\n--- 1-k. the provider's notice is told before the tool runs (spec 3.3) ---");
  {
    const NOTICE = "The buyer sees the time and location immediately. Tell the seller before the pickup is scheduled.";
    // Nothing to ask: no question carried the notice, so it is shown first, and then the tool runs.
    const r = await run("g1-01", "clean", [], { text: ALL_GIVEN, ask: askAllGiven("g1-01") });
    check("every value given in its form: nothing asked, executed in one turn", [r.first.status, r.calls.length], ["executed", 1]);
    check("  the notice is shown first, then the tool is called", r.events, [["notify", [NOTICE]], "call"]);
    const done = r.records.at(-1);
    check("  the executing side's record says it was told, and when", [done.actor, done.execution_decision, done.told.map(t => [t.description, t.when])],
      ["executor", "executed", [[NOTICE, "before_call"]]]);
    // A question carried it: it is not shown a second time.
    check("a run that asked: the notice went with the question, and is not shown again",
      [g1.events, g1.records.at(-1).told.map(t => t.when)], [["call"], ["with_question"]]);
    // No way to show it: the tool does not run.
    const mute = await run("g1-01", "clean", [], { text: ALL_GIVEN, ask: askAllGiven("g1-01"), notify: null });
    check("no way to show a notice, and no question to show it with: not executed", [mute.first.status, mute.calls.length], ["not_executed", 0]);
    check("  the verdict was execute; the executing side's own record says why it did not run",
      [mute.records.map(x => `${x.actor}:${x.execution_decision}`), /a notice could not be shown/.test(mute.records.at(-1).reason)],
      [["gate:execute", "executor:not_executed"], true]);
  }

  console.log("\n--- 1-l. the executing side's decision is a record of its own, also when it does not run (spec 6.4) ---");
  {
    const held = await run("g1-01", "order_cancelled", ["yes"]);
    const last = held.records.at(-1), verdict = held.records.at(-2);
    check("a hold: the gate's verdict, then the executing side's record that it did not run it",
      [verdict.actor, verdict.execution_decision, last.actor, last.execution_decision, held.calls.length], ["gate", "hold", "executor", "not_executed", 0]);
    check("  it says which reading of the record stopped it", /not executed: the verdict is unmet/.test(last.reason), true);
    check("  it is not a verdict: not ready, and nothing a later run carries values from",
      [readyToExecute(last, TOOL.name), graphSide.readyToExecute(last, TOOL.name), await held.store.load(held.key)], [false, false, null]);
    check("  every record says who wrote it", held.records.every(x => x.actor === "gate" || x.actor === "executor"), true);
    // The seller's next words are judged again, and the executing side records its decision again.
    check("  each turn: a verdict, then the executing side's record", held.records.map(x => `${x.actor}:${x.execution_decision}`),
      ["gate:hold", "executor:not_executed", "gate:hold", "executor:not_executed"]);
    // The unit's history is read from the gate's records: a failed call's record is not a second asking.
    let n = 0;
    const retried = await run("g1-01", "clean", ["yes", "Try again."], { callTool: async () => { if (++n === 1) throw new Error("timeout"); return { ok: true }; } });
    check("a call that failed, then tried again: asked once in all, and the second verdict counts it once",
      [retried.records.map(x => `${x.actor}:${x.execution_decision}`), retried.records.filter(x => x.actor === "gate").at(-1).gate.next_ask_attempt],
      [["gate:ask_user", "gate:execute", "executor:failed", "gate:execute", "executor:executed"], 1]);
  }

  console.log("\n--- 1-m. a call for later: what the seller approves is asked before it is scheduled (spec 4.5) ---");
  {
    // The call is to be made later (the classifier says scheduled), and one of the seller's conditions has
    //   no form to compare it in: the seller approves it for the place. Asked now, while the seller is here.
    //   Before 1.33 it was first asked when the call was due.
    let when = "scheduled";
    const inner = makeAsk("g2-01");
    const s = standIn("g2-01", "clean", { ask: async (m, system, user, hook) => (hook === "when_case" ? { when_case: when } : inner(m, system, user, hook)) });
    const main = createMain({ connect: s.connect });
    const userChecklist = S.instructions.find(i => i.id === "g2-01").user_checklist;
    const say = typed => main.turn({ threadId: "later", message: { typed }, userChecklist });
    await say("(stand-in)");
    const asked = await say("Saturday 3pm, Hongdae station lockers");
    check("the time to approve and the condition to approve are asked together, before scheduling",
      [asked.status, asked.question?.block], ["waiting", ["time = 2026-10-31 (Sat) 15:00 +09:00", "public places only — for location = \"Hongdae station lockers\"",
                                                             "Note: The buyer sees the time and location immediately. Tell the seller before the pickup is scheduled."]]);
    const scheduled = await say("yes");
    const recs = () => s.store.list(`user:${TOOL.name}:later`);
    const deferred = (await recs()).filter(x => x.actor === "gate").at(-1);
    check("the seller's yes: scheduled, nothing run, the approval on the record",
      [scheduled.status, deferred.execution_decision, s.calls.length, deferred.user_checklist.find(i => i.id === "chk_public")?.approved_at],
      ["not_executed", "deferred", 0, "at_instruction"]);
    // The call is due: the same conversation is judged again, as a call to make now.
    when = "immediate";
    const due = await say("(the scheduler runs it)");
    const verdict = (await recs()).filter(x => x.actor === "gate").at(-1);
    check("when it is due nothing is asked: the approval given then counts, and it runs",
      [due.status, verdict.phase, verdict.user_checklist.find(i => i.id === "chk_public")?.status, s.calls.map(c => [c.args.time, c.args.location])],
      ["executed", "at_trigger", "verified", [["2026-10-31T15:00:00+09:00", "Hongdae station lockers"]]]);
    // The provider's notice went with the question asked before scheduling, so it is not shown again when
    //   the call is due, when the seller may not be there.
    check("  the notice was told with the question at instruction time, not again before the call",
      [s.events, (await recs()).at(-1).told.map(t => t.when)], [["call"], ["with_question"]]);
  }

  console.log("\n--- 1-n. an optional argument the seller gave in words: asked about, not dropped ([SAID OPTIONAL]) ---");
  {
    // The tool takes an optional ready_by. The seller says when, in words that are not a date-time.
    //   Before 1.35 the argument was neither asked about nor sent, and the pickup ran without it.
    const tool = JSON.parse(JSON.stringify(TOOL));
    tool.inputSchema.properties.ready_by = { type: "string", format: "date-time" };
    const text = `${S.instructions.find(i => i.id === "g1-01").text} Have it ready by noon Saturday.`;
    const NOON = "2026-10-31T12:00:00+09:00";
    const inner = makeAsk("g1-01");
    const ask = async (m, system, user, hook) => {
      if (hook === "propose_value" && /^Field: ready_by:/m.test(user)) return { value: NOON };
      const out = await inner(m, system, user, hook);
      if (hook === "extraction") {
        const segs = JSON.parse(user.slice(user.indexOf("[", user.indexOf("Segments:")), user.indexOf("\n\nFields to locate")));
        const i = segs.findIndex(sg => sg.trust === "user" && sg.text.includes("noon Saturday"));
        out.ready_by = i < 0 ? { found: false } : { found: true, value: "noon Saturday", segment_index: i };
      }
      return out;
    };
    const r = await run("g1-01", "clean", ["yes"], { tool, text, ask });
    const asked = r.records.find(x => x.execution_decision === "ask_user");
    check("the optional argument is asked about with the time, its reading shown",
      [r.first.status, r.first.question?.block?.slice(0, 2), asked.fields.find(f => f.name === "ready_by")?.optional, asked.unknown_count],
      ["waiting", ["time = 2026-10-31 (Sat) 14:00 +09:00", "ready_by = 2026-10-31 (Sat) 12:00 +09:00"], true, 2]);
    const verdict = r.records.filter(x => x.actor === "gate").at(-1);
    check("the seller's yes: sent with the rest, and the record says where it came from",
      [r.last.status, r.calls[0]?.args.ready_by, verdict.extra_fields.map(f => [f.name, f.status, f.source])],
      ["executed", NOON, [["ready_by", "known", "user_answer"]]]);
    // The same tool, and a seller who says nothing about it: nothing more is asked.
    const quiet = await run("g1-01", "clean", ["yes"], { tool, ask });
    check("said nothing about it: not asked, not sent", [quiet.first.question?.block?.length, quiet.last.status, "ready_by" in (quiet.calls[0]?.args ?? {})],
      [g1.first.question?.block?.length, "executed", false]);
  }

  console.log("\n--- 2. what judge.run returns cannot be executed from ---");
  {
    const s = standIn("g1-01", "clean");
    const judge = createJudge({ ask: s.connect.ask, measure: s.connect.measure, readToolDefinition: s.connect.readToolDefinition,
      measurements: MEASUREMENTS, storage: s.store });
    const conversation = s.connect.labelInput({ typed: "x" });
    const toolCall = (await s.connect.chat()).toolCall;
    const r1 = await judge.run({ unitKey: "u1", conversation, toolCall });
    check("it returns the key, what to ask, what is settled, the gate's own words, the notices and the reason", Object.keys(r1),
      ["key", "ask", "questions", "block", "settled", "message", "options", "notices", "reason"]);
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
  // Every decision record of the 35 runs, each carried on through the seller's yes. The agent's side does
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
  check("every decision record: ready exactly when the gate decided execute", disagree, []);
  check("  and some of them were ready (the check is not empty)", [verdicts > 35, ready > 0], [true, true]);

  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("THREW:", e.stack); process.exit(1); });
