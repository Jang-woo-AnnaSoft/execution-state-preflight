# execution-state-preflight

Don't execute on a guess. Check everything stated, and ask or stop when it can't be confirmed.

Rules are written as sentences in the tool's description, and code does the counting. The checks that used to be hard-coded for each tool are no longer needed.

Before a tool is called, check where the intent, values and conditions came from and whether they were confirmed, and write it into the record.

Models fill blanks, and when blocked they find another way through. The usual expectation is that better models will stop this; better models only find better ways around. The blanks are mostly not facts the model lacks — they are things missing from the input. And models were trained to fill blanks in the first place.

So this does not ask the model whether it knows. Against a checklist kept outside the model, it counts where the model looked, what came back, and what is missing.

---

## A rule in a prompt, a hook, or a checklist

A hook is code the harness runs before a tool executes.

| | Prompt | Hook | Checklist |
|---|---|---|---|
| Written as | Natural language | Code | Natural language (labelled lines) |
| Read by | The model | The harness | The model too, but the gate reads the tool's definition itself |
| Who decides it was kept | The model that read it | Code the developer wrote | Code that counts unconfirmed items |
| Checked against | The model's words | What the code sees, usually the call the model made | Declared sources: the system's data, the user's words |
| If skipped | Runs, with no mark | Blocked | Stays unconfirmed, and does not run |
| To change a rule | Edit the sentence | Edit the code and deploy | Edit the sentence |

In a prompt, a sentence is a request. The model reads it and decides whether it kept it, and an output that kept it looks the same as one that skipped it. A hook enforces, but each rule is code a developer writes, and it does not look at where a value came from unless that is built too. The checklist does not replace the hook: a place to stop before execution is still needed, and the hook is that place. What changes is that the code running there no longer grows with each rule.

So one line does two jobs:

- **Safety.** Unlike a prompt, a stated condition is not skipped, and nothing runs while it is unconfirmed.
- **Developer productivity.** Unlike a hook, nobody writes that guarantee as code. A condition is not turned into an `if`; to change it, edit the sentence. Only a rule that needs system data not yet connected needs one more connection.

---

## Where this sits

Where work can be undone, let the model act and verify the result; fixing it afterwards is cheaper. An irreversible execution is different. The result cannot be fixed after the fact, so the model has to move inside a declared frame, and the inputs have to be confirmed before execution (spec 1.1).

### What already exists, and where this goes

| | What it does | What it checks | Who judges |
|---|---|---|---|
| Alignment | Makes the AI judge well | The AI's dispositions and values, in training | The AI |
| Governance | Settles who may act, and under what process | Risk tiers, approval paths, access, audit. Lately also a tool call just before execution, against policy: whether a transfer amount is within the limit | People, through declared policy |
| Harness | Builds the environment around the model and limits what it can reach | Which tools and data the agent can reach, and whether inputs and outputs match their formats | People set the bounds; within them, the AI fills the arguments |
| This specification | Checks that what people declared was met, and records it | Where the intent, each value and each condition of this call came from, and who confirmed it, just before execution | People. The AI does not judge |

Loop engineering is a method that runs across these: act, verify, record, repeat. It checks the result after the act, and the checker is often another model. This checks before the act, and moves the criteria and the decision into a separate, declared model of execution and code. It is not a model of a business domain: each tool's own rules stay in the checklists its provider and the user write.

Governance, harness and loop together come close to the domain modeling and finite-state machines of earlier systems. Which values are allowed, and which transitions are possible from which state, are fixed outside the model, and the model moves inside them. That frame is already being built. This does not replace it. It adds back one premise the frame cannot restore.

### The broken premise

The frame checks whether a value is allowed and whether a transition is possible. It does not check who set the value. It never had to: a person logged in and typed the values, so the input path was the proof of origin.

With agents, the execution still runs under the user's session and permissions, and the audit log still says the user executed with this value. But the model wrote it. Nothing was tampered with, and the premise breaks anyway.

