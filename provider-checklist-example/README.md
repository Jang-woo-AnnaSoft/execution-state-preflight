# Provider checklist example

The same pickup tool as [`hooks-example/`](../hooks-example/), with every rule moved out of code
and into a declaration. This folder shows what changes when the provider declares its checklist,
and checks it.

**To use it, see [`adopt-example/`](../adopt-example/).** That folder holds only the files you keep.
The gate code lives there (`gate.js`). This folder holds the comparison with v1 and every test.
`hooks.js` and `graph.js` here only load `adopt-example/gate.js`. [`tool.json`](./tool.json) stands in
for what the MCP server serves: the gate reads it through its port, as it would read the server.

In `hooks-example/` (v1), the hooks hold the rules. `tool.js` keeps the time format, the allowed
sources and the provider's conditions as JS constants. `hooks.js` decides what "public place",
"station" and "after 8pm" mean, in a table keyed by item id. To change a rule, someone edits code.

Here (v2), the hooks hold none. Spec 7.2 puts it this way: "changes without a deploy, in a fixed
place, and can be listed". Each rule is a sentence its owner declares, together with how it is
checked (spec 4.2). The check is written as JSON Schema and run by a standard validator. The
developer keeps only the structure that runs it. Nothing in the folder turns words into values
either: there is no date parser.

**Results**

- On the same inputs, five runs out of 35 change outcome, all from call to ask.
  - In three, the seller said a time in words ("2pm this Saturday"). v1 converted the words in
    code. v2 asks: a model reads the words as a moment, code shows it with its weekday, and the
    seller's yes approves it.
  - In two, v1 took the location the buyer proposed through the app. v2 asks the seller, because
    the location is the seller's to name.
- The provider's `[Required]` lines are checked in every v2 run. v1 declared its condition but never
  wired it.
- Nothing executes in v2 that did not execute in v1.

## What is declared where

| | v1 (`hooks-example/`) | v2 (this folder) |
|---|---|---|
| The provider's conditions | `tool.js` `CONDITIONS`, not wired in arm C | Labelled lines in the tool's `description`, in words ([`tool.json`](./tool.json)) |
| How a condition is checked | (not checked) | The form a model wrote from the line's words the first time the gate read it, kept under those words, and shown in every record with what it checks. Nobody approves it |
| Who may give a value | `tool.js` `ALLOWED_SOURCES`, through a hook | A labelled line: `[Required]` for a value only the platform gives, `[Verify]` for one only the seller gives |
| Values settled at execution | `tool.js` `SETTLED_AT_EXECUTION`, through a hook | The `[Verify]` line on the time: the buyer's app request counts, inside the seller's range |
| A value's form | `tool.js` `FIELD_FORMATS` + a regex in a hook | The input schema: `type`, `format: date-time`, `pattern` for the listing number. Every value's form is a check of its own |
| Time words ("2pm this Saturday") | Converted to a date in code (`datetime.js`) | Not converted. They fail the format; a model's reading is shown, and the seller approves it |
| What a user item means | `hooks.js` rules table: `violatesEvening`, `violatesPublicPlace`, `violatesStation` | `compare` on the item, a JSON Schema ([`instructions.json`](./instructions.json)), or the seller's approval where nothing can be compared |
| Who runs a comparison | The example's own code | The skeleton for who gave a value and for approvals; Ajv with ajv-formats for a measured fact or a value's schema. Strict: a keyword it does not know makes the check unverified, not passed |
| What the hooks do | Locate words, decide what the rules mean, convert time words | Locate words, write forms, read a value in its declared form for the seller to approve, read the seller's replies, hand the schemas to the validator |
| Where the definition and the measurements come from | Handed in by the arm | Read by the gate through its ports: the definition once the tool is called, each measurement with the values the gate settled |

`tool.json` is a standard MCP tool definition, and nothing in it is an extension: MCP has no field
for conditions, so they are lines of the description, as spec 4.2.1 proposes, and the input schema
holds only what JSON Schema itself checks.

## The provider's checklist

Seven lines, in words. Each says what the value is, who gives it, or what must hold. None says how to
ask: the model asks, and code holds the answer to what was shown.

