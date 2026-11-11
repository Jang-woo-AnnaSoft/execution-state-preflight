"use strict";

/**
 * Where the gate meets your system. Fill in this file; nothing else in the folder needs code.
 *
 *   ask                 the model, for the gate's questions to it: told where to look, it reports where
 *                       the user's words are, and writes what it is asked to write as JSON
 *   chat                the agent's model: reads the conversation and the tools, and calls a tool
 *   listTools           the tools, as you declare them (tool.md); or as an MCP server lists them
 *   readToolDefinition  one tool's definition, from that list: the gate reads it itself
 *   measure             your system's values, read when the gate asks, with the values it has settled
 *   labelInput          who wrote each part of an incoming message
 *   callTool            the real tool call: your own tool; or the MCP server's
 *   store               where decision records and kept translations go
 *   checkpointer        where a conversation waits while the user answers
 *
 * Keys and addresses come from the environment, never from this file:
 *   MODEL            "provider:model", e.g. "anthropic:<model-name>" or "openai:<model-name>".
 *                    Install that provider's package too (e.g. npm install @langchain/anthropic).
 *                    The provider package reads its own key from the environment
 *                    (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY).
 *   TOOLS_FILE       your declaration of the tools: files in the format of tool.md, separated by
 *                    commas (default ./tool.md, beside this file)
 *   MCP_SERVER_URL   only with the MCP connection below, uncommented: the server that serves the tools
 *   RECORD_PATH      where the records file goes (default ./records.jsonl)
 *
 * A function left unconnected fails closed: a measurement that is not connected is "not measured", so
 * a check that needs it is unverified and the run does not execute.
 */

const fs = require("fs");
const path = require("path");
const { MemorySaver } = require("@langchain/langgraph");

// ── the model ──────────────────────────────────────────────────────────────────────────────────
// The model is chosen once, at start, from MODEL. It is not chosen per request: what the gate is
//   given to read should not change with outside input. Changing the model changes how well words
//   are located, never what counts as checked.
let modelPromise = null;
function model() {
  if (!modelPromise) {
    if (!process.env.MODEL) throw new Error("set MODEL, e.g. MODEL=anthropic:<model-name>");
    const { initChatModel } = require("langchain/chat_models/universal");
    // No sampling setting is sent unless you set one: some models refuse a temperature other than their
    //   default. TEMPERATURE=0 sends it, for a model that takes it.
    const temperature = process.env.TEMPERATURE;
    modelPromise = initChatModel(process.env.MODEL, temperature === undefined || temperature === "" ? {} : { temperature: Number(temperature) });
  }
  return modelPromise;
}
const MODEL_NAME = process.env.MODEL ?? "model";
const textOf = res => (typeof res.content === "string" ? res.content
  : (res.content ?? []).map(p => (typeof p === "string" ? p : p?.text ?? "")).join(""));

