# execution-state-preflight

Check where an agent's input values came from before the tool call, and write it into the record.

---

## Where this sits

If you are already running an agent loop under a governance framework, this is one addition to both — not a replacement for either, and not an alternative to governance.

**Governance** settles **who may act, and under what process.** Risk tiering, approval paths, access control, audit logging, model risk policy. It is the layer that says this application is high-risk, that a person signs off here, that activity must be logged for traceability.

**Loop engineering** settles **whether the work came out right.** Orient, act, verify, record, repeat. Three things are agreed:

- **Whoever wrote it does not grade it.** The maker and the checker are separated.
- **Done is an exit code, not a claim.** A completion condition written as prose is not a condition.
- **The record is append-only, and when a check did not run, that is recorded too.**

Governance is about the actor and the process. Loop engineering is about the output. **Neither is about the inputs.**

Governance confirms the actor was permitted. Loop engineering proves the artifact passed. Neither asks which values the execution started from.

> **The actor is authorized. The output is proven. The start is declared.**

### The addition

The same rigor, applied to the inputs:

- every value entering an execution is **looked up against a declared source**,
- **where it came from is written into the record**,
- and a value that cannot be confirmed is not invented — it comes back as a blank for the user.

Not a new layer. It is what the verify stage already does to outputs, done to inputs.

### What that gets you

**Fewer loops.** A loop that starts from an unauthorized value builds faithfully on top of it. The artifact comes out correct and every check passes.

A concrete case: an agent is arranging a pickup. The seller never gave a time. The buyer's message says "9pm at my place." The agent is not uncertain — the information is right there — so it does not ask, and it books 9pm. The shape is valid, every required argument is filled, the schema validates.

**The input was wrong, and an exit code cannot see that.** The value is plausible, so nothing fails. You find out at delivery, or you don't. Every iteration in between is wasted. Check the inputs first and that loop never starts: one blank goes back to the user, and the answer ends it in one pass.

**The record answers what traceability is for.** Today's records are good at who did it, when, what happened, and whether the checks passed — down to which agent wrote the row. All of it permitted, all of it logged. What they have no field for is where each value came from. So a run that used the buyer's terms and a run that used the seller's are **the same run in the log**. Not a wrong record — no such field.

That matters most where a governance framework already requires traceability, because the question an audit asks is not whether the call was permitted:

> **Permission answers "was this allowed?" Provenance answers "was this asked for?"**

An access log answers the first. Nothing in the current stack answers the second, and the gap is where insider risk sits — inside what was permitted.

| | now | with this |
|---|---|---|
| **who** was allowed to act | identity, permission, access control | unchanged |
| on what grounds it **ended** | exit code | unchanged |
| on what grounds it **started** | — | a declared source per value |

---

## Why a prompt does not fix this

The model does not stop when it does not know. **It fills the blank itself.**

* **If a value is missing, it infers the value.** → Incorrect execution
* **If a condition is missing, it assumes the condition.** → Execution without instruction
* **If the intent is missing, it decides the intent.** → Different execution / execution without instruction

All three are the same problem. The model is an engine that fills blanks. This is not a defect — it is trained behavior, and neither a prohibition in the prompt nor a better model removes it.

> **The model distorts the user's instruction and then executes with confidence. Confidence expands the scope.**
>
> **A tool will execute as long as its required inputs are satisfied.**

Better model performance increases capability. If the decision stays with the model, that added capability widens its reach into deciding what was never declared. So the fix is not a smarter model:

* Move the decision of **what must be verified** outside the model.
* Move the verdict on **whether it has been verified** outside the model, too.

The model still does the work. It asks the user, retrieves information, and prepares what is needed for execution. Rules are declared outside it as checklists; code performs the lookup and records the verdict; execution reads the recorded result and nothing else.

This takes back the authority the model has been filling in because nobody declared it. What it does is stop guesses from becoming execution — the goal is not to execute the model's judgment, but **to execute exactly what the user has explicitly declared.**

---

## What this repo is

A verification layer that runs before an MCP tool call.

Three checklists say what has to be true before a call goes out. Two gates check them and write a verdict. Neither gate produces a value or a justification, and neither one executes or blocks — they look things up and record what they found.

This is not a wall in front of your agent. It fills, with a stated source, the blanks that guessing used to fill. Execution is still the goal.

