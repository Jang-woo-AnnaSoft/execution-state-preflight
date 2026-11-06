# adopt-example

The files you keep in your own system. You write the rules down, connect your system, and the gate
decides whether a call has everything it needs before it runs.

| File | What you do |
|---|---|
| [`tool.json`](./tool.json) | **Write.** The tool's rules, as a standard MCP tool definition |
| [`confirmed.json`](./confirmed.json) | **Write.** How each rule is checked, as you confirmed it |
| [`connect.js`](./connect.js) | **Fill in.** Your model, your system's values, your tool call, your storage |
| [`principles.md`](./principles.md) | **Put in your agent's system prompt.** The specification's rules as prompt sentences |
| [`agent.js`](./agent.js) | Run it, or call it from your app. No edits needed |
| [`gate.js`](./gate.js) | Do not edit. Reads the rules, runs the checks, runs the flow |

You also need the skeleton, [`execution-state-preflight.js`](../execution-state-preflight.js): one
file, no dependencies. Copy it next to this folder or into it.

## 1. Write the rules: `tool.json`

Put the conditions in the tool's description, one per line, each starting with a label:

```
Schedule an in-person pickup for a marketplace item. …
[Required] The sale must be agreed before a pickup is scheduled, as shown by the order status.
[Notice] The buyer sees the time and location immediately.
```

- `[Required]` must hold, and is confirmed only from your system's own data.
- `[Verify]` needs the user's approval.
- `[Notice]` is shown to the user and blocks nothing.

Say how each condition is checked, in the same sentence. Here that is "as shown by the order status".

In the input schema, write each value's form and where it may come from:

- `"format": "date-time"` for the value's form.
- `"x-allowed-sources": ["measured_data"]` for a value only your system knows.
- `"x-allowed-sources": ["user_answer", "instruction", "pre_set_data"]` for a value only the user gives.
- `"x-settled-at-execution": true` for a value your system settles at run time. It is taken only
  inside a range the user set.

**Not using MCP?** If your agent and your tools are built together, write the rules in your own
format. A Markdown document is fine, as long as your model can read it. The format is not the
point. The point is that the rules are written down, in one place, by whoever owns them. A rule
that is not written down is either guessed by the model each time or hidden in someone's code.

## 2. Confirm how each rule is checked: `confirmed.json`

A sentence cannot be compared as it stands, so each labelled line gets a comparable form: a JSON
Schema the value must satisfy.

```json
{ "label": "Required",
  "stated_as": "The sale must be agreed before a pickup is scheduled, as shown by the order status.",
  "compare": { "source": "measured_data", "measure": "order_status", "schema": { "const": "agreed" } } }
```

Let a model write the form ("put this sentence into a JSON Schema check"), then read it next to
the sentence and confirm it. You do this once, when you write the rule. After that, every run
checks against the form with a standard validator. The model is never asked whether a check passed.

`stated_as` must match the line in `tool.json` word for word. If you reword a line, its old form
no longer applies. Until you confirm a new one, a `[Required]` line stops the run.

**JSON Schema is this example's choice, not a requirement.** What is required is that the
confirmed form can be compared by code, the same way every time: no model judges at run time
whether a rule held (spec 6.3). JSON Schema works because a standard validator runs it. If your
rules live in your own format and you check them with your own deterministic code, replace the two
readers in `gate.js` that do this: the labelled-line reader, and `checkAgainst`. Keep the rest of
the gate as it is.

## 3. Connect your system: `connect.js`

| What | In `connect.js` | What you put there |
|---|---|---|
| Model | `ask` | Your chat model, chosen by `MODEL="provider:model"`. Install that provider's package |
| Your system's values | `measure(name)` | Calls to your own APIs: order status, contact details. Never from the conversation |
| Who wrote what | `labelInput(message)` | Your input path marks what the user typed. Pasted or quoted text, other people's messages and tool output are untrusted |
| The tool | `callTool(name, args)` | Your MCP client call. Set `MCP_SERVER_URL` |
| Decision records | `store` | Append-only, somewhere the agent cannot rewrite |
| Waiting runs | `checkpointer` | A persistent LangGraph checkpointer, for example Postgres |
| The form the user sees | outside this folder | Your client renders `request` (an MCP elicitation form) |

**Keys.** Keys and addresses come from environment variables only. Never write them into these
files.

**Fail-closed.** A measurement you have not connected counts as "not measured". As shipped, nothing
is connected, so the `[Required]` line is unverified and nothing runs.

## 4. Run

```
npm install
npm install @langchain/anthropic        # or the package for the provider you chose
MODEL=anthropic:<model-name> MCP_SERVER_URL=https://… node agent.js "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae station lockers."
```

The run is asked for what is missing. Here that is the time: "2pm this Saturday" is not a
date-time, so the model's reading of it is shown as the default for you to confirm. The run
executes with what you send back.

From your app:

```js
const { createAgent } = require("./agent");
const agent = createAgent();
let r = await agent.start({ threadId, message: { typed, context } });
// r.status === "waiting": show r.request as a form
r = await agent.resume({ threadId, reply: { action: "accept", content } });
```

## What the code here does not show

Some of the specification is not visible in these files. Keep it in your system anyway.

- **Principles** ([`principles.md`](./principles.md), spec 6.2). Put them in your agent's system
  prompt. The gate catches a violation either way. The prompt makes it rarer.
- **Only the record decides execution** (spec 3.5). Whatever executes reads the decision record
  and nothing else. There must be no path to the tool that does not go through the record. Here,
  `execute` uses only the gate's arguments, but it runs in the same process as the gate.
- **Records the agent cannot rewrite** (spec 8.2). Keep `store` outside the agent's reach.
- **Which version of the rules was used** (spec 6.1). A changed rule voids earlier verdicts made
  under it. Put a version or date on each entry in `confirmed.json`. The gate carries fields it
  does not know into the record, so a version you add there lands in it.
- **Trust labels are set on arrival** (spec 5.2). Your input path decides what the user typed,
  never the model.
- **An approval is tied to the value shown** (spec 6.3). In this flow, the value the user sends
  back is the value executed. If you approve values another way, bind each approval to its value
  and void it when the value changes.

## The user's own conditions

When a user says "nothing after 8pm", that is their condition, with their way of checking it. The
model writes it as a JSON Schema item, and the user confirms it (spec 3.3, 4.4). Pass confirmed
items to `agent.start({ userChecklist })`. This folder does not include that confirmation step. See
[`provider-checklist-example/instructions.json`](../provider-checklist-example/instructions.json)
for what the items look like.

## Where this is checked

The tests are in [`provider-checklist-example/`](../provider-checklist-example/), so this folder holds only
what you keep. They check five things:

- this folder holds only these files, and `principles.md` matches spec 6.2;
- what is measured is exactly what the declarations name;
- `connect.js` as shipped fails closed;
- start, wait, resume and execute run end to end;
- on the same 35 inputs, the first decision here equals the reference run.
