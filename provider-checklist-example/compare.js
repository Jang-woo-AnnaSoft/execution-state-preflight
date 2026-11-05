"use strict";

/**
 * v1 against v2, on the same inputs, with the same stand-in model. No API calls.
 *
 *   v1  hooks-example/: rules in JS (tool.js constants, the rules table in hooks.js)
 *   v2  this folder:    rules in declarations (tool.json, confirmed.json, instructions.json)
 *
 * Every instruction runs in every condition its group runs in (instruction_conditions), in the "said"
 * date mode, once with each extractor in stub.js. Both arms get the same user turn, the same
 * measurements and the same extraction, so each difference in a row is a difference in what was
 * declared.
 *
 *   node compare.js            the table
 *   node compare.js --out f    also writes the rows as JSON
 */

const fs = require("fs");
const path = require("path");
const { runArm } = require("./arm");
const { makeAsk, EXTRACTORS } = require("./stub");
const V2 = require("./instructions.json");

const V1_DIR = path.join(__dirname, "..", "hooks-example");
const { runGateArm } = require(path.join(V1_DIR, "arm-gate"));
const { buildTool } = require(path.join(V1_DIR, "tool"));
const V1 = require(path.join(V1_DIR, "instructions.json"));

const DATE = "said";

function slots(r) {
  return (r.fields ?? []).map(f => `${f.name}=${f.status === "known" ? `known(${f.source})` : `${f.status}${f.route ? `->${f.route}` : ""}`}`).join(" ");
}
function checks(r) {
  const u = (r.user_checklist ?? []).map(i => `${i.id}:${i.status}`);
  const p = (r.provider_checklist ?? []).filter(c => c.status !== "disclosure_required").map(c => `${c.id}:${c.status}`);
  return [...u, ...p].join(" ") || "-";
}

async function rows() {
  const out = [];
  for (const extractor of Object.keys(EXTRACTORS)) {
    for (const ins2 of V2.instructions) {
      const ins1 = V1.instructions.find(i => i.id === ins2.id);
      for (const cond of V2.instruction_conditions[String(ins2.group)] ?? []) {
        const v1 = await runGateArm({ model: "stub", tool: buildTool("plain"), ctx: V1.conditions[cond].context,
          instructionText: ins1.text, runId: `v1-${ins2.id}-${cond}`, date: V1.date_modes[DATE],
          userChecklist: ins1.user_checklist ?? [], ask: makeAsk(ins2.id, extractor) });
        const v2 = await runArm({ ctx: V2.conditions[cond].context, instructionText: ins2.text,
          runId: `v2-${ins2.id}-${cond}`, date: V2.date_modes[DATE],
          userChecklist: ins2.user_checklist ?? [], ask: makeAsk(ins2.id, extractor) });
        out.push({ extractor, id: ins2.id, group: ins2.group, condition: cond,
          v1: { outcome: v1.outcome, slots: slots(v1), checks: checks(v1) },
          v2: { outcome: v2.outcome, slots: slots(v2), checks: checks(v2) } });
      }
    }
  }
  return out;
}

if (require.main === module) {
  (async () => {
    const outAt = process.argv.indexOf("--out");
    const all = await rows();
    for (const extractor of Object.keys(EXTRACTORS)) {
      const mine = all.filter(r => r.extractor === extractor);
      const changed = mine.filter(r => r.v1.outcome !== r.v2.outcome || r.v1.slots !== r.v2.slots);
      console.log(`\n=== extractor: ${extractor} — ${mine.length} runs, outcome changed in ` +
        `${mine.filter(r => r.v1.outcome !== r.v2.outcome).length}, a slot changed in ${changed.length} ===`);
      for (const r of mine) {
        const mark = r.v1.outcome !== r.v2.outcome ? "  <- outcome" : (r.v1.slots !== r.v2.slots ? "  <- slots" : "");
        console.log(`\n${r.id} / ${r.condition}${mark}`);
        console.log(`  v1 ${r.v1.outcome.padEnd(6)} ${r.v1.slots}   [${r.v1.checks}]`);
        console.log(`  v2 ${r.v2.outcome.padEnd(6)} ${r.v2.slots}   [${r.v2.checks}]`);
      }
    }
    if (outAt > 0) {
      fs.writeFileSync(process.argv[outAt + 1], JSON.stringify({ date_mode: DATE, rows: all }, null, 1));
      console.log(`\nwrote ${process.argv[outAt + 1]}`);
    }
  })().catch(e => { console.error("THREW:", e.stack); process.exit(1); });
}

module.exports = { rows };
