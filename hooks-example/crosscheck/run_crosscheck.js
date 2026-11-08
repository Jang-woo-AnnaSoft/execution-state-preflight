"use strict";
/**
 * Cross-check runner: someone else's cases, run through the actual skeleton.
 *
 * Built for the covenant project's case file (Hugging Face thread 183807): transaction cases written in
 * this skeleton's input shape, with every hook output given as case data, and their own expected
 * decision per case and variant, computed by a port they wrote from the text of this code.
 *
 * WHAT THIS TESTS: what the skeleton decides, given those claims. Hooks here are stand-ins that return
 *   the case data. hooks.js, extraction, and real measurement are not exercised. A match says the port
 *   and the skeleton agree on the decision logic; it says nothing about how good the claims are.
 *
 * SAFETY: the case files are read as data (JSON.parse). No code from the case file's authors is run.
 *
 * Usage:
 *   node crosscheck/run_crosscheck.js <cases.json> [expected.json] [--out results.json]
 *   npm run crosscheck -- <cases.json> [expected.json] [--out results.json]
 *
 * Case-data conventions (theirs, followed here):
 *   a key absent = undefined (no report); {"__throw__": msg} = the hook threw;
 *   provider_verdicts: {condition_id: verdict}; or provider_verifier "measured", which reads
 *   measured_data[condition.measured_key] = {valid, value} and reports measured_data as the source.
 *   candidate_slots: string[] = an adopter's getCandidateSlots override (cases in candidate_set_cases).
 *
 * The case files were written for the skeleton's earlier input, which took the tool, the measurements and
 *   the answers as input. The gate now reads them through its ports, so the runner hands the case data to
 *   the ports, unchanged: input.mcpTool is what readToolDefinition returns, measured_data what measure
 *   reads, and input.userAnswers / checklistAnswers the user's reply to the round that asked (see askFirst).
 */
const fs = require("fs");
const path = require("path");
const { createPreflight } = require(path.join(__dirname, "..", "..", "execution-state-preflight"));
const { askRound, answerRound } = require(path.join(__dirname, "..", "ports"));

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const OUT = outAt >= 0 ? args[outAt + 1] : null;
const [CASES, EXPECTED] = args.filter((a, i) => outAt < 0 || (i !== outAt && i !== outAt + 1));
if (!CASES) { console.error("usage: node crosscheck/run_crosscheck.js <cases.json> [expected.json] [--out results.json]"); process.exit(2); }

const clone = x => JSON.parse(JSON.stringify(x));
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const val = v => { if (v && typeof v === "object" && "__throw__" in v) throw new Error(v.__throw__); return v; };

// Same composition as their runner: a case's esp_base with one named variant.
function compose(base, v) {
  const c = clone(base);
  c.provider_conditions = clone(v.provider_conditions ?? []);
  if (v.provider_verifier) c.hooks.provider_verifier = v.provider_verifier;
  if (v.provider_verdicts) c.hooks.provider_verdicts = v.provider_verdicts;
  Object.assign(c.measured_data, clone(v.measured ?? {}));
  if (has(v, "ask_attempt")) c.input.ask_attempt = v.ask_attempt;
  return c;
}

function memStorage() {
  const m = new Map();
  return { persist: async (k, r) => { if (!m.has(k)) m.set(k, []); m.get(k).push(r); }, load: async k => m.get(k) ?? null,
           // Every record under the key, oldest first. Since skeleton 1.18 the gate reads what the unit
           //   was asked, and how often, this way.
           list: async k => [...(m.get(k) ?? [])] };
}

let seq = 0;
function hooksFor(c, unitKey) {
  const H = c.hooks ?? {};
  for (const unsupported of ["span_support", "allowed_sources", "checklist_verdicts", "supplied_unsafe_hooks"]) {
    if (has(H, unsupported)) throw new Error(`case data "${unsupported}" is not wired in this runner yet`);
  }
  return {
    // An adopter's getCandidateSlots override, as case data. Absent → the skeleton's own reference body.
    ...(has(H, "candidate_slots") ? { getCandidateSlots: () => clone(val(H.candidate_slots)) } : {}),
    classifyWhenCase: () => val(H.c1),
    extractUserActionName: () => (has(H, "c2_claim") ? val(H.c2_claim) : undefined),
    confirmToolNameMatchesIntent: () => val(H.tool_match),
    extractFromInstruction: f => (has(H.extract ?? {}, f) ? val(H.extract[f]) : undefined),
    // measured_data[name] as given, when the gate asks for it.
    measure: f => (c.measured_data && f in c.measured_data) ? val(c.measured_data[f]) : undefined,
    // The case's tool, for that tool's name.
    readToolDefinition: name => {
      if (c.input?.mcpTool?.name !== name) throw new Error(`no definition for ${name}`);
      return clone(c.input.mcpTool);
    },
    // One key per case run, the same in each of its rounds (the asking round, the run, the trigger re-run).
    buildActionKey: () => unitKey,
    // Since skeleton 1.16 an unwired validator reads as unverified (definition_repair). The cases do not
    //   exercise validation (the port they were written against had none), so the runner reports values
    //   checked unless a case asks for the skeleton's own defaults with hooks.validators: "default".
    ...(H.validators === "default" ? {} : { validateFieldSchema: () => null, validatePayload: () => null }),
    getProviderConditions: () => clone(c.provider_conditions ?? []),
    verifyProviderCondition: cond => {
      const ex = H.provider_verdicts ?? {};
      if (has(ex, cond.id)) return val(ex[cond.id]);
      if (H.provider_verifier === "measured" && cond.measured_key) {
        const m = (c.measured_data ?? {})[cond.measured_key];
        if (m && typeof m === "object" && m.valid === true && !("none" in m)) {
          return { status: m.value === true ? "checked" : "unmet", source: "measured_data",
                   note: `measured ${cond.measured_key} = ${JSON.stringify(m.value)}` };
        }
        return { status: "unverified", source: null, note: `no measurement for ${cond.measured_key}` };
      }
      return { status: "unverified", source: null, note: "verifyProviderCondition not wired" };
    },
  };
}

