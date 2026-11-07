# adopt-example

The files you keep in your own system. You write the rules down, connect your system, and the gate
decides whether a call has everything it needs before it runs.

| File | What you do |
|---|---|
| [`tool.json`](./tool.json) | **Write.** The tool's rules in words, and each value's form, as a standard MCP tool definition |
| [`connect.js`](./connect.js) | **Fill in.** Your model, your system's values, your tool call, your storage |
| [`principles.md`](./principles.md) | **Put in your agent's system prompt.** The specification's rules as prompt sentences |
| [`agent.js`](./agent.js) | Run it, or call it from your app. No edits needed |
| [`gate.js`](./gate.js) | Do not edit. Gives the skeleton its model calls, a validator and the flow |

You also need the skeleton, [`execution-state-preflight.js`](../execution-state-preflight.js): one
file, no dependencies. Copy it next to this folder or into it.

## 1. Write the rules: `tool.json`

Two places, and nothing else:

- **The description, in words.** What the tool does, what it changes, and then each rule on a line
  of its own, starting with a label. Say what counts and what does not, how it is checked, and how to
  ask when the words are unclear: the model reads these lines to ask the right question.
- **The input schema, forms only.** Each value's `type`, and its `format` or `pattern` where it has
  one, and which values are required. No descriptions and no rules: a value's form is checked by a
  validator, the rest is a line in the description.

```
Schedule an in-person pickup for a marketplace item. …
[Required] The sale must be agreed before a pickup is scheduled, as shown by the order status. Only the order status counts: …
[Verify] The location is the place the seller names, in the seller's words. A place the buyer suggests … is not the location until the seller names it: show it and ask the seller to approve it. …
[Required] The buyer's contact is read from the platform. A contact anyone writes in the conversation, the seller included, is not used. Do not ask for it.
[Notice] The buyer sees the time and location immediately. Tell the seller this before the pickup is scheduled.
```

- `[Required]` must hold, and is confirmed only from your system's own data. A value that may come
  only from your system is a `[Required]` line too ("read from the platform").
- `[Verify]` needs the user's approval. A value only the user may give is a `[Verify]` line ("the place
  the seller names"): a value from anywhere else counts only once the user gives it.
- `[Notice]` is shown to the user and blocks nothing.

The provider of the tool writes these, even when the same team builds the agent (spec 4.2). A value's
form — a listing number is `LST-` and four digits — belongs to whoever issues the values.

**Not using MCP?** If your agent and your tools are built together, write the rules in your own
format. A Markdown document is fine, as long as your model can read it. The format is not the
point. The point is that the rules are written down, in one place, by whoever owns them. A rule
that is not written down is either guessed by the model each time or hidden in someone's code.

## 2. Confirm each line once

A sentence cannot be compared as it stands (spec 3.3). The first time the gate meets a line, it asks
a model to put the line into a form code can compare, and stops: the run ends as `definition_repair`
with `formApprovals`, one per line. Each shows three things:

- the line, as you wrote it;
- the proposed form, as JSON — the model's reading of your words;
- what that form checks, in words written by code from the form itself, never by the model.

```
[Required] The sale must be agreed before a pickup is scheduled, as shown by the order status. …
  will be checked like this: holds only when the system measurement order_status is exactly "agreed".
    A measurement that cannot be read leaves it unconfirmed, and the run does not execute.
  form: {"compare":{"source":"measured_data","measure":"order_status","schema":{"const":"agreed"}},"constrains":[]}
```

If both say what you meant, confirm it (`agent.approveForm(request, "you")`, or `y` in `node agent.js`).
The confirmation is kept in your store. You write no file for it. After that, every run compares the
line in that form, with a standard validator, and the model is never asked whether a check passed.

Reword a line and its confirmation no longer applies: it is asked for again. Revoke one and the line
stops runs until it is confirmed again. Every decision record carries each line's version and who
confirmed its form (spec 6.1).

The conditions a user states ("nothing after 8pm") are confirmed the same way, by the user, inside the
conversation: the question shows their words and what will be checked, and asks if that is what they
meant (spec 4.4).

**JSON Schema is this example's choice, not a requirement.** What is required is that the
confirmed form can be compared by code, the same way every time: no model judges at run time
whether a rule held (spec 6.3). JSON Schema works because a standard validator runs it. With your own
deterministic checker, replace `checkAgainst` in `gate.js`. Keep the rest of the gate as it is.

## 3. Connect your system: `connect.js`

