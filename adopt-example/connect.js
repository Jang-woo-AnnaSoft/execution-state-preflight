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
 *   notify              the provider's notices, shown to the user before the tool runs
 *   callTool            the real tool call: your own tool; or the MCP server's
 *   store               where decision records and kept translations go
 *   checkpointer        where a conversation waits while the user answers
 *
 * Keys and addresses come from the environment, never from this file:
 *   MODEL            "provider:model", e.g. "anthropic:<model-name>" or "openai:<model-name>".
 *                    Install that provider's package too (e.g. npm install @langchain/anthropic).
 *                    The provider package reads its own key from the environment
 *                    (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY).
 *   MODEL_OPTIONS    optional: a JSON object given to that package as it is, e.g. '{"useResponsesApi":true}'
 *                    for an OpenAI model that calls tools only through the Responses API
 *   TEMPERATURE      optional: sent only when set, e.g. TEMPERATURE=0
 *   TOOLS_FILE       your declaration of the tools: files in the format of tool.md, separated by
 *                    commas (default ./tool.md, beside this file)
 *   MCP_SERVER_URL   only with the MCP connection below, uncommented: the server that serves the tools
 *
 * A function left unconnected fails closed: a measurement that is not connected is "not measured", so
 * a check that needs it is unverified and the run does not execute.
 */

const fs = require("fs");
const path = require("path");
const { MemorySaver, InMemoryStore } = require("@langchain/langgraph");
const { recordStore } = require("./records");

// ── the model ──────────────────────────────────────────────────────────────────────────────────
// The model is chosen once, at start, from MODEL. It is not chosen per request: what the gate is
//   given to read should not change with outside input. Changing the model changes how well words
//   are located, never what counts as checked.
// To use two models, split here. One model serves both places by default, and nothing requires two.
//   The gate's questions to the model go through ask and say; the agent's turns go through chat.
//   1. Make a second model() beside this one, from its own variable (e.g. GATE_MODEL), chosen once too.
//   2. Call it in ask and say, and leave chat on this one.
//   3. Set MODEL_NAME from that variable: it is the name recorded on each translation, and the gate's
//      model is the one that writes them.
//   Install the second provider's package if it differs. The gate's model decides how well words are
//   read and questions are put, so a smaller one may ask more often; what counts as checked is the same.
let modelPromise = null;
function model() {
  if (!modelPromise) {
    if (!process.env.MODEL) throw new Error("set MODEL, e.g. MODEL=anthropic:<model-name>");
    const { initChatModel } = require("langchain/chat_models/universal");
    modelPromise = initChatModel(process.env.MODEL, modelOptions());
  }
  return modelPromise;
}
// The provider's own settings, from MODEL_OPTIONS: a JSON object, given as it is. This file reads
//   nothing in it; which settings there are is the provider package's. Not a JSON object: an error,
//   before any model is called.
// No sampling setting is sent unless you set one: some models refuse a temperature other than their
//   default. TEMPERATURE=0 sends it, for a model that takes it, over one in MODEL_OPTIONS.
function modelOptions(env = process.env) {
  let options = {};
  if (env.MODEL_OPTIONS !== undefined && env.MODEL_OPTIONS !== "") {
    try { options = JSON.parse(env.MODEL_OPTIONS); } catch (e) { throw new Error(`MODEL_OPTIONS is not JSON (${e.message})`); }
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw new Error("MODEL_OPTIONS must be a JSON object");
  }
  const temperature = env.TEMPERATURE;
  return temperature === undefined || temperature === "" ? options : { ...options, temperature: Number(temperature) };
}
const MODEL_NAME = process.env.MODEL ?? "model";
const textOf = res => (typeof res.content === "string" ? res.content
  : (res.content ?? []).map(p => (typeof p === "string" ? p : p?.text ?? "")).join(""));

// The gate's model calls. An answer not in the shape asked is an error: the gate treats a failed
//   extraction as "not found", never as a value.
async function ask(_model, system, user, hook, schema) {
  return askWith(await model(), system, user, hook, schema, structuredMethod());
}
// How the shape reaches the provider. Anthropic: its structured outputs (method "jsonSchema"), as it
//   recommends; Claude Opus 5.5 and Sonnet 5.5 refuse the forced tool call LangChain sends otherwise.
//   Another provider: LangChain's default for it.
function structuredMethod(env = process.env) {
  return String(env.MODEL ?? "").startsWith("anthropic:") ? "jsonSchema" : undefined;
}
// The answer's shape, given with each call (judge-only.js), is the model's to keep: LangChain's
//   withStructuredOutput hands it to the provider (structuredMethod, below) and reads the
//   answer back. Only the shape: what the values say is the gate's to check. An answer the provider
//   could not read in that shape is an error, with what the model wrote kept in it: the gate treats the
//   failure as unconfirmed, and the text says why.
async function askWith(m, system, user, hook, schema, method) {
  if (!schema || typeof schema !== "object") throw new Error(`no shape given for the model's answer (${hook ?? "ask"})`);
  const res = await m.withStructuredOutput(schema, { name: hook ?? "answer", includeRaw: true, ...(method ? { method } : {}) })
    .invoke([{ role: "system", content: system }, { role: "user", content: user }]);
  if (res?.parsed && typeof res.parsed === "object") return res.parsed;
  const t = (res?.raw ? textOf(res.raw) : "") || JSON.stringify(res?.raw?.tool_calls ?? null);
  const raw = JSON.stringify(t.length > 300 ? t.slice(0, 300) + " …" : t);
  throw new Error(`the model's answer was not in the shape asked${res?.parsingError ? ` (${res.parsingError.message ?? res.parsingError})` : ""}: ${raw}`);
}

