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
 *
 * 4. TOKEN BUDGETS. A tool call (arms A and B, one call per turn) gets MAX_TOKENS,
 *    unchanged since the first runs so their numbers stay comparable. The hooks'
 *    JSON calls (arm C) get JSON_MAX_TOKENS. In the first "said" run, 7 of arm C's
 *    extraction calls stopped at 1024 tokens with no text at all, and the record
 *    could not say where the tokens went. They now get more room, and every JSON
 *    call records which kinds of content block came back (blocks).
 */

const MAX_TOKENS = 1024;
const JSON_MAX_TOKENS = 4096;

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

  // userText: the user turn, or a whole conversation as [{ role, content }] (the "answered" mode).
  async callTool(model, system, userText, tool) {
    const res = await anthropic().messages.create({
      model, max_tokens: MAX_TOKENS, system,
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.inputSchema }],
      messages: Array.isArray(userText) ? userText : [{ role: "user", content: userText }],
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
    return (await this.callJsonMeta(model, system, user)).json;
  },

  // Same call, with what the record needs to explain a failure: why the model stopped, what it
  //   wrote, what it cost. A parse failure throws with those attached (see jsonReply).
  async callJsonMeta(model, system, user) {
    const res = await anthropic().messages.create({
      model, max_tokens: JSON_MAX_TOKENS, system,
      messages: [{ role: "user", content: user }],
    });
    return jsonReply(res.content.filter(b => b.type === "text").map(b => b.text).join(""),
                     res.stop_reason ?? null, res.usage ?? null, (res.content ?? []).map(b => b.type));
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
        messages: [{ role: "system", content: system },
                   ...(Array.isArray(userText) ? userText : [{ role: "user", content: userText }])],
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
      return (await this.callJsonMeta(model, system, user)).json;
    },

    async callJsonMeta(model, system, user) {
      const out = await post({
        model,
        max_tokens: JSON_MAX_TOKENS,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      });
      const msg = out?.choices?.[0]?.message ?? {};
      return jsonReply(msg.content ?? "", out?.choices?.[0]?.finish_reason ?? null, out?.usage ?? null,
                       Object.keys(msg).filter(k => msg[k] != null && k !== "role"));
    },
  };
}

// ── shared ──────────────────────────────────────────────────────────────────

/**
 * Lenient on wrapping prose, strict on the object. Same rule for every provider.
 * Reads the FIRST complete top-level object, matching braces outside strings. It used to take the
 *   span from the first "{" to the last "}", so prose after the object that contained a brace — or a
 *   second object — made the whole reply unparseable, and the run was scored as a broken hook.
 */
function parseJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`no JSON object in reply: ${text.slice(0, 200)}`);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`unterminated JSON object in reply: ${text.slice(0, 200)}`);
}

// Parse a JSON reply and keep the facts that explain it. On failure the error carries them, so the
//   record can say WHY the hook failed — the first smoke run had 19 extraction failures and no way
//   to tell a truncated reply from a chatty one.
const TRUNCATED = new Set(["max_tokens", "length"]);
// blocks: the kinds of content that came back (Anthropic block types, or the populated message
//   fields on the OpenAI shape). An empty text with a "thinking" block is a different failure from
//   an empty text with nothing — the first said run could not tell them apart.
function jsonReply(text, stop_reason, usage, blocks = null) {
  try {
    return { json: parseJsonObject(text), stop_reason, usage, blocks };
  } catch (e) {
    const err = new Error(`${TRUNCATED.has(stop_reason) ? "reply truncated at the token limit; " : ""}` +
                          `${stop_reason === "refusal" ? "the model refused; " : ""}${e.message}`);
    err.stop_reason = stop_reason;
    err.usage = usage;
    err.blocks = blocks;
    err.head = String(text).slice(0, 300);
    throw err;
  }
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

module.exports = { buildAdapter, parseJsonObject, jsonReply, MAX_TOKENS, JSON_MAX_TOKENS };
