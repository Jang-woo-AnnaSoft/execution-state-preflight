"use strict";

/**
 * Checks adopt-example/ — the files an adopter keeps — from here, so that folder holds no test files.
 *
 * agent.js runs with stand-in connections: the stub models, this folder's tool.json as what the server
 * serves, the same measurements and user turns as the other checks, a tool call that only records. Where
 * a check is about connect.js itself (labelInput, an unconnected measurement, no server), the real
 * function is used.
 *
 *   npm run check
 */

const fs = require("fs");
const path = require("path");
const ADOPT = path.join(__dirname, "..", "adopt-example");
const { createAgent, systemPrompt } = require(path.join(ADOPT, "agent"));
const realConnect = require(path.join(ADOPT, "connect"));
const gate = require(path.join(ADOPT, "gate"));
const { runArm, measuredFor, measurePort, MEASUREMENTS } = require("./arm");
const TOOL = require("./tool.json");
const { buildUserTurn } = require("./prompts");
const { makeAsk, makeChat } = require("./stub");
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
  const calls = [], prompts = [];
  const text = S.instructions.find(i => i.id === id).text;
  let first = true;
  return {
    calls, prompts,
    connect: {
      ask: over.ask ?? makeAsk(id),
      chat: async req => { prompts.push(req.system); return makeChat()(req); },
      listTools: async () => [TOOL],
      readToolDefinition: over.readToolDefinition ?? (async name => [TOOL].find(t => t.name === name)),
      measure: over.measure ?? measurePort(measuredFor(ctx, date)),
      // The first message arrives with the condition's context; later ones are what the seller typed.
      labelInput: over.labelInput ?? (msg => {
        if (first) { first = false; return buildUserTurn(ctx, text, date).segments; }
        return realConnect.labelInput(msg);
      }),
      callTool: async (name, args) => { calls.push({ name, args }); return { ok: true }; },
      store: gate.createStorage(),
      checkpointer: new gate.MemorySaver(),
      // The names this system can measure (connect.js's MEASUREMENTS keys).
      MEASUREMENTS: Object.fromEntries(MEASUREMENTS.map(n => [n, async () => undefined])),
      MODEL_NAME: "stub",
    },
  };
}
const run = async (id, condition, over = {}, replies = []) => {
  const s = standIn(id, condition, over);
  const agent = createAgent({ connect: s.connect });
  const threadId = `t${++thread}`;
  const first = await agent.start({ threadId, message: { typed: "(stand-in)" }, userChecklist: S.instructions.find(i => i.id === id).user_checklist ?? [] });
  let last = first;
  for (const r of replies) last = r === "CANCEL" ? await agent.cancel({ threadId }) : await agent.reply({ threadId, message: { typed: r } });
  return { first, last, calls: s.calls, prompts: s.prompts, store: s.connect.store };
};