| What | In `connect.js` | What you put there |
|---|---|---|
| Model | `ask` | Your chat model, chosen by `MODEL="provider:model"`. Install that provider's package |
| Your system's values | `MEASUREMENTS` | Calls to your own APIs: order status, who owns a listing, contact details. Never from the conversation. The names are what a proposed form may read, and a run reads exactly those the confirmed forms name |
| Who wrote what | `labelInput(message)` | Your input path marks what the user typed. Pasted or quoted text, other people's messages and tool output are untrusted |
| The tool | `callTool(name, args)` | Your MCP client call. Set `MCP_SERVER_URL` |
| Decision records | `store` | Append-only, somewhere the agent cannot rewrite. It also needs `list(key)`, every record under a key, oldest first: the gate reads confirmed forms, what a conversation was asked and how often with it. Without it no answer counts and nothing is confirmed |
| Waiting runs | `checkpointer` | A persistent LangGraph checkpointer, for example Postgres |
| The form the user sees | outside this folder | Your client renders `request`. It has the shape of an MCP elicitation request, but the gate asks it, before any call |

**Keys.** Keys and addresses come from environment variables only. Never write them into these
files.

**Fail-closed.** A measurement you have not connected counts as "not measured". As shipped, nothing
is connected, so the `[Required]` lines are unverified and nothing runs. A line not yet confirmed stops
the run too.

**When the server asks for more input.** Under MCP 2026-07-28 a server may answer a tool call with
`input_required`: it asks the user for something before it completes. The MCP client would normally
answer that itself and retry. Here it is set not to (`autoFulfill: false`). Input gathered that way
would reach the tool without passing the gate, and would not be in the record. The run stops with
status `input_required`, nothing executed, and the server's request is returned to you. If your
tool needs that input, declare it in the input schema, where the gate asks for it and checks it.
The client speaks 2026-07-28 to a server that offers it and the 2025 protocol otherwise. On 2025,
a server that tries to ask gets no answer, and the tool reports an error.

**What a run can end as.** `executed` means the tool completed with the gate's arguments. Anything
else means it did not complete:

- the gate's own reasons: `hold`, `definition_repair`, `exhausted` …;
- the user's: `declined`, `cancelled`;
- the call's: `input_required`, `tool_error` (the tool reported a failure), `call_failed` (the call
  threw). Neither of the last two is retried. Whether the tool did anything is for you to check on
  the tool's side.

## 4. Run

```
npm install
npm install @langchain/anthropic        # or the package for the provider you chose
MODEL=anthropic:<model-name> MCP_SERVER_URL=https://… node agent.js "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae station lockers."
```

The first run shows the lines to confirm (section 2). After that, the run is asked for what is
missing. Here that is the time: "2pm this Saturday" is not a date-time, so the model's reading of it
is shown as the default for you to confirm. The run executes with what you send back.

From your app:

```js
const { createAgent } = require("./agent");
const agent = createAgent();
let r = await agent.start({ threadId, message: { typed, context } });
// r.status === "waiting": show r.request as a form
r = await agent.resume({ threadId, reply: { action: "accept", content } });
```

Use one `threadId` per conversation about one action, and keep it for every round of it. The gate
counts the questions and lookups of that conversation from its records, and an answer counts only for
a question asked in it. A new `threadId` each round shows the gate a conversation that was never asked
anything, so every answer is refused.

## What the code here does not show

Some of the specification is not visible in these files. Keep it in your system anyway.

- **Principles** ([`principles.md`](./principles.md), spec 6.2). Put them in your agent's system
  prompt. The gate catches a violation either way. The prompt makes it rarer.
- **Only the record decides execution** (spec 3.5). Whatever executes reads the decision record
  and nothing else. There must be no path to the tool that does not go through the record. Here,
  `execute` uses only the gate's arguments, but it runs in the same process as the gate.
- **Records the agent cannot rewrite** (spec 8.2). Keep `store` outside the agent's reach.
- **Trust labels are set on arrival** (spec 5.2). Your input path decides what the user typed,
  never the model.

## What the skeleton does that you do not write

- **Each check is its own slot in the record**: each value, its format, the payload, each line, each
  condition the user stated, and an answer refused because nothing asked for it.
- **The user's own conditions** (spec 4.4): taken from what the user typed, checked against their
  words, confirmed by the user. A standing setting the user saved goes in `agent.start({ userChecklist })`.
- **Approvals bound to what they approved** (spec 6.3): a yes counts only for the values it was shown
  with, and for the version of the rule it was given under.
- **Which version of the rules was used** (spec 6.1): every line and condition carries its version, and
  a scheduled run that finds the rules changed does not carry the old approvals.
- **Answers only to questions asked, ceilings counted from the record** (spec 4.5, 4.6).

## Where this is checked

The tests are in [`provider-checklist-example/`](../provider-checklist-example/), so this folder holds only
what you keep. They check:

- this folder holds only these files, and `principles.md` matches spec 6.2;
- what is measured is exactly what the confirmed forms name;
- the provider confirms each line from what the agent shows;
- `connect.js` as shipped fails closed;
- start, wait, resume and execute run end to end;
- on the same 35 inputs, the first decision here equals the reference run.
