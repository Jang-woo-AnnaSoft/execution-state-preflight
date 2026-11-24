# adopt-example

The files you keep in your own system, when you build the agent and its tools together. You declare
the tools, connect your model, your tools and your system's data, and the gate decides whether each
tool call has everything it needs before it runs.

**Both ways in judge with `judge-only.js`.** The gate judges and writes the record, and the tool runs
from that record. Start with LangChain's `createAgent`: `middleware.js` does this for you. With a loop
of your own, `judge-only-example.js` shows how. Only the second keeps the executing party outside the
agent's graph, as the specification describes (spec 3.5).

There are two ways in. What you write (`tool.json`) and what you connect (`connect.js`) are the same in
both.

| | LangChain `createAgent` (recommended) | Your own loop |
|---|---|---|
| For | An agent built on `createAgent`, existing or new | An agent with a loop of its own |
| Start from | [`middleware.js`](./middleware.js), as `agent.js` uses it | [`judge-only-example.js`](./judge-only-example.js) |
| Who runs the flow (ask, wait, call again) | `createAgent`; the call waits on `interrupt()` | Your agent's own loop |
| Who executes the tool | The middleware, after reading the record | Your agent, after reading the record |
| The gate and the executing side | Two parties: the gate ends with the record, and the middleware reads it | Two parties: the gate ends with the record, and your loop reads it |
| What you must keep yourself | The labels on the user's messages, a checkpointer, `connect.notify` | Eight things, listed in [section 4](#4-use-it-your-agent-executes-judge-onlyjs) |

`agent.js` is the first way as a whole agent to run and watch. Sections 1 to 3 are for both. Section 4
is your own loop, and how the middleware does the same. Section 5 is the demonstration.

**To watch a whole run first, with stand-in models and no API key:**

```
npm install
cd ../tests/adopt
node trial-real-model.js --stub --id g1-01 --reply yes
```

It has the measurements and the tool connected, which this folder as shipped does not (section 3).
The gate asks about the time, the stand-in user answers yes, and the tool runs.

| File | What you do |
|---|---|
| [`tool.json`](./tool.json) | **Write.** Your declaration of the tool, as an MCP tool definition: name, rules in words, input schema |
| [`connect.js`](./connect.js) | **Fill in.** Your model, your tools, your system's values, your storage |
| [`principles-gated.md`](./principles-gated.md) | Goes into your agent's system prompt (both flows put it there). What the model needs to know when a gate judges its calls (spec 6.2, last paragraph) |
| [`principles.md`](./principles.md) | The specification's 6.2 as prompt sentences, for a model with no gate (`systemPrompt("principles.md")`) |
| [`judge-only.js`](./judge-only.js) | Do not edit. Gives the library its model calls and a validator; judges one tool call and writes the record |
| [`judge-only-example.js`](./judge-only-example.js) | Read and adapt. Your agent's side: ask, judge again, read the record, execute, write the result |
| [`middleware.js`](./middleware.js) | Do not edit. The same agent's side, as LangChain middleware for `createAgent` |
| [`records.js`](./records.js) | Do not edit. The decision records in a LangGraph `BaseStore` (`connect.js` picks which one) |
| [`agent.js`](./agent.js) | Demonstration. `createAgent` with `middleware.js`. Run it, or call it from your app. No edits needed |

You also need the library, [`execution-state-preflight.js`](../execution-state-preflight.js): one
file, no dependencies. Copy it next to this folder or into it.

## 1. Declare the tool: `tool.json`

You build the tool, so you are its provider (spec 4.2), and you write its rules. They go in the
tool's definition, which the agent's model and the gate both read from `tool.json`, on every run. The
gate reads it itself, once the model has called the tool.

`tool.json` is an MCP tool definition: `name`, `description` and `inputSchema`, as a provider
registers a tool on an MCP server. The same file serves if you move the tool to a server later. In
the agent it becomes a LangChain tool in one line, `tool(fn, { name, description, schema: inputSchema })`
(`agent.js`). In the JSON, the description is one string; its lines are separated by `\n`. The tests
run this same tool, from [`tests/adopt/tool.json`](../tests/adopt/tool.json),
and check that the two are the same.

