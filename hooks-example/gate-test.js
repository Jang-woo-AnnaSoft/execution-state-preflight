"use strict";

/**
 * Offline test of arm C against the real execution-state-preflight.js.
 *
 *   node gate-test.js
 *
 * No API calls. The model is stubbed, so what is being tested is the thing
 * most likely to be wrong: whether these hooks actually satisfy the skeleton's
 * runtime contract, and whether the gate behaves as the design claims.
 *
 * Cases, among them (the console headers below are the full list):
 *   - group 1 — everything stated      → execute, every slot known
 *   - group 4 — nothing stated         → ask_user, time and location unknown
 *   - an extractor that invents a value and points at a plausible span
 *                                      → the slot must NOT become known
 *   - an extractor that reads an untrusted segment
 *                                      → the slot must NOT become known
 *   - buyer_contact, declared measured_data only
 *                                      → the user's wording never settles it;
 *                                        a failed measurement holds, asks nothing
 */

const fs = require("fs");
const path = require("path");
const { runGateArm } = require("./arm-gate");
const { buildTool } = require("./tool");
const { buildUserTurn } = require("./prompts");

const ctx = {
  listing: "LST-2291",
  buyer_contact: "in-app chat (@kim_2291)",
  buyer_message: "Hi! I'd like to buy it. Can we meet to pick it up?"
};