So some wrong executions pass the whole frame. In [the reported Meta Muse case](./case-muse-marketplace.en.md), with "Allow Always" on, Muse agreed in the seller's name to the buyer's 8 to 10 p.m., and the buyer came to the seller's building while the seller was out. The permission was there, the format was right, no policy was broken. The seller had not set that time.

Authority comes from ownership, not accuracy, and a model that answers for nothing cannot hold it (spec 2.1). The model writes the draft; the agent, the code around the model, checks it.

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

**It stops executions nobody asked for.** Only an execution unit the user stated can execute. Not being prohibited is not a ground (spec 0, 1.1).

**It stops different executions.** The act is settled only from the user's words in this request, so an act the user did not name does not execute (gate 1). Going around a block or a failure by another tool or another path is not a continuation of the same request; it is a new execution, judged again from the start. Whether the act and the tool match, however, is not proven by code (spec 8.1).

**It leaves a record, and the verdict reproduces.** Each value is recorded with its source and its place in the original text, so someone other than the gate can check it again. The verdict is a count made by code, so the same input gives the same verdict (spec 3.4).

**It raises the execution rate.** Not the number of executions — it means a stopped execution reaches execution after checking. The purpose is not to block but to reach a state where execution is possible (spec 0.1). Questions do not multiply; they surface. Only what is missing comes back, as a list, so it can be filled in one go, and once the user sets a range, requests inside it execute without asking. Items that repeat become pre-set settings (spec 7.2).

**It divides responsibility and makes it traceable.** Which checklist an empty slot belongs to is where the responsibility lies: a value points to the source integration, a condition to the provider's declaration, an intent to the conversation design (spec 7.1). Today, with no record, an anomaly is left blamed on the agent developer or the model. A decision record cannot be made after the incident.

**It opens other ways to improve.** It shows what to fix without retraining the model. None of the three types needs a training budget (spec 7.1). The gate code stays the same as tools are added or models are swapped. Decision records become data by failure type, an input to model development (spec 7.2).

[The case report](./case-muse-marketplace.en.md) maps this incident's message log onto the checklists and is explicit about what this gate would **not** have caught.

---

## The three checklists

The rules an execution needs, split by who declares them. This split is the core of the design (spec §4). The fixed checklist settles the intent, the provider's the values and conditions, and the user's the range of those values and conditions. Every item in all three is checked and recorded as its own slot.

**Fixed** — which tool, and when it runs. Tool-independent, applied the same way to every execution. It settles the execution unit. Today it is not recorded, and a misreading leads to a bypass.

**Provider** — per tool. Values sit in the MCP input schema or inside the agent. Conditions have to be declared separately. Today they vary from agent to agent, and an MCP server's conditions are not applied before execution.

**User** — intent, limits, preferences. Changes with the user's environment rather than the tool, and differs from user to user. Today all of it is left to the model's judgment.

## Writing the provider's checklist

The checklist is written in the tool's definition: each condition on a line of its own in the description, with a label, and the forms of the values in the input schema. Shortened from [`adopt-example/tool.md`](./adopt-example/tool.md):

```text
Schedule an in-person pickup for a marketplace item. The buyer sees it at once.
The lines below are checked after this tool is called and before it runs. Call it with what the user said; what is missing is asked or checked then.
[Required] The sale must be agreed, as shown by the order status.
[Verify] The time is the one the seller states. It is one moment.
[Verify] The location is the place the seller names, not a place read from the platform.
[Required] The buyer's contact is read from the platform.
[Notice] The buyer sees the time and location immediately.
```

- `[Required]` is confirmed only from the system's own data. The user's words do not fill it.
- `[Verify]` is the user's. A value the user did not give counts only once the user approves it.
- `[Notice]` is told to the user and blocks nothing.

A line without a label is like a prompt: it is recorded and blocks nothing. A line need not say how to ask. The model asks, and code holds what was answered.

Two lines came from running real models:

