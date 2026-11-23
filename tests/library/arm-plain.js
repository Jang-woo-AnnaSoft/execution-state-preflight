"use strict";

/**
 * Arms A and B — a plain tool-calling loop. No framework, no gate.
 *
 * A run ends in exactly one of two outcomes:
 *   { outcome: "call", args }   the model called the tool
 *   { outcome: "ask", text }    the model asked instead
 *
 * One turn, except in the "answered" date mode: if the model asked, the seller answers once, in
 * their own words, and the model gets one more turn. The answer is the same text whatever was
 * asked (instructions.json date_modes), so it supplies the date and nothing else.
 *
 * Provider-agnostic: the adapter is handed in, so this file is the same code for
 * every company's model and cannot accidentally favour one.
 */

const { buildUserTurn } = require("./prompts");

function shape(out) {
  if (out.kind === "call") {
    return { outcome: "call", tool_name: out.name, args: out.args ?? {},
             stop_reason: out.stop_reason ?? null, raw_text: out.text ?? null, usage: out.usage ?? null };
  }
  return { outcome: "ask", text: out.text ?? "", stop_reason: out.stop_reason ?? null, args: null,
           usage: out.usage ?? null };
}

function addUsage(a, b) {
  if (!a && !b) return null;
  const out = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {})) if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
  return out;
}

async function runPlainArm({ adapter, model, systemPrompt, tool, ctx, instructionText, date = null }) {
  const turn = buildUserTurn(ctx, instructionText, date);
  const out1 = await adapter.callTool(model, systemPrompt, turn.text, tool);
  const r1 = shape(out1);
  if (!(date?.seller_answer && r1.outcome === "ask")) return { ...r1, turns: 1 };

  // The conversation so far, then the seller's answer. The model's own question is kept as it
  //   wrote it — this is the ordinary multi-turn shape, nothing added.
  const messages = [
    { role: "user", content: turn.text },
    { role: "assistant", content: r1.text || "(no text)" },
    { role: "user", content: `[Seller to you]\n${date.seller_answer}` },
  ];
  const r2 = shape(await adapter.callTool(model, systemPrompt, messages, tool));
  return { ...r2, turns: 2, turn1: { outcome: r1.outcome, text: r1.text }, usage: addUsage(r1.usage, r2.usage) };
}

module.exports = { runPlainArm };
