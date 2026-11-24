"use strict";

/**
 * Checks adopt-example/ — the files an adopter keeps — from here, so that folder holds no test files.
 *
 * agent.js runs with stand-in connections: the stub models, this folder's tool.json as what the server
 * serves, the same measurements and user turns as the other checks, a tool call that only records. Where
 * a check is about connect.js itself (labelInput, an unconnected measurement, no server), the real
 * function is used.
 *
 * agent.js is createAgent with middleware.js.
 *
 *   npm run check
 */

const fs = require("fs");
const path = require("path");
const ADOPT = path.join(__dirname, "..", "..", "adopt-example");
const { createAgent, systemPrompt } = require(path.join(ADOPT, "agent"));
const { StubChatModel } = require("./stub-chat-model");
const realConnect = require(path.join(ADOPT, "connect"));
const { runArm, measuredFor, measurePort, MEASUREMENTS } = require("./arm");
const TOOL = require("./tool.json");
const { buildUserTurn } = require("./prompts");
const { makeAsk, makeChat } = require("./stub");
const shapes = require("./shape-check");
const { recordStore } = require(path.join(__dirname, "..", "..", "adopt-example", "records"));
const { InMemoryStore, MemorySaver } = require(path.join(__dirname, "..", "..", "adopt-example", "node_modules", "@langchain/langgraph"));
const { createStorage } = require(path.join(ADOPT, "judge-only"));
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
let thread = 0;