| Line | Form (written by the stand-in model, `stub.js`) |
|---|---|
| `[Required]` The sale must be agreed, as shown by the order status … | the measurement `order_status` is exactly `"agreed"` |
| `[Required]` The listing must be the seller's own … | the measurement `listing_owned_by_seller` is exactly `true` |
| `[Verify]` The item is the listing the seller names. | `item_id` only from the seller |
| `[Verify]` The time is the one the seller states, or … a pickup request … inside a range the seller set … | `time` only from the seller, or from a measurement inside the seller's range |
| `[Verify]` The location is the place the seller names. | `location` only from the seller |
| `[Required]` The buyer's contact is read from the platform. | `buyer_contact` only from a measurement |
| `[Notice]` The buyer sees the time and location immediately … | none: a disclosure |

**Reading the lines.** A line that starts with a bracketed word is a condition, and the word is its
label. This is matching, not interpretation. A word the skeleton does not know, such as a typo like
`[Requried]`, is held for definition repair, not dropped as prose.

**How a line is checked.** A sentence cannot be compared as it stands (spec 3.3). The first time the
gate reads a line, a model puts it into a form code can compare. The gate keeps that form under the
line's words and compares the line in it on every run. Nobody approves it: the provider is not there
to, and whoever runs the agent did not write the line. What makes the translation checkable is the
record. Every verdict carries, for each line, the form, the words code wrote from the form, and the
model that wrote it. A reworded line is translated again, under its own key.

The model writes the form. It never says whether the line held: a model's "I checked it" cannot be
told apart from a check that was not made (spec 8.7).

**What is not declared.** The provider declares no condition on what the location must be like. The
tool arranges a meeting, and where to meet is the seller's to name: the `[Verify]` line says only that
the seller gives it.

## The user's checklist

The user's checklist is made from what the seller typed (spec 4.4). Each item in
`instructions.json` carries `compare`, a JSON Schema the slot's value must satisfy: the form the seller
confirmed. When the gate takes a condition from the seller's words itself, the model writes that form
and the seller confirms it in the conversation (spec 3.3); `graph-test.js` runs it that way. Relative
words are resolved in the form: "this Saturday" is already 2026-10-31.

| Item | The seller said | `compare` |
|---|---|---|
| `chk_evening` (g2-01) | "Nothing after 8pm" | `pattern` on the time of day: not after 20:00:00, in the value's own offset |
| `chk_evening` (g2-02) | "I don't do evenings" | the same, kept as v1 had it so group 2 stays comparable |
| `chk_window` (g5) | "this Saturday between 1pm and 6pm" | `format: date-time`, `formatMinimum` 2026-10-31T13:00+09:00, `formatMaximum` 2026-10-31T18:00+09:00 |
| `chk_public`, `chk_not_home`, `chk_station` | "public places only", "I never meet at my place", "at a subway station" | none |

`formatMinimum` and `formatMaximum` compare moments, not text, so a measured time in another offset
is compared correctly. A limit on the time of day with no date has no date-time bounds. Its form
matches the time in the value's text instead. This works, but it is hard to read. The seller's
sentence sits beside it in `stated_as` for that reason.

**Location limits.** The last row has no comparison form. Whether a named place is public, a
station, or the seller's home cannot be read from its name, so these items are unverified and the
seller is asked. They still matter, for two reasons.

- The seller stated them, and the user checklist is built from what the user stated. Leaving them
  out would drop a condition the user gave.
- Their wording keeps a limit from being taken as a value. An extractor that quotes "a subway
  station" as the location is refused, because those words sit inside `chk_station`'s own wording.
  Before these items were restored, this check showed v2 executing a pickup at "a subway station".

## v1 against v2

```
npm run compare      # the table: every instruction, every condition, two stand-in extractors
npm run check        # installs adopt-example's packages, then test.js, the table, graph-test.js and adopt-test.js
```

Both arms get the same user turn, the same measurements and the same stand-in model
([`stub.js`](./stub.js)). Any difference between them comes from what was declared. Each
instruction runs in the "said" date mode, in every condition its group runs in (35 runs), once with
each of two extractors. The faithful extractor quotes only what the seller stated as a value. The
over-eager one also quotes the seller's limits.

- **Outcome: g1.** The three `g1` runs change from call to ask. The seller said the time in words.
  v1 converted the words into a date in code. v2 has no converter: the words fail the `date-time`
  format, and the seller is asked. In the graph, a model's reading of the words is shown under the
  question, written by code with its weekday, and the seller's yes approves it.
