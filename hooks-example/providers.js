"use strict";

/**
 * Provider adapters. Every model in this experiment is reached through exactly
 * two operations, so the arms do not know which company they are talking to:
 *
 *   callTool(model, system, userText, tool)  -> { kind: "call", name, args }
 *                                            | { kind: "text", text }
 *   callJson(model, system, user)            -> a parsed JSON object
 *
 * Adapters: "anthropic" (SDK) and "openai" (raw HTTP against any endpoint that
 * speaks the OpenAI chat-completions shape). Meta's Llama models have no
 * first-party API, so they are reached through the openai adapter pointed at
 * whichever host serves them (Together, Groq, Fireworks, Bedrock, vLLM…).
 *
 * ── Three choices that affect whether the numbers compare ───────────────────
 *
 * 1. SAMPLING. Nothing is sent. No temperature, no top_p, no seed. Each
 *    provider's own default applies, which is what an ordinary integration
 *    does. Pinning temperature to 0 would suppress the very variance this
 *    experiment measures; pinning it to one value across providers would be a
 *    choice no integration makes. What was sent (nothing) is recorded in the
 *    run's meta line so a reader does not have to take this on trust.
 *
 * 2. JSON MODE. Off everywhere. The OpenAI shape offers
 *    response_format: {type:"json_object"} and the Anthropic one does not.
 *    Turning it on for some providers would make arm C's locator more reliable
 *    for those providers for a reason that has nothing to do with the gate.
 *    It is exposed as a per-provider knob, default off, and enabling it
 *    unevenly makes the arms non-comparable. Say so if you turn it on.
 *
 * 3. ARM C USES THE MODEL AS A LOCATOR. The gate asks the model to point at
 *    where a value is, then checks the text at that spot. A model that returns
 *    malformed JSON or bad spans produces lookup failures, and those cells are
 *    reported as broken_hooks / NOT CLEAN rather than counted as gate wins.
 *    This is a real second measurement — how well each model points instead of
 *    asserting — and it must not be read as the gate's effect.
 */

const MAX_TOKENS = 1024;

// ── Anthropic ───────────────────────────────────────────────────────────────

let anthropicClient = null;
function anthropic() {
  if (!anthropicClient) {
    const Anthropic = require("@anthropic-ai/sdk");
    anthropicClient = new Anthropic();           // reads ANTHROPIC_API_KEY
  }
  return anthropicClient;
}

const anthropicAdapter = {
  id: "anthropic",
  envKey: "ANTHROPIC_API_KEY",

  async callTool(model, system, userText, tool) {
    const res = await anthropic().messages.create({
      model, max_tokens: MAX_TOKENS, system,
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.inputSchema }],
      messages: [{ role: "user", content: userText }],
    });
    const text = res.content.filter(b => b.type === "text").map(b => b.text).join("\n") || null;
    const use = res.content.find(b => b.type === "tool_use");
    if (use) {
      return { kind: "call", name: use.name, args: use.input ?? {}, text,
               stop_reason: res.stop_reason, usage: res.usage };
    }
    return { kind: "text", text: text ?? "", stop_reason: res.stop_reason, usage: res.usage };
  },

  async callJson(model, system, user) {
    const res = await anthropic().messages.create({
      model, max_tokens: MAX_TOKENS, system,
      messages: [{ role: "user", content: user }],
    });
    return parseJsonObject(res.content.filter(b => b.type === "text").map(b => b.text).join(""));
  },
};

// ── OpenAI chat-completions shape (OpenAI, and any host serving Llama) ──────

function openaiAdapter({ id, baseUrl, envKey, jsonMode = false, headers = {} }) {
  function apiKey() {
    const k = process.env[envKey];
    if (!k) throw new Error(`${id}: ${envKey} is not set`);
    return k;
  }

  async function post(body) {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey()}`, ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${id} HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res.json();
  }

  return {
    id, envKey, baseUrl,

    async callTool(model, system, userText, tool) {
      const out = await post({
        model,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "system", content: system }, { role: "user", content: userText }],
        tools: [{
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        }],
        tool_choice: "auto",
      });
      const msg = out?.choices?.[0]?.message ?? {};
      const finish = out?.choices?.[0]?.finish_reason ?? null;
      const call = msg.tool_calls?.[0];
      if (call) {
        // arguments arrive as a JSON *string* here, unlike Anthropic's object.
        let args;
        try {
          args = JSON.parse(call.function?.arguments ?? "{}");
        } catch (e) {
          // Malformed arguments are not an empty call. Treated as an error so the
          // run is excluded rather than scored as "called the tool with nothing".
          throw new Error(`${id}: tool arguments were not valid JSON: ${String(call.function?.arguments).slice(0, 200)}`);
        }
        return { kind: "call", name: call.function?.name, args, text: msg.content ?? null,
                 stop_reason: finish, usage: out.usage };
      }
      return { kind: "text", text: msg.content ?? "", stop_reason: finish, usage: out.usage };
    },

    async callJson(model, system, user) {
      const out = await post({
        model,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      });
      return parseJsonObject(out?.choices?.[0]?.message?.content ?? "");
    },
  };
}

// ── shared ──────────────────────────────────────────────────────────────────

/** Lenient on wrapping prose, strict on the object. Same rule for every provider. */
function parseJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`no JSON object in reply: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Build the adapter for one registry entry.
 * An unknown provider fails here rather than at the first call, so a typo in
 * models.json surfaces before anything is spent.
 */
function buildAdapter(entry) {
  if (entry.provider === "anthropic") return anthropicAdapter;
  if (entry.provider === "openai") {
    if (!entry.base_url) throw new Error(`${entry.model}: openai-shaped entries need base_url`);
    if (!entry.env_key) throw new Error(`${entry.model}: openai-shaped entries need env_key`);
    return openaiAdapter({
      id: entry.id ?? entry.model,
      baseUrl: entry.base_url,
      envKey: entry.env_key,
      jsonMode: entry.json_mode === true,
      headers: entry.headers ?? {},
    });
  }
  throw new Error(`unknown provider "${entry.provider}" (expected "anthropic" or "openai")`);
}

module.exports = { buildAdapter, parseJsonObject, MAX_TOKENS };