- **The second line, without a label.** A model that does not know this specification reads the labelled lines as conditions to meet before calling. So the description says, in a line of its own, that they are checked after the call (spec 4.2.1).
- **"not a place read from the platform."** For a value the user can give and the system can also read, the line says whether the system's value counts too. Without it, the same line takes a different form each time it is translated (spec 4.2.1).

Alignment and governance stay as they are, and each decides its own rules in its own layer. To apply one to a tool at execution, write it here as a line: a transfer limit from governance, or a principle from alignment such as "a home address is not disclosed when a public place serves the same purpose." It is then checked and recorded like any other. A rule for one user goes in that user's checklist; a rule for every tool goes in the principles the model is given, and, where it needs checking, in the provider checklist of each tool it concerns (spec 7.2).

## Who does what

| | Does |
|---|---|
| Developer, tool provider | Writes **what** is checked, in the checklist |
| Model | Translates the lines into a comparable form, asks the user, finds the answers in the user's words, and tells the user why it stopped |
| System | Reads the facts from real APIs; code decides pass or fail and records it |

From outside, a model's "I checked" cannot be told apart from a real check. So the model translates, asks, finds and tells, and code decides. Better models translate and ask better; the authority to decide does not move to them. Each line's translation is made once and recorded with every verdict, and a line that could not be translated stays unconfirmed and blocks the run.

---

## The code

Two gates. Neither produces a value or a justification, and neither executes — they look things up and record what they found.

**Gate 1 — intent: what did the user ask for, when or in what situation does it run, and is this the tool that does it?**

**Gate 2 — values and conditions: where did each value come from, and were the conditions confirmed?**

| # | source | meaning |
|---|--------|---------|
| 0 | `user_answer` | answered by the user after an `ask_user` |
| 1 | `instruction` | taken from a trusted segment, with its location |
| 2 | `pre_set_data` | settings the user approved and stored in advance; a value the model proposed and the user approved belongs here too |
| 3 | `measured_data` | measured from the environment |
| 4 | `prior_state` | a value in a prior `executed` record. Never settles a slot; it is shown to the user as a candidate and counts, as `user_answer`, only once confirmed |

A search order, not a ranking by trustworthiness. `instruction` is an array of trust-labeled segments, not a string. Pass a string and the `instruction` source closes; nothing is confirmed from it. Untrusted text — a forwarded email, a tool result, a web page, or text pasted into the user's own message — cannot settle a value on its own. To use something from it, ask the user and take the answer back as `user_answer`. The labels are set by the adopting system when the message arrives, not by the model (spec 5.2).

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

This file is the overview. **The specification is the standard; the adopt example is how it is applied.** The rest shows why each part is there. Each thing below is explained where it lives, not here.

| | |
|---|---|
| **The standard** | |
| [**The specification**](./spec.en.md) · [ko](./spec.ko.md) | What counts as confirmed, who judges, what is recorded. The problems this works through are §2; the three checklists are §4; the slot states and sources are §5 |
| **Applying it** | |
| [**Adopt example**](./adopt-example/) | **Start here.** The files you keep to use this, when you build the agent and its tools together: your declaration of each tool (the rules in words), the connections to your own model, tools and data, and the flow the gate runs in. The gate judges and records (`judge-only.js`), and your agent executes from the record. A whole agent to run is there as a demonstration, and the MCP server connection as comments |
| **The library** ([`execution-state-preflight.js`](./execution-state-preflight.js)) | What the adopt example runs: one file, no dependencies. Hook contracts, the record shape, and where it departs from the specification are in the source comments, beside the code they describe. **Pre-release:** being tested against real models; the API may still change |
| **Why each part is there** | |
| [**The argument, in short**](./model-reasons-agent-executes.en.md) | Why what the model makes up must not reach execution, the two methods, and how this differs from current practice. An essay, not a guide |
| [**Hook examples**](./hooks-example/) | What has to be declared, and how much of this you have to keep, each shown by putting a piece in and taking it out |
| [**Provider checklist example**](./provider-checklist-example/) | The same tool with every rule moved out of code into declarations, the provider's checklist as labelled lines in a standard MCP description, and what that changes, run against the hook examples on the same inputs |
| [**A case report**](./case-muse-marketplace.en.md) | A reported incident mapped onto the checklists |