// The model's plain text, for what is words and not data: the words of a question to the user.
async function say(_model, system, user) {
  const m = await model();
  const res = await m.invoke([{ role: "system", content: system }, { role: "user", content: user }]);
  return textOf(res);
}

// The agent's model, with the server's tools bound as they are listed: name, description, input
//   schema. → { toolCall: { name, arguments, id } } or { text }. id is the model's id for the call: its
//   result goes back under it (messagesFor).
async function chat({ system, messages, tools }) {
  const m = await model();
  const bound = m.bindTools(tools.map(t => ({
    type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object" } },
  })));
  const res = await bound.invoke([...(system ? [{ role: "system", content: system }] : []), ...messages]);
  const call = (res.tool_calls ?? [])[0];
  return call ? { toolCall: { name: call.name, arguments: call.args ?? null, id: call.id ?? null } } : { text: textOf(res) };
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
//   form: the answers from a form made from the gate's questions (answerSchema), as the user's segments,
//     one per field (5.2). Only what the user entered: never a field a model or the system filled in.
function labelInput({ typed, context = [], form }) {
  if (form !== undefined) return require("./judge-only").formSegments(form);
  return [
    ...context.map(c => ({ text: c.text, trust: "untrusted" })),
    { text: typed, trust: "user" },
  ];
}

// ── notify: the provider's notices ─────────────────────────────────────────────────────────────
// A [Notice] line is told to the user before the tool runs (spec 3.3). The notices go under every
//   question; when a run asks nothing, they are shown through here, and then the tool runs. Nothing is
//   waited for: a notice is told, not acknowledged. Put your own way to reach the user here. Without
//   this function, a run that has a notice to show and no question to show it with does not execute.
async function notify(lines) {
  for (const l of lines) console.log(`Note: ${l}`);
}

// ── store: decision records ────────────────────────────────────────────────────────────────────
// Append-only, in a LangGraph BaseStore (records.js). load returns the latest record that executed, for
//   the key (spec 5.2). list returns every record under the key, oldest first: the gate reads what a
//   conversation was asked, and the kept translations of the provider's lines, with it. steps: the
//   middleware's own judging steps, kept so that resuming does not judge again.
// InMemoryStore keeps the records only while this process runs. To keep them longer, change this one
//   line to a persistent store, for example PostgresStore:
//     const { PostgresStore } = require("@langchain/langgraph-checkpoint-postgres/store");
//     const baseStore = PostgresStore.fromConnString(process.env.DATABASE_URL);   // await baseStore.setup() once
// Keep it where the agent process cannot rewrite records (spec 8.2): not handed to the agent
//   (createAgent's store), where its tools and other middleware reach it.
const baseStore = new InMemoryStore();
const store = recordStore(baseStore);
const steps = recordStore(baseStore, "steps");

// ── readPreSet: the user's settings for a tool ─────────────────────────────────────────────────
// (userId, toolName) → { field: { value, trust, approved_by, approved_at, approved_in } } (spec 5.2).
//   trust "user": a setting the user approved; keep who approved it, when, and where, so the record can
//   say so. Any other trust (a value a model remembered on its own) is shown to the user as a candidate,
//   never used as a setting. How settings come to be stored, and the user's consent, is yours: a
//   settings page, a "remember this?" in your agent, or a tool of its own that goes through the gate.
//   This starting point has none.
async function readPreSet(userId, toolName) {
  return {};
}

// ── checkpointer: where a conversation waits ───────────────────────────────────────────────────
// MemorySaver loses waiting conversations on restart. For a real system use a persistent one, for
//   example PostgresSaver from @langchain/langgraph-checkpoint-postgres.
const checkpointer = new MemorySaver();

// chatModel: the agent's model itself, for LangChain's createAgent (agent.js); chat is the same model,
//   called one turn at a time (judge-only-example.js).
module.exports = { ask, say, chat, chatModel: model, listTools, readToolDefinition, measure, labelInput, notify, callTool, store, steps, readPreSet, checkpointer,
                   MEASUREMENTS, TOOLS, MODEL_NAME, readToolFile, askWith, structuredMethod, modelOptions };
// With the MCP connection above uncommented:
//   listTools: mcpListTools, readToolDefinition: mcpReadToolDefinition, callTool: mcpCallTool
