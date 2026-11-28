"use strict";

/**
 * Checks plain-agent.js: what a plain agent would have done with the model's first call, read from the
 * decision records.
 *
 *   node plain-agent-test.js
 */

const { plainAgent } = require("./plain-agent");

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(68)} got=${JSON.stringify(got)}${ok ? "" : `  want=${JSON.stringify(want)}`}`);
}

const schema = { required: ["time", "location"], properties: { time: { type: "string", format: "date-time" }, location: { type: "string" } } };
const rec = (decision, args, fields, extra = {}) => ({ execution_decision: decision, tool_call: { name: "t", arguments: args }, fields, ...extra });
const call = { time: "2026-10-31T14:00:00+09:00", location: "my usual spot" };

check("no record: the model called no tool", plainAgent([], schema).verdict, "no call");
check("a required value empty, or not a date-time: the tool would have refused it",
  [plainAgent([rec("ask_user", { time: "", location: "x" }, [])], schema).verdict,
   plainAgent([rec("ask_user", { time: "Saturday", location: "x" }, [])], schema).verdict], ["invalid", "invalid"]);
check("a condition that did not hold: wrong, with the reason",
  plainAgent([rec("hold", { ...call, location: "Hongdae" }, [{ name: "time", status: "known", value: call.time }, { name: "location", status: "known", value: "Hongdae" }],
                  { reason: "hold: unmet — order_status = \"cancelled\"" })], schema).reasons,
  ["a condition did not hold: unmet — order_status = \"cancelled\""]);
const later = rec("execute", call, [], { call_arguments: { time: call.time, location: "Hongdae station lockers" } });
check("a value found nowhere then, and settled to another later: wrong",
  plainAgent([rec("ask_user", call, [{ name: "time", status: "known", value: call.time }, { name: "location", status: "unknown" }]), later], schema).reasons,
  ["location \"my usual spot\", where \"Hongdae station lockers\" was settled"]);
check("a value read from the user's words then, changed by the user later: not held against the call",
  plainAgent([rec("ask_user", { time: call.time, location: "Hongdae" }, [{ name: "time", status: "unknown", located_at: { segment_index: 3 } }, { name: "location", status: "known", value: "the Hongdae" }]),
              rec("execute", {}, [], { call_arguments: { time: "2026-10-31T19:00:00+09:00", location: "the Hongdae" } })], schema).verdict, "right");
check("a value known then, written otherwise in the call: wrong (\"the\" and case do not count)",
  [plainAgent([rec("ask_user", { time: call.time, location: "buyer's chat" }, [{ name: "location", status: "known", value: "in-app chat (@k)" }])], schema).verdict,
   plainAgent([rec("execute", { time: call.time, location: "The Hongdae" }, [{ name: "location", status: "known", value: "hongdae" }], { call_arguments: { time: call.time, location: "hongdae" } })], schema).verdict],
  ["wrong", "right"]);
check("what the gate did: ran after asking, ran with no question, did not run",
  [plainAgent([rec("ask_user", call, []), rec("execute", call, [], { call_arguments: call })], schema).gate,
   plainAgent([rec("execute", call, [], { call_arguments: call })], schema).gate,
   plainAgent([rec("hold", call, [])], schema).gate],
  ["ran after asking", "ran, no question", "did not run"]);
check("the executing side's own records are not the model's call",
  plainAgent([rec("not_executed", call, [], { actor: "executor" })], schema).verdict, "no call");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exitCode = failed ? 1 : 0;
