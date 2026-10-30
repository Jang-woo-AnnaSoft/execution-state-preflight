# execution-state-preflight

Before a tool is called, check where the intent, values and conditions came from and whether they were confirmed, and write it into the record.

Models fill blanks, and when blocked they find another way through. The usual expectation is that better models will stop this; better models only find better ways around. The blanks are mostly not facts the model lacks — they are things missing from the input. And models were trained to fill blanks in the first place.

So this does not ask the model whether it knows. Against a checklist kept outside the model, it counts where the model looked, what came back, and what is missing.

---

## Where this sits

It does not replace a governance framework or an agent loop. It is added to both.

**Governance settles who may act, and under what process.** Risk tiering, approval paths, access control, audit logging, model risk policy. It is the layer that says where a person signs off and what must be logged for traceability.

**Loop engineering settles whether the work came out right.** Orient, act, verify, record, repeat. Three things are agreed:

- **Whoever wrote it does not grade it.** The maker and the checker are separated.
- **Done is an exit code, not a claim.** A completion condition written as prose is not a condition.
- **The record is append-only, and when a check did not run, that is recorded too.**

Governance is about the actor and the process. Loop engineering is about the output. Governance can set rules for inputs — a transfer limit, an approval requirement — but setting a rule is not checking the values that actually enter an execution against it. A policy can say a transfer stays within the user's limit; it does not say where the amount the model proposed came from, or whether the limit was checked before the tool was called. Here, those rules become checklist lines that the gate checks at every execution (spec 7.2).

Governance confirms the actor was permitted. Loop engineering proves the artifact passed. **Neither asks whether the values the execution started from are the user's or the model's.**

In governance, the model and the agent are treated as one actor and given permissions the way a person is. In earlier systems that was enough: a person typed the values into a form, so whoever entered a value was its source. With agents, the model writes the first draft. The controls came over; the premise that made them enough did not.

The model and the agent are not one actor. Permission comes from ownership, not accuracy, and a model that answers for nothing cannot hold it (spec 2.1). The agent — the code around the model — has to check the model's draft. **Where the act happens.**

**Where the act happens**, three things have to be checked: intent, values, and conditions. The user's words settle the intent, and the agent checks it. The provider says what must be filled and which conditions apply; the user adds their own rules and fills what remains.

Today, only values are checked, by the input schema, and only for shape, not for origin. The user's intent, the provider's conditions and the rules the user added are left to the model's judgment.

**What is left in a prompt is forgotten as the conversation grows, and gone when the conversation changes.**

The same rigor, applied to the inputs:

- every value and condition entering an execution is **checked against a declared source**,
- **where it came from is written into the record**,
- and what cannot be confirmed is not made up by the model — it comes back to the user as a blank.

Not a new layer. It is what the verify stage already does to outputs, done to inputs.

### What that gets you

**It stops wrong executions.** A value whose source is not confirmed does not enter an execution. A value the model made up, or one it took from someone else's text, stays unconfirmed and comes back to the user as a blank (spec 5.2). Even a confirmed value is held if it exceeds the user's limit or the provider's condition.

**It stops executions nobody asked for.** Only an execution unit the user stated or approved can execute. Not being prohibited is not a ground (spec 0, 1.1).

**It stops different executions.** The act is settled only from the user's words in this request, so an act the user did not name does not execute (gate 1). Going around a block or a failure by another tool or another path is not a continuation of the same request; it is a new execution, judged again from the start. Whether the act and the tool match, however, is not proven by code (spec 8.1).

**It leaves a record, and the verdict reproduces.** Each value is recorded with its source and its place in the original text, so someone other than the gate can check it again. The verdict is a count made by code, so the same input gives the same verdict (spec 3.4).

**It raises the execution rate.** Not the number of executions — it means a stopped execution reaches execution after checking. The purpose is not to block but to reach a state where execution is possible (spec 0.1). Questions do not multiply; they surface. Only what is missing comes back, as a list, so it can be filled in one go, and once the user sets a range, requests inside it execute without asking. Items that repeat become pre-set settings (spec 7.2).

**It divides responsibility and makes it traceable.** Which checklist an empty slot belongs to is where the responsibility lies: a value points to the source integration, a condition to the provider's declaration, an intent to the conversation design (spec 7.1). Today, with no record, an anomaly is left blamed on the agent developer or the model. A decision record cannot be made after the incident.

**It opens other ways to improve.** It shows what to fix without retraining the model. None of the three types needs a training budget (spec 7.1). Rules become data and change without a deploy, and the gate code stays the same as tools are added or models are swapped. Decision records become data by failure type, an input to model development (spec 7.2).

[A reported Meta Muse incident](./case-muse-marketplace.en.md) took this shape: the buyer proposed an evening window, the agent agreed in the seller's name, and the seller heard about it fifty minutes after the buyer had come and gone. The case report maps the message log onto the checklists and is explicit about what this gate would **not** have caught.

