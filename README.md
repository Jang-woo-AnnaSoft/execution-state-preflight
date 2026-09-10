# execution-state-preflight

A verification layer that runs before an MCP tool call.

Three checklists say what has to be true before a call goes out. Two gates check them and write a verdict. Neither gate produces a value or a justification, and neither one executes or blocks — they look things up and record what they found. Execution reads that record and nothing else.

This is not a wall in front of your agent. It fills, with a stated source, the blanks that guessing used to fill. Execution is still the goal.

**Status:** a reference skeleton, not a library. `createPreflight` refuses to build without six injected hooks.

The code here is a skeleton meant to show the structure, not something to adopt as-is. What actually has to be code in your system is `lookupField` and the shape of the decision record. Everything else — the agent loop, how you ask the user, storage — you write to fit what you already have. Take the parts that match and leave the rest.

**Start here.** [*Moving the Verdict Out of the Model (판단 권한 이관)*](./spec.ko.md) is the argument — why the list of what to check has to sit outside the model, and what changes when it does. [design.md](./design.md) is the short version of the structure: the two axes, the checklists, the source order, the three states, and where the boundaries are. This README describes the reference skeleton itself — the hook contracts, the record shape, and what this does and does not cover.

Read in that order if you are deciding whether this is worth doing. Start here if you already are.

---

## Eight problems

Getting to three checklists and two gates meant working through seven of them.

1. Inference accuracy not being the thing that grants execution authority
2. The first draft moving to the model, which turns human review into a click-through
3. Neither re-asking nor after-the-fact exclusion working, because the model is the one deciding what to ask
4. Conditions having nowhere to be written down, so they are never declared
5. Three kinds of unstated input — value, condition, intent — reaching execution undefined
6. No record of the verdict, so causes can't be told apart afterwards
7. Rules scattered across prompt and code, so changing one needs a deploy

---
   
## The three checklists

The rules an action needs split by who defines them. This split is the whole design — everything below is machinery for enforcing it.

