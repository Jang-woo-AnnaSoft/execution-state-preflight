"use strict";
/**
 * Checks the cross-check runner's own wiring, with a case written here (none of theirs is vendored).
 *
 * What is checked: hooks.candidate_slots reaches the skeleton as getCandidateSlots, and cases in
 *   candidate_set_cases are run and compared. Without the wiring the narrowed case would run with the
 *   skeleton's default candidate set and execute — a match against a wrong expectation would then
 *   look like agreement. With it, the required slots the override leaves out are never looked up,
 *   and the skeleton routes them to definition_repair (gate-test case 16 covers the skeleton side).
 *
 *   node crosscheck/runner-test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const RUNNER = path.join(__dirname, "run_crosscheck.js");
const text = "Send 500 to account 123-45 for rent.";
const at = s => [text.indexOf(s), text.indexOf(s) + s.length];
const base = (narrow) => ({
  input: {
    userId: "u", instruction: [{ text, trust: "user" }],
    mcpTool: { name: "transfer_funds", description: "Transfer money.",
      inputSchema: { properties: { account: { type: "string" }, amount: { type: "number" }, memo: { type: "string" } },
                     required: ["account", "amount"] } },
    preSetData: {}, userAnswers: {}, priorExecutionState: { none: "absent" }, userChecklist: [],
  },
  measured_data: {},
  hooks: {
    c1: "immediate",
    c2_claim: { value: "Send", segment_index: 0, span: at("Send") },
    tool_match: { approved: true, reason: "case data" },
    extract: { account: { value: "123-45", segment_index: 0, span: at("123-45") },
               amount: { value: "500", segment_index: 0, span: at("500") },
               memo: { value: "rent", segment_index: 0, span: at("rent") } },
    ...(narrow ? { candidate_slots: ["memo"] } : {}),
  },
});
const variants = [{ name: "plain", provider_conditions: [] }];
// A case that answers: amount is not in the extraction, so the asking round asks for it; account is,
//   so an answer for it was never asked for and is refused (skeleton 1.18).
const answering = () => {
  const b = base(false);
  delete b.hooks.extract.amount;
  b.input.userAnswers = { amount: 500, account: "999-99" };
  return b;
};
const cases = {
  transaction_cases: [{ id: "T-default", esp_base: base(false), variants }, { id: "A-answer", esp_base: answering(), variants }],
  candidate_set_cases: [{ id: "N-narrow", esp_base: base(true), variants }],
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosscheck-runner-test-"));
let failed = 0;
const check = (label, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(52)} got=${got}${ok ? "" : `  want=${want}`}`);
};
try {
  const cf = path.join(dir, "cases.json"), out = path.join(dir, "out.json");
  fs.writeFileSync(cf, JSON.stringify(cases));
  execFileSync(process.execPath, [RUNNER, cf, "--out", out], { encoding: "utf8" });
  const rows = JSON.parse(fs.readFileSync(out, "utf8")).rows;
  const row = id => rows.find(r => r.id === id);

  console.log("--- crosscheck runner: candidate_slots wiring ---");
  check("both lists are run", rows.length, 3);
  check("default candidate set: executes", row("T-default")?.ours.decision, "execute");
  check("candidate_set_cases is read", row("N-narrow") != null, true);
  check("narrowed to [memo]: definition_repair", row("N-narrow")?.ours.decision, "definition_repair");
  check("  account routed to definition_repair", /account=unknown->definition_repair/.test(row("N-narrow")?.ours.why ?? ""), true);
  check("  amount routed to definition_repair", /amount=unknown->definition_repair/.test(row("N-narrow")?.ours.why ?? ""), true);

  console.log("--- crosscheck runner: a case that answers runs the asking round first ---");
  check("the asked slot's answer counts: executes", row("A-answer")?.ours.decision, "execute");
  check("  amount from user_answer", /amount=known\(user_answer\)/.test(row("A-answer")?.ours.why ?? ""), true);
  check("  account stays the instruction's: the unasked answer is refused", /account=known\(instruction\)/.test(row("A-answer")?.ours.why ?? ""), true);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
