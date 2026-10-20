"use strict";

/**
 * Arms A and B — a plain tool-calling loop. No framework, no gate.
 *
 * A run ends in exactly one of two outcomes:
 *   { outcome: "call", args }   the model called the tool
 *   { outcome: "ask", text }    the model asked instead
 *
 * The model is not answered and the run is not continued. Answering it would be
 * a different experiment: this one asks what happens on a single instruction.
 *
 * Provider-agnostic: the adapter is handed in, so this file is the same code for
 * every company's model and cannot accidentally favour one.
 */

const { buildUserTurn } = require("./prompts");

async function runPlainArm({ adapter, model, systemPrompt, tool, ctx, instructionText }) {
  const turn = buildUserTurn(ctx, instructionText);
  const out = await adapter.callTool(model, systemPrompt, turn.text, tool);

  if (out.kind === "call") {
    return {
      outcome: "call",
      tool_name: out.name,
      args: out.args ?? {},
      stop_reason: out.stop_reason ?? null,
      raw_text: out.text ?? null,
      usage: out.usage ?? null,
    };
  }

  return {
    outcome: "ask",
    text: out.text ?? "",
    stop_reason: out.stop_reason ?? null,
    args: null,
    usage: out.usage ?? null,
  };
}

module.exports = { runPlainArm };
