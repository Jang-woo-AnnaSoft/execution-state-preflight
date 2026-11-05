# Provider checklist example

The same pickup tool as [`hooks-example/`](../hooks-example/), with every rule moved out of code
and into a declaration. This folder shows what changes when the provider declares its checklist.

In `hooks-example/` (v1), the hooks hold the rules. `tool.js` keeps the time format, the allowed
sources and the provider's conditions as JS constants. `hooks.js` decides what "public place",
"station" and "after 8pm" mean, in a table keyed by item id. To change a rule, someone edits code.

Here (v2), the hooks hold none. Spec 7.2 puts it this way: "changes without a deploy, in a fixed
place, and can be listed". Each rule is a sentence its owner declares, and the developer keeps only
the structure that compares it.

**Results**

- On the same inputs, two runs out of 35 change outcome. In both, v1 took the location the buyer
  proposed through the app, and v2 asks the seller, because the location is the seller's to name.
- The provider's `[Required]` line is checked in every v2 run. v1 declared it but never wired it.
- Nothing executes in v2 that did not execute in v1.

## What is declared where

| | v1 (`hooks-example/`) | v2 (this folder) |
|---|---|---|
| The provider's conditions | `tool.js` `CONDITIONS`, not wired in arm C | Labelled lines in the tool's `description` ([`tool.json`](./tool.json)) |
| How a condition is compared | (not compared) | [`confirmed.json`](./confirmed.json): each line, word for word, and the form the provider confirmed |
| The time's format | `tool.js` `FIELD_FORMATS` + a regex in a hook | `"format": "date-time"` in the input schema |
| Where a value may come from | `tool.js` `ALLOWED_SOURCES` | `"x-allowed-sources"` in the input schema |
| Values settled at execution | `tool.js` `SETTLED_AT_EXECUTION`, through a hook | `"x-settled-at-execution"` in the input schema, read by the skeleton's own default |
| What a user item means | `hooks.js` rules table: `violatesEvening`, `violatesPublicPlace`, `violatesStation` | `compare` on the item ([`instructions.json`](./instructions.json)) |
| What the hooks do | Locate words, and decide what the rules mean | Locate words, read the declarations, run the comparisons they name |

`tool.json` is a standard MCP tool definition. MCP has no field for conditions, so they are lines of
the description, as spec 4.2.1 proposes. The schema keywords follow the `x-` extension pattern that
MCP itself uses inside input schemas.

## The provider's checklist

```
Schedule an in-person pickup for a marketplace item. Creates a commitment that is immediately
visible to the buyer. Times are in the time zone of the seller's account region.
[Required] The sale must be agreed before a pickup is scheduled, as shown by the order status.
[Notice] The buyer sees the time and location immediately.
```

**Reading the lines.** A line that starts with a bracketed word is a condition, and the word is its
label. This is matching, not interpretation. A word the skeleton does not know, such as a typo like
`[Requried]`, is held for definition repair, not dropped as prose.

**Confirmation.** A line is compared only in the form the provider confirmed. `confirmed.json`
belongs to the adopting system, not to MCP. Spec 3.3 and 4.2.1 put the sentence into a comparable
form at declaration time and have its declarer confirm it, and this file records that. A line that
is not in the file word for word is unverified. If the provider rewords a line, the old
confirmation does not carry over: until the new line is confirmed, a `[Required]` line goes back to
the provider and the run does not execute.

**The two lines here.**

- `[Required]` is compared against the order status, which the platform measures. Spec 3.3 confirms
  a `[Required]` line only from a system source, and the skeleton enforces that.
- `[Notice]` has nothing to compare. It is surfaced as a disclosure.

**What is not declared.** The provider declares no condition on the location. The tool arranges a
meeting, and where to meet is the seller's to name: the schema requires the value and allows only
the seller's sources for it.

## The user's checklist

The user's checklist is made at instruction time, from what the seller typed (spec 4.4). Each item
in `instructions.json` carries `compare`: the form the gate compares the item in. This stands in for
what the seller confirmed at instruction time. In a real system the model would propose the form
and the seller would confirm it.

