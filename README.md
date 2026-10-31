# execution-state-preflight

Before a tool is called, check where the intent, values and conditions came from and whether they were confirmed, and write it into the record.

Models fill blanks, and when blocked they find another way through. The usual expectation is that better models will stop this; better models only find better ways around. The blanks are mostly not facts the model lacks — they are things missing from the input. And models were trained to fill blanks in the first place.

So this does not ask the model whether it knows. Against a checklist kept outside the model, it counts where the model looked, what came back, and what is missing.

---

## Where this sits

Where work can be undone, let the model act and verify the result; fixing it afterwards is cheaper. An irreversible execution is different. The result cannot be fixed after the fact, so the model has to move inside a declared frame, and the inputs have to be confirmed before execution (spec 1.1).

That frame is already being built. This does not replace it. It adds back one premise the frame cannot restore.

### The frame: what already exists

**Governance settles who may act, and under what process.** Risk tiering, approval paths, access control, audit logging, model risk policy. Lately it has come down to a runtime layer that intercepts a tool call just before execution and checks it against policy. Whether a transfer amount is within the limit can be checked there too.

**Harness engineering builds the environment around the model.** What matters here is the part that decides what the agent can reach: which tools it can call, which data it can access, whether inputs and outputs match their formats.

**Loop engineering settles whether the result is right.** Act, verify, record, repeat. The maker and the checker are separated, and done is a passed check, not a claim.

Together they come close to the domain modeling and finite-state machines of earlier systems. Which values are allowed, and which transitions are possible from which state, are fixed outside the model, and the model moves inside them.

### The broken premise

The frame checks whether a value is allowed and whether a transition is possible. It does not check who set the value. It never had to.

In earlier systems a person logged in and typed the values into a form. Short of tampering, the source of a value could only be that person. The input path itself was the proof of origin, and the controls were built on that premise.

With agents, the user still logs in, and the execution still runs under that person's session and permissions. The audit log still says "the user executed with this value." But the model wrote the value. Nobody tampered with anything, and the premise still breaks. The controls came over; the premise that made them enough did not.

So there are wrong executions that pass the whole frame. [The reported Meta Muse case](./case-muse-marketplace.en.md) is one. The seller handed his sale messages to Muse and chose "Allow Always." When the buyer proposed 8 to 10 p.m., Muse agreed in the seller's name, and the buyer came to the seller's building. The seller was not home and did not know anyone was coming. The permission was there, the format was right, and no policy was broken. One thing was wrong: the seller had not set that time.

The model and the agent are not one actor. Permission comes from ownership, not accuracy, and a model that answers for nothing cannot hold it (spec 2.1). The model writes the draft; the agent — the code around the model — checks it. **Where the act happens.**

### What this adds

What login and direct input used to guarantee is checked again, for every execution. Three things are checked:

- **Intent** — what, and when. Settled only from what the user said in this request.
- **Values** — whether each value came from a declared source. If it came from the user's words, its place is checked against the original text.
- **Conditions** — whether the provider's declared conditions and the user's limits were confirmed.

Three rules:

- Every value and condition entering an execution is **checked against a declared source.** Not being prohibited is not a ground for execution.
- **Where it came from is written into the record.** The source and the place in the original text are kept, so anyone other than the gate can check them again. Blocked executions and checks that did not run are recorded too.
- What cannot be confirmed is not made up by the model; it **comes back as a blank to whoever can fill it.** What the user can answer goes to the user, what the system can look up goes to the system, and what was never declared goes to whoever declares it.

The rules are declared by whoever holds the knowledge, not by one team for everything as before. The provider declares the tool's conditions, the user declares limits and preferences, and the adopting system declares the rules common to every execution.

**Rules left in a prompt are forgotten as the conversation grows, and gone when the conversation changes.** So these rules live in a checklist outside the model, and code does the counting.

Security research asks where values come from as well. [CaMeL](https://arxiv.org/abs/2503.18813), [FIDES](https://arxiv.org/abs/2505.23643), [PACT](https://arxiv.org/abs/2605.11039) and [ROPE](https://arxiv.org/abs/2608.27496) track the origin of each argument and keep untrusted data out of sensitive arguments; some, like ROPE, go as far as requiring a confirmed origin. What differs here is that no attack is assumed. Without any attack, the model still fills in what is missing. This does not stop at blocking that blank; it sends it back to whoever can fill it, and it counts intent and conditions the same way as values.

Not a new layer. It does for the owner of each value what the frame already does for the actor and the result.

### What that gets you

**It stops wrong executions.** A value whose source is not confirmed does not enter an execution. A value the model made up, or one it took from someone else's text, stays unconfirmed and comes back to the user as a blank (spec 5.2). Even a confirmed value is held if it exceeds the user's limit or the provider's condition.

**It stops executions nobody asked for.** Only an execution unit the user stated or approved can execute. Not being prohibited is not a ground (spec 0, 1.1).

**It stops different executions.** The act is settled only from the user's words in this request, so an act the user did not name does not execute (gate 1). Going around a block or a failure by another tool or another path is not a continuation of the same request; it is a new execution, judged again from the start. Whether the act and the tool match, however, is not proven by code (spec 8.1).

**It leaves a record, and the verdict reproduces.** Each value is recorded with its source and its place in the original text, so someone other than the gate can check it again. The verdict is a count made by code, so the same input gives the same verdict (spec 3.4).

**It raises the execution rate.** Not the number of executions — it means a stopped execution reaches execution after checking. The purpose is not to block but to reach a state where execution is possible (spec 0.1). Questions do not multiply; they surface. Only what is missing comes back, as a list, so it can be filled in one go, and once the user sets a range, requests inside it execute without asking. Items that repeat become pre-set settings (spec 7.2).

**It divides responsibility and makes it traceable.** Which checklist an empty slot belongs to is where the responsibility lies: a value points to the source integration, a condition to the provider's declaration, an intent to the conversation design (spec 7.1). Today, with no record, an anomaly is left blamed on the agent developer or the model. A decision record cannot be made after the incident.

**It opens other ways to improve.** It shows what to fix without retraining the model. None of the three types needs a training budget (spec 7.1). Rules become data and change without a deploy, and the gate code stays the same as tools are added or models are swapped. Decision records become data by failure type, an input to model development (spec 7.2).

[The case report](./case-muse-marketplace.en.md) maps this incident's message log onto the checklists and is explicit about what this gate would **not** have caught.

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