---

## The three checklists

The rules an execution needs, split by who declares them. This split is the core of the design (spec §4). The fixed checklist settles the intent, the provider's the values and conditions, and the user's the range of those values and conditions. Every item in all three is checked and recorded as its own slot.

**Fixed** — which tool, and when it runs. Tool-independent, applied the same way to every execution. It settles the execution unit. Today it is not recorded, and a misreading leads to a bypass.

**Provider** — per tool. Values sit in the MCP input schema or inside the agent. Conditions have to be declared separately. Today they vary from agent to agent, and an MCP server's conditions are not applied before execution.

**User** — intent, limits, preferences. Changes with the user's environment rather than the tool, and differs from user to user. Today all of it is left to the model's judgment.

---

## The code

Two gates. Neither produces a value or a justification, and neither executes — they look things up and record what they found.

**Gate 1 — intent: what did the user ask for, when or in what situation does it run, and is this the tool that does it?**

**Gate 2 — values and conditions: where did each value come from, and were the conditions confirmed?**

| # | source | meaning |
|---|--------|---------|
| 0 | `user_answer` | answered by the user after an `ask_user` |
| 1 | `instruction` | taken from a trusted segment, with its location |
| 2 | `pre_set_data` | settings the user approved and stored in advance; a proposal the user accepted belongs here too |
| 3 | `measured_data` | measured from the environment |
| 4 | `prior_state` | a value in a prior `executed` record. Never settles a slot; it is shown to the user as a candidate and counts, as `user_answer`, only once confirmed |

A search order, not a ranking by trustworthiness. `instruction` is an array of trust-labeled segments, not a string. Pass a string and the `instruction` source closes; nothing is confirmed from it. Untrusted text — a forwarded email, a tool result, a web page — cannot settle a value on its own. To use something from it, ask the user and take the answer back as `user_answer`.

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

**You do not have to run all of it. Apply it only to irreversible executions, and only the parts that fit (spec 1.2).**

---

## Where to read what

This file is the overview. Each thing below is explained where it lives, not here.

| | |
|---|---|
| [**The short version**](./model-reasons-agent-executes.en.md) | the goal, the two methods, how this differs from current practice |
| [**The specification**](./spec.en.md) · [ko](./spec.ko.md) | **the standard.** What counts as confirmed, who judges, what is recorded. The problems this works through are §2; the three checklists are §4; the slot states and sources are §5 |
| **The skeleton** ([`execution-state-preflight.js`](./execution-state-preflight.js)) | a reference skeleton, not a library. Hook contracts, the record shape, and where it falls short of the specification — in the source comments, beside the code they describe |
| [**Hook examples**](./hooks-example/) | what has to be declared, and how much of this you have to keep — each shown by putting a piece in and taking it out |
| [**A case report**](./case-muse-marketplace.en.md) | a reported incident mapped onto the checklists |

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

---

## What this doesn't do

- **No masking.**
- **No integrity check on the state it is handed.**
- **No retry.**
- **No per-tool risk weighting.**
- **No locking.**
- **Flat arguments assumed.**
- **Verdict and execution are not separated here, and that is on purpose.** **That is for demonstration, not a design to copy.**

These are limits of the skeleton. It also does not record which checklist version a verdict used (spec 6.1), and does not bind an approval to the value it approved (spec 6.3). Take them into account when applying it.

---

## Why this exists

A tool's input schema defines the shape of the values it needs. It does not say why a value is needed, who asked for the execution, or whether the execution may run right now. The gap is not MCP's — it shows up anywhere natural language turns into execution, and when one owner has both sides it is invisible and the rules end up scattered across prompts and code.

**If you build the agent and the tool together, you are still the tool provider.** Sharing an owner removes the protocol, not the role. The failure mode of same-ownership is not that the declaration lands in the wrong place; it is that **nobody plays the provider role at all.**

So, a proposal for tool providers: declare conditions and how each is checked in the `description`, with a label — `[Required]`, `[Verify]`, `[Notice]`. A labeled line is read by the gate, not the model, so a hint the model may or may not follow becomes a condition that can be checked before execution. It needs no protocol change and can be done today (spec 4.2.1).

The first version of the argument was posted as [If unsure, ask. Never guess. — AI Agent Pre-Execution Checklist](https://discuss.huggingface.co/t/if-unsure-ask-never-guess-ai-agent-pre-execution-checklist/176632). The discussion continues in [Misalignment is not required for an agent to act without authorization](https://discuss.huggingface.co/t/misalignment-is-not-required-for-an-agent-to-act-without-authorization/180541).

Contact: [hello@anna.software](mailto:hello@anna.software)

License: see [LICENSE.md](./LICENSE.md)