// The gate's prompts ask for JSON. A reply that is not JSON is an error: the gate treats a failed
//   extraction as "not found", never as a value.
async function ask(_model, system, user) {
  const m = await model();
  const res = await m.invoke([{ role: "system", content: system }, { role: "user", content: user }]);
  const text = textOf(res);
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

// The agent's model, with the server's tools bound as they are listed: name, description, input
//   schema. → { toolCall: { name, arguments } } or { text }.
async function chat({ system, messages, tools }) {
  const m = await model();
  const bound = m.bindTools(tools.map(t => ({
    type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object" } },
  })));
  const res = await bound.invoke([...(system ? [{ role: "system", content: system }] : []), ...messages]);
  const call = (res.tool_calls ?? [])[0];
  return call ? { toolCall: { name: call.name, arguments: call.args ?? null } } : { text: textOf(res) };
}

// ── the tools: your declaration, and your call ─────────────────────────────────────────────────
// You build the agent and the tools together, so you are the tools' provider (spec 4.2), and a file in
//   the format of tool.md is your declaration of them: name, description with the rules in words, input
//   schema. The agent's model and the gate read the tools from it, on every run. Build the tools from
//   the same declaration: a tool that does something its declaration does not say is the provider's
//   gap, here as anywhere.
function readToolFile(text) {
  const block = (heading, kind) => {
    const at = text.search(new RegExp(`^## ${heading}\\s*$`, "m"));
    if (at < 0) throw new Error(`tool file: no "## ${heading}" section`);
    const m = new RegExp("```" + kind + "\\n([\\s\\S]*?)\\n```").exec(text.slice(at));
    if (!m) throw new Error(`tool file: no ${kind} block under "## ${heading}"`);
    return m[1];
  };
  return { name: block("Name", "text").trim(), description: block("Description", "text"),
           inputSchema: JSON.parse(block("Input schema", "json")) };
}
const toolFiles = () => (process.env.TOOLS_FILE ?? path.join(__dirname, "tool.md"))
  .split(",").map(f => f.trim()).filter(Boolean);

async function listTools() {
  return toolFiles().map(f => readToolFile(fs.readFileSync(f, "utf8")));
}

async function readToolDefinition(name) {
  const tool = (await listTools()).find(t => t.name === name);
  if (!tool) throw new Error(`no tool named ${JSON.stringify(name)} is declared`);
  return tool;
}

// Your tools, by name: each takes the arguments in the gate's record and does the thing. Called only
//   with those, once the record reads as ready. A tool not connected here is not called: the run ends as
//   call_failed, and nothing happened.
const TOOLS = {
  // schedule_pickup: async args => pickups.create(args),
};

async function callTool(name, args) {
  const run = TOOLS[name];
  if (!run) throw new Error(`the tool ${JSON.stringify(name)} is not connected in connect.js`);
  return run(args);
}

// ── or: the tools on an MCP server ─────────────────────────────────────────────────────────────
// When the tools are someone else's, served by an MCP server, read them from the server instead: set
//   MCP_SERVER_URL, uncomment this block, and use mcpListTools, mcpReadToolDefinition and mcpCallTool
//   as listTools, readToolDefinition and callTool (module.exports, at the end of this file).
//   The provider writes the rules in the tool's description on the server; the gate reads them from
//   the server's list. Note that a [Required] line can only be checked if your system can measure what
//   it names — often data on the provider's side.
//
// MCP 2026-07-28 lets a server answer tools/call with input_required: it asks the user for more input
//   (an elicitation) before it completes the call. The client would normally answer that itself and
//   retry. Here it must not: input gathered that way reaches the tool without going through the
//   gate, and is in no decision record. So the client is set to hand such a result back, and the run
//   stops there, not executed, and the server's request comes back to you. If your tool needs that
//   input, the provider declares it in the input schema, where the gate asks for it and checks it.
// The client declares the elicitation capability so that the server's request comes back as data
//   you can show, rather than as a refusal. It registers no handler for it: on the 2025 protocol, a
//   server that asks gets "method not found", and the tool reports an error.
// The tool list: when the server announces changes to it (tools.listChanged), the client refreshes
//   the list on each notice and the gate reads that list; otherwise the list is read again for each
//   definition the gate reads. Either way the gate reads what the server serves, and the record keeps
//   a hash of the definition it read.
//
// let toolList = null;
// const CLIENT_OPTIONS = {
//   versionNegotiation: { mode: "auto" },     // 2026-07-28 with a server that offers it, 2025 otherwise
//   inputRequired: { autoFulfill: false },    // never answer a server's request for input behind the gate
//   capabilities: { elicitation: {} },        // so the request is handed back, not refused
//   listChanged: { tools: { onChanged: (error, tools) => { toolList = error ? null : tools; } } },
// };
//
// // { inputRequired } when the server asked for input instead of completing; the result otherwise.
// function toToolResult(result) {
//   const { isInputRequiredResult } = require("@modelcontextprotocol/client");
//   return isInputRequiredResult(result) ? { inputRequired: result.inputRequests ?? {} } : result;
// }
//
// let mcpClient = null;
// async function client() {
//   if (!mcpClient) {
//     if (!process.env.MCP_SERVER_URL) throw new Error("set MCP_SERVER_URL");
//     const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
//     const c = new Client({ name: "adopt-example", version: "1.0.0" }, CLIENT_OPTIONS);
//     await c.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_SERVER_URL)));
//     mcpClient = c;
//   }
//   return mcpClient;
// }
//
// async function mcpListTools() {
//   const c = await client();
//   const announces = c.getServerCapabilities()?.tools?.listChanged === true;
//   if (!toolList || !announces) toolList = (await c.listTools(undefined, { cacheMode: "refresh" })).tools;
//   return toolList;
// }
//
// async function mcpReadToolDefinition(name) {
//   const tool = (await mcpListTools()).find(t => t.name === name);
//   if (!tool) throw new Error(`the server lists no tool named ${JSON.stringify(name)}`);
//   return tool;
// }
//
// // Called only with the arguments in the gate's record, once the record reads as ready.
// async function mcpCallTool(name, args) {
//   const c = await client();
//   return toToolResult(await c.callTool({ name, arguments: args }, { allowInputRequired: true }));
// }

// ── measure: your system's values ──────────────────────────────────────────────────────────────
// One entry per measurement this system can read. The names are what a comparable form may name. The
//   gate calls measure(name, { values, userId }) when it needs one, with the values it has settled in
//   this round: "the order status of the listing the seller named" reads values.item_id. Return the
//   value as your system holds it. Do not take it from the conversation: a value the user or the buyer
//   typed is not a measurement.
//   For the pickup tool's lines:
const MEASUREMENTS = {
  // order_status: async ({ values }) => (await orders.byListing(values.item_id)).status,
  // listing_owned_by_seller: async ({ values, userId }) => (await listings.get(values.item_id)).ownerId === userId,
  // buyer_contact: async ({ values }) => (await orders.byListing(values.item_id)).buyer.contact,
  // time: async ({ values }) => (await pickupRequests.latest(values.item_id))?.time,   // a request the buyer sent in the app
};

async function measure(name, settled = {}) {
  const read = MEASUREMENTS[name];
  if (!read) return { valid: false };   // not connected: not measured
  const value = await read(settled);
  return value === undefined || value === null ? { valid: false } : { valid: true, value };
}

// ── labelInput: who wrote what ─────────────────────────────────────────────────────────────────
// Set on arrival, by your input path, never by the model (spec 5.2). Only what the user typed is
//   "user". A pasted, forwarded or quoted message, an attachment, another person's message or a
//   tool's output is "untrusted": the gate never settles a value or an act from it.
function labelInput({ typed, context = [] }) {
  return [
    ...context.map(c => ({ text: c.text, trust: "untrusted" })),
    { text: typed, trust: "user" },
  ];
}

// ── store: decision records ────────────────────────────────────────────────────────────────────
// Append-only. load returns the latest record that executed, for the key (spec 5.2). list returns every
//   record under the key, oldest first: the gate reads what a conversation was asked, and the kept
//   translations of the provider's lines, with it. A store without list counts no reply.
// This file is a starting point. In a real system, keep records where the agent process cannot
//   rewrite them (spec 8.2): a write-once table, a log service, a separate account.
const RECORD_PATH = process.env.RECORD_PATH ?? "./records.jsonl";
const store = {
  async persist(key, record) {
    fs.appendFileSync(RECORD_PATH, JSON.stringify({ key, record }) + "\n");
    return record;
  },
  async load(key) {
    const all = await this.list(key);
    for (let i = all.length - 1; i >= 0; i--) if (all[i]?.execution_decision === "executed") return all[i];
    return null;
  },
  async list(key) {
    if (!fs.existsSync(RECORD_PATH)) return [];
    return fs.readFileSync(RECORD_PATH, "utf8").trim().split("\n").filter(Boolean)
      .map(l => JSON.parse(l)).filter(e => e.key === key).map(e => e.record);
  },
};

// ── checkpointer: where a conversation waits ───────────────────────────────────────────────────
// MemorySaver loses waiting conversations on restart. For a real system use a persistent one, for
//   example PostgresSaver from @langchain/langgraph-checkpoint-postgres.
const checkpointer = new MemorySaver();

module.exports = { ask, chat, listTools, readToolDefinition, measure, labelInput, callTool, store, checkpointer,
                   MEASUREMENTS, TOOLS, MODEL_NAME, readToolFile };
// With the MCP connection above uncommented:
//   listTools: mcpListTools, readToolDefinition: mcpReadToolDefinition, callTool: mcpCallTool