// Stand-in connections for one instruction in one condition. Anything not overridden is a stand-in: the
//   stub model, this folder's tool.json as the server's one tool, the condition's platform facts.
function standIn(id, condition, over = {}) {
  const ctx = { ...S.conditions[condition].context, ...(over.ctx ?? {}) }, date = S.date_modes.said;
  const calls = [], prompts = [], events = [];
  const text = over.text ?? S.instructions.find(i => i.id === id).text;
  let first = true;
  return {
    calls, prompts, events,
    connect: {
      // The provider's notices, shown before the call when no question carried them; the user's settings.
      ...(over.notify === null ? {} : { notify: async lines => { events.push(["notify", lines]); } }),
      ...(over.readPreSet ? { readPreSet: over.readPreSet } : {}),
      ask: shapes.watch(over.ask ?? makeAsk(id)),
      chat: async req => { prompts.push(req.system); return makeChat()(req); },
      // agent.js on createAgent: the same stand-in, as a LangChain chat model.
      async chatModel() { return new StubChatModel(a => this.chat(a)); },
      listTools: async () => [TOOL],
      readToolDefinition: over.readToolDefinition ?? (async name => [TOOL].find(t => t.name === name)),
      measure: over.measure ?? measurePort(measuredFor(ctx, date)),
      // The first message arrives with the condition's context; later ones are what the seller typed.
      labelInput: over.labelInput ?? (msg => {
        if (first) { first = false; return buildUserTurn(ctx, text, date).segments; }
        return realConnect.labelInput(msg);
      }),
      callTool: async (name, args) => { events.push("call"); calls.push({ name, args }); return { ok: true }; },
      store: baseStoreRecords(),
      checkpointer: new MemorySaver(),
      // The names this system can measure (connect.js's MEASUREMENTS keys).
      MEASUREMENTS: Object.fromEntries(MEASUREMENTS.map(n => [n, async () => undefined])),
      MODEL_NAME: "stub",
    },
  };
}
const run = async (id, condition, over = {}, replies = [], make = createAgent) => {
  const s = standIn(id, condition, over);
  const agent = make({ connect: s.connect });
  const threadId = `t${++thread}`;
  const first = await agent.start({ threadId, message: { typed: "(stand-in)" }, userChecklist: S.instructions.find(i => i.id === id).user_checklist ?? [] });
  let last = first;
  for (const r of replies) last = r === "CANCEL" ? await agent.cancel({ threadId }) : await agent.reply({ threadId, message: { typed: r } });
  return { first, last, calls: s.calls, events: s.events, prompts: s.prompts, store: s.connect.store, key: `user:${TOOL.name}:${threadId}` };
};


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
  console.log("--- 1. the folder holds only what an adopter keeps ---");
  const files = fs.readdirSync(ADOPT).filter(f => f !== "node_modules").sort();
  check("adopt-example files", files, ["README.md", "agent.js", "connect.js", "judge-only-example.js", "judge-only.js", "middleware.js", "package-lock.json", "package.json", "principles-gated.md", "principles.md", "records.js", "tool.json"]);
  // tool.json is the declaration the agent reads by default, an MCP tool definition: it must be the tool the tests run.
  const declared = JSON.parse(fs.readFileSync(path.join(ADOPT, "tool.json"), "utf8"));
  check("  tool.json is the tool the tests run: an MCP tool definition, the same name, description, input schema",
    [Object.keys(declared), declared.name, declared.description, JSON.stringify(declared.inputSchema)], [["name", "description", "inputSchema"], TOOL.name, TOOL.description, JSON.stringify(TOOL.inputSchema)]);
  // principles.md is spec 6.2 as prompt sentences: every bullet must be the spec's own sentence.
  const spec = fs.readFileSync(path.join(__dirname, "..", "..", "spec.en.md"), "utf8");
  const bullets = fs.readFileSync(path.join(ADOPT, "principles.md"), "utf8").split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2));
  check("principles.md: ten bullets, each word for word in spec 6.2", [bullets.length, bullets.filter(b => !spec.includes(b))], [10, []]);
  check("  and they are what systemPrompt(\"principles.md\") gives", bullets.every(b => systemPrompt("principles.md").includes(b)), true);
  // principles-gated.md: what the model needs to know when a gate judges its calls. Each line names the
  //   spec section it comes from; the reference is for the reader, not sent to the model.
  const gated = fs.readFileSync(path.join(ADOPT, "principles-gated.md"), "utf8").split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2));
  const refs = gated.map(b => (b.match(/\(spec ([^)]*)\)$/) ?? [])[1]);
  const sections = new Set([...spec.matchAll(/^#+ (\d+(?:\.\d+)*)\b/gm)].map(m => m[1]));
  check("principles-gated.md: every line names spec sections, and each section exists",
    [gated.length > 0, refs.every(Boolean), refs.flatMap(r => (r ?? "").split(/,\s*/)).filter(s => !sections.has(s))], [true, true, []]);
  const gatedPrompt = systemPrompt("principles-gated.md");
  check("  with a gate, the agent's system prompt is principles-gated.md by default", systemPrompt(), gatedPrompt);
  check("  in the system prompt, each line without its reference",
    [gated.every(b => gatedPrompt.includes(b.replace(/\s*\(spec [^)]*\)$/, ""))), gatedPrompt.includes("(spec ")], [true, false]);
  check("  the tool-selection lines are spec 6.2's own sentences",
    gated.filter(b => b.endsWith("(spec 6.2)")).map(b => spec.includes(b.replace(/\s*\(spec [^)]*\)$/, ""))), [true, true]);

  console.log("\n--- 2. connect.js as shipped: the tools from tool.json, and it fails closed ---");
  {
    const prior = process.env.TOOLS_FILE;
    delete process.env.TOOLS_FILE;
    const listed = await realConnect.listTools();
    check("by default the tools are read from tool.json, beside connect.js", [listed.length, JSON.stringify(listed[0]) === JSON.stringify(TOOL)], [1, true]);
    const shipped = await run("g4-01", "clean", { readToolDefinition: realConnect.readToolDefinition, measure: realConnect.measure });
    const verdictRecord = (await shipped.store.list(shipped.key)).filter(r => r.actor === "gate" && r.provider_checklist).at(-1);
    const measuredLines = (verdictRecord?.provider_checklist ?? []).filter(c => c.compare?.source === "measured_data");
    check("as shipped: the definition is read, no measurement is connected, so nothing runs",
      [shipped.first.verdict.decision, measuredLines.length, measuredLines.every(c => c.status === "unverified"), shipped.calls.length],
      ["definition_repair", 2, true, 0]);
    check("an unconnected measurement reads as not measured", await realConnect.measure("order_status", { values: { item_id: "LST-2291" } }), { valid: false });
    let refused = null;
    try { await realConnect.callTool("schedule_pickup", {}); } catch (e) { refused = e.message; }
    check("an unconnected tool is not called", /not connected/.test(refused ?? ""), true);
    const other = await run("g4-01", "clean", { readToolDefinition: async () => realConnect.readToolDefinition("cancel_pickup") });
    check("a tool that is not declared: its definition is not read, nothing runs", [other.first.status, /tool definition not read/.test(other.first.verdict?.reason ?? "")],
      ["definition_repair", true]);

    console.log("\n--- 2-b. the declaration is the definition, read on every run ---");
    const os = require("os");
    const fromFile = await run("g1-01", "clean", { readToolDefinition: realConnect.readToolDefinition }, ["yes"]);
    check("the gate reads tool.json: asks, the seller says yes, executes", [fromFile.first.status, fromFile.last.status, fromFile.calls[0]?.args.time],
      ["waiting", "executed", SAT_2PM]);
    const edited = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tools-")), "tool.json");
    fs.writeFileSync(edited, fs.readFileSync(path.join(ADOPT, "tool.json"), "utf8").replace("It is one moment.", "It is one moment, in the seller's time zone."));
    process.env.TOOLS_FILE = edited;
    const changed = await run("g1-01", "clean", { readToolDefinition: realConnect.readToolDefinition });
    const hashOf = async r => (await r.store.list(`user:schedule_pickup:t${thread}`)).find(x => x.tool_definition)?.tool_definition?.hash;
    const hChanged = await hashOf(changed);
    delete process.env.TOOLS_FILE;
    const same = await run("g1-01", "clean", { readToolDefinition: realConnect.readToolDefinition });
    check("TOOLS_FILE points elsewhere: that declaration is read, and the record shows the change", hChanged !== await hashOf(same), true);
    const refuses = t => { try { realConnect.readToolFile(t); return "read"; } catch { return "refused"; } };
    check("a file that is not a tool definition is not read", [refuses("# nothing"), refuses('{"name": "x"}'), refuses(JSON.stringify(TOOL))], ["refused", "refused", "read"]);
    if (prior !== undefined) process.env.TOOLS_FILE = prior;

    // The MCP connection is kept in connect.js as comments, for tools on someone else's server. Uncommented,
    //   it must still be code: checked here for syntax, not run.
    const src = fs.readFileSync(path.join(ADOPT, "connect.js"), "utf8");
    const start = src.indexOf("// let mcp = null;");
    const end = src.indexOf("\n\n", src.indexOf("// async function mcpCallTool"));
    const uncommented = src.slice(start, end).split("\n").map(l => l.replace(/^\/\/ ?/, "")).join("\n");
    let syntax = "ok";
    try { new Function("require", "process", `${uncommented}\nreturn { mcpListTools, mcpReadToolDefinition, mcpCallTool, mcpClient };`); } catch (e) { syntax = e.message; }
    check("the MCP connection kept as comments is code once uncommented", [start > 0, syntax], [true, "ok"]);
    check("  LangChain's MCP connection, and it keeps the server's requests for input behind the gate",
      [/require\("@langchain\/mcp-adapters"\)/.test(uncommented), /elicitation: false/.test(uncommented), /cacheMode: "refresh"/.test(uncommented)], [true, true, true]);
  }

  console.log("\n--- 3. labelInput as shipped: only what the user typed is the user's ---");
  const segs = realConnect.labelInput({ typed: "Set up the pickup for LST-2291.", context: [{ text: "Buyer: 9pm tonight at your door?" }] });
  check("context is untrusted, the typed message is the user's", segs.map(s => s.trust), ["untrusted", "user"]);

  console.log("\n--- 3-b. the stores keep every record and can list them ---");
  {
    const os = require("os"), { execFileSync } = require("child_process");
    const script = `const { store } = require(${JSON.stringify(path.join(ADOPT, "connect"))});
      (async () => {
        await store.persist("k", { n: 1, execution_decision: "hold" });
        await store.persist("other", { n: 9 });
        await store.persist("k", { n: 2, execution_decision: "executed" });
        await store.persist("k", { n: 3, execution_decision: "ask_user" });
        console.log(JSON.stringify({ list: (await store.list("k")).map(r => r.n), load: (await store.load("k"))?.n, none: await store.list("absent") }));
      })();`;
    const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { env: process.env }).toString());
    check("connect.js store: list is every record under the key, oldest first", out.list, [1, 2, 3]);
    check("  load is the latest that executed", out.load, 2);
    check("  an unknown key lists nothing", out.none, []);
    const mem = createStorage();
    await mem.persist("k", { n: 1 }); await mem.persist("k", { n: 2 });
    check("judge-only.js createStorage: list too", (await mem.list("k")).map(r => r.n), [1, 2]);
  }

  console.log("\n--- 4. start, ask, reply, execute ---");
  const g1 = await run("g1-01", "clean", {}, ["yes"]);
  check("g1-01: waits on a question, the model's reading of the time shown by code", [g1.first.status, g1.first.question?.block?.[0]],
    ["waiting", "time = 2026-10-31 (Sat) 14:00 +09:00"]);
  check("  the provider's notice goes with it", g1.first.question?.block?.some(l => l.startsWith("Note: The buyer sees")), true);
  check("  the seller's yes: executed once, with the record's arguments", [g1.last.status, g1.calls.length, g1.calls[0]?.args.time], ["executed", 1, SAT_2PM]);
  check("  the location is the seller's words", g1.calls[0]?.args.location, "Hongdae station lockers");
  check("  the principles were in the model's system prompt", g1.prompts.every(p => p.includes("Do not fill in a value the user did not give")), true);
  const kept = [];
  for (const key of ["user:schedule_pickup:" + `t${thread}`]) kept.push(...await g1.store.list(key));
  const rec = kept.filter(r => r.provider_checklist).at(-1);
  const sale = rec?.provider_checklist?.find(c => c.description?.startsWith("The sale must be agreed"));
  check("the record carries the definition read, the line's version and its translation",
    [typeof rec?.tool_definition?.hash, typeof sale?.rule_hash, sale?.form_translation?.translated_by], ["string", "string", "stub"]);
  const cancelled = await run("g1-01", "clean", {}, ["CANCEL"]);
  check("the seller stops: nothing runs", [cancelled.last.status, cancelled.calls.length], ["cancelled", 0]);

  console.log("\n--- 3-y. the model's settings, from the environment ---");
  {
    const { modelOptions } = require("../../adopt-example/connect");
    const err = env => { try { modelOptions(env); return null; } catch (e) { return e.message; } };
    check("nothing set: nothing sent", modelOptions({}), {});
    const { structuredMethod } = require("../../adopt-example/connect");
    check("an Anthropic model: the answer's shape goes through its structured outputs; another: LangChain's default",
      [structuredMethod({ MODEL: "anthropic:claude-sonnet-5-5" }), structuredMethod({ MODEL: "openai:gpt-6" }), modelOptions({ MODEL: "anthropic:claude-sonnet-5-5" })],
      ["jsonSchema", undefined, {}]);
    check("TEMPERATURE=0: sent", modelOptions({ TEMPERATURE: "0" }), { temperature: 0 });
    check("MODEL_OPTIONS: given as it is", modelOptions({ MODEL_OPTIONS: '{"useResponsesApi":true,"reasoning":{"effort":"low"}}' }),
      { useResponsesApi: true, reasoning: { effort: "low" } });
    check("both: TEMPERATURE over MODEL_OPTIONS", modelOptions({ MODEL_OPTIONS: '{"temperature":1,"useResponsesApi":true}', TEMPERATURE: "0" }),
      { temperature: 0, useResponsesApi: true });
    check("MODEL_OPTIONS not JSON, or not an object: an error",
      [/not JSON/.test(err({ MODEL_OPTIONS: "useResponsesApi=true" }) ?? ""), /JSON object/.test(err({ MODEL_OPTIONS: "[1]" }) ?? ""),
       /JSON object/.test(err({ MODEL_OPTIONS: "true" }) ?? "")], [true, true, true]);
  }

  console.log("\n--- 3-z. a model's answer comes in the shape asked (withStructuredOutput), or as an error that keeps it ---");
  {
    const { askWith } = require("../../adopt-example/connect");
    const { SHAPES } = require("../../adopt-example/judge-only");
    // A model as LangChain hands it: withStructuredOutput(schema, options) gives something to invoke.
    const fake = res => { const seen = {}; return { seen, withStructuredOutput(schema, options) { Object.assign(seen, { schema, options }); return { invoke: async msgs => { seen.msgs = msgs; return res; } }; } }; };
    const ok = fake({ raw: { content: "" }, parsed: { approved: true, reason: "the same act" } });
    const got = await askWith(ok, "sys", "user", "tool_match", SHAPES.tool_match);
    check("the shape goes to withStructuredOutput, named for the call, and the answer is what it read",
      [got, ok.seen.schema === SHAPES.tool_match, ok.seen.options, ok.seen.msgs.map(m => m.role)],
      [{ approved: true, reason: "the same act" }, true, { name: "tool_match", includeRaw: true }, ["system", "user"]]);
    await askWith(ok, "sys", "user", "tool_match", SHAPES.tool_match, "jsonSchema");
    check("  the method, when given, goes with it", ok.seen.options, { name: "tool_match", includeRaw: true, method: "jsonSchema" });
    let a = null, b = null;
    try { await askWith(fake({ raw: { content: "Sure! Before I book it, please confirm the time." }, parsed: null }), "s", "u", "tool_match", SHAPES.tool_match); } catch (e) { a = e.message; }
    check("not in the shape: an error that carries what the model wrote", [/not in the shape asked/.test(a ?? ""), /please confirm the time/.test(a ?? "")], [true, true]);
    try { await askWith(fake({ raw: { content: "x" }, parsed: { approved: true } }), "s", "u", "tool_match"); } catch (e) { b = e.message; }
    check("  a call with no shape is refused, not sent", /no shape given/.test(b ?? ""), true);
  }

  {
    const sq = standIn("g1-01", "clean");
    sq.connect.say = async (m, sys, u, h) => (h === "question" ? "Plain words from say." : "");
    const aq = createAgent({ connect: sq.connect });
    const rq = await aq.start({ threadId: `q${++thread}`, message: { typed: "x" } });
    check("the question starts with what say wrote", rq.question?.message.split("\n")[0], "Plain words from say.");
  }

  console.log("\n--- 4-0. the agent's model is not shown the provider's labelled lines ---");
  {
    const sm = standIn("g1-01", "clean");
    const given = [];
    const inner = sm.connect.chat;
    sm.connect.chat = async a => { given.push(a?.tools ?? null); return inner(a); };
    const am = createAgent({ connect: sm.connect });
    const idM = `m${++thread}`;
    await am.start({ threadId: idM, message: { typed: "x" } });
    const rm = await am.reply({ threadId: idM, message: { typed: "yes" } });
    check("every list the model was given had no labelled line, and the run still executes",
      [given.length > 0, given.flat().some(t => /^\[(Required|Verify|Notice)\]/m.test(t?.description ?? "")), rm.status], [true, false, "executed"]);
  }

  {
    // The gate could not match the tool: the agent shows the gate's own words and waits.
    const su = standIn("g1-01", "clean");
    const stubAsk = su.connect.ask;
    let n = 0;
    su.connect.ask = (m, s, u, h, shape) => (h === "tool_match" ? { approved: n++ >= 1, reason: "stand-in" } : stubAsk(m, s, u, h, shape));
    const au = createAgent({ connect: su.connect });
    const idU = `u${++thread}`;
    const r1 = await au.start({ threadId: idU, message: { typed: "x" } });
    check("the tool is not matched: waiting, with the gate's own words", [r1.status, r1.question?.message],
      ["waiting", "I could not tell which action this maps to. Please describe what you want done, in your own words."]);
    await au.reply({ threadId: idU, message: { typed: "Schedule the pickup, as I said." } });
    const r3 = await au.reply({ threadId: idU, message: { typed: "yes" } });
    check("  the user says it again: the run goes on, and executes on yes", [r3.status, su.calls.length], ["executed", 1]);
  }

  console.log("\n--- 4-a. the executing step starts from the record ---");
  const verdictRec = kept.filter(r => r.execution_decision === "execute").at(-1);
  check("the arguments sent are the record's", g1.calls[0]?.args, verdictRec?.call_arguments);
  check("  what the gate hands the agent carries no arguments", ["call_arguments" in g1.last.verdict, JSON.stringify(g1.last.verdict).includes(SAT_2PM)], [false, false]);
  check("  what happened is written back, and a later run may carry values from it",
    [kept.at(-1)?.execution_decision, (await g1.store.load(kept.at(-1)?.action_key))?.execution_decision], ["executed", "executed"]);
  {
    // The gate decides execute, but the executing step cannot read that record: nothing runs.
    const sh = standIn("g1-01", "clean");
    const base = sh.connect.store;
    sh.connect.store = { ...base, list: async k => (await base.list(k)).filter(r => r.execution_decision !== "execute") };
    const ah = createAgent({ connect: sh.connect });
    const id = `h${++thread}`;
    await ah.start({ threadId: id, message: { typed: "x" } });
    const rh = await ah.reply({ threadId: id, message: { typed: "yes" } });
    check("the record of the verdict cannot be read back: not executed", [rh.status, sh.calls.length], ["not_executed", 0]);
    // What is sent is what the record says, not what the agent was handed.
    const sr = standIn("g1-01", "clean");
    const baseR = sr.connect.store;
    sr.connect.store = { ...baseR, list: async k => (await baseR.list(k)).map(r => r.execution_decision === "execute"
      ? { ...r, call_arguments: { ...r.call_arguments, location: "as the record says" } } : r) };
    const ar = createAgent({ connect: sr.connect });
    const idR = `h${++thread}`;
    await ar.start({ threadId: idR, message: { typed: "x" } });
    await ar.reply({ threadId: idR, message: { typed: "yes" } });
    check("the tool receives the record's arguments", sr.calls[0]?.args.location, "as the record says");
  }

  console.log("\n--- 4-b. a call that does not complete is not counted as executed ---");
  // A server's request for input (MCP input_required), as the MCP connection hands it back.
  const ask = { method: "elicitation/create", params: { mode: "form", message: "Card PIN?", requestedSchema: { type: "object", properties: { pin: { type: "string" } } } } };
  for (const [label, result, want] of [
    ["the server asked during the call: stopped, not executed", async () => ({ inputRequired: { pin: ask } }), "input_required"],
    ["the tool reports an error: not counted as executed", async () => ({ isError: true, content: [{ type: "text", text: "slot taken" }] }), "tool_error"],
    ["the call throws: reported, not executed", async () => { throw new Error("connection reset"); }, "call_failed"],
  ]) {
    const sf = standIn("g1-01", "clean");
    sf.connect.callTool = async (n, a) => { sf.calls.push(a); return result(); };
    const af = createAgent({ connect: sf.connect });
    const id = `f${++thread}`;
    await af.start({ threadId: id, message: { typed: "x" } });
    const rf = await af.reply({ threadId: id, message: { typed: "yes" } });
    check(label, [rf.status, rf.executedWith, sf.calls.length], [want, null, 1]);
    check("  and it is recorded as failed, not as something to carry values from",
      [(await sf.connect.store.list(`user:schedule_pickup:${id}`)).at(-1)?.execution_decision, await sf.connect.store.load(`user:schedule_pickup:${id}`)], ["failed", null]);
  }

  console.log("\n--- 4-c. the executing step: notices before the call, its own record, the user's settings ---");
  {
    const NOTICE = "The buyer sees the time and location immediately. Tell the seller before the pickup is scheduled.";
    const r = await run("g1-01", "clean", { text: ALL_GIVEN, ask: askAllGiven("g1-01") });
    const recs = await r.store.list(r.key);
    check("nothing to ask: the notice is shown, then the tool is called", [r.first.status, r.events], ["executed", [["notify", [NOTICE]], "call"]]);
    check("  the executing step's record says so", [recs.at(-1).actor, recs.at(-1).told.map(t => t.when)], ["executor", ["before_call"]]);
    const mute = await run("g1-01", "clean", { text: ALL_GIVEN, ask: askAllGiven("g1-01"), notify: null });
    const mrecs = await mute.store.list(mute.key);
    check("no way to show the notice: not executed, and the step's own record says why",
      [mute.first.status, mute.calls.length, mrecs.map(x => `${x.actor}:${x.execution_decision}`)], ["not_executed", 0, ["gate:execute", "executor:not_executed"]]);
    const held = await run("g1-01", "order_cancelled", {}, ["yes"]);
    const hrecs = await held.store.list(held.key);
    check("a hold: the step's record that it did not run it follows the verdict",
      [held.last.status, hrecs.slice(-2).map(x => `${x.actor}:${x.execution_decision}`)], ["hold", ["gate:hold", "executor:not_executed"]]);
    // The seller's saved place (spec 5.2) reaches the gate too: g6-01's "my usual spot".
    const preSet = S.instructions.find(i => i.id === "g6-01").pre_set;
    const saved = await run("g6-01", "clean", { readPreSet: async () => preSet }, ["yes"]);
    check("readPreSet reaches the gate: the saved place is the one used",
      [saved.last.status, saved.calls[0]?.args.location], ["executed", preSet.location.value]);
    const none = await run("g6-01", "clean", {}, ["yes"]);
    check("  without it the place is still to be given: nothing runs", [none.calls.length, none.last.status === "executed"], [0, false]);
  }

  console.log("\n--- 5. the agent's first verdict is the arm's ---");
  const mismatched = [];
  for (const ins of S.instructions) {
    for (const condition of S.instruction_conditions[String(ins.group)] ?? []) {
      const ctx = S.conditions[condition].context, date = S.date_modes.said;
      const arm = await runArm({ ctx, instructionText: ins.text, userChecklist: ins.user_checklist ?? [], date, ask: makeAsk(ins.id), runId: `a-${ins.id}` });
      const agent = await run(ins.id, condition);
      if (arm.decision !== agent.first.verdict.decision) mismatched.push(`${ins.id}/${condition}: ${arm.decision} vs ${agent.first.verdict.decision}`);
    }
  }
  check("35 runs: the same decision", mismatched, []);

  // Two calls in one message, of two tools, both waiting on a question (spec 1.1: two calls, two gates). Each question is
  //   shown, and an answer goes to the call it was given for (spec 6.3). Before, agent.js showed the first
  //   question only, and its answer was handed to both calls: the second ran on a question never shown.
  console.log("\n--- the demonstration: two calls in one message, both asking ---");
  {
    const { FakeToolCallingModel } = require(path.join(ADOPT, "node_modules", "langchain"));
    // One instruction, two tools: each its own key (one tool, one key).
    const OTHER = { ...TOOL, name: `${TOOL.name}_copy` };
    const two = () => [[{ name: TOOL.name, args: {}, id: "c1" }, { name: OTHER.name, args: {}, id: "c2" }], []];
    const begin = async () => {
      const s = standIn("g1-01", "clean");
      s.connect.listTools = async () => [TOOL, OTHER];
      s.connect.readToolDefinition = async name => [TOOL, OTHER].find(t => t.name === name);
      s.connect.chatModel = async () => new FakeToolCallingModel({ toolCalls: two() });
      const agent = createAgent({ connect: s.connect }), threadId = `t${++thread}`;
      return { s, agent, threadId, first: await agent.start({ threadId, message: { typed: "(stand-in)" } }) };
    };
    const w = await begin();
    check("both wait, each with its question, and the message shows both",
      [w.first.status, (w.first.waiting ?? []).map(x => [x.tool_call_id, x.question.questions.map(q => q.target)]),
       (w.first.waiting ?? []).every(x => w.first.question.message.includes(x.question.message)), w.s.calls.length],
      ["waiting", [["c1", ["value:time"]], ["c2", ["value:time"]]], true, 0]);
    const typed = await w.agent.reply({ threadId: w.threadId, message: { typed: "yes" } });
    check("  a yes typed after both: each call reads it for its own question, and each runs",
      [typed.status, typed.results.map(r => [r.tool_call_id, r.status]), w.s.calls.length], ["several", [["c1", "executed"], ["c2", "executed"]], 2]);

    const f = await begin();
    const byCall = await f.agent.reply({ threadId: f.threadId, answers: { c1: { "value:time": true } } });
    check("  a form answered for one call: that one runs; the other had no answer, and does not",
      [byCall.status, byCall.results.map(r => [r.tool_call_id, r.status]), f.s.calls.length], ["several", [["c1", "executed"], ["c2", "cancelled"]], 1]);
    // Spec 6.4: not running it is the executing side's decision, recorded as its own on the verdict that waited.
    const c2recs = (await f.s.connect.store.list(`user:${OTHER.name}:${f.threadId}`)).filter(x => "execution_decision" in x);
    check("  the executing side records that it did not run the unanswered one, and why",
      [c2recs.map(x => `${x.actor ?? "gate"}:${x.execution_decision}`), /did not answer the question \(decline\)/.test(c2recs.at(-1)?.reason ?? ""),
       /did not answer/.test(byCall.results[1]?.why ?? "")], [["gate:ask_user", "executor:not_executed"], true, true]);

    const u = await begin();
    let refused = null;
    try { await u.agent.reply({ threadId: u.threadId, answers: { "value:time": true } }); } catch (e) { refused = e.message; }
    check("  a form's answers not given by call, with two waiting: refused, nothing runs",
      [/by tool call id/.test(refused ?? ""), u.s.calls.length], [true, 0]);
  }

  console.log("\n--- [ANSWER SHAPES] ---");
  shapes.report(check);

  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("THREW:", e.stack); process.exit(1); });
