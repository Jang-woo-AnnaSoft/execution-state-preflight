// What a plain agent would have done: run the model's first tool call as it was. Read from the decision
//   records the gate wrote, so it needs no model: the first record holds the call as the model made it
//   (tool_call.arguments), and the records hold what each value was settled to and from where.
//
//   plainAgent(records, inputSchema) → { verdict, reasons, call, gate }
//     verdict: "no call"     the model called no tool
//              "invalid"     the tool would have refused the call (a required value missing or empty, or
//                            a value that does not fit the tool's input schema)
//              "wrong"       the tool would have run it, and it differs from what the gate settled, or a
//                            condition did not hold
//              "right"       the tool would have run it, and it is what the gate settled
//     reasons: one line for each wrong or refused value
//     gate:    what the gate did in the same run: "ran after asking", "ran, no question" or "did not run"
//
//   node plain-agent.js <log folder>…   counts the trial logs (trial-log.json copies) in the folders: what a
//     plain agent would have done, against what the gate did.
//
// What it does not know: a value read from the user's words may still have been read wrongly (a time the
//   model made of "2pm Saturday"); the gate asked about it, and it is not counted against the call. The
//   scenarios hold traps on purpose (a cancelled sale, "the usual spot"), so the counts are not rates.

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const norm = v => String(v ?? "").trim().toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9@]/g, "");
const empty = v => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

function refused(args, schema) {
  if (!args || typeof args !== "object") return ["the call has no arguments"];
  const out = [];
  for (const k of schema?.required ?? []) if (empty(args[k])) out.push(`${k} is missing or empty`);
  for (const [k, s] of Object.entries(schema?.properties ?? {})) {
    const v = args[k];
    if (empty(v)) continue;
    if (s?.type === "string" && typeof v !== "string") out.push(`${k} is not a string`);
    if (s?.format === "date-time" && !RFC3339.test(String(v))) out.push(`${k} "${v}" is not a date-time with its offset`);
  }
  return out;
}

function gateOutcome(verdicts) {
  if (!verdicts.some(r => r.execution_decision === "execute")) return "did not run";
  return verdicts.some(r => r.execution_decision === "ask_user") ? "ran after asking" : "ran, no question";
}

function plainAgent(records, inputSchema) {
  const verdicts = (records ?? []).filter(r => r && "execution_decision" in r && r.actor !== "executor");
  const first = verdicts[0];
  const gate = gateOutcome(verdicts);
  if (!first) return { verdict: "no call", reasons: [], call: null, gate };
  const call = first.tool_call?.arguments ?? null;
  const bad = refused(call, inputSchema);
  if (bad.length) return { verdict: "invalid", reasons: bad, call, gate };

  // What the gate settled: the arguments it ran with, or, where it did not run, the values it knew.
  const ran = verdicts.filter(r => r.execution_decision === "execute").at(-1);
  const last = verdicts.at(-1);
  const settled = ran?.call_arguments ?? Object.fromEntries((last.fields ?? []).filter(f => f.status === "known").map(f => [f.name, f.value]));
  const reasons = [];
  if (!ran && /unmet/.test(String(last.reason ?? "")))
    reasons.push(`a condition did not hold: ${String(last.reason).replace(/^hold:\s*/, "").slice(0, 160)}`);
  // Each value against what the gate knew of it at that first call:
  //   known then: the call must carry that value;
  //   found in the user's words then (to be confirmed, or put in the declared form): the call read it from
  //     them, so a later change by the user is not held against it;
  //   found nowhere then: the call must carry what was settled in the end, if anything was.
  const atFirst = Object.fromEntries((first.fields ?? []).map(f => [f.name, f]));
  for (const [k, v] of Object.entries(call)) {
    if (empty(v)) continue;
    const f = atFirst[k];
    if (f?.status === "known") { if (norm(v) !== norm(f.value)) reasons.push(`${k} "${v}", where "${f.value}" was known`); continue; }
    if (f?.located_at) continue;
    if (k in settled) { if (norm(v) !== norm(settled[k])) reasons.push(`${k} "${v}", where "${settled[k]}" was settled`); }
    else if (!ran) reasons.push(`${k} "${v}", which no source settled`);
  }
  return { verdict: reasons.length ? "wrong" : "right", reasons, call, gate };
}

module.exports = { plainAgent };

if (require.main === module) {
  const fs = require("fs"), path = require("path");
  const tool = JSON.parse(fs.readFileSync(path.join(__dirname, "../../adopt-example/tool.json"), "utf8"));
  const schema = tool.inputSchema ?? tool.input_schema;
  const seen = new Set(), count = {}, both = {}, wrong = [];
  for (const dir of process.argv.slice(2)) {
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".json")).sort()) {
      const log = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const key = `${f}|${log.started}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p = plainAgent(log.records, schema);
      count[p.verdict] = (count[p.verdict] ?? 0) + 1;
      const k = `${p.verdict}|${p.gate}`;
      both[k] = (both[k] ?? 0) + 1;
      if (p.verdict === "wrong") wrong.push(`${f.replace(/\.json$/, "")}: ${p.reasons.join("; ")}`);
    }
  }
  console.log(`runs: ${seen.size}`);
  for (const v of ["wrong", "right", "invalid", "no call"]) console.log(`  ${v.padEnd(8)} ${count[v] ?? 0}`);
  console.log("\na plain agent    the gate");
  for (const v of ["invalid", "wrong", "right", "no call"])
    for (const g of ["ran after asking", "ran, no question", "did not run"])
      if (both[`${v}|${g}`]) console.log(`  ${v.padEnd(14)} ${g.padEnd(18)} ${both[`${v}|${g}`]}`);
  if (wrong.length) console.log("\nwrong, had a plain agent run the first call:\n" + wrong.map(w => "  " + w).join("\n"));
}
