"use strict";

/**
 * The agent: your rules (tool.json, confirmed.json), your connections (connect.js), the gate
 * (gate.js). You should not need to edit this file.
 *
 *   const { createAgent } = require("./agent");
 *   const agent = createAgent();
 *   let r = await agent.start({ threadId, message: { typed: "Set up the pickup for LST-2291 …" } });
 *   // r.status "waiting": show r.request to the user as a form (r.responseSchema is its shape)
 *   r = await agent.resume({ threadId, reply: { action: "accept", content: { time: "…" } } });
 *   // r.status "executed", or why not: "hold", "definition_repair", "exhausted", "declined",
 *   //   "input_required" (the server asked for more input; nothing was executed),
 *   //   "call_failed" (the call threw) or "tool_error" (the tool reported a failure); see callError, …
 *
 * Or from a terminal: node agent.js "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae
 * station lockers." It prints each request and reads your reply as one line of JSON.
 */

const gate = require("./gate");
const defaultConnect = require("./connect");
const TOOL = require("./tool.json");
const CONFIRMED = require("./confirmed.json");

/**
 * @param userChecklist  the user's conditions, already confirmed by the user: items with a JSON
 *                       Schema the slot's value must satisfy (spec 3.3, 4.4). See README.
 * @param propose        let the model propose values for the form's defaults. A proposal settles
 *                       nothing: only what the user sends back counts.
 */
function createAgent({ connect = defaultConnect, tool = TOOL, confirmed = CONFIRMED, userId = "user", propose = true } = {}) {
  const graph = gate.buildGraph({
    ask: connect.ask, callTool: connect.callTool, tool, confirmed,
    checkpointer: connect.checkpointer, storage: connect.store, userId,
  });

  // Exactly the measurements the declarations name. One that cannot be read is "not measured".
  async function measureAll(context) {
    const out = {};
    for (const name of gate.measurementsNeeded(tool, confirmed)) {
      try { out[name] = await connect.measure(name, context); }
      catch { out[name] = { valid: false }; }
    }
    return out;
  }

  // The model reads the user's words in each field's declared form ("2pm this Saturday" →
  //   2026-10-31T14:00:00+09:00). Shown to the user as defaults; a failure here only means no defaults.
  async function proposalsFor(segments) {
    if (!propose) return {};
    const props = tool.inputSchema?.properties ?? {};
    const fields = Object.entries(props).map(([n, p]) => `  ${n}: ${p?.format ? `format ${p.format}. ` : ""}${p?.description ?? ""}`).join("\n");
    try {
      const out = await connect.ask("model",
        "Read what the user typed and propose a value for each field, written in the field's format. " +
        "Use only what the user typed (segments with trust \"user\"). Your proposals are shown to the user " +
        "to confirm; they decide nothing. Return JSON only.",
        `Tool: ${tool.name}\n${String(tool.description ?? "").split("\n")[0]}\n\nSegments:\n${JSON.stringify(segments, null, 2)}` +
        `\n\nFields:\n${fields}\n\nReply as {"proposals": {"<field>": "<value>" or null}}`, "proposals");
      return Object.fromEntries(Object.entries(out?.proposals ?? {}).filter(([k, v]) => k in props && typeof v === "string"));
    } catch { return {}; }
  }

  async function report(state, config) {
    const waiting = (await graph.getState(config)).tasks.flatMap(t => t.interrupts ?? [])[0];
    return {
      status: waiting ? "waiting" : (state.ended ?? state.verdict?.decision),
      request: waiting?.value ?? null,
      responseSchema: waiting?.response_schema ?? null,
      executedWith: state.executedWith ?? null,
      serverRequests: state.serverRequests ?? null,   // the server asked for input instead of completing
      callError: state.callError ?? null,             // the call itself failed
      verdict: state.verdict,
    };
  }

  async function start({ threadId, message, userChecklist = [], context = {} }) {
    const config = { configurable: { thread_id: threadId } };
    const segments = connect.labelInput(message);
    const state = await graph.invoke({
      segments, measuredData: await measureAll(context), userChecklist, proposals: await proposalsFor(segments),
    }, config);
    return report(state, config);
  }

  async function resume({ threadId, reply }) {
    const config = { configurable: { thread_id: threadId } };
    const state = await graph.invoke(new gate.Command({ resume: reply }), config);
    return report(state, config);
  }

  return { start, resume };
}

module.exports = { createAgent };

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
      console.log("\n" + r.request.message);
      console.log(JSON.stringify(r.request.requestedSchema, null, 2));
      const line = await new Promise(res => rl.question('\nreply as JSON, e.g. {"action":"accept","content":{...}}\n> ', res));
      r = await agent.resume({ threadId, reply: JSON.parse(line) });
    }
    rl.close();
    console.log(`\n${r.status}`, r.executedWith ? JSON.stringify(r.executedWith) : (r.verdict?.reason ?? ""));
  })().catch(e => { console.error(e.message); process.exit(1); });
}
