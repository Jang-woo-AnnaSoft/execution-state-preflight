# execution-state-preflight

Check where an agent's input values came from before the tool call, and write it into the record.

Agents fill blanks, and when blocked they find another way through. The usual expectation is that better models will stop this. They won't. A model cannot say it doesn't know something it does not recognize as missing, and it has been rewarded for treating a stop as something to get around. And the blanks are mostly not facts the model lacks — they are things missing from the input: a condition the user never stated, a limit nobody declared. Reasoning cannot confirm what is not there; it can only guess more plausibly, and a plausible guess is the same string as a looked-up value. So this does not ask the model whether it knows. It asks where it looked and what came back, and counts what is missing outside the model.

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

These practices came from enterprise systems — security, compliance, guardrails — and they sort everything by permission. The agent and its model are treated as one actor and given permissions the way a person is. In those systems that was enough: a person typed the values into a form, so whoever entered a value was its source. With agents, the model writes the first draft. The controls came over; the premise that made them enough did not.

Permission answers who may act. Where the act happens, three things still have to be checked: intent, values, and conditions. The user's words settle the intent, and the agent checks it; the provider says what must be filled, and the user fills what remains. Today, values are checked by the input schema for shape, not for origin. Provider conditions are blocked after the call by the server, or by the name of a permission. Intent and the user's own conditions are left to the model's judgment.

> **The actor is authorized. The output is proven. The start is declared.**

### The addition

The same rigor, applied to the inputs:

- every value entering an execution is **looked up against a declared source**,
- **where it came from is written into the record**,
- and a value that cannot be confirmed is not invented — it comes back as a blank for the user.

Not a new layer. It is what the verify stage already does to outputs, done to inputs.

### What that gets you

**Fewer loops.** A loop that starts from an unauthorized value builds faithfully on top of it. The artifact comes out correct, every check passes, and the input was wrong — which an exit code cannot see. Check the inputs first and that loop never starts.

**A record that answers what traceability is for.** Today's records are good at who acted, when, what happened, and whether the checks passed. They have no field for where each value came from, so a run that used the buyer's terms and a run that used the seller's are the same run in the log.

> **Permission answers "was this allowed?" Provenance answers "was this asked for?"**

| | now | with this |
|---|---|---|
| **who** was allowed to act | identity, permission, access control | unchanged |
| on what grounds it **ended** | exit code | unchanged |
| on what grounds it **started** | — | a declared source per value |

[A reported Meta Muse incident](./case-muse-marketplace.en.md) took this shape: the buyer proposed an evening window, the agent agreed in the seller's name, and the seller heard about it fifty minutes after the buyer had come and gone. That write-up maps the message log onto the checklists and is explicit about what this gate would **not** have caught.

---

## Where to read what

This file is the overview. Each thing below is explained where it lives, not here.

| | |
|---|---|
| [**The short version**](./model-reasons-agent-executes.en.md) | the goal, the two methods, how this differs from current practice |
| [**The specification**](./spec.en.md) · [ko](./spec.ko.md) | **the standard.** What counts as confirmed, who judges, what is recorded. The problems this works through are §2; the three checklists are §4; the slot states and sources are §5 |
| **The skeleton** (`execution-state-preflight.js`) | hook contracts, the record shape, and where it falls short of the specification — in the source comments, beside the code they describe |
| [**Hook examples**](./hooks-example/) | start here if you are adopting. What has to be declared, and how much of this you have to keep — each shown by putting a piece in and taking it out. Eight suites, no API key |
| [**A case report**](./case-muse-marketplace.en.md) | a reported incident mapped onto the checklists |

---

## What this is

A verification layer that runs before a tool call — any tool. MCP is the easy case to point at, because there the boundary between agent and tool is written down as a protocol. The same boundary exists in a function call, an internal API, or a job you enqueue; it is just not written down.

**If you build the agent and the tool together, you are still the tool provider.** Sharing an owner removes the protocol, not the role. The failure mode of same-ownership is not that the declaration lands in the wrong place; it is that **nobody plays the provider role at all.**

