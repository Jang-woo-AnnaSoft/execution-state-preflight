# adopt-example

The files you keep in your own system. You connect your model, your MCP server and your system's
data, and the gate decides whether each tool call has everything it needs before it runs.

| File | What you do |
|---|---|
| [`connect.js`](./connect.js) | **Fill in.** Your model, your MCP server, your system's values, your storage |
| [`principles.md`](./principles.md) | Goes into your agent's system prompt (`agent.js` puts it there). The specification's rules as prompt sentences |
| [`agent.js`](./agent.js) | Run it, or call it from your app. No edits needed |
| [`gate.js`](./gate.js) | Do not edit. Gives the skeleton its model calls, a validator and the flow |
| [`tool.md`](./tool.md) | An example of a tool's definition as its provider declares it. Your own declaration, if you build the tool too (`TOOLS_FILE`) |

You also need the skeleton, [`execution-state-preflight.js`](../execution-state-preflight.js): one
file, no dependencies. Copy it next to this folder or into it.

## 1. The rules are the provider's, in the tool's definition

A tool's rules are in its definition, written by whoever provides the tool (spec 4.2). The gate
reads that definition itself, from where the provider declares it, once your model has called the
tool: from the MCP server's tool list, or — when you build the agent and the tool together, and so are
the provider yourself — from your own declaration of it (`TOOLS_FILE`, in the format of
[`tool.md`](./tool.md)).

The provider writes two things, and nothing else:

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

The whole tool is in [`tool.md`](./tool.md): its name, description and input schema. The agent works
with a tool declared that way. Against a server that does not serve one, it cannot work: the model has
no tool to call, or the gate finds no definition and stops. If you build the tool too, `tool.md` is
your declaration: point `TOOLS_FILE` at it, and build the tool from it.

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
the definition it read, so a change on the server shows in the record.

The conditions a user states ("nothing after 8pm") are different: they are the user's words, so the
user confirms the form, in the conversation, before anything is compared in it (spec 4.4).

**JSON Schema is this example's choice, not a requirement.** What is required is that the form can
be compared by code, the same way every time: no model judges at run time whether a rule held
(spec 6.3). With your own deterministic checker, replace `checkAgainst` in `gate.js`.

## 3. Connect your system: `connect.js`

| What | In `connect.js` | What you put there |
|---|---|---|
| Model | `ask`, `chat` | Your chat model, chosen by `MODEL="provider:model"`. Install that provider's package |
| The tools | `listTools`, `readToolDefinition` | Your MCP server, at `MCP_SERVER_URL`. The client follows the server's notices that its tool list changed; a server that sends none is listed again each time. Or, if you build the tools, your declaration of them: `TOOLS_FILE` |
| Your system's values | `MEASUREMENTS` | Calls to your own APIs. The gate calls one when it needs it, with the values it has settled (`values.item_id`). Never from the conversation |
| Who wrote what | `labelInput(message)` | Your input path marks what the user typed. Pasted or quoted text, other people's messages and tool output are untrusted |
| The tool call | `callTool(name, args)` | Your MCP client call, or your own call to the tool |
| Records | `store` | Append-only, somewhere the agent cannot rewrite. It also needs `list(key)`: the gate reads what a conversation was asked, and the kept forms, with it |
| Waiting conversations | `checkpointer` | A persistent LangGraph checkpointer, for example Postgres |

**Keys.** Keys and addresses come from environment variables only. Never write them into these
files.

**Fail-closed.** As shipped, nothing is connected: no server, so no definition is read, and no
measurement, so the `[Required]` lines are unverified. Nothing runs.

**When the server asks for more input.** Under MCP 2026-07-28 a server may answer a tool call with
`input_required`. The MCP client is set not to answer it itself (`autoFulfill: false`): input gathered
that way would reach the tool without passing the gate. The run stops with status `input_required`,
nothing executed, and the server's request is returned to you.

## 4. Run

```
npm install
npm install @langchain/anthropic        # or the package for the provider you chose
MODEL=anthropic:<model-name> MCP_SERVER_URL=https://… node agent.js "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae station lockers."
```

The model calls the tool. The gate reads the tool's definition from the server and judges. Here the
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

## What the code here does not show

- **Principles** ([`principles.md`](./principles.md), spec 6.2). The gate catches a violation either
  way. The prompt makes it rarer.
- **Only the record decides execution** (spec 3.5). Here, `execute` uses only the gate's arguments,
  but it runs in the same process as the gate.
- **Records the agent cannot rewrite** (spec 8.2). Keep `store` outside the agent's reach.
- **Trust labels are set on arrival** (spec 5.2). Your input path decides what the user typed, never
  the model.
- **A notice is shown, not acknowledged.** The provider's `[Notice]` lines go with every question and
  come back in the result (`disclosures`). The gate does not wait for the user to acknowledge one; if
  your tool needs that, ask for it before the call.

## What the skeleton does that you do not write

- **Reads the tool's definition** once the model calls the tool, and records which one it read.
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
- `connect.js` as shipped fails closed;
- the model calls the tool, the gate asks, the user replies in words, and the tool runs;
- on the same 35 inputs, the first decision here equals the reference run.
