# adopt-example

The files you keep in your own system, when you build the agent and its tools together. You declare
the tools, connect your model, your tools and your system's data, and the gate decides whether each
tool call has everything it needs before it runs.

**Use `judge-only.js`.** The gate judges and writes the record, and your agent executes from that
record. This is the structure the specification describes (spec 3.5).

`agent.js` is a demonstration: a whole agent to run and watch, with the flow written for you. **It
departs from spec 3.5.** The one difference left is that the gate and the executing step are in one
graph. What you write (`tool.md`) and what you connect (`connect.js`) are the same in both.

| | `judge-only.js` (recommended) | `agent.js` (demonstration) |
|---|---|---|
| For | Your agent, existing or new, with its own loop | Trying it end to end before you wire anything |
| Start from | [`judge-only-example.js`](./judge-only-example.js) | [`agent.js`](./agent.js) |
| Who runs the flow (ask, wait, call again) | Your agent's own loop | `gate.js`, a LangGraph graph |
| Who executes the tool | Your agent, after reading the record | The graph's executing step, after reading the record |
| The gate and the executing side | Two parties: the gate ends with the record | **Departs from spec 3.5**: the gate and the executing step are in one graph |
| What you must keep yourself | Six things, listed in [section 4](#4-use-it-your-agent-executes-judge-onlyjs) | Nothing in the flow |

Sections 1 to 3 are for both. Section 4 is `judge-only.js`. Section 5 is the demonstration.

| File | What you do |
|---|---|
| [`tool.md`](./tool.md) | **Write.** Your declaration of the tool: name, rules in words, input schema |
| [`connect.js`](./connect.js) | **Fill in.** Your model, your tools, your system's values, your storage |
| [`principles-gated.md`](./principles-gated.md) | Goes into your agent's system prompt (both flows put it there). What the model needs to know when a gate judges its calls (spec 6.2, last paragraph) |
| [`principles.md`](./principles.md) | The specification's 6.2 as prompt sentences, for a model with no gate (`systemPrompt("principles.md")`) |
| [`judge-only.js`](./judge-only.js) | Do not edit. Gives the skeleton its model calls and a validator; judges one tool call and writes the record |
| [`judge-only-example.js`](./judge-only-example.js) | Read and adapt. Your agent's side: ask, judge again, read the record, execute, write the result |
| [`agent.js`](./agent.js) | Demonstration. Run it, or call it from your app. No edits needed |
| [`gate.js`](./gate.js) | Demonstration. Do not edit. The flow around `judge-only.js`, as a LangGraph graph |

You also need the skeleton, [`execution-state-preflight.js`](../execution-state-preflight.js): one
file, no dependencies. Copy it next to this folder or into it.

## 1. Declare the tool: `tool.md`

You build the tool, so you are its provider (spec 4.2), and you write its rules. They go in the
tool's definition, which the agent's model and the gate both read from `tool.md`, on every run. The
gate reads it itself, once the model has called the tool.

Two places, and nothing else:

- **The description, in words.** What the tool does, and then each rule on a line of its own,
  starting with a label. Say what the value is and who gives it. A line need not say how to ask:
  the model asks, and code holds the answer to what was shown. Say once, in a line without a label,
  that the labelled lines are checked after the call and before it runs: a model that does not know
  the labels reads them as conditions to meet before it calls, and then does not call (spec 4.2.1).
- **The input schema, forms only.** Each value's `type`, and its `format` or `pattern` where it has
  one, and which values are required.

```
Schedule an in-person pickup for a marketplace item. The buyer sees it at once. Times are in the time zone of the seller's account region.
The lines below are checked after this tool is called and before it runs: [Required] by the platform from its own data, [Verify] with the user, and [Notice] is told to the user. Call it with what the user said; what is missing is asked or checked then.
[Required] The sale must be agreed, as shown by the order status. Only the status "agreed" means agreed.
[Verify] The time is the one the seller states, or the time of a pickup request the buyer sent in the app inside a range the seller set for this pickup. It is one moment.
[Verify] The location is the place the seller names, not a place read from the platform.
[Required] The buyer's contact is read from the platform.
[Notice] The buyer sees the time and location immediately. Tell the seller before the pickup is scheduled.
```

- `[Required]` must hold, and is confirmed only from your system's own data. A value that may come
  only from your system is a `[Required]` line too ("read from the platform").
- `[Verify]` is the user's. A value only the user may give is a `[Verify]` line: a value from
  anywhere else counts only once the user approves it.
- `[Notice]` is shown to the user and blocks nothing.

Build the tool itself from the same declaration. Changing a rule is changing its line: there is no
code to change and nothing to redeploy on the agent's side.

**Several tools?** One file each, listed in `TOOLS_FILE`, separated by commas.

**A tool on someone else's MCP server?** Its provider writes the rules in the tool's description on
the server. `connect.js` keeps the MCP connection as comments: uncomment it and the gate reads the
definition from the server's list. A `[Required]` line can be checked only if your system can
measure what it names, which is often data on the provider's side.

## 2. How a line is checked

A sentence cannot be compared as it stands (spec 3.3). The first time the gate meets a line, a model
puts it into a form code can compare, and the gate keeps that form, under the line's own words, and
compares the line in it on every run. Nobody approves it. Every decision record shows, for each line:

- the form it was compared in, as JSON;
- what that form checks, in words written by code from the form itself, never by the model;
- which model wrote the form.

```
[Required] The sale must be agreed, as shown by the order status. …
  checked like this: holds only when the system measurement order_status is exactly "agreed". …
  form: {"compare":{"source":"measured_data","measure":"order_status","schema":{"const":"agreed"}},"constrains":[]}
```

A line the model cannot put into a form that fits its label is not compared, and the run does not
execute. A reworded line is translated again. If an audit finds a form wrong, drop it
(`preflight.revokeForm`) and the next run translates the line again. The record also keeps a hash of
the definition it read, so a change to the declaration shows in the record.

The conditions a user states ("nothing after 8pm") are different: they are the user's words, so the
user confirms the form, in the conversation, before anything is compared in it (spec 4.4).

**JSON Schema is this example's choice, not a requirement.** What is required is that the form can
be compared by code, the same way every time: no model judges at run time whether a rule held
(spec 6.3). With your own deterministic checker, replace `checkAgainst` in `judge-only.js`.

## 3. Connect your system: `connect.js`

| What | In `connect.js` | What you put there |
|---|---|---|
| Model | `ask`, `say`, `chat` | Your chat model, chosen by `MODEL="provider:model"`. Install that provider's package. `ask` answers the gate in JSON, `say` writes the words of a question in plain text |
| The tools' definitions | `listTools`, `readToolDefinition` | Nothing: they read `tool.md` (or the files in `TOOLS_FILE`). For an MCP server, uncomment the MCP connection |
| Your system's values | `MEASUREMENTS` | Calls to your own APIs. The gate calls one when it needs it, with the values it has settled (`values.item_id`). Never from the conversation |
| Who wrote what | `labelInput(message)` | Your input path marks what the user typed. Pasted or quoted text, other people's messages and tool output are untrusted |
| The tool call | `TOOLS` | Your tool, by name: it takes the arguments in the gate's record and does the thing. For an MCP server, the commented `mcpCallTool` |
| Records | `store` | Append-only, somewhere the agent cannot rewrite. It also needs `list(key)`: the gate reads what a conversation was asked, and the kept forms, with it |
| Waiting conversations | `checkpointer` | A persistent LangGraph checkpointer, for example Postgres |

**Keys.** Keys and addresses come from environment variables only. Never write them into these
files.

**Fail-closed.** As shipped, the tool is declared but nothing is connected: no measurement, so the
`[Required]` lines are unverified, and no tool to call. Nothing runs.

**When an MCP server asks for more input.** Under MCP 2026-07-28 a server may answer a tool call with
`input_required`. The commented MCP client is set not to answer it itself (`autoFulfill: false`):
input gathered that way would reach the tool without passing the gate. The run stops with status
`input_required`, nothing executed, and the server's request is returned to you.

## 4. Use it: your agent executes (`judge-only.js`)

Your agent keeps its loop and executes the tool itself. Before it does, it calls `judge.run` with the
conversation and the tool call the model made. `judge-only.js` judges and writes the decision record.
It executes nothing, and what it returns carries no arguments and no decision to execute.

```js
const { createJudge } = require("./judge-only");
const judge = createJudge({ ask, measure, readToolDefinition, measurements, storage, userId });

const r = await judge.run({ unitKey, conversation, toolCall, userChecklist });
if (r.questions.length > 0) {
  // show your model's words, then r.block exactly as it is; add the reply to the conversation; run again
} else if (r.ask && r.message) {
  // the gate could not tell what is wanted: show r.message as it is; the user says it again; run again
} else {
  const record = (await storage.list(r.key)).at(-1);       // the record this round wrote
  if (readyToExecute(record, toolCall.name)) {              // your own reading of it
    const result = await callTool(record.tool_call.name, record.call_arguments);
    await judge.recordResult(record, { ok: true });
  }
}
```

[`judge-only-example.js`](./judge-only-example.js) is the whole of it. To run it:

```
npm install
npm install --no-save @langchain/anthropic@1.5.13   # or your provider's package, in a version that takes @langchain/core 1.2.20
MODEL=anthropic:<model-name> node judge-only-example.js "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae station lockers."
```

`judge-only.js` needs only the skeleton and the validator (Ajv). It does not load LangGraph.

**Six things are yours to keep.** Nothing checks them for you, and
breaking one leaves a record that is right about an execution that was not.

1. **Label who wrote each part of a message on arrival**, before the model sees it (spec 5.2). Only
   what the user typed is the user's.
2. **Show `r.block` unchanged.** A yes approves those lines. If your model rewrites them, the user
   approved something else.
3. **Add the user's reply as the user's words, and judge again under the same `unitKey`.** A reply
   counts only for a question asked in that conversation, after it.
4. **Execute from the record** (spec 3.5): read it from storage, decide for yourself, send its
   `call_arguments`. Never the model's own arguments. `readyToExecute` in the example reads what was
   counted (nothing unconfirmed, nothing that prohibits, this tool, made for this moment) and does not
   follow the gate's `execution_decision`. A record that still asks also carries `call_arguments`, the
   values known so far: arguments alone are not a sign of readiness.
5. **Keep the record where the agent cannot rewrite it** (spec 8.2), **and write what happened back**
   with `judge.recordResult`. Only an executed record is what a later run may carry values from.
6. **Tell your model how its calls are judged, and what happened to each.** Give it
   `principles-gated.md` as its system prompt, and keep the line in the description that says when
   the labelled lines are checked (section 1). A model that does not know the labels reads them as
   conditions to meet before calling: with a real model and the lines alone, it did not call, and
   asked the user for a fact only the system could check; with both, it called at once and left the
   asking to the gate. Show the gate's answer, a question, a stop or a run, as the result of the
   model's call (`messagesFor`, `afterCall` in `judge-only.js`): a real model shown the gate's reason
   as its own words took it back, on the next turn, as made up. Where you hand the model its tool
   list yourself you may also take the labelled lines out (`judge.toolsForModel`); a host that lists
   a server's tools itself shows the whole description. The gate reads the full definition either way.

**When nothing runs, tell the user why.** `writeStop` (in `judge-only.js`) hands your model the
skeleton's `stopFacts` for the record: the condition in its own words, whose it is, what was found.
Your model writes the message from those alone; without its words there is still a plain sentence.
The example shows it, and gives it to the model as its call's result. Without this, a hold ends with
nothing said: a real run held on a `[Required]` line did.

**Settings and the last execution** (spec 5.2). Give `createJudge` a `readPreSet(userId, toolName)`
(`connect.js` has a starting point) and the gate reads the user's settings for the tool: `trust:
"user"` with `approved_by`, `approved_at` and `approved_in` is a setting, recorded with them; any other
trust, a value a model remembered, is shown to the user and counts only once approved. When a call
executes, `recordResult` keeps the record for this user and tool, and the next run offers its values
when nothing else gives them ("same place as last time"), again only once approved. How settings come
to be stored is yours.

**Try it without blocking.** Because judging only records, you can call `judge.run` beside your
agent as it is and read the records, before anything depends on them. Most first records will ask:
whether a run reaches execution shows only once the asking is wired in. Each round calls the model.

## 5. The demonstration: a whole agent (`agent.js`)

The same gate, with the flow written for you as a LangGraph graph. The graph does the flow's part of
section 4 itself: it shows the values unchanged, judges again after a reply, executes from the record
and writes the result back. It also gives its model the tools without the labelled lines, and tells
the user why when nothing runs.

**This departs from spec 3.5.** The one difference left is that the gate and the executing step are in
one graph; the specification has the executing party outside the gate. It shows the behaviour, end to
end.

```
MODEL=anthropic:<model-name> node agent.js "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae station lockers."
```

The model calls the tool. The gate reads the tool's definition from `tool.md` and judges. Here the
time is missing: "2pm this Saturday" is not a date-time. The model asks, and under its words code shows
the value it read, as it will be used:

```
Is this the time you meant?
- time = 2026-10-31 (Sat) 14:00 +09:00
- Note: The buyer sees the time and location immediately. Tell the seller before the pickup is scheduled.
```

Answer in words. A yes approves exactly the value shown. Another time ("no, 3pm") is read again and
shown again. The run executes with the record's arguments only; what the model put in its own tool
call is recorded and never used.

From your app:

```js
const { createAgent } = require("./agent");
const agent = createAgent();
let r = await agent.start({ threadId, message: { typed, context } });
// r.status === "waiting": show r.question.message
r = await agent.reply({ threadId, message: { typed: "yes" } });
```

Use one `threadId` per conversation, for every turn of it. The gate reads what it asked in that
conversation from its records, and a reply counts only for a question asked there, in the user's
words after it. If the model calls another tool, that is another unit: the first one's records stay
as they are.

**What a run can end as.** `executed` means the tool completed with the record's arguments. Anything
else means it did not: the gate's own reasons (`hold`, `definition_repair`, `exhausted` …), the user's
(`cancelled`), the model's (`replied`: it answered without calling a tool), or the call's
(`input_required`, `tool_error`, `call_failed`). None is retried.

## What the code here does not show

- **Principles** ([`principles-gated.md`](./principles-gated.md), spec 6.2). The gate catches a
  violation either way. The prompt decides whether the gate gets a call to judge.
- **Only the record decides execution** (spec 3.5). Both paths read the record and decide from it, but
  both run in one process here. A real system reads the record across the boundary between the gate
  and the executing party, and leaves no way to the tool that does not pass through it.
- **Records the agent cannot rewrite** (spec 8.2). Keep `store` outside the agent's reach.
- **Trust labels are set on arrival** (spec 5.2). Your input path decides what the user typed, never
  the model.
- **A notice is shown, not acknowledged.** The provider's `[Notice]` lines go with every question and
  come back in the result (`disclosures`). The gate does not wait for the user to acknowledge one; if
  your tool needs that, ask for it before the call.

## What the skeleton does that you do not write

- **Reads the tool's definition** once the model calls the tool, and records which one it read: a
  changed declaration shows in the record.
- **Each check is its own slot in the record**: each value, its format, the payload, each line, each
  condition the user stated, each reply.
- **Measures when it needs a value**, with the values it has settled, and records each measurement.
- **The user's own conditions** (spec 4.4): taken from what the user typed, confirmed by the user. A
  standing setting the user saved goes in `agent.start({ userChecklist })`.
- **Replies bound to what they answered** (spec 6.3): a yes counts only for a question asked, for the
  values it showed, and for the version of the rule it was given under.
- **Which version of the rules was used** (spec 6.1): every line, condition and the input schema.

## Where this is checked

The tests are in [`provider-checklist-example/`](../provider-checklist-example/), so this folder holds
only what you keep. They check:

- this folder holds only these files, `principles.md` matches spec 6.2, and each line of
  `principles-gated.md` names spec sections that exist and is in the system prompt by default;
- the tool is read from `tool.md` by default, and `connect.js` as shipped fails closed;
- the MCP connection kept as comments is still code once uncommented;
- the model calls the tool, the gate asks, the user replies in words, and the tool runs;
- judging returns no arguments and no decision, and executes nothing; the agent's side executes from
  the record, and reads every verdict record the same way the gate decided;
- in the demonstration too, the executing step starts from the record and writes the result back;
- on the same 35 inputs, the first decision here equals the reference run.