Two places, and nothing else:

- **The description, in words.** What the tool does, and then each rule on a line of its own,
  starting with a label. Write each line so it can be judged: what is checked, where it is read
  from, and what passes, as a condition in code would need (spec 4.2.1). A line need not say how to ask:
  the model asks, and code holds the answer to what was shown. Say once, in a line without a label,
  that the labelled lines are checked after the call and before it runs: a model that does not know
  the labels reads them as conditions to meet before it calls, and then does not call (spec 4.2.1).
- **The input schema, forms only.** Each value's `type`, and its `format` or `pattern` where it has
  one, and which values are required.

```
Schedule an in-person pickup for a marketplace item. The buyer sees it at once. Times are in the time zone of the seller's account region.
This tool's labelled lines are checked after it is called and before it runs: [Required] by the platform from its own data, [Verify] with the user, and [Notice] is told to the user. Call it with what the user said; what is missing is asked or checked then.
[Required] The sale must be agreed, as shown by the order status. Only the status "agreed" means agreed.
[Required] The listing must be the seller's own, as shown by the listing's owner on the platform.
[Verify] The item is the listing the seller names.
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

A label starts its line, in the tool's description. A list marker, a quote or heading mark, or emphasis
before it changes nothing. A labelled line anywhere else, such as an argument's description, is prose.

Build the tool itself from the same declaration, and connect it in `connect.js` (`TOOLS`). Changing a
rule is changing its line: there is no code to change and nothing to redeploy on the agent's side.

The lines name what your system must be able to read. In `connect.js`, `MEASUREMENTS` connects them,
each read for the listing the gate settled:

| Line | Measurement |
|---|---|
| The sale must be agreed | `order_status` |
| The listing must be the seller's own | `listing_owned_by_seller` |
| The time … a pickup request the buyer sent in the app | `time` |
| The buyer's contact is read from the platform | `buyer_contact` |

Until they are connected, the `[Required]` lines are unverified and nothing runs.

**Several tools?** One file each, listed in `TOOLS_FILE`, separated by commas.

**A tool on someone else's MCP server?** Its provider writes the rules in the tool's description on
the server. `connect.js` keeps the MCP connection as comments: uncomment it and the gate reads the
definition from the server's list. A `[Required]` line can be checked only if your system can
measure what it names, which is often data on the provider's side.

**A rule from alignment or governance?** Those stay as they are, and each decides its own rules in its
own layer. To apply one to a tool at execution, write it in that tool's description as a line. A rule
for one user goes in that user's checklist; a rule for every tool goes in the principles the model is
given, and, where it needs checking, in the provider checklist of each tool it concerns (spec 7.2).

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
| Model | `ask`, `say`, `chat` | Your chat model, chosen by `MODEL="provider:model"`. Install that provider's package. `ask` answers the gate in the shape it asks for (LangChain's `withStructuredOutput`), `say` writes the words of a question in plain text. With Anthropic, through its structured outputs (`method: "jsonSchema"`), as Anthropic recommends: Claude Opus 5.5 and Sonnet 5.5 refuse a forced tool call. Those take at most 24 optional keys in a request, and reading a tool's fields uses two per field: a tool with more than 12 input fields does not run there |
| The tools' definitions | `listTools`, `readToolDefinition` | Nothing: they read `tool.json` (or the files in `TOOLS_FILE`). For an MCP server, uncomment the MCP connection |
| Your system's values | `MEASUREMENTS` | Calls to your own APIs. The gate calls one when it needs it, with the values it has settled (`values.item_id`). Never from the conversation |
| Who wrote what | `labelInput(message)` | Your input path marks what the user typed. Pasted or quoted text, other people's messages and tool output are untrusted |
| The provider's notices | `notify(lines)` | How your app shows a `[Notice]` line to the user before the tool runs, when no question carried it. As shipped it prints them. With no `notify`, a run that has a notice to show and nothing to show it with does not execute |
| The tool call | `TOOLS` | Your tool, by name: it takes the arguments in the gate's record and does the thing. For an MCP server, the commented `mcpCallTool` |
| The user's settings | `readPreSet(userId, toolName)` | Optional. What the user saved for this tool, read from your own storage. As shipped it returns none |
| Records | `store` | Append-only, somewhere the agent cannot rewrite. A LangGraph `BaseStore` through `records.js`: `InMemoryStore` as shipped, kept only while the process runs. To keep records longer, change that one line in `connect.js` to a persistent store such as `PostgresStore` |
| Waiting conversations | `checkpointer` | A persistent LangGraph checkpointer, for example Postgres |

**Who wrote what.** The user's words reach the gate as `instruction`, an array of trust-labelled
segments, not a string. Pass a string and the `instruction` source closes; nothing is confirmed from
it. Untrusted text — a forwarded email, a tool result, a web page, or text pasted into the user's own
message — cannot settle a value on its own. To use something from it, the gate asks the user and takes
the answer back as `user_answer`. The labels are set by your input path when the message arrives, not
by the model (spec 5.2).

**Keys.** Keys and addresses come from environment variables only. Never write them into these
files. The provider's package reads its own key: `ANTHROPIC_API_KEY` for `@langchain/anthropic`,
`OPENAI_API_KEY` for `@langchain/openai`.

**Model settings.** `MODEL_OPTIONS` takes a JSON object and gives it to the provider's package as it
is. Some OpenAI models call tools only through the Responses API: `MODEL_OPTIONS='{"useResponsesApi":true}'`.

**Fail-closed.** As shipped, the tool is declared but nothing is connected: no measurement, so the
`[Required]` lines are unverified, and no tool to call. Nothing runs: the example asks nothing and ends
by saying it did not run and which lines could not be checked. That is the expected first result.
Fill in `MEASUREMENTS` and `TOOLS` and it asks and executes.

**When an MCP server asks for more input.** Under MCP 2026-07-28 a server may answer a tool call with
`input_required`. The commented MCP connection is LangChain's (`@langchain/mcp-adapters`), set not to
gather that input itself (`elicitation: false`; by default it would, with an interrupt): input gathered
that way would reach the tool without passing the gate. The server cannot ask, the call ends as
failed (`call_failed`), and nothing is executed. The server's request itself does not come back.

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
  // readyToExecute, notify and callTool are yours: judge-only-example.js has one of each
  const record = (await storage.list(r.key)).at(-1);       // the record this round wrote
  if (readyToExecute(record, toolCall.name)) {              // your own reading of it
    const { toShow } = await judge.notices(record);         // the provider's notices not shown with a question
    if (toShow.length) await notify(toShow.map(d => d.description));   // told before the tool runs
    const result = await callTool(record.tool_call.name, record.call_arguments);
    await judge.recordResult(record, { ok: true });
  } else {
    await judge.recordResult(record, { executed: false, why: "not ready" });   // your decision, recorded too
  }
}
```