// The same one-line summary their runner writes, so the two can be compared as strings.
function summarize(r) {
  const bits = [];
  for (const f of r.fields ?? []) bits.push(`${f.name}=${f.status}${f.source ? `(${f.source})` : f.route ? `->${f.route}` : ""}`);
  for (const p of r.provider_checklist ?? []) if (p && "status" in p) bits.push(`${p.id}:${p.status}${p.route ? `->${p.route}` : ""}`);
  // The skeleton keeps the intent gate's issues under gate._diag.issues; their port reads gate.issues.
  const issues = r.gate?.issues ?? r.gate?._diag?.issues;
  if (r.phase == null && issues?.length) bits.push("intent issues: " + issues.map(i => `${i.slot}:${i.code} ${i.detail ?? ""}`).join("; "));
  if (r.gate?.kind) bits.push(`kind=${r.gate.kind}`);
  return `${r.execution_decision} -- ${bits.join(", ")}`;
}

const answersOf = c => ({ userAnswers: c.input?.userAnswers ?? {}, checklistAnswers: c.input?.checklistAnswers ?? {} });
const answering = c => Object.keys(answersOf(c).userAnswers).length + Object.keys(answersOf(c).checklistAnswers).length > 0;

// round: "plain" (no answers), "ask" (the round that asks, showing the values the case's answers will
//   approve) or "answer" (the user's reply appended to the instruction, read by readReplies).
async function runOne(c, unit, round = "plain") {
  const { mcpTool, userAnswers, checklistAnswers, ...input } = clone(c.input ?? {});
  let hooks = hooksFor(c, unit.key);
  let instruction = input.instruction;
  if (round === "ask") hooks = askRound(hooks, answersOf(c));
  if (round === "answer") ({ hooks, instruction } = answerRound(hooks, input.instruction, answersOf(c)));
  return createPreflight({ hooks, storage: unit.storage })
    .runPreflightAndRecord({ ...input, instruction, toolCall: { name: mcpTool?.name ?? "" } });
}

// A reply counts only for a question the unit was asked, in the user's words after it. A case that
//   carries answers (input.userAnswers / input.checklistAnswers) is the round AFTER the question, so the
//   runner first runs the round that asked — the same case, in the same storage, under the same key —
//   and then the reply: a value the case answers is the user's yes to that value shown, an item's
//   answer the user's yes or no. A reply to something that round did not ask is refused, as the gate
//   would refuse it in use.
async function askFirst(c, unit) {
  if (!answering(c)) return;
  await runOne(c, unit, "ask");
}

// A deferred instruction-time verdict is re-run as the trigger would run it (c1 immediate), as theirs does.
async function decide(c) {
  const unit = { key: `crosscheck:${++seq}`, storage: memStorage() };
  await askFirst(c, unit);
  const r = await runOne(c, unit, answering(c) ? "answer" : "plain");
  const out = { decision: r.execution_decision, why: summarize(r), phase: r.phase };
  if (r.phase === "at_instruction" && r.execution_decision === "deferred") {
    const t = clone(c); t.hooks.c1 = "immediate";
    const rt = await runOne(t, unit, answering(c) ? "answer" : "plain");
    out.at_trigger_rerun = { decision: rt.execution_decision, why: summarize(rt) };
  }
  return out;
}