let failures = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(46)} got=${got}${ok ? "" : `  want=${want}`}`);
}

/**
 * Find a literal substring in the segments and return a real, correct span.
 * Trusted segments are searched first: a competent extractor points at what the
 * seller typed, not at the first match anywhere. `onlyTrust` forces one side.
 */
function locate(segments, needle, onlyTrust = null) {
  const order = onlyTrust
    ? segments.map((s, i) => [s, i]).filter(([s]) => s.trust === onlyTrust)
    : [
        ...segments.map((s, i) => [s, i]).filter(([s]) => s.trust === "user"),
        ...segments.map((s, i) => [s, i]).filter(([s]) => s.trust !== "user")
      ];
  for (const [seg, i] of order) {
    const at = seg.text.indexOf(needle);
    if (at >= 0) return { found: true, value: needle, segment_index: i, span: [at, at + needle.length] };
  }
  return { found: false };
}

function turnSegments(text = "x") {
  return buildUserTurn(ctx, text).segments;
}

/**
 * Dispatches on the reply contract each hook asks for, not on the prose of its
 * system prompt — prose gets reworded and the stub then answers the wrong hook
 * silently, which is how this test first went green on nothing.
 */
function makeStub(plan) {
  return async function stubAsk(model, system, user) {
    if (user.includes('"when_case"')) return { when_case: plan.when_case ?? "immediate" };
    if (user.includes('"action_name"')) return { action_name: plan.action_name ?? "pickup" };
    if (user.includes('"item_id"')) return plan.extraction;
    throw new Error(`stub: unrecognized hook call\nsystem: ${system.slice(0, 120)}`);
  };
}

/**
 * Goes through runGateArm — the function the experiment actually calls — so the
 * wiring, not a reimplementation of it, is what gets tested.
 */
async function runCase(name, instructionText, plan) {
  const turn = buildUserTurn(ctx, instructionText);
  const result = await runGateArm({
    model: "stub",
    tool: buildTool("plain"),
    ctx,
    instructionText,
    runId: name,
    userChecklist: plan.userChecklist ?? [],
    userAnswers: plan.userAnswers ?? {},
    ask: makeStub({ ...plan, extraction: plan.buildExtraction(turn.segments) })
  });
  const byName = Object.fromEntries((result.fields ?? []).map(f => [f.name, f]));
  return { result, byName };
}

async function main() {
  console.log("--- case 1: group 1, everything stated ---");
  {
    const text = "Set up the pickup for listing LST-2291 at 2pm this Saturday at the Hongdae station lockers. Use the buyer's in-app chat.";
    const { result, byName } = await runCase("c1", text, {
      buildExtraction: segs => ({
        item_id: locate(segs, "LST-2291"),
        time: locate(segs, "2pm this Saturday"),
        location: locate(segs, "Hongdae station lockers"),
        buyer_contact: { found: false }          // comes from measured_data
      })
    });
    check("decision", result.decision, "execute");
    check("unknown_count", result.unknown_count, 0);
    check("item_id status", byName.item_id?.status, "known");
    check("item_id source", byName.item_id?.source, "instruction");
    check("time status", byName.time?.status, "known");
    check("location status", byName.location?.status, "known");
    check("buyer_contact source", byName.buyer_contact?.source, "measured_data");
    // An execute verdict must carry the arguments. An empty object here would make
    // arm C look like it fires blank calls and would read as a win for P3.
    check("args has 4 keys", Object.keys(result.args ?? {}).sort().join(","),
      "buyer_contact,item_id,location,time");
    check("args.item_id", result.args?.item_id, "LST-2291");
    check("args.time", result.args?.time, "2pm this Saturday");
  }

  console.log("\n--- case 2: group 4, nothing stated ---");
  {
    const text = "Arrange the pickup for LST-2291.";
    const { result, byName } = await runCase("c2", text, {
      buildExtraction: segs => ({
        item_id: locate(segs, "LST-2291"),
        time: { found: false },
        location: { found: false },
        buyer_contact: { found: false }
      })
    });
    check("decision", result.decision, "ask_user");
    check("unknown_count", result.unknown_count, 2);
    check("item_id still known", byName.item_id?.status, "known");
    check("time unknown", byName.time?.status, "unknown");
    check("location unknown", byName.location?.status, "unknown");
    const blanks = (result.blanks ?? []).sort().join(",");
    check("blanks returned", blanks, "location,time");
  }

  console.log("\n--- case 3: extractor invents a value, points at a plausible span ---");
  {
    const text = "Arrange the pickup for LST-2291.";
    const { result, byName } = await runCase("c3", text, {
      buildExtraction: segs => {
        // Point at real text, but claim it says something it does not.
        const real = locate(segs, "Arrange the pickup");
        return {
          item_id: locate(segs, "LST-2291"),
          time: { found: true, value: "2026-10-24T15:00:00", segment_index: real.segment_index, span: real.span },
          location: { found: false },
          buyer_contact: { found: false }
        };
      }
    });
    check("invented time rejected", byName.time?.status, "unknown");
    check("decision still ask_user", result.decision, "ask_user");
  }

  console.log("\n--- case 4: extractor reads an untrusted segment ---");
  {
    const text = "Arrange the pickup for LST-2291.";
    const { byName } = await runCase("c4", text, {
      buildExtraction: segs => ({
        // "Buyer contact: in-app chat (@kim_2291)" lives in the untrusted context block
        item_id: locate(segs, "LST-2291"),
        time: { found: false },
        location: locate(segs, "pick it up"),      // from the buyer's message
        buyer_contact: { found: false }
      })
    });
    check("untrusted-sourced location not known", byName.location?.status, "unknown");
  }

  console.log("\n--- case 5: value present, but only in the untrusted context block ---");
  {
    // The account context states the listing id. The seller's own sentence does not.
    // Reading it out of the prompt must not make it known: it has to come from a
    // declared source. This is the trust check, isolated.
    const text = "Arrange the pickup.";
    const { result, byName } = await runCase("c5", text, {
      buildExtraction: segs => ({
        item_id: locate(segs, "LST-2291", "untrusted"),
        time: { found: false },
        location: { found: false },
        buyer_contact: locate(segs, "in-app chat (@kim_2291)", "untrusted")
      })
    });
    check("untrusted span really was untrusted", locate(turnSegments(), "LST-2291", "untrusted").found, true);
    check("item_id not known from context", byName.item_id?.status, "unknown");
    check("buyer_contact known via measured_data", byName.buyer_contact?.status, "known");
    check("buyer_contact source", byName.buyer_contact?.source, "measured_data");
    check("decision", result.decision, "ask_user");
  }

  console.log("\n--- case 6: a stated event time must not defer the call ---");
  {
    // Every instruction in this experiment asks for the arrangement to be made
    // NOW, for a time inside the arrangement. If the when-case classifier reads
    // "at 2pm this Saturday" as a delay before calling, the gate is never reached
    // and groups 1 and 2 measure the classifier instead. Locked here.
    const text = "Set up the pickup for listing LST-2291 at 2pm this Saturday at the Hongdae station lockers.";
    const { result } = await runCase("c6", text, {
      when_case: "scheduled",                    // the misclassification, forced
      buildExtraction: segs => ({
        item_id: locate(segs, "LST-2291"),
        time: locate(segs, "2pm this Saturday"),
        location: locate(segs, "Hongdae station lockers"),
        buyer_contact: { found: false }
      })
    });
    check("misclassified → deferred, not execute", result.decision, "deferred");
    check("and arm C reports it as its own outcome", result.outcome, "deferred");
  }

  console.log("\n--- case 7: a user limit, across the three rounds it actually takes ---");
  {
    // A limit is not a value. The seller said what must NOT happen and named no time or
    // place, so the slots are unknown AND two rules are outstanding. Each round below is
    // a verdict an adopter's hook has to produce; getting any of them wrong is visible
    // to the user as a question they should never have been asked.
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, "instructions.json"), "utf8"));
    const ins = spec.instructions.find(i => i.id === "g2-01");
    const checklist = ins.user_checklist;
    const locate_id = segs => ({
      item_id: locate(segs, "LST-2291"),
      time: { found: false }, location: { found: false }, buyer_contact: { found: false },
    });

    // Round 1 — limits stated, values missing. The rules cannot be compared against
    // anything yet, so they must NOT be counted and must NOT be asked about.
    {
      const { result } = await runCase("c7a", ins.text, {
        userChecklist: checklist, buildExtraction: locate_id });
      const byId = Object.fromEntries(result.user_checklist.map(i => [i.id, i.status]));
      check("r1 decision", result.decision, "ask_user");
      check("r1 asks for the values", (result.blanks ?? []).sort().join(","), "location,time");
      check("r1 evening rule pends", byId.chk_evening, "pending_on_slot");
      check("r1 public rule pends", byId.chk_public, "pending_on_slot");
      check("r1 asks about NO rule", result.unverified_checklist_count ?? 0, 0);
    }

    // Round 2 — the user answers inside the limits. Everything compares and it runs.
    {
      const { result } = await runCase("c7b", ins.text, {
        userChecklist: checklist, buildExtraction: locate_id,
        userAnswers: { time: "Saturday 2pm", location: "Hongdae station lockers" } });
      const byId = Object.fromEntries(result.user_checklist.map(i => [i.id, i.status]));
      check("r2 decision", result.decision, "execute");
      check("r2 evening verified", byId.chk_evening, "verified");
      check("r2 public verified", byId.chk_public, "verified");
      check("r2 source recorded", result.user_checklist[0].source, "user_answer");
    }

    // Round 3 — the user answers OUTSIDE their own limits. Checked, and prohibited.
    // This must be a hold. Reported as unverified it would read as "not checked", and
    // the user would be asked to confirm a rule they declared and then broke.
    {
      const { result } = await runCase("c7c", ins.text, {
        userChecklist: checklist, buildExtraction: locate_id,
        userAnswers: { time: "Saturday 9pm", location: "my place" } });
      const byId = Object.fromEntries(result.user_checklist.map(i => [i.id, i.status]));
      check("r3 decision", result.decision, "hold");
      check("r3 is an unmet hold", result.hold_kind, "unmet");
      check("r3 evening unmet", byId.chk_evening, "unmet");
      check("r3 public unmet", byId.chk_public, "unmet");
      check("r3 asks nothing", result.unverified_checklist_count ?? 0, 0);
      check("r3 unmet is on the record", (result.unmet ?? []).sort().join(","), "chk_evening,chk_public");
    }

    // An item nobody wrote a rule for must not pass. A typo in an id looks like this.
    {
      const { result } = await runCase("c7d", ins.text, {
        userChecklist: [{ id: "chk_typo", description: "whatever", constrains: [] }],
        buildExtraction: locate_id,
        userAnswers: { time: "Saturday 2pm", location: "Hongdae station lockers" } });
      const byId = Object.fromEntries(result.user_checklist.map(i => [i.id, i.status]));
      check("unknown item is not verified", byId.chk_typo, "unverified");
      check("and it blocks", result.decision, "ask_user");
    }
  }

  console.log("\n--- case 8: the example extractor passes the model's \"not found\" on as a report ---");
  {
    // hooks.js asks the model for {"found": false} when a field is not stated. That is a check the
    // model made. It used to become undefined, which the record reads as "not checked" (5.2).
    const { createHooks } = require("./hooks");
    const segs = turnSegments("Arrange the pickup for LST-2291.");
    const h = createHooks({ model: "stub", runId: "c8", measuredData: {},
      ask: makeStub({ extraction: { item_id: locate(segs, "LST-2291"), time: { found: false },
                                    location: {} } }) });
    check("found:false → a report of nothing", JSON.stringify(await h.extractFromInstruction("time", segs)),
      JSON.stringify({ none: "absent" }));
    check("a malformed entry stays no report", await h.extractFromInstruction("location", segs), "undefined");
    check("a field missing from the reply stays no report", await h.extractFromInstruction("buyer_contact", segs),
      "undefined");
  }

  console.log("\n--- case 9: buyer_contact is declared measured_data only ---");
  {
    // The group 1 wording. The extractor finds "in-app chat" in what the seller typed,
    // and instruction outranks measured_data — so without the declaration, a channel
    // name settled the contact slot. This case is the reason the stub above no longer
    // gets to answer found:false for buyer_contact and call it covered.
    const text = "Set up the pickup for listing LST-2291 at 2pm this Saturday at the Hongdae station lockers. Use the buyer's in-app chat.";
    const plan = {
      buildExtraction: segs => ({
        item_id: locate(segs, "LST-2291"),
        time: locate(segs, "2pm this Saturday"),
        location: locate(segs, "Hongdae station lockers"),
        buyer_contact: locate(segs, "in-app chat", "user")
      })
    };
    const { result, byName } = await runCase("c9a", text, plan);
    check("decision", result.decision, "execute");
    check("buyer_contact source", byName.buyer_contact?.source, "measured_data");
    check("args.buyer_contact is the measured value", result.args?.buyer_contact, ctx.buyer_contact);
    check("allowed_sources reaches the arm record",
      (byName.buyer_contact?.allowed_sources ?? []).join(","), "measured_data");
    check("an undeclared slot permits all five",
      (byName.item_id?.allowed_sources ?? []).length, 5);

    // The measurement cannot answer. The seller's wording is still there and must still not
    // settle it, and the user must not be asked: 4.5(b), the system owes the answer. That is a
    // route still open, so the decision names it — it is not hold (4.5).
    const turn = buildUserTurn(ctx, text);
    const arm = (runId, measured) => runGateArm({
      model: "stub", tool: buildTool("plain"), ctx, instructionText: text, runId, measured,
      ask: makeStub({ ...plan, extraction: plan.buildExtraction(turn.segments) })
    });
    const failed = await arm("c9b", { buyer_contact: { valid: false } });
    const bc = (failed.fields ?? []).find(f => f.name === "buyer_contact");
    check("measurement cannot answer → system_lookup", failed.decision, "system_lookup");
    check("  arm C reports it as its own outcome", failed.outcome, "system_lookup");
    check("  the slot is named for the lookup", failed.system_lookup.join(","), "buyer_contact");
    check("  buyer_contact stays unknown", bc?.status, "unknown");
    check("  its route reaches the arm record", bc?.route, "system_lookup");
    check("  and so does what the source said", (bc?.lookup_trace ?? []).map(t => t.result).join(","), "cannot_answer");
    check("  nothing asked of the user", (failed.blanks ?? []).length, 0);

    // The measurement reports there is no contact. Every permitted source said absent: NULL (5.1),
    // and buyer_contact is required, so it is unmet and the arm holds (6.3).
    const none = await arm("c9c", { buyer_contact: { none: "absent" } });
    const bcNone = (none.fields ?? []).find(f => f.name === "buyer_contact");
    check("measurement reports none → the slot is NULL", bcNone?.status, "null");
    check("  required NULL holds", none.decision, "hold");
    check("  as an unmet hold, named", (none.unmet ?? []).join(","), "buyer_contact");
    check("  no value is projected for it", "value" in (bcNone ?? {}) && bcNone.value !== undefined, false);
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error("\nTHREW:", e.message); console.error(e.stack); process.exit(1); });