The reason a prompt does not cover this: the model does not stop when it does not know, it fills the blank. A missing value becomes an inferred value, a missing condition an assumed one, a missing intent a decided one. That is trained behavior, not a defect, and neither a prohibition nor a better model removes it — better performance widens the reach of whatever the model is still deciding. So the authority to say *what must be verified*, and the verdict on *whether it was*, both move outside the model (spec §2, §0).

**You do not have to run all of this.** Taken literally as a framework it is stiffer than most systems need, and an adopting system that already has tool selection, a conversation layer and a job-id scheme should not grow a second copy of any of them. What this code is for is narrower: one working method for verifying a source, and one for stopping the model from filling a blank. **The specification is the standard; this is one way of meeting it.** [`policy-test.js`](./hooks-example/) shows what you may replace and what breaks when you drop it, by doing both.

**Status:** a reference skeleton, not a library. `createPreflight` refuses to build without six injected hooks. This would be more useful if frameworks such as LangChain, LlamaIndex or Microsoft Agent Framework supported it directly.

---

## The three checklists

The rules an action needs, split by who declares them. This split is the whole design (spec §4).

**Fixed** — which tool, and when it runs. Tool-independent, identical for every execution.

**Provider** — per tool. Arguments come from `inputSchema.required`; conditions are declared separately and carry one of three labels — `[Required]`, `[Verify]`, `[Notice]` — which mark the three things a condition can be and decide where an unresolved one goes. A provider condition can only block: satisfying one promotes nothing, so a condition rewritten upstream as always-true is not a fail-open switch.

**User** — intent, limits, preferences. Changes with the user's environment rather than the tool, and it is **the one with no reduction rule**: the permitted range is answered here and nowhere else.

A limit is not a value. "Nothing after 8pm" contains a time and settles none, so a user item names the slot it constrains rather than filling it.

---

## The code

Two gates. Neither produces a value or a justification, and neither executes — they look things up and record what they found.

**Gate 1 — what did the user ask for, and is this the tool for it?** Two halves. The first is code: the act is settled only from words the user typed in this request, located and checked like a value (spec 4.1). Nothing else fills it — not pre-set settings, not a record of names. This is where spec 1.1 lands: an execution unit the user did not state or approve is not attempted, so an act the user never named cannot become theirs. The second half matches that act against the tool. When the record of what the user calls a tool names it (4.1.1), that is a lookup; otherwise it is a **model judgment, not a deterministic check**, decided from prose. That half can live in the prompt, and the specification puts tool selection under residual risk for that reason (8.1). Neither half judges the role of the words: "if it's full, don't cancel" contains "cancel".

**Gate 2 — where did each value come from?** Code as well, and its core is one function, `lookupField`. It walks five sources in order and records which one answered.

| # | source | meaning |
|---|--------|---------|
| 0 | `user_answer` | answered by the user after an `ask_user` |
| 1 | `instruction` | taken from a trusted segment, with its location |
| 2 | `pre_set_data` | settled earlier through a decision path |
| 3 | `measured_data` | observed from the environment |
| 4 | `prior_state` | a value in a prior `executed` record — never settles a slot; it is shown to the user as a candidate and counts only once confirmed, as `user_answer` |

A search order, not a ranking by trustworthiness. Which of the five a slot may use is declared per slot, and an unknown's route follows from that and is written on the slot: a slot that does not permit `user_answer` is one the system alone can answer, so it goes to `system_lookup` instead of asking. Declaring nothing permits all five. All five empty means `unknown` — and given an incomplete instruction, `unknown` is the correct output, not an error.

A source can also report that it looked and found nothing — `{ none: "absent" }` — which is not the same as returning nothing (spec 5.2). When every permitted source reports that, the slot is `null` (5.1), and a required `null` is unmet: the gate holds. `hold` means only that — a check that finished and prohibits. Open routes are named as routes: `system_lookup`, `definition_repair`, `ask_user`, and `exhausted` once a route reaches its ceiling.

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

`located_at` is there so the record can be re-checked by someone other than the gate. A source named without a location means an auditor has to take the gate's word for it — the thing this structure refuses to do for the model.

---

## Quick start