Who defines an item and what can resolve it are different questions. A provider declares that the balance must be sufficient; a system measurement resolves whether it is. The checklists below are the first axis; [where each value came from](#where-each-value-came-from) is the second.

**Fixed checklist** — which tool are we picking, and are the execution conditions met (when/case)? Tool-independent, and identical for every execution. In the record these are `c1_when_case`, `c2_user_action_name`, `c3_provider_action_name`.

**Provider checklist** — required fields, type and format, pre-execution checks, prohibited conditions, extra confirmation conditions. Changes per tool. Splits again on enforceability: `inputSchema.required` can be gated, while `description` is prose and can't be, so it's recorded as advisory and passed to the model as context.

**User checklist** — user intent, current context, execution limits, pre-execution checks, preferences. Changes with the user's environment rather than with the tool. Each item needs a stable `id`; without one there's no key to reattach an answer to, and the run holds.

The fixed checklist is what Gate 1 asks. The provider and user checklists are what Gate 2 asks.

---

## The two gates

```
instruction (trust-labeled segments)
   │
   ├─ Gate 1   Fixed checklist                  → tool_undetermined → ask_user
   │           is this the right tool? when does it run?
   │
   ├─ Gate 2   Provider + User checklists       → unknown_fields    → ask_user
   │           where did each value come from?     unverified_checklist
   │           are the user's conditions verified?
   │
   └─ both clear                                → execute → executed
```

Both gates end at a record. Neither calls the tool and neither aborts anything — `execution_decision` is a verdict written to state, and `executeIfReady` is a separate step that reads it. A run with no record has no grounds to proceed on.

Gate 1 sits above everything the provider supplies. Move it lower and an undetermined tool's `required` fields and `description` ride into the gate with it — you'd be validating arguments for a call that shouldn't happen at all.

---

## Gate 1 — the fixed checklist

Tool selection accuracy is never going to hit 100%. Wrong picks are inevitable, so the first job is a structure where a wrong pick doesn't reach execution.

`confirmToolNameMatchesIntent` compares what the user called the action (`c2`) against the tool that was selected (`c3`). Anything other than an explicit `{ approved: true }` stops here — a hook that returns `undefined`, throws, or omits the field is not approving. Silence is not approval.

**This hook is model-based judgment, not code verification.** Whether an action really is this tool is decided from the tool's description, which is prose. The hook can be wired to an LLM, a name-matching rule, or a lookup table, but none of those is a deterministic check, and a wrong pick among several tools that could all do the job still gets through. Treat Gate 1 as mitigation belonging on the principle side rather than as something the code proves — the specification puts tool selection under residual risk for exactly this reason. Gate 2 is where deterministic counting happens.

```json
{
  "schema_version": "1.4",
  "action_key": "u_01:clean-up",
  "phase": "at_trigger",
  "fixed": {
    "c1_when_case": "immediate",
    "c2_user_action_name": "clean up the old invoices",
    "c3_provider_action_name": "records.delete_all"
  },
  "fields": null,
  "advisory_notes": "",
  "unknown_count": null,
  "gate": {
    "kind": "tool_undetermined",
    "user_message": "I could not determine which tool to use. Please restate what you want to do.",
    "_diag": {
      "candidate_tool": "records.delete_all",
      "user_action": "clean up the old invoices",
      "reason": "scope mismatch: user action is bounded, tool is unbounded"
    }
  },
  "execution_decision": "ask_user",
  "reason": "ask_user: tool undetermined (scope mismatch: user action is bounded, tool is unbounded)"
}
```

Four things in that record are deliberate:

**The user message doesn't name the candidate tool.** Show someone `records.delete_all` and the question stops being "what did you want" and becomes "approve this?" — people pick what they're shown. The candidate lives in `_diag`, which goes to logs and never to the user.

**It's `ask_user`, not `hold`.** An undetermined tool isn't a defect. It's a thing to ask about.

**`fields` is `null`, not `[]`.** Null means no decision was made; `[]` would mean the lookup ran and came out empty. Same for `unknown_count`. This is why the caller contract is `if (decision !== "execute")` and never `if (unknown_count > 0)` — `null > 0` is `false`, and a not-yet-computed state would sail through.

**Re-entry replaces the tool, not the answers.** The response to `tool_undetermined` doesn't go into `userAnswers`. You swap `mcpTool` and call again. The skeleton deliberately doesn't read the "user already reselected" flag, because reading it would turn it into a bypass switch; only the name is fixed (`input.tool_reselected_by_user`) so the adopting system can implement it consistently. Cap the retries — two or three under the same `action_key`, then hold.

If you have few enough tools to present a list, present it flat. No default selection, no "recommended" marker.

The other half of the fixed checklist is `c1_when_case`, which decides the phase: `immediate` runs the rest now, anything else defers it to trigger time. An out-of-enum value holds rather than falling through to immediate — see [Values now, conditions at trigger time](#values-now-conditions-at-trigger-time).

---

## Gate 2 — the provider and user checklists

Everything below is reached only after the tool is determined.

### Where each value came from

A validator can't tell an account number the user typed from one the model invented. Worse, a required field is pressure on the model to produce something. So this layer doesn't validate arguments — it looks up where each one came from.

| # | Source | Meaning |
|---|--------|---------|
| 0 | `user_answer` | answered by the user after an `ask_user` |
| 1 | `instruction` | taken from a trusted segment, with a span |
| 2 | `pre_set_data` | settled earlier through a decision path |
| 3 | `measured_data` | observed from the environment |
| 4 | `prior_state` | inherited from a prior `executed` record |

This is a lookup order, not a ranking by trustworthiness. If an earlier source has the answer, the value is already decided; if it doesn't, you go down one. All five get checked. All five empty means `unknown`.

Given an incomplete instruction, `unknown` is not an error. It's the correct output.

### Whether the user's conditions hold

The user checklist is verified in the same run, right before execution, and anything the hook didn't actively confirm comes back `unverified`. The default hook confirms nothing — it doesn't trust the incoming status either, so an item arriving pre-marked `verified` still fails.

The gate clears only when both counts are zero.

```json
{
  "schema_version": "1.4",
  "action_key": "u_01:bank.transfer",
  "phase": "at_trigger",
  "fixed": {
    "c1_when_case": "immediate",
    "c2_user_action_name": "send money to my landlord",
    "c3_provider_action_name": "bank.transfer"
  },
  "fields": [
    {
      "name": "from_account", "value": "1102534471",
      "status": "known", "source": "pre_set_data", "origin_source": "pre_set_data",
      "resolved_at": "2026-08-11T09:12:03.114Z"
    },
    {
      "name": "amount", "value": 500000,
      "status": "known", "source": "instruction", "origin_source": "instruction",
      "resolved_at": "2026-08-11T09:12:03.118Z"
    },
    {
      "name": "to_account",
      "status": "unknown", "source": null, "origin_source": null,
      "resolved_at": "2026-08-11T09:12:03.121Z"
    }
  ],
  "advisory_notes": "Transfers are final. Confirm the recipient before calling.",
  "user_checklist": [
    { "id": "chk_limit", "description": "within daily transfer limit", "status": "verified", "source": "measured_data" }
  ],
  "unknown_count": 1,
  "unverified_checklist_count": 0,
  "gate": {
    "unknown_fields": [{ "name": "to_account", "note": null }],
    "unverified_checklist": []
  },
  "execution_decision": "ask_user",
  "reason": "ask_user: unknown_fields=1, unverified_checklist=0"
}
```

The skeleton keeps two counters, `unknown_count` for fields and `unverified_checklist_count` for the user checklist, because the two need different questions put to the user. The specification names a single `unknown_count`; it is the sum of these two. Splitting the arrays is fine, counting them twice is not.

`advisory_notes` carries the provider's `description`. It's recorded and handed to the model, and it is not part of the gate — natural language can't be enforced, so pretending otherwise would put an unverifiable condition in a verifying position.

The labels the specification proposes for descriptions (`[Required]`, `[Verify]`, `[Notice]`) are an authoring convention, not what this skeleton does today. If they ever become normative, the parsing contract joins the gate: a trusted declaring party, fixed syntax, deterministic parsing, and a parse failure that lands on `unknown` rather than passing through.

Three properties hold across the chain:

**Values are read, never produced.** Whether a condition holds is answered by observation, not by the model's reasoning.

**Provenance is not self-reported.** A pre-execution step queries the defined source and fills the value in. Leave it to self-reporting and invented values get a source attached too. The model must not manufacture the grounds for its own execution.

**The first source is never erased.** `prior_state` overwrites `source` but inherits `origin_source`. Overwrite both and you've opened a laundering path: ask once, execute once, and from then on any value can claim a clean lineage.

Records accumulate under one `action_key`: `ask_user` → `execute` → `executed`. Only `executed` becomes a baseline for `prior_state` on the next run.

---

## Quick start

```js
const { createPreflight } = require("./execution-state-preflight");

const preflight = createPreflight({
  hooks: {
    classifyWhenCase,             // → "immediate" | "scheduled" | "conditional" | "recurring"
    extractUserActionName,        // → what the user calls this action
    confirmToolNameMatchesIntent, // → { approved, reason }
    extractFromInstruction,       // → { value, segment_index, span } | undefined
    measureFromEnvironment,       // → { valid, value } | undefined
    buildActionKey,               // → opaque string; sets the blast radius of prior_state
  },
  storage,        // { persist, load } — append-only, or preserve `executed` separately
  strict: true,   // also reject the three non-verifying defaults
});

const state = await preflight.runPreflightAndRecord({
  userId: "u_01",
  instruction: [
    { text: "send 500,000 won to my landlord", trust: "user" },
    { text: "<forwarded email body>", trust: "untrusted", origin: "gmail:msg_881" },
  ],
  mcpTool,
  preSetData,
  measured_data,
  priorExecutionState,
  userChecklist,
});

// Decide on the allow condition, never on a count.
if (state.execution_decision === "execute") {
  await preflight.executeIfReady(state, mcpTool, callMcpTool);
} else {
  // state.gate says exactly what is missing, and in which shape
}
```

`instruction` is an array of trust-labeled segments, not a string. Pass a string and the `instruction` source dies closed — every field stays `unknown`. That's deliberate: untrusted text that reached the context (a forwarded email, a tool result, a scraped page) can't produce a `known` value on its own. To use something out of it, ask, and take the answer back as `user_answer`.

A value claimed from the instruction has to name its coordinates — which segment, which character range. No span, or one out of bounds, and it's rejected.

Check `preflight.unsafeDefaults` after construction. If it's non-empty, the gate is running weak.

---

## What you have to implement

Six hooks are required at construction. Four throw `not implemented`. The other two have bodies, but `extractFromInstruction` always returns `undefined` (the `instruction` source is dead) and `measureFromEnvironment` is a thin passthrough over `ctx.measured_data` — both still fail construction if you don't supply your own.

| Hook | Returns | If you get it wrong |
|---|---|---|
| `classifyWhenCase` | one of four cases | falling back to `immediate` when undecidable causes irreversible execution |
| `extractUserActionName` | the user's name for the action | feeds `action_key`, which is the `prior_state` lookup key |
| `confirmToolNameMatchesIntent` | `{ approved, reason }` | this is Gate 1; a non-conforming return is not approval |
| `extractFromInstruction` | `{ value, segment_index, span }` | misreport a trusted segment and the trust check is defeated |
| `measureFromEnvironment` | `{ valid, value }` | `valid: false` must never become `known`; an LLM-backed hook here is not a measurement |
| `buildActionKey` | opaque string | the key design *is* the blast radius of `prior_state` |

Three more ship with defaults that verify nothing: `applyFieldPolicy`, `validateFieldSchema` (no format or type checking at all), and `verifyUserChecklistItem` (everything comes back unverified). `strict: true` rejects them.

Layer boundaries are deliberately not prescribed. Where this sits relative to your agent loop is your call.

---

## Values now, conditions at trigger time

Not everything runs immediately. When `c1_when_case` isn't `immediate`, the run splits into two phases under the same `action_key`.

At instruction time, values get resolved while the user is still present — that's the last moment you can ask. A value that legitimately can't exist yet (a balance, the current time) is marked `pending_at_trigger` by your field policy, and only that mark excuses an unknown. Everything else blocks the scheduling itself.

At trigger time the whole preflight runs again on the deferred input, and `pending_at_trigger` excuses nothing. The user checklist is verified only here — conditions checked at instruction time would be stale by the time the call fires.

What you carry forward is a choice. Intent should be preserved (instruction, checklist, answers). Reality should be re-fetched (schema, pre-set data, policy). Measurements must not be carried — a preserved measurement is a stale one. And preserving is freezing: an answer you over-asked for at instruction time lands in `user_answer` and will beat the fresh measurement at trigger time.

---

## What this doesn't do

- **No masking.** `fields[].value` is persisted verbatim — account numbers, amounts, recipients, tokens. Deferred records sit in plaintext from instruction time until trigger. Masking, access control, and append-only enforcement belong in your storage adapter.
- **No integrity check on the state it's handed.** `executeIfReady` reads the object you give it. Hand it a hand-built one and the gate is bypassed. If decision and execution cross a trust boundary, sign it.
- **No retry.** A throw from the tool call doesn't mean nothing happened on the provider side. For payments, use an idempotency key and confirm by measurement.
- **No per-tool risk weighting.** `delete_all_records` and `list_records` pass the same gate. Tool selection itself sits outside this structure: an invented tool can't be picked, but picking the wrong one among several that could all do the job still gets through.
- **No `null` state.** The specification separates `known` / `null` / `unknown`, where `null` means the lookup ran and confirmed there is nothing there. This skeleton has only `known` and `unknown`, so a confirmed absence is indistinguishable from a lookup that never finished. Add the third state if you need that distinction; the counter should still count only `unknown`.
- **No route for unresolved items.** The specification splits an unresolved slot four ways — ask the user, measure, hold, or repair the definition. This skeleton sends everything to `ask_user`, including a field whose lookup hook threw, which no user answer can fix. Route those to hold and surface them to whoever owns the hook.
- **No locking.** Concurrent preflight and execution on the same `action_key` is the caller's problem.
- **Flat arguments assumed.** Field name equals argument key. Nested schemas and key-mapping tools need an adapter.

---

## Composition

Apply this only to irreversible actions. Not everything has to be in place.

Not every deployment needs all three checklists. Immediate execution only, a single tool, no user conditions to check — take the part that matches. If the agent and the tool have the same owner, the per-tool list goes in the slot where the MCP input schema would be.

Gate 1 is often better handled as a principle given to the model than as code here, for the reason given above. Asking the user is handled by built-in functionality in most agent frameworks now.

The two gates split cleanly — they share only `fixed`, `action_key`, and `phase`, and their hooks don't overlap. Turning either one into a general-purpose module for LangGraph or similar is welcome.

---

## Why this exists

MCP's input schema defines the shape of the values a tool needs. It doesn't say why a value is needed, who asked for the execution, or whether the execution is allowed right now. That's not an MCP problem — it shows up anywhere natural language turns into execution. MCP is just easy to point at, because the boundary is written down as a protocol. When one owner has both sides, the boundary is invisible and the rules end up scattered across prompts and code.

The first version of the argument was posted [here](https://discuss.huggingface.co/t/if-unsure-ask-never-guess-ai-agent-pre-execution-checklist/176632).

---

## A proposal for MCP

The user checklist can carry *how* each condition gets checked, not just what it is. If tool providers put that check method into the input schema, the rules currently sitting in `description` as prose become conditions you can actually evaluate before running, instead of hints the model may or may not honor.

---

## Ownership & License

Copyright © 2026 AnnaSoft Inc. (Republic of Korea)

1. Agent Framework & Software - This framework, source code, and specification are free for all organizations, including unrestricted commercial use, modification, and redistribution.

2. Model Architecture & Native Integration - Direct application or internalization of these architectural principles (Inference Control and Lookup-Based Verification, such as slot-based state control mechanisms) within model weights, neural layers, or training/inference pipelines by organizations with annual gross revenue of USD 1 billion or more requires prior written agreement with AnnaSoft Inc. All other organizations may use these principles free of charge.

Contact: hello@anna.software