[`judge-only-example.js`](./judge-only-example.js) is the whole of it. To run it:

```
npm install
npm install --no-save @langchain/anthropic@1.5.13   # or your provider's package, in a version that takes @langchain/core 1.2.20
export ANTHROPIC_API_KEY=...                        # the provider's package reads its key from the environment
MODEL=anthropic:<model-name> node judge-only-example.js "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae station lockers."
```

`judge-only.js` needs only the library and the validator (Ajv). It does not load LangGraph. The validator reads a tool's input schema as MCP does: JSON Schema 2020-12
when it names no `$schema`, draft-07 when it says so, and no other. `format: "date-time"` is RFC
3339's, with its offset: the value carries its own time standard.

**Eight things are yours to keep.** Nothing checks them for you, and
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
5. **Keep the record where the agent cannot rewrite it** (spec 8.2), **and write your own decision
   back** with `judge.recordResult`, as a record of its own (spec 6.4): executed, failed, or read and
   not run. Only an executed record is what a later run may carry values from.
6. **Tell your model how its calls are judged, and what happened to each.** Give it
   `principles-gated.md` as its system prompt, and keep the line in the description that says when
   the labelled lines are checked (section 1). A model that does not know the labels reads them as
   conditions to meet before calling: with a real model and the lines alone, it did not call, and
   asked the user for a fact only the system could check; with both, it called at once and left the
   asking to the gate. Show the gate's answer, a question, a stop or a run, as the result of the
   model's call (`messagesFor`, `afterCall` in `judge-only.js`), with `r.settled` when it asks: the
   values the gate already holds that the call does not carry as they are, so the model does not ask
   for them itself: a real model shown the gate's reason
   as its own words took it back, on the next turn, as made up. Where you hand the model its tool
   list yourself you may also take the labelled lines out (`judge.toolsForModel`); a host that lists
   a server's tools itself shows the whole description. The gate reads the full definition either way.
