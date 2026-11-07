"use strict";

/**
 * Checks adopt-example/ — the files an adopter keeps — from here, so that folder holds no test files.
 *
 * agent.js runs with stand-in connections: the stub model, the same measurements and user turns as the
 * other checks, a tool call that only records. Where a check is about connect.js itself (labelInput,
 * an unconnected measurement), the real function is used.
 *
 *   npm run check
 */

const fs = require("fs");
const path = require("path");
const ADOPT = path.join(__dirname, "..", "adopt-example");
const { createAgent } = require(path.join(ADOPT, "agent"));
const realConnect = require(path.join(ADOPT, "connect"));
const gate = require(path.join(ADOPT, "gate"));
const { runArm, measuredFor } = require("./arm");
const { buildUserTurn } = require("./prompts");
const { makeAsk } = require("./stub");
const S = require("./instructions.json");

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(68)} got=${JSON.stringify(got)}${ok ? "" : `  want=${JSON.stringify(want)}`}`);
}
const SAT_2PM = "2026-10-31T14:00:00+09:00";
let thread = 0;

// Stand-in connections for one instruction in one condition. Anything not overridden is a stand-in.
function standIn(id, condition, over = {}) {
  const ctx = { ...S.conditions[condition].context, ...(over.ctx ?? {}) }, date = S.date_modes.said;
  const measured = measuredFor(ctx, date);
  const calls = [];
  const base = makeAsk(id);
  return {
    calls,
    connect: {
      ask: over.ask ?? (async (m, system, user) => (user.includes('"proposals"') ? { proposals: over.proposals ?? {} } : base(m, system, user))),
      measure: over.measure ?? (async (name) => { if (!(name in measured)) throw new Error("not measured"); return measured[name]; }),
      labelInput: over.labelInput ?? (() => buildUserTurn(ctx, S.instructions.find(i => i.id === id).text, date).segments),
      callTool: async (name, args) => { calls.push({ name, args }); return { ok: true }; },
      store: gate.createStorage(),
      checkpointer: new gate.MemorySaver(),
    },
  };
}
const run = async (id, condition, over = {}, reply) => {
  const s = standIn(id, condition, over);
  const agent = createAgent({ connect: s.connect, propose: over.propose ?? false });
  const threadId = `t${++thread}`;
  const first = await agent.start({ threadId, message: { typed: "(stand-in)" }, userChecklist: S.instructions.find(i => i.id === id).user_checklist ?? [] });
  const last = reply ? await agent.resume({ threadId, reply }) : first;
  return { first, last, calls: s.calls };
};

(async () => {
  console.log("--- 1. the folder holds only what an adopter keeps ---");
  const files = fs.readdirSync(ADOPT).filter(f => f !== "node_modules").sort();
  check("adopt-example files", files, ["README.md", "agent.js", "confirmed.json", "connect.js", "gate.js", "package-lock.json", "package.json", "principles.md", "tool.json"]);
  // principles.md is spec 6.2 as prompt sentences: every bullet must be the spec's own sentence.
  const spec = fs.readFileSync(path.join(__dirname, "..", "spec.en.md"), "utf8");
  const bullets = fs.readFileSync(path.join(ADOPT, "principles.md"), "utf8").split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2));
  check("principles.md: ten bullets, each word for word in spec 6.2", [bullets.length, bullets.filter(b => !spec.includes(b))], [10, []]);
  check("its tool.json is this folder's", JSON.stringify(JSON.parse(fs.readFileSync(path.join(ADOPT, "tool.json")))) === JSON.stringify(require("./tool.json")), true);
  check("its confirmed.json is this folder's", JSON.stringify(JSON.parse(fs.readFileSync(path.join(ADOPT, "confirmed.json")))) === JSON.stringify(require("./confirmed.json")), true);

  console.log("\n--- 2. what is measured is what is declared ---");
  check("measurements the declarations name", gate.measurementsNeeded(require("./tool.json"), require("./confirmed.json")), ["time", "buyer_contact", "order_status"]);
  const unconnected = await run("g4-01", "clean", { measure: realConnect.measure });
  check("connect.js as shipped: nothing measured, the [Required] line unverified", unconnected.first.verdict.decision, "definition_repair");
  check("  and nothing runs", unconnected.calls.length, 0);

  // Spec 6.1: a version put on a confirmed entry lands in the decision record.
  const kept = [];
  const versioned = JSON.parse(JSON.stringify(require("./confirmed.json")));
  versioned.tools.schedule_pickup[0].version = "2026-11-06.1";
  const sv = standIn("g4-01", "clean");
  sv.connect.store = { async persist(key, record) { kept.push(record); return record; }, async load() { return null; } };
  await createAgent({ connect: sv.connect, confirmed: versioned, propose: false }).start({ threadId: `t${++thread}`, message: { typed: "x" } });
  const pc = kept.at(-1)?.provider_checklist?.find(c => c.id === "cond_sale_agreed");
  check("a version on a confirmed entry is in the record", pc?.version ?? null, "2026-11-06.1");

  console.log("\n--- 3. labelInput as shipped: only what the user typed is the user's ---");
  const segs = realConnect.labelInput({ typed: "Set up the pickup for LST-2291.", context: [{ text: "Buyer: 9pm tonight at your door?" }] });
  check("context is untrusted, the typed message is the user's", segs.map(s => s.trust), ["untrusted", "user"]);

  console.log("\n--- 3-b. the stores keep every record and can list them (confirmed forms are read this way) ---");
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

  console.log("\n--- 4. start, wait, resume, execute ---");
  const g1 = await run("g1-01", "clean", { propose: true, proposals: { time: SAT_2PM, location: "Hongdae station lockers" } },
    { action: "accept", content: { time: SAT_2PM } });
  check("g1-01: waits for the time, with the model's reading as the default",
    [g1.first.status, g1.first.request?.requestedSchema?.properties?.time?.default], ["waiting", SAT_2PM]);
  check("  the reply's shape is offered to the client", g1.first.responseSchema?.properties?.action?.enum, ["accept", "decline", "cancel"]);
  check("  accepted: executed once, with the gate's arguments", [g1.last.status, g1.calls.length, g1.calls[0]?.args.time], ["executed", 1, SAT_2PM]);
  check("  the location is the seller's words, not the proposal", g1.calls[0]?.args.location, "Hongdae station lockers");
  const declined = await run("g1-01", "clean", {}, { action: "decline" });
  check("declined: nothing runs", [declined.last.status, declined.calls.length], ["declined", 0]);
  const broken = await run("g1-01", "clean", { propose: true, ask: async (m, system, user) => { if (user.includes('"proposals"')) throw new Error("model down"); return makeAsk("g1-01")(m, system, user); } });
  check("a failed proposal only means no defaults", [broken.first.status, broken.first.request?.requestedSchema?.properties?.time?.default ?? null], ["waiting", null]);

  console.log("\n--- 4-b. a server that asks for more input does not get it behind the gate ---");
  check("the MCP client is set not to answer input_required itself", realConnect.CLIENT_OPTIONS.inputRequired?.autoFulfill, false);
  check("  and declares elicitation, so the request comes back as data", JSON.stringify(realConnect.CLIENT_OPTIONS.capabilities?.elicitation), "{}");
  check("  and to speak 2026-07-28 when the server offers it", realConnect.CLIENT_OPTIONS.versionNegotiation?.mode, "auto");
  const ask = { method: "elicitation/create", params: { mode: "form", message: "Card PIN?", requestedSchema: { type: "object", properties: { pin: { type: "string" } } } } };
  check("an input_required result is handed back as such", realConnect.toToolResult({ resultType: "input_required", inputRequests: { pin: ask } }), { inputRequired: { pin: ask } });
  const done = { resultType: "complete", content: [{ type: "text", text: "scheduled" }] };
  check("  a complete result passes through", realConnect.toToolResult(done), done);
  const sir = standIn("g1-01", "clean");
  sir.connect.callTool = async (name, args) => { sir.calls.push({ name, args }); return { inputRequired: { pin: ask } }; };
  const ag = createAgent({ connect: sir.connect, propose: false });
  await ag.start({ threadId: "sir", message: { typed: "x" }, userChecklist: [] });
  const sr = await ag.resume({ threadId: "sir", reply: { action: "accept", content: { time: SAT_2PM } } });
  check("the server asked during the call: stopped, not executed", [sr.status, sr.executedWith], ["input_required", null]);
  check("  the server's request is returned to the caller", Object.keys(sr.serverRequests ?? {}), ["pin"]);
  check("  and the call is not retried", sir.calls.length, 1);
  for (const [label, fail, want] of [
    ["the tool reports an error: not counted as executed", async () => ({ isError: true, content: [{ type: "text", text: "slot taken" }] }), "tool_error"],
    ["the call throws: reported, not executed", async () => { throw new Error("connection reset"); }, "call_failed"],
  ]) {
    const sf = standIn("g1-01", "clean");
    sf.connect.callTool = async (n, a) => { sf.calls.push(a); return fail(); };
    const af = createAgent({ connect: sf.connect, propose: false });
    await af.start({ threadId: `f${++thread}`, message: { typed: "x" } });
    const rf = await af.resume({ threadId: `f${thread}`, reply: { action: "accept", content: { time: SAT_2PM } } });
    check(label, [rf.status, rf.executedWith, sf.calls.length, typeof rf.callError], [want, null, 1, "string"]);
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
