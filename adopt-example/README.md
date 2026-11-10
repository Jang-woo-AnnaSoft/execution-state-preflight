# adopt-example

The files you keep in your own system, when you build the agent and its tools together. You declare
the tools, connect your model, your tools and your system's data, and the gate decides whether each
tool call has everything it needs before it runs.

**Two ways to use it. Choose one.** What you write (`tool.md`) and what you connect (`connect.js`) are
the same in both.

| | A. Build the agent here | B. Add it to an agent you already have |
|---|---|---|
| Start from | [`agent.js`](./agent.js) | [`judge-only-example.js`](./judge-only-example.js) |
| Who runs the flow (ask, wait, call again) | `gate.js`, a LangGraph graph | Your agent's own loop |
| Who executes the tool | The graph, with the gate's arguments | Your agent, after reading the record |
| What the gate does | Judges, records, asks, executes | Judges and records, nothing else ([`judge-only.js`](./judge-only.js)) |
| What you must keep yourself | Nothing in the flow | Five things, listed in [section 5](#5-add-it-to-an-agent-you-already-have) |

Sections 1 to 3 are for both. Section 4 is A. Section 5 is B.

| File | What you do |
|---|---|
| [`tool.md`](./tool.md) | **Write.** Your declaration of the tool: name, rules in words, input schema |
| [`connect.js`](./connect.js) | **Fill in.** Your model, your tools, your system's values, your storage |
| [`principles.md`](./principles.md) | Goes into your agent's system prompt (`agent.js` puts it there). The specification's rules as prompt sentences |
| [`judge-only.js`](./judge-only.js) | Do not edit. Gives the skeleton its model calls and a validator; judges one tool call and writes the record |
| [`agent.js`](./agent.js) | **A.** Run it, or call it from your app. No edits needed |
| [`gate.js`](./gate.js) | **A.** Do not edit. The flow around `judge-only.js`, as a LangGraph graph |
| [`judge-only-example.js`](./judge-only-example.js) | **B.** Read and adapt. Your agent's side: ask, judge again, read the record, execute, write the result |

You also need the skeleton, [`execution-state-preflight.js`](../execution-state-preflight.js): one
file, no dependencies. Copy it next to this folder or into it.

## 1. Declare the tool: `tool.md`

You build the tool, so you are its provider (spec 4.2), and you write its rules. They go in the
tool's definition, which the agent's model and the gate both read from `tool.md`, on every run. The
gate reads it itself, once the model has called the tool.

Two places, and nothing else:

- **The description, in words.** What the tool does, and then each rule on a line of its own,
  starting with a label. Say what the value is and who gives it. A line need not say how to ask:
  the model asks, and code holds the answer to what was shown.
- **The input schema, forms only.** Each value's `type`, and its `format` or `pattern` where it has
  one, and which values are required.

```
Schedule an in-person pickup for a marketplace item. The buyer sees it at once. Times are in the time zone of the seller's account region.
[Required] The sale must be agreed, as shown by the order status. Only the status "agreed" means agreed.
[Verify] The time is the one the seller states, or the time of a pickup request the buyer sent in the app inside a range the seller set for this pickup. It is one moment.
[Verify] The location is the place the seller names.
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
| Model | `ask`, `chat` | Your chat model, chosen by `MODEL="provider:model"`. Install that provider's package |
| The tools' definitions | `listTools`, `readToolDefinition` | Nothing: they read `tool.md` (or the files in `TOOLS_FILE`). For an MCP server, uncomment the MCP connection |
| Your system's values | `MEASUREMENTS` | Calls to your own APIs. The gate calls one when it needs it, with the values it has settled (`values.item_id`). Never from the conversation |
| Who wrote what | `labelInput(message)` | Your input path marks what the user typed. Pasted or quoted text, other people's messages and tool output are untrusted |
| The tool call | `TOOLS` | Your tool, by name: it takes the gate's arguments and does the thing. For an MCP server, the commented `mcpCallTool` |
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

## 4. Run (A: build the agent here)

```
npm install
npm install @langchain/anthropic        # or the package for the provider you chose
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
shown again. The run executes with the gate's arguments only; what the model put in its own tool call
is recorded and never used.

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

**What a run can end as.** `executed` means the tool completed with the gate's arguments. Anything
else means it did not: the gate's own reasons (`hold`, `definition_repair`, `exhausted` …), the user's
(`cancelled`), the model's (`replied`: it answered without calling a tool), or the call's
(`input_required`, `tool_error`, `call_failed`). None is retried.

## 5. Add it to an agent you already have

Your agent keeps its loop and executes the tool itself. Before it does, it calls `judge.run` with the
conversation and the tool call the model made. `judge-only.js` judges and writes the decision record.
It executes nothing, and what it returns carries no arguments and no decision to execute.

```js
const { createJudge } = require("./judge-only");
const judge = createJudge({ ask, measure, readToolDefinition, measurements, storage, userId });

const r = await judge.run({ unitKey, conversation, toolCall, userChecklist });
if (r.questions.length > 0) {
  // show your model's words, then r.block exactly as it is; add the reply to the conversation; run again
} else {
  const record = (await storage.list(r.key)).at(-1);       // the record this round wrote
  if (readyToExecute(record, toolCall.name)) {              // your own reading of it
    const result = await callTool(record.tool_call.name, record.call_arguments);
    await judge.recordResult(record, { ok: true });
  }
}
```

[`judge-only-example.js`](./judge-only-example.js) is the whole of it, and runs the same way as
`agent.js`:

```
MODEL=anthropic:<model-name> node judge-only-example.js "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae station lockers."
```

`judge-only.js` needs only the skeleton and the validator (Ajv). It does not load LangGraph.

**Five things are yours to keep.** In A the graph keeps them. Here nothing checks them for you, and
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

**Try it without blocking.** Because judging only records, you can call `judge.run` beside your
agent as it is and read the records, before anything depends on them. Most first records will ask:
whether a run reaches execution shows only once the asking is wired in. Each round calls the model.

## What the code here does not show

- **Principles** ([`principles.md`](./principles.md), spec 6.2). The gate catches a violation either
  way. The prompt makes it rarer.
- **Only the record decides execution** (spec 3.5). In A, `execute` uses only the gate's arguments,
  but it follows the gate's decision in the same flow. In B the agent's side reads the record and
  decides, though the example still runs in one process: a real system reads the record across the
  boundary between the two.
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

- this folder holds only these files, and `principles.md` matches spec 6.2 and is in the system prompt;
- the tool is read from `tool.md` by default, and `connect.js` as shipped fails closed;
- the MCP connection kept as comments is still code once uncommented;
- the model calls the tool, the gate asks, the user replies in words, and the tool runs;
- on the same 35 inputs, the first decision here equals the reference run.