7. **Show the provider's notices before the tool runs** (spec 3.3). They go with every question. When
   a run asks nothing, `judge.notices(record)` gives the ones not yet shown: show them (`notify`), then
   call the tool, and `recordResult` records which were told. A run that has a notice to show and no
   way to show it does not execute.
8. **Put each call through the gate on its own, and judge the waiting calls again when the user
   answers.** A model may make several calls in one message: each is judged, run and answered on its
   own (spec 1.1), and every question that waits is shown. The user's answer goes to the calls that wait,
   as they were made, without asking the model first: a model may take the answer as the end of it and
   tell the user it was done. With several waiting, a form's answers go by call (`{ [tool_call_id]:
   fields }`); a call whose form is declined ends without running. This is how the middleware does it
   (section 5).

**When nothing runs, tell the user why.** `writeStop` (in `judge-only.js`) hands your model the
library's `stopFacts` for the record: the condition in its own words, whose it is, what was found.
Your model writes the message from those alone; without its words there is still a plain sentence.
The example shows it, and gives it to the model as its call's result. Without this, a hold ends with
nothing said: a real run held on a `[Required]` line did.

**Settings and the last execution** (spec 5.2). Give `createJudge` a `readPreSet(userId, toolName)`
(`connect.js` has a starting point) and the gate reads the user's settings for the tool: `trust:
"user"` with `approved_by`, `approved_at` and `approved_in` is a setting, recorded with them; any other
trust, a value a model remembered, is shown to the user and counts only once approved. When a call
executes, `recordResult` keeps the record for this user and tool, and the next run offers its values
when nothing else gives them ("same place as last time"), again only once approved. When the user's
words give a field one value and a stored setting holds another, both are shown and the user chooses.
How settings come to be stored is yours.

**With LangChain's `createAgent`.** [`middleware.js`](./middleware.js) does the agent's side for you,
in the shape of LangChain's own human-in-the-loop middleware (`per_call`):

```js
const { preflightMiddleware } = require("./middleware");
const agent = createAgent({ model, tools, checkpointer: new MemorySaver(), middleware: [preflightMiddleware()] });
// the call waits: interrupt value { type: "preflight_question", message, block, questions, notices },
//   with responseSchema = answerSchema(questions)
await agent.invoke(new Command({ resume: { "value:time": true } }), config);   // or { typed: "yes" }
```

Each tool call is judged where it is made. When the user has to answer, the call waits on
`interrupt()` and is judged again with the answer, so the model does not have to call again. The tool
runs with the record's arguments. A declined or cancelled answer runs nothing and leaves the question
open. A `HumanMessage` is the user's, another tool's result is not; label someone else's words inside a
`HumanMessage` yourself (`labelMessage`).

**Try it without blocking.** Because judging only records, you can call `judge.run` beside your
agent as it is and read the records, before anything depends on them. Most first records will ask:
whether a run reaches execution shows only once the asking is wired in. Each round calls the model.

## 5. The demonstration: a whole agent (`agent.js`)

The same gate in LangChain's `createAgent`, with `middleware.js`. The middleware does the flow's part
of section 4 itself: it shows the values unchanged, judges again with the answer, executes from the
record and writes the result back. The agent gives its model the tools without the labelled lines,
and the user is told why when nothing runs.

**The gate and the executing side are apart, as spec 3.5 has them.** The gate ends with the record, and
the middleware's own code reads the record and decides from it alone, never from what judging returned.
That code runs in the agent's graph, where an executing party usually is. Other code there (another
middleware, the tool node) could still call a tool without reading the record; nothing but review keeps
it from doing so (spec 8.6), here as in any loop.

```
MODEL=anthropic:<model-name> node agent.js "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae station lockers."
```

With `MEASUREMENTS` and `TOOLS` connected (as shipped, the run stops first: section 3), the model
calls the tool. The gate reads the tool's definition from `tool.json` and judges. Here the
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
// or from a form: answerSchema(r.question.questions), then agent.reply({ threadId, answers })
```

