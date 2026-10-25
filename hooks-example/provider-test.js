"use strict";

/**
 * Offline test of the provider adapters.
 *
 *   node provider-test.js
 *
 * No API calls and no keys: fetch is replaced, so what is tested is the thing
 * most likely to be wrong — whether the request we build is the shape the
 * provider expects, and whether we read its reply correctly.
 *
 * The two shapes differ in ways that are easy to get silently wrong:
 *   Anthropic  tools[].input_schema          reply: content[] with a tool_use block
 *   OpenAI     tools[].function.parameters   reply: tool_calls[].function.arguments
 *                                                   — a JSON *string*, not an object
 * A wrong key name means the model is handed no tool at all and every run comes
 * back as "ask", which would read as a finding rather than a bug.
 */

const { buildAdapter } = require("./providers");
const { buildTool } = require("./tool");

let failures = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(50)} got=${got}${ok ? "" : `  want=${want}`}`);
}

const ENTRY = {
  provider: "openai", model: "test-model", vendor: "Test",
  base_url: "https://example.invalid/v1", env_key: "TEST_KEY",
};

/** Capture the request the adapter builds, and reply with whatever is handed in. */
function withFetch(reply, fn) {
  const real = global.fetch;
  let seen = null;
  global.fetch = async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    return {
      ok: reply.ok !== false,
      status: reply.status ?? 200,
      json: async () => reply.json,
      text: async () => reply.text ?? "",
    };
  };
  return fn().then(
    out => { global.fetch = real; return { out, seen }; },
    err => { global.fetch = real; return { err, seen }; }
  );
}

async function main() {
  process.env.TEST_KEY = "sk-not-a-real-key";
  const adapter = buildAdapter(ENTRY);
  const tool = buildTool("plain");

  console.log("--- openai shape: the request we build ---");
  {
    const { seen } = await withFetch(
      { json: { choices: [{ message: { content: "hi" }, finish_reason: "stop" }] } },
      () => adapter.callTool("test-model", "SYS", "USER", tool)
    );
    check("endpoint", seen.url, "https://example.invalid/v1/chat/completions");
    check("auth header present", String(seen.headers.authorization).startsWith("Bearer "), "true");
    check("system goes in messages[0]", seen.body.messages[0].role, "system");
    check("tool is type=function", seen.body.tools[0].type, "function");
    check("schema key is 'parameters'", seen.body.tools[0].function.parameters !== undefined, "true");
    check("NOT 'input_schema'", seen.body.tools[0].input_schema === undefined, "true");
    check("tool name carried", seen.body.tools[0].function.name, "schedule_pickup");
    check("required args carried", (seen.body.tools[0].function.parameters.required ?? []).length, 4);
    // Sampling must be absent, not zero. A sent temperature would change what the
    // experiment measures, so its absence is asserted rather than assumed.
    check("no temperature sent", "temperature" in seen.body, "false");
    check("no top_p sent", "top_p" in seen.body, "false");
    check("no seed sent", "seed" in seen.body, "false");
    check("no response_format (json_mode off)", "response_format" in seen.body, "false");
  }

  console.log("\n--- openai shape: reading the reply ---");
  {
    const { out } = await withFetch(
      { json: { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{
          function: { name: "schedule_pickup", arguments: '{"item_id":"LST-2291","time":"2pm Sat"}' } } ] } }],
          usage: { total_tokens: 7 } } },
      () => adapter.callTool("test-model", "SYS", "USER", tool)
    );
    check("outcome kind", out.kind, "call");
    check("arguments parsed from string", out.args.item_id, "LST-2291");
    check("second arg", out.args.time, "2pm Sat");
    check("usage carried", out.usage.total_tokens, 7);
  }
  {
    const { out } = await withFetch(
      { json: { choices: [{ message: { content: "Which time works?" }, finish_reason: "stop" }] } },
      () => adapter.callTool("test-model", "SYS", "USER", tool)
    );
    check("text reply becomes kind=text", out.kind, "text");
    check("text carried", out.text, "Which time works?");
  }
  {
    // Malformed arguments must NOT become an empty call: that would be scored as
    // "called the tool with nothing", which is a different thing entirely.
    const { err } = await withFetch(
      { json: { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{
          function: { name: "schedule_pickup", arguments: "{not json" } }] } }] } },
      () => adapter.callTool("test-model", "SYS", "USER", tool)
    );
    check("malformed arguments throw", /not valid JSON/.test(err?.message ?? ""), "true");
  }
  {
    const { err } = await withFetch(
      { ok: false, status: 429, text: "rate limited" },
      () => adapter.callTool("test-model", "SYS", "USER", tool)
    );
    check("HTTP error surfaces status", /429/.test(err?.message ?? ""), "true");
  }

  console.log("\n--- openai shape: callJson (arm C) ---");
  {
    const { out, seen } = await withFetch(
      { json: { choices: [{ message: { content: 'here you go {"when_case":"immediate"} ok' } }] } },
      () => adapter.callJson("test-model", "SYS", "USER")
    );
    check("no tools on a json call", "tools" in seen.body, "false");
    check("object extracted from prose", out.when_case, "immediate");
    // Hook JSON calls get more room than tool calls; tool calls keep the first runs' budget.
    const { JSON_MAX_TOKENS, MAX_TOKENS } = require("./providers");
    check("json call budget", seen.body.max_tokens, JSON_MAX_TOKENS);
    const t = await withFetch({ json: { choices: [{ message: { content: "ok" } }] } },
      () => adapter.callTool("test-model", "SYS", "USER", tool));
    check("tool call budget unchanged", t.seen.body.max_tokens, MAX_TOKENS);
  }
  {
    // What came back is on the record, success or not, and a refusal says it was one.
    const ok = await withFetch(
      { json: { choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }] } },
      () => adapter.callJsonMeta("test-model", "SYS", "USER"));
    check("blocks recorded on success", (ok.out.blocks ?? []).join(","), "content");
    const ref = await withFetch(
      { json: { choices: [{ message: { content: "" , refusal: "no" }, finish_reason: "refusal" }] } },
      () => adapter.callJsonMeta("test-model", "SYS", "USER"));
    check("a refusal is named as one", /the model refused/.test(ref.err?.message ?? ""), "true");
    check("  with what came back", (ref.err?.blocks ?? []).join(","), "content,refusal");
  }
  {
    const { err } = await withFetch(
      { json: { choices: [{ message: { content: "I cannot do that." } }] } },
      () => adapter.callJson("test-model", "SYS", "USER")
    );
    // A non-JSON reply must throw: in arm C that settles the slot as a lookup
    // failure, which the analyzer reports as broken_hooks, not as a gate verdict.
    check("non-JSON reply throws", /no JSON object/.test(err?.message ?? ""), "true");
  }

  console.log("\n--- json_mode is opt-in per entry ---");
  {
    const jm = buildAdapter({ ...ENTRY, json_mode: true });
    const { seen } = await withFetch(
      { json: { choices: [{ message: { content: "{}" } }] } },
      () => jm.callJson("test-model", "SYS", "USER")
    );
    check("response_format set when enabled", seen.body.response_format?.type, "json_object");
  }

  console.log("\n--- registry validation refuses bad entries ---");
  {
    const bad = [
      [{ provider: "meta", model: "x" }, /unknown provider/],
      [{ provider: "openai", model: "x", env_key: "K" }, /base_url/],
      [{ provider: "openai", model: "x", base_url: "https://y/v1" }, /env_key/],
    ];
    for (const [entry, re] of bad) {
      let msg = "";
      try { buildAdapter(entry); } catch (e) { msg = e.message; }
      check(`rejects ${JSON.stringify(entry).slice(0, 44)}`, re.test(msg), "true");
    }
    check("accepts anthropic entry", buildAdapter({ provider: "anthropic", model: "x" }).id, "anthropic");
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error("\nTHREW:", e.message); console.error(e.stack); process.exit(1); });