---

## Quick start

Start from [`adopt-example/`](./adopt-example/), with the library next to it.

1. **Declare the tool** in [`tool.md`](./adopt-example/tool.md): what it does, each rule on a labelled line, and the input schema.
2. **Connect** your model, your tool and your system's data in [`connect.js`](./adopt-example/connect.js).
3. **Judge each tool call before it runs**, from your agent's own loop, and execute from the record:

```js
const { createJudge } = require("./judge-only");
const judge = createJudge({ ask, measure, readToolDefinition, measurements, storage, userId });

const r = await judge.run({ unitKey, conversation, toolCall, userChecklist });
if (r.questions.length > 0) {
  // show your model's words, then r.block exactly as it is; add the reply to the conversation; run again
} else {
  // readyToExecute, notify and callTool are yours: judge-only-example.js has one of each
  const record = (await storage.list(r.key)).at(-1);       // the record this round wrote
  if (readyToExecute(record, toolCall.name)) {              // your own reading of it
    const { toShow } = await judge.notices(record);         // the provider's notices not shown with a question
    if (toShow.length) await notify(toShow.map(d => d.description));   // told before the tool runs
    await callTool(record.tool_call.name, record.call_arguments);
    await judge.recordResult(record, { ok: true });
  } else {
    await judge.recordResult(record, { executed: false, why: "not ready" });   // your decision, recorded too
  }
}
```

To watch a whole run first, with stand-in models and no API key:

```
cd adopt-example && npm install
cd ../provider-checklist-example
node trial-real-model.js --stub --id g1-01 --reply yes
```

The gate asks about the time, the stand-in user answers yes, and the tool runs. The output shows each
model call, the question as shown, each value with its source, and each of the provider's lines with
the form it was checked in.

To try it with your own model:

```
cd adopt-example
npm install
npm install --no-save @langchain/anthropic@1.5.13   # or your provider's package
export ANTHROPIC_API_KEY=...                        # the provider's package reads its key from the environment
MODEL=anthropic:<model-name> node judge-only-example.js "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae station lockers."
```