Use one `threadId` per conversation, for every turn of it. The gate reads what it asked in that
conversation from its records, and a reply counts only for a question asked there, in the user's
words after it. If the model calls another tool, that is another unit: the first one's records stay
as they are. One tool is one unit in a conversation: a second call of the same tool after it ran is a
new request, and is asked again.

**Several calls in one message.** Each is judged on its own. `r.waiting` has every call that waits,
with its question, and `r.question.message` shows them all; a form's answers then go by call
(`agent.reply({ threadId, answers: { [tool_call_id]: fields } })`). `r.results` has how each call
ended; with several, `r.status` is `several`.

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
- **A notice is shown, not acknowledged.** The provider's `[Notice]` lines go with every question. When
  a run asks nothing, the executing side shows them before it calls the tool (`notify` in `connect.js`,
  spec 3.3), and its record says which were told and when (`told`). Nothing waits for the user to
  acknowledge one; if your tool needs that, ask for it before the call. With no `notify` connected, a
  run that has a notice to show and no question to show it with does not execute.

## What the library does that you do not write

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

## Calling the library directly

`judge-only.js` gives the library its hooks and storage. Without it, you give them yourself. The hook
contracts and the record shape are in the library's source comments.

```js
const { createPreflight } = require("../execution-state-preflight");

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

## Where this is checked

The tests are in [`tests/adopt/`](../tests/adopt/), so this folder holds
only what you keep. They check:

- this folder holds only these files, `principles.md` matches spec 6.2, and each line of
  `principles-gated.md` names spec sections that exist and is in the system prompt by default;
- the tool is read from `tool.json` by default, and `connect.js` as shipped fails closed;
- the MCP connection kept as comments is still code once uncommented;
- the model calls the tool, the gate asks, the user replies in words, and the tool runs;
- judging returns no arguments and no decision, and executes nothing; the agent's side executes from
  the record, and reads every decision record the same way the gate decided;
- in the demonstration (`agent.js` on `createAgent`), the same scenarios as before reach the same first
  decision, execute from the record and write the result back;
- as middleware in `createAgent`, the call waits on `interrupt()`, is not judged twice on resume, runs
  with the record's arguments, runs nothing when the answer is declined, and its result tells the model
  what the user was asked and answered;
- on the same 35 inputs, the first decision here equals the reference run.

## For safety, consider these

The library judges and records. What surrounds it is your system's, and some of it decides whether
the gate can be relied on. Besides what is above (the boundary between the gate and the executing
party, records the agent cannot rewrite, trust labels set on arrival), decide these:

- **Which tools go through the gate.** It weighs no tool's risk. Put every call that is hard to undo
  through it (spec 1.1); a call left out runs unchecked.
- **Two runs of one request at the same time.** They are not kept apart. Lock per conversation and
  tool, or both can run.
- **Retrying a failed call.** The gate records the failure and does not retry. A retry is a new call:
  send it through the gate again.
- **A call deferred for later.** It is recorded with what to run it on (`deferred_input`). When it is
  due, call the gate again with that input; do not execute from the earlier record.
- **What is stored.** Values are recorded as given. Mask what must not be kept or shown, in the store.
- **Saved settings.** How a value is kept for next time, and how the user agrees to it, is yours. A
  value counts as a setting only when the store says the user approved it, and who, when and where.
  Take a one-use setting out of the store once a record shows it was used (spec 3.5, 5.2).
- **Nested arguments.** A value nested inside an argument is not a slot of its own: its source is
  checked only with the argument it sits in. Keep what must be checked at the top of the input schema.