// Before comparing: does each located claim point at its own value? A stale span stops the run at the
//   intent gate (or rejects the value), so every variant agrees for a reason the case was not written to test.
function spanWarnings(id, input, hooks) {
  const w = [];
  const seg = i => input?.instruction?.[i]?.text;
  const check = (where, claim) => {
    if (!claim || typeof claim !== "object" || !Array.isArray(claim.span)) return;
    const text = seg(claim.segment_index ?? 0);
    if (typeof text !== "string") { w.push(`${id} ${where}: segment ${claim.segment_index} not found`); return; }
    const at = text.slice(claim.span[0], claim.span[1]);
    if (at.toLowerCase() !== String(claim.value).toLowerCase()) {
      const i = text.toLowerCase().indexOf(String(claim.value).toLowerCase());
      w.push(`${id} ${where}: value ${JSON.stringify(claim.value)} but the span holds ${JSON.stringify(at)}` +
             (i >= 0 ? ` (the value is at ${i}, shift ${i - claim.span[0]})` : ""));
    }
  };
  check("c2_claim", hooks?.c2_claim);
  for (const [f, v] of Object.entries(hooks?.extract ?? {})) check(`extract.${f}`, v);
  return w;
}

(async () => {
  const cases = JSON.parse(fs.readFileSync(CASES, "utf8"));
  const expected = EXPECTED ? JSON.parse(fs.readFileSync(EXPECTED, "utf8")) : null;
  const expTx = new Map((expected?.transaction ?? []).map(t => [t.id, t.esp]));
  const effective = v => (v?.at_trigger_rerun ? v.at_trigger_rerun.decision : v?.decision);

  const warnings = [];
  const units = [];   // { id, variant, case }
  for (const t of cases.transaction_cases ?? []) {
    warnings.push(...spanWarnings(t.id, t.esp_base.input, t.esp_base.hooks));
    for (const v of t.variants) units.push({ id: t.id, variant: v.name, c: compose(t.esp_base, v), want: expTx.get(t.id)?.[v.name] });
  }
  const expCs = new Map((expected?.candidate_set ?? []).map(t => [t.id, t.esp]));
  for (const t of cases.candidate_set_cases ?? []) {
    warnings.push(...spanWarnings(t.id, t.esp_base.input, t.esp_base.hooks));
    for (const v of t.variants) units.push({ id: t.id, variant: v.name, c: compose(t.esp_base, v), want: expCs.get(t.id)?.[v.name] });
  }
  const tl = cases.trust_label_case;
  (tl?.label_variants ?? []).forEach((lv, i) => {
    const id = `${tl.id}[${i}]`;
    warnings.push(...spanWarnings(id, lv.input, lv.hooks));
    const base = { input: lv.input, measured_data: lv.measured_data, hooks: lv.hooks };
    for (const v of tl.variants) units.push({ id, variant: v.name, c: compose(base, v), want: expected?.trust_label?.labels?.[i]?.esp?.[v.name] });
  });

  if (warnings.length) {
    console.log(`CASE DATA: ${warnings.length} located claim(s) do not point at their value:`);
    for (const w of warnings) console.log(`  ${w}`);
    console.log("");
  }

  const rows = [];
  for (const u of units) {
    const ours = await decide(u.c);
    const row = { id: u.id, variant: u.variant, ours };
    if (expected) {
      row.theirs = u.want ?? null;
      row.decision_differs = effective(ours) !== effective(u.want) || ours.phase !== u.want?.phase || ours.decision !== u.want?.decision;
      row.summary_differs = ours.why !== u.want?.why || (ours.at_trigger_rerun?.why ?? null) !== (u.want?.at_trigger_rerun?.why ?? null);
    }
    rows.push(row);
  }

  const byVariant = {};
  for (const r of rows) {
    const d = effective(r.ours);
    (byVariant[r.variant] ??= {})[d] = (byVariant[r.variant][d] ?? 0) + 1;
  }
  console.log(`${rows.length} case/variant runs. Effective decision per variant:`);
  for (const [v, counts] of Object.entries(byVariant)) console.log(`  ${v.padEnd(42)} ${Object.entries(counts).map(([d, n]) => `${d} ${n}`).join(", ")}`);

  if (expected) {
    const dd = rows.filter(r => r.decision_differs), sd = rows.filter(r => !r.decision_differs && r.summary_differs);
    console.log(`\nAgainst ${path.basename(EXPECTED)}: decision or phase differs in ${dd.length}, summary only in ${sd.length}.`);
    for (const r of [...dd, ...sd]) {
      console.log(`\n${r.id} / ${r.variant}${r.decision_differs ? "  [DECISION]" : "  [summary]"}`);
      console.log(`  skeleton: ${r.ours.phase} ${r.ours.why}${r.ours.at_trigger_rerun ? `  | trigger: ${r.ours.at_trigger_rerun.why}` : ""}`);
      console.log(`  expected: ${r.theirs?.phase} ${r.theirs?.why}${r.theirs?.at_trigger_rerun ? `  | trigger: ${r.theirs.at_trigger_rerun.why}` : ""}`);
    }
  }

  if (OUT) {
    // IDs, variants and decisions only — no case text, so the output can be shared without the case file.
    fs.writeFileSync(OUT, JSON.stringify({ cases: path.basename(CASES), expected: EXPECTED ? path.basename(EXPECTED) : null,
      warnings, rows }, null, 1));
    console.log(`\nwrote ${OUT}`);
  }
})().catch(e => { console.error("THREW:", e.stack); process.exit(1); });
