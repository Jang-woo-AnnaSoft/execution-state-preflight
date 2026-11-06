"use strict";

/**
 * Where the gate meets your system. Fill in this file; nothing else in the folder needs code.
 *
 *   ask            the model: told where to look, it reports where the user's words are
 *   measure        your system's values, read when the gate needs them
 *   labelInput     who wrote each part of the incoming message
 *   callTool       the real tool call
 *   store          where decision records are kept
 *   checkpointer   where a run waits while the user answers
 *
 * Keys and addresses come from the environment, never from this file:
 *   MODEL            "provider:model", e.g. "anthropic:<model-name>" or "openai:<model-name>".
 *                    Install that provider's package too (e.g. npm install @langchain/anthropic).
 *                    The provider package reads its own key from the environment
 *                    (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY).
 *   MCP_SERVER_URL   the MCP server that serves the tool
 *   RECORD_PATH      where the records file goes (default ./records.jsonl)
 *
 * A function left unconnected fails closed: a measurement that throws is "not measured", so a check
 * that needs it is unverified and the run does not execute.
 */

const fs = require("fs");
const { MemorySaver } = require("@langchain/langgraph");

// ── ask: the model ─────────────────────────────────────────────────────────────────────────────
// The model is chosen once, at start, from MODEL. It is not chosen per request: what the gate is
//   given to read should not change with outside input. Changing the model changes how well words
//   are located, never what counts as checked.
let modelPromise = null;
function model() {
  if (!modelPromise) {
    if (!process.env.MODEL) throw new Error("set MODEL, e.g. MODEL=anthropic:<model-name>");
    const { initChatModel } = require("langchain/chat_models/universal");
    modelPromise = initChatModel(process.env.MODEL, { temperature: 0 });
  }
  return modelPromise;
}

// The gate's prompts ask for JSON. A reply that is not JSON is an error: the gate treats a failed
//   extraction as "not found", never as a value.
async function ask(_model, system, user) {
  const m = await model();
  const res = await m.invoke([{ role: "system", content: system }, { role: "user", content: user }]);
  const text = typeof res.content === "string" ? res.content
    : (res.content ?? []).map(p => (typeof p === "string" ? p : p?.text ?? "")).join("");
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json);
}

// ── measure: your system's values ──────────────────────────────────────────────────────────────
// One entry per measurement your declarations name (agent.js asks for exactly those). Return the
//   value as your system holds it. Do not take it from the conversation: a value the user or the
//   buyer typed is not a measurement.
const MEASUREMENTS = {
  // order_status: async ({ itemId }) => (await orders.get(itemId)).status,
  // buyer_contact: async ({ itemId }) => (await orders.get(itemId)).buyer.contact,
  // time: async ({ itemId }) => (await pickupRequests.latest(itemId))?.time,   // a pickup request the buyer sent in the app
};

async function measure(name, context = {}) {
  const read = MEASUREMENTS[name];
  if (!read) throw new Error(`measurement "${name}" is not connected`);
  const value = await read(context);
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

// ── callTool: the real call ────────────────────────────────────────────────────────────────────
// Called only with the gate's own arguments, after it decided to execute.
let mcpClient = null;
async function callTool(name, args) {
  if (!mcpClient) {
    if (!process.env.MCP_SERVER_URL) throw new Error("set MCP_SERVER_URL");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "adopt-example", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_SERVER_URL)));
    mcpClient = client;
  }
  return mcpClient.callTool({ name, arguments: args });
}

// ── store: decision records ────────────────────────────────────────────────────────────────────
// Append-only. load returns the latest record that executed, for the key (spec 5.2).
// This file is a starting point. In a real system, keep records where the agent process cannot
//   rewrite them (spec 8.2): a write-once table, a log service, a separate account.
const RECORD_PATH = process.env.RECORD_PATH ?? "./records.jsonl";
const store = {
  async persist(key, record) {
    fs.appendFileSync(RECORD_PATH, JSON.stringify({ key, record }) + "\n");
    return record;
  },
  async load(key) {
    if (!fs.existsSync(RECORD_PATH)) return null;
    const lines = fs.readFileSync(RECORD_PATH, "utf8").trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const { key: k, record } = JSON.parse(lines[i]);
      if (k === key && record?.execution_decision === "executed") return record;
    }
    return null;
  },
};

// ── checkpointer: where a run waits ────────────────────────────────────────────────────────────
// MemorySaver loses waiting runs on restart. For a real system use a persistent one, for example
//   PostgresSaver from @langchain/langgraph-checkpoint-postgres.
const checkpointer = new MemorySaver();

module.exports = { ask, measure, labelInput, callTool, store, checkpointer, MEASUREMENTS };