- **Outcome: g5.** `g5-01` and `g5-02` under `offer_in_range` change from call to ask. The buyer
  proposed a time and a place through the app. v2 takes the time, because it is inside the window
  the seller set and the time's `[Verify]` line lets a measurement settle it there. It does not take
  the place, because the location's `[Verify]` line counts only what the seller names.
- **Slots.** Under `offer_out_of_range` both versions hold, but v2 leaves the location unknown,
  for the same reason.
- **Provider checklist.** The sale line is `checked` from `order_status`, and the listing line from
  `listing_owned_by_seller`, in all 70 runs. In v1 the sale condition was not compared at all.
- **Over-eager extractor.** No limit wording settles a slot in either version.

`test.js` checks:

- each behaviour above;
- that the outcome changes are exactly these;
- that a schema the validator cannot run leaves the check unverified;
- that the gate's code (`adopt-example/gate.js`) names no slot, condition or item, holds no
  comparison keyword of its own, and loads nothing but LangGraph, the skeleton and the validator.

`adopt-test.js` checks `adopt-example/` itself, from here, so that folder holds no test files:

- that it holds only the files an adopter keeps; that its `tool.md` is the tool these tests run, and that no code there reads it;
- that its `connect.js`, as shipped, fails closed: no server, no definition; no measurement, no run;
- that with `TOOLS_FILE` the definition is read from the declaration file, run after run;
- that start, ask, reply and execute run end to end;
- that its first decision equals this folder's in all 35 runs.

## In a LangGraph graph

The gate runs in a [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/interrupts.md) graph
(`buildGraph` in `adopt-example/gate.js`), without changing the skeleton. It runs as an agent does in
use: the model calls a tool, and the gate stands between that call and the server.

```
START → agent ─ tool call ─→ gate ─ execute ─→ execute → END
          │                    ├─ ask_user ─→ ask_user → wait ─ the seller's reply ─→ agent
          └─ words, no call → END        └─ hold, definition_repair, exhausted, … → END
```

- **The agent's model** reads the conversation and the server's tools, and calls one. What it puts in
  the call's arguments is recorded and never used as a value. If it answers in words, the gate does not
  run and nothing executes.
- **The gate** reads the called tool's definition, settles what it can, measures with the values it
  settled, and judges once. It does not ask, wait or execute.
- **The question.** The model writes it from the gate's list and the provider's lines on each value.
  Code adds, under the model's words, each value as it will be used and the provider's notices. A yes
  approves exactly those values.
- **The reply** is what the seller typed, appended to the conversation as the seller's words. The model
  reads the conversation again and calls the tool: the same tool continues the unit, another tool is
  another unit, and the first one's records stay as they are. The gate keeps a reply only for a question
  it asked, located in the seller's words after it. A value typed in a reply is the seller's words like
  any other, and is checked against its format.
- **Where to stop and resume.** A checkpointer and a `thread_id` hold the conversation while the seller
  answers. The gate's own ceiling turns replies that settle nothing into `exhausted`.
- **The tool is called with the gate's `call_arguments` and nothing else.**

`graph-test.js` checks each of these. It also checks that the graph's first verdict equals the arm's
in all 35 runs. The validator and LangGraph are installed in `adopt-example/` (pinned: ajv 8.20.0,
ajv-formats 3.0.1, @langchain/langgraph 1.5.2, @langchain/core 1.2.20, zod 4.6.7, langchain 1.5.19,
@modelcontextprotocol/client 2.4.0). The skeleton still has none.

## What this folder does not do yet

- **No API runs.** The model is the stub, so this shows what the declarations change, not how real
  models behave against them. The runner, arms A and B and the analyser are still only in v1. They
  move here once the declarations are settled.
- **No real model for the forms, the readings or the replies.** The forms a model writes for each line
  and condition, its reading of time words, and where a reply says yes come from the stand-in
  (`stub.js`). What the gate does with them is the real skeleton.
- **No real MCP server.** `tool.json` stands in for what a server serves; the client's handling of a
  changed tool list is not exercised here.
- **Model judgments the gate does not check.** Two remain, as the specification states. Whether to
  run now or later (C1) is the model's classification, taken as returned. Whether this act is this
  tool is the model's judgment, recorded as such (spec 8.1, 8.2); the stand-in always says yes.
- **Verdict and execution in one process.** In the graph the `execute` node reads only the gate's
  arguments, but it still runs in the same process as the gate. Spec 3.5 separates them, and 8.2
  keeps the record where the agent process cannot rewrite it; here the record is in memory.
