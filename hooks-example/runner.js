"use strict";

/**
 * Runs (model × arm × instruction × repeat) and writes raw JSONL.
 *
 *   node runner.js                           full run 1, every model in models.json
 *   node runner.js --models opus             one model
 *   node runner.js --models opus,gpt,llama   across providers
 *   node runner.js --repeats 2 --arms A      a smoke test before spending
 *   node runner.js --variant labelled        run 2 (provider labels)
 *   node runner.js --check                   validate registry and keys, call nothing
 *
 * Models come from models.json, not from this file: ids change and which ones
 * you can reach depends on your account. Verify them before spending.
 */

const fs = require("fs");
const path = require("path");
const { buildTool } = require("./tool");
const { SYSTEM_A, SYSTEM_B, SYSTEM_C } = require("./prompts");
const { runPlainArm } = require("./arm-plain");
const { runGateArm } = require("./arm-gate");
const { buildAdapter } = require("./providers");

const REGISTRY = JSON.parse(fs.readFileSync(path.join(__dirname, "models.json"), "utf8")).models;

const ARMS = {
  A: { label: "plain", system: SYSTEM_A },
  B: { label: "prompt-mitigation", system: SYSTEM_B },
  C: { label: "gate", system: SYSTEM_C }
};

function parseArgs(argv) {
  const out = { models: Object.keys(REGISTRY), arms: ["A", "B", "C"], repeats: 5, variant: "plain",
                check: false, conditions: null };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i].replace(/^--/, "");
    if (k === "check") { out.check = true; continue; }
    const v = argv[i + 1]; i += 1;
    if (k === "models" || k === "arms" || k === "conditions") out[k] = v.split(",");
    else if (k === "repeats") out.repeats = parseInt(v, 10);
    else if (k === "variant") out.variant = v;
  }
  return out;
}

/**
 * Resolve every requested model to an adapter, and confirm its key is present,
 * BEFORE the first paid call. A stale id or a missing key then costs nothing
 * instead of stopping a run halfway and leaving a half-populated results file.
 */
function resolveModels(keys) {
  const resolved = [];
  const problems = [];
  for (const key of keys) {
    const entry = REGISTRY[key];
    if (!entry) { problems.push(`${key}: not in models.json (have: ${Object.keys(REGISTRY).join(", ")})`); continue; }
    let adapter;
    try { adapter = buildAdapter(entry); }
    catch (e) { problems.push(`${key}: ${e.message}`); continue; }
    const envKey = entry.env_key ?? adapter.envKey;
    if (!process.env[envKey]) { problems.push(`${key}: ${envKey} is not set`); continue; }
    resolved.push({ key, entry, adapter, model: entry.model, vendor: entry.vendor ?? entry.provider });
  }
  return { resolved, problems };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const opts = parseArgs(process.argv);

  const { resolved, problems } = resolveModels(opts.models);
  if (problems.length) {
    console.error("\nmodels.json / environment problems:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("");
  }
  if (opts.check) {
    for (const m of resolved) {
      console.log(`  ok  ${m.key.padEnd(10)} ${String(m.vendor).padEnd(10)} ${m.model}  via ${m.adapter.id}`);
    }
    console.log(`\n${resolved.length} usable, ${problems.length} unusable. Nothing was called.\n`);
    process.exit(problems.length ? 1 : 0);
  }
  if (!resolved.length) { console.error("no usable models. Nothing was called."); process.exit(1); }
  if (problems.length) {
    // Dropping a model silently would leave a results file whose missing cells
    // look like a finding. Refuse instead and let the caller narrow --models.
    console.error("refusing to run a partial model set. Fix the above, or pass --models explicitly.");
    process.exit(1);
  }

  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, "instructions.json"), "utf8"));
  const tool = buildTool(opts.variant);

  // (instruction × condition) pairs. Declared groups run clean only; the
  // undeclared ones carry the pollution axis. See instructions.json.
  const cells = [];
  for (const ins of spec.instructions) {
    const names = opts.conditions
      ?? spec.instruction_conditions[String(ins.group)]
      ?? ["clean"];
    for (const cname of names) {
      const cond = spec.conditions[cname];
      if (!cond) throw new Error(`instruction ${ins.id}: unknown condition "${cname}"`);
      cells.push({ ins, cname, cond });
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(__dirname, "results", `run-${opts.variant}-${stamp}.jsonl`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const meta = {
    kind: "meta",
    started_at: new Date().toISOString(),
    variant: opts.variant,
    repeats: opts.repeats,
    models: resolved.map(m => ({ key: m.key, vendor: m.vendor, model: m.model, provider: m.adapter.id,
                                 base_url: m.entry.base_url ?? null, json_mode: m.entry.json_mode === true })),
    // Recorded so a reader does not have to take it on trust: no sampling
    // parameters are sent to any provider. See the header of providers.js.
    sampling: { temperature: null, top_p: null, seed: null, note: "provider defaults; nothing sent" },
    arms: opts.arms,
    tool,
    prompts: { A: SYSTEM_A, B: SYSTEM_B, C: SYSTEM_C },
    instructions: spec.instructions,
    conditions: spec.conditions,
    instruction_conditions: spec.instruction_conditions,
    cells: cells.map(c => ({ instruction_id: c.ins.id, group: c.ins.group, condition: c.cname })),
  };
  fs.appendFileSync(outPath, JSON.stringify(meta) + "\n");

  const total = resolved.length * opts.arms.length * cells.length * opts.repeats;
  let n = 0;

  for (const { key: mKey, model, adapter, vendor } of resolved) {
    for (const armKey of opts.arms) {
      const arm = ARMS[armKey];
      for (const { ins, cname, cond } of cells) {
        const ctx = cond.context;
        for (let r = 1; r <= opts.repeats; r++) {
          n += 1;
          const runId = `${mKey}-${armKey}-${ins.id}-${cname}-r${r}`;
          const t0 = Date.now();
          let result, error = null;
          try {
            result = armKey === "C"
              ? await runGateArm({ adapter, model, tool, ctx, instructionText: ins.text, runId,
                                   userChecklist: ins.user_checklist ?? [] })
              : await runPlainArm({ adapter, model, systemPrompt: arm.system, tool, ctx, instructionText: ins.text });
          } catch (e) {
            error = { message: e?.message ?? String(e), stack: e?.stack ?? null };
            result = { outcome: "error", args: null };
          }

          fs.appendFileSync(outPath, JSON.stringify({
            kind: "run",
            run_id: runId,
            model, model_key: mKey, vendor, provider: adapter.id,
            arm: armKey, arm_label: arm.label,
            instruction_id: ins.id, group: ins.group, instruction_text: ins.text,
            // The condition and its trap travel with the run, so the analyzer
            // never has to guess which context a result came from.
            condition: cname, pollution: cond.pollution ?? 0, trap: cond.trap ?? {},
            repeat: r,
            variant: opts.variant,
            ms: Date.now() - t0,
            error,
            ...result
          }) + "\n");

          process.stdout.write(`\r${n}/${total}  ${runId}${error ? "  ERROR" : ""}        `);
          await sleep(300);        // be polite to the API
        }
      }
    }
  }

  process.stdout.write(`\ndone → ${outPath}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