(async () => {
  console.log("--- 1. the folder holds only what an adopter keeps ---");
  const files = fs.readdirSync(ADOPT).filter(f => f !== "node_modules").sort();
  check("adopt-example files", files, ["README.md", "agent.js", "connect.js", "gate.js", "package-lock.json", "package.json", "principles.md", "tool.md"]);
  // tool.md is a declaration of the tool. The code reads a declaration only where TOOLS_FILE points, and
  //   the example must be the tool the tests run.
  const code = ["agent.js", "connect.js", "gate.js"].map(f => fs.readFileSync(path.join(ADOPT, f), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")).join("\n");
  check("  no file name in the code: a declaration is read only where TOOLS_FILE points", /tool\.md|tool\.json/.test(code), false);
  const md = fs.readFileSync(path.join(ADOPT, "tool.md"), "utf8");
  const blocks = [...md.matchAll(/```(\w+)\n([\s\S]*?)\n```/g)].map(m => [m[1], m[2]]);
  const texts = blocks.filter(([k]) => k === "text").map(([, b]) => b), json = blocks.find(([k]) => k === "json")?.[1];
  check("  tool.md is the tool the tests run: name, description, input schema",
    [texts[0], texts[1], JSON.stringify(JSON.parse(json ?? "null"))], [TOOL.name, TOOL.description, JSON.stringify(TOOL.inputSchema)]);
  // principles.md is spec 6.2 as prompt sentences: every bullet must be the spec's own sentence.
  const spec = fs.readFileSync(path.join(__dirname, "..", "spec.en.md"), "utf8");
  const bullets = fs.readFileSync(path.join(ADOPT, "principles.md"), "utf8").split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2));
  check("principles.md: ten bullets, each word for word in spec 6.2", [bullets.length, bullets.filter(b => !spec.includes(b))], [10, []]);
  check("  and they are in the agent's system prompt", bullets.every(b => systemPrompt().includes(b)), true);

  console.log("\n--- 2. connect.js as shipped fails closed ---");
  const unread = await run("g4-01", "clean", { readToolDefinition: realConnect.readToolDefinition });
  check("no MCP server set: the definition is not read, nothing runs", [unread.first.status, /tool definition not read/.test(unread.first.verdict?.reason ?? "")],
    ["definition_repair", true]);
  const unconnected = await run("g4-01", "clean", { measure: realConnect.measure });
  check("no measurement connected: the [Required] lines unverified", unconnected.first.verdict.decision, "definition_repair");
  check("  and nothing runs", unconnected.calls.length, 0);
  check("an unconnected measurement reads as not measured", await realConnect.measure("order_status", { values: { item_id: "LST-2291" } }), { valid: false });

  console.log("\n--- 2-b. building the tool too: the declaration file is the definition ---");
  {
    const os = require("os");
    const prior = process.env.TOOLS_FILE;
    process.env.TOOLS_FILE = path.join(ADOPT, "tool.md");
    const listed = await realConnect.listTools();
    check("TOOLS_FILE: the tools are read from the declaration", [listed.length, JSON.stringify(listed[0]) === JSON.stringify(TOOL)], [1, true]);
    const fromFile = await run("g1-01", "clean", { readToolDefinition: realConnect.readToolDefinition }, ["yes"]);
    check("  the gate reads it as it reads a server's list: executes the same", [fromFile.first.status, fromFile.last.status, fromFile.calls[0]?.args.time],
      ["waiting", "executed", SAT_2PM]);
    const edited = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tools-")), "tool.md");
    fs.writeFileSync(edited, fs.readFileSync(process.env.TOOLS_FILE, "utf8").replace("It is one moment.", "It is one moment, in the seller's time zone."));
    process.env.TOOLS_FILE = edited;
    const changed = await run("g1-01", "clean", { readToolDefinition: realConnect.readToolDefinition });
    const hashOf = async r => (await r.store.list(`user:schedule_pickup:t${thread}`)).find(x => x.tool_definition)?.tool_definition?.hash;
    const hChanged = await hashOf(changed);
    process.env.TOOLS_FILE = path.join(ADOPT, "tool.md");
    const same = await run("g1-01", "clean", { readToolDefinition: realConnect.readToolDefinition });
    check("  a changed declaration is read on the next run, and the record shows it", hChanged !== await hashOf(same), true);
    check("  a file that is not a declaration is not read", (() => { try { realConnect.readToolFile("# nothing"); return "read"; } catch { return "refused"; } })(), "refused");
    if (prior === undefined) delete process.env.TOOLS_FILE; else process.env.TOOLS_FILE = prior;
  }

  console.log("\n--- 3. labelInput as shipped: only what the user typed is the user's ---");
  const segs = realConnect.labelInput({ typed: "Set up the pickup for LST-2291.", context: [{ text: "Buyer: 9pm tonight at your door?" }] });
  check("context is untrusted, the typed message is the user's", segs.map(s => s.trust), ["untrusted", "user"]);

  console.log("\n--- 3-b. the stores keep every record and can list them ---");
  {
    const os = require("os"), { execFileSync } = require("child_process");
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "adopt-")), "records.jsonl");
    const script = `const { store } = require(${JSON.stringify(path.join(ADOPT, "connect"))});
      (async () => {
        await store.persist("k", { n: 1, execution_decision: "hold" });
        await store.persist("other", { n: 9 });
        await store.persist("k", { n: 2, execution_decision: "executed" });
        await store.persist("k", { n: 3, execution_decision: "ask_user" });
        console.log(JSON.stringify({ list: (await store.list("k")).map(r => r.n), load: (await store.load("k"))?.n, none: await store.list("absent") }));
      })();`;
    const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { env: { ...process.env, RECORD_PATH: tmp } }).toString());
    check("connect.js store: list is every record under the key, oldest first", out.list, [1, 2, 3]);
    check("  load is the latest that executed", out.load, 2);
    check("  an unknown key lists nothing", out.none, []);
    const mem = gate.createStorage();
    await mem.persist("k", { n: 1 }); await mem.persist("k", { n: 2 });
    check("gate.js createStorage: list too", (await mem.list("k")).map(r => r.n), [1, 2]);
  }

  console.log("\n--- 4. start, ask, reply, execute ---");
  const g1 = await run("g1-01", "clean", {}, ["yes"]);
  check("g1-01: waits on a question, the model's reading of the time shown by code", [g1.first.status, g1.first.question?.block?.[0]],
    ["waiting", "time = 2026-10-31 (Sat) 14:00 +09:00"]);
  check("  the provider's notice goes with it", g1.first.question?.block?.some(l => l.startsWith("Note: The buyer sees")), true);
  check("  the seller's yes: executed once, with the gate's arguments", [g1.last.status, g1.calls.length, g1.calls[0]?.args.time], ["executed", 1, SAT_2PM]);
  check("  the location is the seller's words", g1.calls[0]?.args.location, "Hongdae station lockers");
  check("  the principles were in the model's system prompt", g1.prompts.every(p => p.includes("Do not generate values")), true);
  const kept = [];
  for (const key of ["user:schedule_pickup:" + `t${thread}`]) kept.push(...await g1.store.list(key));
  const rec = kept.filter(r => r.provider_checklist).at(-1);
  const sale = rec?.provider_checklist?.find(c => c.description?.startsWith("The sale must be agreed"));
  check("the record carries the definition read, the line's version and its translation",
    [typeof rec?.tool_definition?.hash, typeof sale?.rule_hash, sale?.form_translation?.translated_by], ["string", "string", "stub"]);
  const cancelled = await run("g1-01", "clean", {}, ["CANCEL"]);
  check("the seller stops: nothing runs", [cancelled.last.status, cancelled.calls.length], ["cancelled", 0]);

  console.log("\n--- 4-b. a server that asks for more input does not get it behind the gate ---");
  check("the MCP client is set not to answer input_required itself", realConnect.CLIENT_OPTIONS.inputRequired?.autoFulfill, false);
  check("  and declares elicitation, so the request comes back as data", JSON.stringify(realConnect.CLIENT_OPTIONS.capabilities?.elicitation), "{}");
  check("  and to speak 2026-07-28 when the server offers it", realConnect.CLIENT_OPTIONS.versionNegotiation?.mode, "auto");
  check("  and follows the server's notices that its tool list changed", typeof realConnect.CLIENT_OPTIONS.listChanged?.tools?.onChanged, "function");
  const ask = { method: "elicitation/create", params: { mode: "form", message: "Card PIN?", requestedSchema: { type: "object", properties: { pin: { type: "string" } } } } };
  check("an input_required result is handed back as such", realConnect.toToolResult({ resultType: "input_required", inputRequests: { pin: ask } }), { inputRequired: { pin: ask } });
  const done = { resultType: "complete", content: [{ type: "text", text: "scheduled" }] };
  check("  a complete result passes through", realConnect.toToolResult(done), done);
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

  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("THREW:", e.stack); process.exit(1); });