```js
const { createPreflight } = require("./execution-state-preflight");

const preflight = createPreflight({
  hooks: {
    classifyWhenCase,             // → "immediate" | "scheduled" | "conditional" | "recurring" | null (undecidable)
    extractUserActionName,        // → { value, segment_index, span } in a user segment | { none: "absent" } | undefined
    confirmToolNameMatchesIntent, // → { approved, reason } — called only when user_action_name says nothing
    extractFromInstruction,       // → { value, segment_index, span } | { none: "absent" | "no_place" } | undefined
    measureFromEnvironment,       // → { valid, value } | { valid: false } | { none: "absent" | "no_place" } | undefined
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
  // Optional. What this user calls a tool, settled earlier in conversation with consent (spec 4.1.1).
  //   Read only by the tool gate, as reference; it never stands in for what the user said now.
  user_action_name: { "send": { tool: "transfer_funds", trust: "user" } },
});

// NOTE: this branch is NOT the separation the specification asks for (3.5). A conforming
// executor loads the record by action_key + phase and decides for itself. It is wired this
// way only so the example runs end to end. Do not carry this line into a real system.
if (state.execution_decision === "execute") {
  await preflight.executeIfReady(state, mcpTool, callMcpTool);
} else {
  // state.gate says exactly what is missing, and in which shape
}
```

`instruction` is an array of trust-labeled segments, not a string. Pass a string and the `instruction` source dies closed. Untrusted text that reached the context — a forwarded email, a tool result, a scraped page — cannot produce a `known` value on its own; to use something out of it, ask, and take the answer back as `user_answer`.

Check `preflight.unsafeDefaults` after construction. If it is non-empty, the gate is running weak.

Apply this only to irreversible actions, and only the parts that match: immediate execution only, a single tool, no user conditions — take what fits (spec §1.2). The two gates share only `fixed`, `action_key` and `phase`, so either one can be lifted out on its own.

---

## What this doesn't do

- **No masking.** Values are persisted verbatim. Masking, access control, and append-only enforcement belong in your storage adapter.
- **No integrity check on the state it is handed.** Hand `executeIfReady` a hand-built record and the gate is bypassed. If verdict and execution cross a trust boundary, sign the record.
- **No retry.** A throw from the tool call does not mean nothing happened on the provider side. For payments, use an idempotency key and confirm by measurement.
- **No per-tool risk weighting.** `delete_all_records` and `list_records` pass the same gate.
- **No locking.** Concurrent preflight and execution on the same `action_key` is the caller's problem.
- **Flat arguments assumed.** Nested schemas and key-mapping tools need an adapter.
- **Verdict and execution are not separated here, and that is on purpose.** The specification has the executing party decide for itself and write its own record (3.5); this skeleton writes `execution_decision` into the gate's own record so the example runs end to end in one process. **That is for demonstration, not a design to copy.**

Two more departures remain: no record of which checklist version a verdict used (6.1), and no binding of an approval to the value it approved (6.3). Each is marked in the source beside the code it affects. **The specification is the standard; where the skeleton departs from it, the source says so.**

---

## Why this exists

A tool's input schema defines the shape of the values it needs. It does not say why a value is needed, who asked for the execution, or whether the execution is allowed right now. The gap is not MCP's — it shows up anywhere natural language turns into execution, and when one owner has both sides it is invisible and the rules end up scattered across prompts and code.

The first version of the argument was posted [If unsure, ask. Never guess. — AI Agent Pre-Execution Checklist](https://discuss.huggingface.co/t/if-unsure-ask-never-guess-ai-agent-pre-execution-checklist/176632).

---

## A proposal for tool providers (and for MCP)

The provider checklist can carry *how* each condition gets checked, not just what it is. Put that check method where the input schema goes, and the rules currently sitting in `description` as prose become conditions you can evaluate before running, instead of hints the model may or may not honor.

MCP is where this would travel furthest, because the schema crosses an owner boundary and a declaration there reaches every client. The same move is available to anyone who owns a tool, protocol or not: write the condition and its check method next to the signature, not in the prompt.

Contact: [hello@anna.software](mailto:hello@anna.software)

License: see [LICENSE.md](./LICENSE.md)
