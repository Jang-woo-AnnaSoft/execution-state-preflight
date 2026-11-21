"use strict";

/**
 * The stand-in agent model (stub.js's makeChat) as a LangChain chat model, for agent.js on createAgent.
 * It is handed the same request a connect.chat gets ({ system, messages, tools }). After a tool's result
 * it answers in words, as a real model ends its turn.
 */

const path = require("path");
const ADOPT = path.join(__dirname, "..", "adopt-example");
const { BaseChatModel } = require(path.join(ADOPT, "node_modules", "@langchain/core/language_models/chat_models"));
const { AIMessage } = require(path.join(ADOPT, "node_modules", "@langchain/core/messages"));

const textOf = m => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map(c => c?.text ?? "").join(""));
let ids = 0;

class StubChatModel extends BaseChatModel {
  constructor(chat, tools = []) { super({}); this.chat = chat; this.boundTools = tools; }
  _llmType() { return "stub"; }
  bindTools(tools) { return new StubChatModel(this.chat, tools); }
  async _generate(messages) {
    const type = m => m.getType?.() ?? m._getType?.();
    let out;
    if (type(messages.at(-1)) === "tool") out = { text: "Done." };
    else {
      const system = messages.filter(m => type(m) === "system").map(textOf).join("\n");
      const rest = messages.filter(m => type(m) !== "system").map(m => (type(m) === "human" ? { role: "user", content: textOf(m) }
        : type(m) === "tool" ? { role: "tool", tool_call_id: m.tool_call_id, content: textOf(m) }
        : { role: "assistant", content: textOf(m), ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map(c => ({ id: c.id, name: c.name, args: c.args })) } : {}) }));
      const tools = this.boundTools.map(t => ({ name: t.name, description: t.description, inputSchema: t.schema }));
      out = await this.chat({ system, messages: rest, tools });
    }
    const message = out?.toolCall
      ? new AIMessage({ content: "", tool_calls: [{ name: out.toolCall.name, args: out.toolCall.arguments ?? {}, id: out.toolCall.id ?? `stub_call_${++ids}`, type: "tool_call" }] })
      : new AIMessage(out?.text ?? "");
    return { generations: [{ message, text: textOf(message) }] };
  }
}

module.exports = { StubChatModel };