As shipped, nothing is connected: the `[Required]` lines are unverified, and nothing runs. The run asks
nothing and ends by saying it did not run and which lines could not be checked. That is the gate
failing closed, not a fault: fill in `MEASUREMENTS` and `TOOLS` in `connect.js` and it asks and executes.
The seven things that stay yours, and the whole flow, are in the [adopt example](./adopt-example/#4-use-it-your-agent-executes-judge-onlyjs).

<details>
<summary>Calling the library directly</summary>

```js
const { createPreflight } = require("./execution-state-preflight");

const preflight = createPreflight({
  hooks: {
    classifyWhenCase,             // → "immediate" | "scheduled" | "conditional" | "recurring" | null (undecidable)
    extractUserActionName,        // → { value, segment_index, span } in a user segment | { none: "absent" } | undefined
    confirmToolNameMatchesIntent, // → { approved, reason } — called only when user_action_name says nothing
    extractFromInstruction,       // → { value, segment_index, span } | { none: "absent" | "no_place" } | undefined
    readToolDefinition,           // (name) → { name, description, inputSchema }, from the provider (MCP: tools/list)
    measure,                      // (name, { values, userId, tool }) → { valid, value } | { valid: false } | { none } | undefined
    buildActionKey,               // → opaque string; one per unit, the same in every round of it
    readReplies,                  // → where the user's words answer each question the gate asked
  },
  storage,        // { persist, load, list } — append-only; list(key) returns every record under a key
  strict: true,   // also reject the defaults that verify nothing
});

const state = await preflight.runPreflightAndRecord({
  userId: "u_01",
  instruction: [
    { text: "send 500,000 won to my landlord", trust: "user" },
    { text: "<forwarded email body>", trust: "untrusted", origin: "gmail:msg_881" },
    // …and every later turn of this conversation, the user's replies included
  ],
  toolCall: { name: "transfer_funds", arguments },   // the call the model made; its arguments are recorded, never used as values
  preSetData, priorExecutionState, userChecklist,
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
  // state.gate says exactly what is missing. On ask_user, state.gate.questions is what the model asks
  //   the user, and state.gate.question_block the values as code wrote them, to show with the question.
}
```

</details>

---

## What this doesn't do

The library judges and records. What surrounds it belongs to the system that adopts it, and is filled in there:

- **Masking.** Values are recorded as given. Hide what must not be stored or shown, in the storage adapter.
- **Integrity of what it is handed.** Prior records and stored settings are taken as they come. Keep them where the agent cannot rewrite them (spec 8.2).
- **Trust labels.** Set on arrival by the system, never by the model (spec 5.2).
- **Retry.** A failed call is recorded, not retried.
- **Which tools go through it.** No per-tool risk weighting. Apply it to irreversible executions (spec 1.1).
- **Locking.** Two runs of one unit at the same time are not kept apart.
- **Scheduling.** A call for later is judged, asked about while the user is there, and recorded as deferred with what to run it on (`deferred_input`). Running it again when it is due is the adopting system's: its scheduler calls the gate again with that input, and the gate judges it as a call to make now.
- **Storing settings, consent included.** How a value comes to be kept for next time, and how the user agrees to it, is the adopting system's: a settings page, a "remember this?" in the agent, or a tool of its own, which can go through the gate like any other. The gate only reads. A value counts as a setting only when the store says the user approved it, and who approved it, when and where; a value a model remembered on its own is shown to the user as a candidate (spec 5.2).
- **Execution across a boundary.** The gate writes the record; the executing party reads it and decides (spec 3.5). The examples do both in one process.
- **What the model is told.** That the labeled lines are checked after the call, and what the gate said, as the call's result (spec 4.2.1, 6.2). Without it a model holds back the call, and the gate has nothing to judge.

One is a limit of the library itself:

- **Flat arguments assumed.** Branches at the top of the input schema are read; a value nested inside an argument is not a slot of its own.

---

## Why this exists

A tool's input schema defines the shape of the values it needs. It does not say why a value is needed, who asked for the execution, or whether the execution may run right now. The gap is not MCP's — it shows up anywhere natural language turns into execution, and when one owner has both sides it is invisible and the rules end up scattered across prompts and code.

**If you build the agent and the tool together, you are still the tool provider.** Sharing an owner removes the protocol, not the role. The failure mode of same-ownership is not that the declaration lands in the wrong place; it is that **nobody plays the provider role at all.**

So, a proposal for tool providers: declare conditions in the `description`, each on a labelled line ([Writing the provider's checklist](#writing-the-providers-checklist)). A hint the model may or may not follow becomes a condition checked before execution. It needs no protocol change and can be done today (spec 4.2.1).

The first version of the argument was posted as [If unsure, ask. Never guess. — AI Agent Pre-Execution Checklist](https://discuss.huggingface.co/t/if-unsure-ask-never-guess-ai-agent-pre-execution-checklist/176632). The discussion continues in [Misalignment is not required for an agent to act without authorization](https://discuss.huggingface.co/t/misalignment-is-not-required-for-an-agent-to-act-without-authorization/180541) and [We gave AI a trust we never gave people — The third axis, after capability and permission](https://discuss.huggingface.co/t/we-gave-ai-a-trust-we-never-gave-people-the-third-axis-after-capability-and-permission/183807/), where a team running its own agent is cross-checking the library against its cases ([`hooks-example/crosscheck/`](./hooks-example/crosscheck/)).

Contact: [hello@anna.software](mailto:hello@anna.software)

License: see [LICENSE.md](./LICENSE.md)
