# Tests of the adopt example

The checks for [`adopt-example/`](../../adopt-example/), and the trial with a real model
([`trial-real-model.js`](./trial-real-model.js)). The pickup tool is the one in
[`../library/`](../library/) (v1), with every rule moved out of code and into a declaration (v2).

**To use it, see [`adopt-example/`](../../adopt-example/).** That folder holds only the files you keep.
The gate code lives there (`judge-only.js` judges, `middleware.js` runs it in LangChain's `createAgent`). This folder holds the comparison with v1 and every test.
[`tool.json`](./tool.json) stands in
for the tool's declaration (`adopt-example/tool.json`, which the tests check it matches): the gate reads it through its port.

In `../library/` (v1), the hooks hold the rules. `tool.js` keeps the time format, the allowed
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

| | v1 (`../library/`) | v2 (this folder) |
|---|---|---|
| The provider's conditions | `tool.js` `CONDITIONS`, not wired in arm C | Labelled lines in the tool's `description`, in words ([`tool.json`](./tool.json)) |
| How a condition is checked | (not checked) | The form a model wrote from the line's words the first time the gate read it, kept under those words, and shown in every record with what it checks. Nobody approves it |
| Who may give a value | `tool.js` `ALLOWED_SOURCES`, through a hook | A labelled line: `[Required]` for a value only the platform gives, `[Verify]` for one only the seller gives |
| Values settled at execution | `tool.js` `SETTLED_AT_EXECUTION`, through a hook | The `[Verify]` line on the time: the buyer's app request counts, inside the seller's range |
| A value's form | `tool.js` `FIELD_FORMATS` + a regex in a hook | The input schema: `type`, `format: date-time`, `pattern` for the listing number. Every value's form is a check of its own |
| Time words ("2pm this Saturday") | Converted to a date in code (`datetime.js`) | Not converted. They fail the format; a model's reading is shown, and the seller approves it |
| What a user item means | `hooks.js` rules table: `violatesEvening`, `violatesPublicPlace`, `violatesStation` | `compare` on the item, a JSON Schema ([`instructions.json`](./instructions.json)), or the seller's approval where nothing can be compared |
| Who runs a comparison | The example's own code | The library for who gave a value and for approvals; Ajv with ajv-formats for a measured fact or a value's schema. Strict: a keyword it does not know makes the check unverified, not passed |
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
| `[Verify]` The location is the place the seller names, not a place read from the platform. | `location` only from the seller |
| `[Required]` The buyer's contact is read from the platform. | `buyer_contact` only from a measurement |
| `[Notice]` The buyer sees the time and location immediately … | none: a disclosure |

**Reading the lines.** A line that starts with a bracketed word is a condition, and the word is its
label. This is matching, not interpretation. A word the library does not know, such as a typo like
`[Requried]`, is held for definition repair, not dropped as prose. The label starts its line: list, quote and heading
marks, emphasis, escaped or full-width brackets before or around it are layout, not part of the rule. Only
the tool's description is read: a labelled line in an argument's description is prose.

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
and the seller confirms it in the conversation (spec 3.3). Relative
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
npm run check        # installs adopt-example's packages, then test.js, the table, adopt-test.js, judge-only-test.js, middleware-test.js and records-test.js
```

Both arms get the same user turn, the same measurements and the same stand-in model
([`stub.js`](./stub.js)). Any difference between them comes from what was declared. Each
instruction runs in the "said" date mode, in every condition its group runs in (35 runs), once with
each of two extractors. The faithful extractor quotes only what the seller stated as a value. The
over-eager one also quotes the seller's limits.

- **Outcome: g1.** The three `g1` runs change from call to ask. The seller said the time in words.
  v1 converted the words into a date in code. v2 has no converter: the words fail the `date-time`
  format, and the seller is asked. In the agent, a model's reading of the words is shown under the
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
- that the gate's code (`adopt-example/judge-only.js` and `middleware.js`) names no slot, condition or
  item, holds no comparison keyword of its own, and loads nothing but LangChain, LangGraph, zod, the
  library and the validator.

`adopt-test.js` checks `adopt-example/` itself, from here, so that folder holds no test files:

- that it holds only the files an adopter keeps; that its `tool.json` is the tool these tests run;
- that its `connect.js`, as shipped, fails closed: no server, no definition; no measurement, no run;
- that the definition is read from `tool.json` by default, or from the files in `TOOLS_FILE`, run after run; and that the MCP connection kept as comments is still code;
- that start, ask, reply and execute run end to end;
- that the executing step starts from the record: the arguments are the record's, nothing runs when the
  record cannot be read back, and the result is written back;
- that its first decision equals this folder's in all 35 runs.

`judge-only-test.js` checks the structure to adopt (`adopt-example/judge-only.js`, run through
`judge-only-example.js` itself):

- that ask, reply and execute run end to end, with the arguments read from the record;
- that what judging returns carries no arguments and no decision, and that judging executes nothing;
- that a record that is not ready is not executed, for each thing the agent's side reads;
- that a call that does not complete is recorded as failed;
- that its first decision equals this folder's in all 35 runs, and that the agent's side reads every
  decision record the same way the gate decided.

## In createAgent

`middleware-test.js` checks `adopt-example/middleware.js` in LangChain's `createAgent`: the call waits
on `interrupt()` and is not judged twice when it resumes; it runs with the record's arguments, not the
model's; when it is not ready it is not run, and the user is told why; a declined or unanswered
question stays open; and the call's result tells the model what the user was asked and answered.
`records-test.js` checks `adopt-example/records.js`, the records in a LangGraph `BaseStore`.

The validator and LangGraph are installed in `adopt-example/` (pinned: ajv 8.20.0,
ajv-formats 3.0.1, @langchain/langgraph 1.5.2, @langchain/core 1.2.20, zod 4.6.7, langchain 1.5.19,
@langchain/mcp-adapters 2.0.3). The library still has none.

## What a plain agent would have done

A plain agent runs the model's first tool call as it is. The decision records keep that call
(`tool_call.arguments` in the first record) and what each value was settled to, and from where.
[`plain-agent.js`](./plain-agent.js) reads them and says what that call would have been:

- **invalid**: the tool would have refused it (a required value missing or empty, or not in the declared form);
- **wrong**: the tool would have run it, and a condition did not hold, or a value differs from what the gate
  knew or settled (a value read from the user's words, to be confirmed, is not held against it);
- **right**: the tool would have run it, and it is what the gate settled.

Beside it, what the gate did in the same run: ran after asking, ran with no question, or did not run.
So a call a plain agent would have run wrongly, or the tool would have refused, and that the gate ran
after asking is counted too. `trial-real-model.js` prints both as `a plain agent:` and keeps them in the
log (`plain_agent`); `node plain-agent.js <log folder>…` counts a folder of logs, one against the other. The scenarios hold traps on purpose (a
cancelled sale, "the usual spot"), so the counts say what models do when a trap comes, not how often.
`plain-agent-test.js` checks it.

## What this folder does not do yet

- **No API calls in the tests or the table.** The model there is the stub, so they show what the
  declarations change, not how real models behave against them. The forms a model writes for each line
  and condition, its reading of time words, and where a reply says yes come from the stand-in
  (`stub.js`). What the gate does with them is the real library.
- **One run at a time with a real model, and no repeated runs.** [`trial-real-model.js`](./trial-real-model.js)
  runs one instruction through `adopt-example/agent.js` (or `judge-only-example.js`, with `--loop`) with your model (`MODEL`, and the
  key in the environment), or with the stand-in (`--stub`, no key), and prints every model call and the
  last record. Its output is not kept in this folder. The runner, arms A and B and the analyser are
  still only in v1.
- **No real MCP server.** The MCP connection in `adopt-example/connect.js` is kept as comments and is
  checked only for syntax here.
- **Model judgments the gate does not check.** Two remain, as the specification states. Whether to
  run now or later (C1) is the model's classification, taken as returned. Whether this act is this
  tool is the model's judgment, recorded as such (spec 8.1, 8.2); the stand-in always says yes.
- **Verdict and execution in one process.** In `middleware.js` the executing side reads only the
  record, but it still runs in the same process as the gate. Spec 3.5 separates them, and 8.2
  keeps the record where the agent process cannot rewrite it; here the record is in memory.