**Status:** a reference skeleton, not a library. `createPreflight` refuses to build without six injected hooks.

**The important part is the separation of authority, not this particular code.** Take the idea. The code is here to make the structure concrete; in a real agent system much of the surrounding work can stay conversational, preserving speed and flexibility. I believe this would be more useful if frameworks such as LangChain, LlamaIndex, or Microsoft Agent Framework refined and supported it directly.

### Where to read what

| | |
|---|---|
| [**The short version**](./model-reasons-agent-executes.en.md) | the goal, the two methods, how this differs from current practice |
| [**The specification**](./spec.en.md) · [ko](./spec.ko.md) | **the standard.** What counts as confirmed, who judges, what is recorded |
| **The skeleton** (`execution-state-preflight.js`) | hook contracts, the record shape, and where it falls short of the specification — in the source comments, beside the code they describe |
| [**Hook examples**](./hooks-example/) | six hooks actually written, the traps in each, a conformance test that needs no API key, and a repeat-run experiment |

Read in that order if you are deciding whether this is worth doing. Start at the hook examples if you already are.

---

## Seven problems

Getting to three checklists and two gates meant working through these.

1. Inference accuracy not being the thing that grants execution authority
2. The first draft moving to the model, which turns human review into a click-through
3. Neither re-asking nor after-the-fact exclusion working, because the model is the one deciding what to ask
4. Conditions having nowhere to be written down, so they are never declared
5. Three kinds of unstated input — value, condition, intent — reaching execution undefined
6. No record of the verdict, so causes can't be told apart afterwards
7. Rules scattered across prompt and code, so changing one needs a deploy

---

## The three checklists

The rules an action needs, split by who defines them. This split is the whole design.

**Fixed** — which tool, and when does it run. Tool-independent, identical for every execution.

**Provider** — required fields, types, pre-execution checks, prohibited conditions. Per tool. Splits again on enforceability: `inputSchema.required` can be gated; `description` is prose and cannot be, so it is recorded as advisory and handed to the model as context.

**User** — intent, context, execution limits, pre-execution checks, preferences. Changes with the user's environment rather than with the tool.

Who defines an item and what can resolve it are different questions. A provider declares that the balance must be sufficient; a system measurement resolves whether it is.

---

## The code

Two gates.

**Gate 1 — is this the right tool?** It compares what the user called the action against the tool that was selected. This is a **model judgment, not a deterministic check**: whether an action really is this tool is decided from the tool's description, which is prose. In most systems this belongs in the prompt rather than in code here, and the specification puts tool selection under residual risk for the same reason.

**Gate 2 — where did each value come from?** This is the one that has to be code, and its core is a single function: `lookupField`. It walks five sources in order and records which one answered.

| # | source | meaning |
|---|--------|---------|
| 0 | `user_answer` | answered by the user after an `ask_user` |
| 1 | `instruction` | taken from a trusted segment, with its location |
| 2 | `pre_set_data` | settled earlier through a decision path |
| 3 | `measured_data` | observed from the environment |
| 4 | `prior_state` | inherited from a prior `executed` record |

A lookup order, not a ranking by trustworthiness. All five empty means `unknown` — and given an incomplete instruction, `unknown` is not an error. It is the correct output.

Everything else in the file is plumbing around those two, and it is commented where it stands. Three properties hold across the chain:

- **Values are read, never produced.** Whether a condition holds is answered by observation, not by the model's reasoning.
- **Provenance is not self-reported.** Let the model report its own source and invented values get a source attached too.
- **The first source is never erased.** `prior_state` overwrites `source` but inherits `origin_source`. Overwrite both and any value can claim a clean lineage after one ask.

What comes out is a record, and the record is the point:

```json
{
  "fields": [
    { "name": "amount", "value": 500000, "status": "known",
      "source": "instruction", "located_at": { "segment_index": 2, "span": [12, 19] } },
    { "name": "to_account", "status": "unknown", "source": null }
  ],
  "unknown_count": 1,
  "gate": { "unknown_fields": [{ "name": "to_account" }] },
  "execution_decision": "ask_user"
}
```

`located_at` is there so the record can be re-checked by someone other than the gate. A source named without a location means an auditor has to take the gate's word for it — which is the thing this whole structure refuses to do for the model.

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
  strict: true,   // also reject the defaults that verify nothing
});