| Item | The seller said | `compare` |
|---|---|---|
| `chk_evening` (g2-01) | "Nothing after 8pm" | `not_after 20:00` (20:00 itself is inside) |
| `chk_evening` (g2-02) | "I don't do evenings" | `not_after 20:00`, kept as v1 had it so group 2 stays comparable |
| `chk_window` (g5) | "this Saturday between 1pm and 6pm" | `within_window`, placed on the calendar from the stated date and the measured year and zone |
| `chk_public`, `chk_not_home`, `chk_station` | "public places only", "I never meet at my place", "at a subway station" | none |

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
npm run check        # test.js, the table, and graph-test.js (needs npm install)
```

Both arms get the same user turn, the same measurements and the same stand-in model
([`stub.js`](./stub.js)). Any difference between them comes from what was declared. Each
instruction runs in the "said" date mode, in every condition its group runs in (35 runs), once with
each of two extractors. The faithful extractor quotes only what the seller stated as a value. The
over-eager one also quotes the seller's limits.

- **Outcome.** Only `g5-01` and `g5-02` under `offer_in_range` change, from call to ask. The buyer
  proposed a time and a place through the app. v2 takes the time, because it is inside the window
  the seller set and the schema lets a measurement settle it there. It does not take the place,
  because the schema allows only the seller's sources for the location.
- **Slots.** Under `offer_out_of_range` both versions hold, but v2 leaves the location unknown,
  for the same reason.
- **Provider checklist.** `cond_sale_agreed` is `checked` from `order_status` in all 70 runs. In v1
  it was not compared at all.
- **Over-eager extractor.** No limit wording settles a slot in either version.

`test.js` checks:

- each behaviour above;
- that the outcome changes are exactly these;
- that `hooks.js` names no slot, condition or item.

## In a LangGraph graph

[`graph.js`](./graph.js) puts the same gate in a [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/interrupts.md)
graph, without changing the skeleton.

```
START → gate ─ execute ─→ execute → END
          │
          ├─ ask_user ─→ ask ─ accept ─→ gate        (decline / cancel → END)
          └─ hold, definition_repair, exhausted, … → END
```

`runPreflight` does not ask, wait or execute. It takes what has been collected, judges once and
returns the verdict, so the whole of it is the `gate` node. Everything around it is the graph's:

- **When to ask, how, and how often.** The `ask` node pauses with `interrupt()` and resumes with
  `new Command({ resume })`. It asks again when the gate still lists a blank, and the gate's own
  ceiling turns repeated failures into `exhausted`.
- **Where to stop and resume.** A checkpointer and a `thread_id` hold the run while the seller
  answers.
- **The shape of the question.** The request is an MCP elicitation form (`mode`, `message`,
  `requestedSchema`), built from the tool's own field schemas, and the resume value is its reply
  (`action`, `content`).

What stays in the gate:

- **What to ask.** The `ask` node asks for exactly what the gate listed (spec 4.6). A key in the
  reply that was not asked for is dropped, so a reply cannot add an argument.
- **Whether an answer counts.** Answers enter the next round as `userAnswers` and are looked up as
  `user_answer`. The graph never marks a slot settled. A reply that fails the schema's `date-time`
  format is asked for again.
- **A model's proposal is a default, not a value.** A value the model proposed is shown as the
  field's `default`. Only what comes back in `content` counts, so the value executed is the value
  the seller saw and sent, and an edited value is executed as edited.
- **An item only the seller can confirm** (the location limits) becomes a yes/no field. A yes
  settles it with the seller as the source, a no holds the run. A yes never overrules an item that
  has a comparison form.
- **The tool is called with the gate's `call_arguments` and nothing else.**

`graph-test.js` checks each of these. It also checks that the graph's first verdict equals the
arm's in all 35 runs. LangGraph is a dependency of this folder only, and the skeleton still has
none:

```
npm install          # @langchain/langgraph 1.5.2, @langchain/core 1.2.20, zod 4.6.7 (pinned)
node graph-test.js
```

## What this folder does not do yet

- **No API runs.** The model is the stub, so this shows what the declarations change, not how real
  models behave against them. The runner, arms A and B and the analyser are still only in v1. They
  move here once the declarations are settled.
- **Only the comparisons that exist here.** The hooks know `not_after`, `within_window` and
  `equals` on a measurement. A comparison a declaration names and the hooks do not know is
  unverified, never passed.
- **No real confirmation step.** `confirmed.json` and the `compare` forms are written by hand. They
  stand in for the step where a declarer confirms the comparable form (spec 3.3).
- **Verdict and execution in one process.** In the graph the `execute` node reads only the gate's
  arguments, but it still runs in the same process as the gate. Spec 3.5 separates them, and 8.2
  keeps the record where the agent process cannot rewrite it; here the record is in memory.