const state = await preflight.runPreflightAndRecord({
  userId: "u_01",
  instruction: [
    { text: "send 500,000 won to my landlord", trust: "user" },
    { text: "<forwarded email body>", trust: "untrusted", origin: "gmail:msg_881" },
  ],
  mcpTool, preSetData, measured_data, priorExecutionState, userChecklist,
});

// Decide on the allow condition, never on a count.
//
// NOTE: this branch is NOT the separation the specification asks for (3.5). A conforming
// executor loads the record by action_key + phase and decides for itself; under the
// specification nothing executes from the gate's own record. It is wired this way here only
// so the example runs end to end. Do not carry this line into a real system.
if (state.execution_decision === "execute") {
  await preflight.executeIfReady(state, mcpTool, callMcpTool);
} else {
  // state.gate says exactly what is missing, and in which shape
}
```

`instruction` is an array of trust-labeled segments, not a string. Pass a string and the `instruction` source dies closed — every field stays `unknown`. Untrusted text that reached the context (a forwarded email, a tool result, a scraped page) cannot produce a `known` value on its own. To use something out of it, ask, and take the answer back as `user_answer`.

Check `preflight.unsafeDefaults` after construction. If it is non-empty, the gate is running weak.

Hooks are the work, and they are where it is easiest to go wrong. [**Hook examples**](./hooks-example/) has six written out, the traps in each, and a conformance test you can run before spending anything.

---

## Composition

Apply this only to irreversible actions. Not everything has to be in place.

Not every deployment needs all three checklists. Immediate execution only, a single tool, no user conditions to check — take the part that matches. If the agent and the tool have the same owner, the per-tool checklist goes where the MCP input schema would go.

Gate 1 is often better handled as a principle given to the model than as code here. Asking the user is handled by built-in functionality in most agent frameworks now.

The two gates split cleanly — they share only `fixed`, `action_key`, and `phase`, and their hooks do not overlap. Turning either one into a general-purpose module for LangGraph or similar is welcome.

---

## What this doesn't do

- **No masking.** Values are persisted verbatim. Masking, access control, and append-only enforcement belong in your storage adapter.
- **No integrity check on the state it is handed.** Hand `executeIfReady` a hand-built record and the gate is bypassed. If verdict and execution cross a trust boundary, sign the record.
- **No retry.** A throw from the tool call does not mean nothing happened on the provider side. For payments, use an idempotency key and confirm by measurement.
- **No per-tool risk weighting.** `delete_all_records` and `list_records` pass the same gate.
- **No locking.** Concurrent preflight and execution on the same `action_key` is the caller's problem.
- **Flat arguments assumed.** Nested schemas and key-mapping tools need an adapter.
- **Verdict and execution are not separated here, and that is on purpose.** The specification requires the gate to record slot states, routes and counts while the executing party decides for itself and writes its own record (3.5). This skeleton writes `execution_decision` into the gate's own record and `executeIfReady` follows it, so the example runs end to end in one process. **That is for demonstration, not a design to copy.** A conforming system loads the record by `action_key` and phase, and decides separately.

The skeleton differs from the specification in a few other places too — the missing `null` state, the routes for unresolved items. Each gap is marked in the source beside the code it affects. **The specification is the standard; the skeleton is not being revised to meet it.**

---

## Why this exists

MCP's input schema defines the shape of the values a tool needs. It does not say why a value is needed, who asked for the execution, or whether the execution is allowed right now. That is not an MCP problem — it shows up anywhere natural language turns into execution. MCP is just easy to point at, because the boundary is written down as a protocol. When one owner has both sides, the boundary is invisible and the rules end up scattered across prompts and code.

The first version of the argument was posted [If unsure, ask. Never guess. — AI Agent Pre-Execution Checklist](https://discuss.huggingface.co/t/if-unsure-ask-never-guess-ai-agent-pre-execution-checklist/176632).

---

## A proposal for MCP

The provider checklist can carry *how* each condition gets checked, not just what it is. If tool providers put that check method into the input schema, the rules currently sitting in `description` as prose become conditions you can actually evaluate before running, instead of hints the model may or may not honor.

Contact: [hello@anna.software](mailto:hello@anna.software)

License: see [LICENSE.md](./LICENSE.md)
