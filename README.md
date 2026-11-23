# execution-state-preflight

**When an agent causes an incident, whose judgment was it?**

Today this is usually hard to answer.

---

## Why there is no answer today

Before an agent calls a tool, the model judges all of this at once:

- what the user asked for
- whether to run it now or later
- whether this tool is the one that does it
- where each value comes from
- what to check and what to skip
- whether it may run

What is left on the execution side is the final tool call. A misreading, a made-up value and a skipped check all come out in the same shape: "a wrong call".

So after an incident, only explanations like these are left: "The model misjudged." "The guardrails were not designed well enough." Neither says *what* was not declared, or *who* should have declared it. That information is usually not recorded.

How far the model may judge was never set, so there is no line from which to say where it went wrong.

## One case

In the reported Meta Muse case, with "Allow Always" on, Muse agreed in the seller's name to the buyer's proposed 8 to 10 p.m., and the buyer came to the seller's building while the seller was out ([case report](./case-muse-marketplace.en.md)).

The permission was there, the format was right, no policy was broken. One thing was missing: the seller had not set that time.

Such incidents are often classed as "the model misjudged". The precise question is this: **whose part was it to set the time?**

Everyday requests leave blanks the same way. "Send this to the team lead tomorrow morning" does not say which team lead, or what time; when the model guesses wrong, it is called the user's vague instruction. Which blanks belong to whom is in [the essay's appendix](./model-reasons-agent-executes.en.md#blanks-that-are-called-user-error).

Agents often do not stop when refused. They ask again in other words, or take another route to the same result ([examples](./model-reasons-agent-executes.en.md#a-block-taken-as-a-problem-to-solve)).

## What this is

A part of the harness, the code around the model that limits what an agent executes. What it proposes is a different scope, different owners of the rules, and a different way to write them.

| | A harness today (usually) | This repository |
|---|---|---|
| What is checked | What the agent can do: tools, data access, formats; lately also conditions written as code (approval steps, policy hooks) | This call's intent, each value (per slot) and each condition (per line) |
| Who writes the rules | Usually the developers or the platform team building the agent | Split and declared: the tool provider (the tool's conditions), the user (limits, preferences), the adopting system (common rules) |
| How the rules are written | Code, configuration, policy files | Sentences: the provider's labelled lines in the tool's description, the user's own words, the adopting system's principles |

What is checked widens from the form of values and conditions to where each value came from, the conditions and the intent. Each part of the responsibility gets a name, and rules are no longer written as code one by one.

Nothing unknown is filled in: it runs only with values found in the user's words or the system's data, or settled by asking. Failures and blocks are recorded, not hidden. A tool declared to go through the gate does not run without a verdict.

**The goal is a confirmed execution; blocking is how it gets there.**

## What this repository does

It splits the judgments the model was carrying implicitly into items, and gives each item an owner.

| Judgment | Owner |
|---|---|
| What the request is, and when it runs | What the user said in this request |
| Whether this tool does it | The tool provider's declaration (what the tool does). Whether it fits the request is the model's judgment, recorded as such and not proven by code |
| Where each value came from | A declared source: the user's words and answers, settings the user approved, system measurements |
| Under which conditions it must not run | The provider's declared conditions, the user's limits, the adopting system's common rules |
| Whether everything is confirmed | Code that counts the unconfirmed items |
| Whether it may run | The executing party, reading the record |

The model is left to translate conditions into a form that can be compared, find places in the original text, write the words that ask the user, and judge whether the tool fits the request; that judgment is recorded as a judgment. Counting the unconfirmed items and deciding whether it runs is done by code.

## Where the gaps show

This repository does not claim to judge everything on anyone's behalf. What it does is **ask "whose judgment is this?" and make the slots with no owner visible.**

An unconfirmed item does not run, and where it goes is settled: to the user if the user can answer it, to the system if the system can look it up, and to whoever declares it if nobody has.

Below is a real decision record from the example tool (scheduling a pickup), shortened. The seller said "2pm this Saturday". The gate found where those words are, but they are not in the date-time form the tool requires, so it does not settle the time: it asks the seller.

```json
{
  "fields": [
    { "name": "item_id", "value": "LST-2291", "status": "known", "source": "instruction",
      "located_at": { "segment_index": 3, "span": [46, 54] } },
    { "name": "time", "value": null, "status": "unknown", "source": null,
      "located_at": { "segment_index": 3, "span": [58, 75] } },
    { "name": "buyer_contact", "value": "in-app chat (@kim_2291)", "status": "known", "source": "measured_data" }
  ],
  "unknown_count": 1,
  "execution_decision": "ask_user"
}
```

After an incident the question changes. Not "why did it put in this value?" but **"from which source was this slot of the record settled, or was it empty?"**

## How it works

- **Every verdict is recorded.** Each value's source, the conditions confirmed, and what was blocked or did not run. What is kept is not the inside of the model but the record of the verdict.
- **If someone's part was missing, write it then and there, as a sentence.** One labelled line in the tool's description is enough; no agent code to change or redeploy. From then on, code checks that line on every execution.

```text
[Required] The sale must be agreed, as shown by the order status.
[Verify] The time is the one the seller states. It is one moment.
[Notice] The buyer sees the time and location immediately.
```

### Before you write one

For "write it, and it is checked" to hold:

- **It needs a label.** A line without one is a sentence the model reads; the gate does not check it.
- **For a `[Required]` line, the system must be able to measure what it names.** Until that measurement is connected, the line stays unverified and **nothing runs.** This is intended: what cannot be checked does not pass.
- **The line must be translated into a form that can be compared.** A new or changed line is translated once, by the model, into a form code can compare, and code compares only in that form. A line that cannot be translated stays unconfirmed, and the run stops.
- **A line translated wrongly is checked as translated.** A kept translation is used as it is until someone reads it.
- **A changed line is translated again, and approvals given before the change are not used in the next verdict.**
- **What is checked is what is declared.** A condition written on no line is not checked. Writing that line is someone's part.

## What it does not promise

- It does not claim to prevent every incident. What it stops is limited to what is declared.
- A condition not declared, declared wrongly or translated wrongly passes. What becomes clear instead is *who did not declare what*.
- Choosing the wrong tool is a risk for every agent. This narrows it, by comparing the tool with what the user called the action and when they asked, but code cannot prove the choice (spec 8.1).
- It does not replace access control, injection defense, or a person's final confirmation.

It puts what the model was doing back under people's responsibility. Whether someone will actually hold that responsibility is for the adopting organization to decide.

---

## Three rules

- Every value and condition entering an execution is **checked against a declared source.** Not being prohibited is not a ground for execution.
- **Where it came from is written into the record.** The source and the place in the original text are kept, so anyone other than the gate can check them again. Blocked executions and checks that did not run are recorded too.
- What cannot be confirmed is not made up by the model; it **comes back as a blank to whoever can fill it.** What the user can answer goes to the user, what the system can look up goes to the system, and what was never declared goes to whoever declares it.

The rules are declared by whoever holds the knowledge, not by one team for everything as before. The provider declares the tool's conditions, the user declares limits and preferences, and the adopting system declares the rules common to every execution.

**Rules left in a prompt are forgotten as the conversation grows, and gone when the conversation changes.** So these rules live in a checklist outside the model, and code does the counting.

Security research asks where values come from as well. [CaMeL](https://arxiv.org/abs/2503.18813), [FIDES](https://arxiv.org/abs/2505.23643), [PACT](https://arxiv.org/abs/2605.11039) and [ROPE](https://arxiv.org/abs/2608.27496) track the origin of each argument and keep untrusted data out of sensitive arguments; some, like ROPE, go as far as requiring a confirmed origin. What differs here is that no attack is assumed. Without any attack, the model still fills in what is missing.

---

## The three checklists

The rules an execution needs, split by who declares them. This split is the core of the design (spec §4). The fixed checklist settles the intent, the provider's the values and conditions, and the user's the range of those values and conditions. Every item in all three is checked and recorded as its own slot.

**Fixed** — which tool, and when it runs. Tool-independent, applied the same way to every execution. It settles the execution unit. Today it is not recorded, and a misreading leads to a bypass.

**Provider** — per tool. Values sit in the MCP input schema or inside the agent. Conditions have to be declared separately. Today they vary from agent to agent, and an MCP server's conditions are not applied before execution.

**User** — intent, limits, preferences. Changes with the user's environment rather than the tool, and differs from user to user. Today all of it is left to the model's judgment.

## Writing the provider's checklist

Each condition goes on a labelled line of its own in the tool's description; the forms of the values go in the input schema. Three lines from [`adopt-example/tool.json`](./adopt-example/tool.json):

```text
[Required] The sale must be agreed, as shown by the order status.
[Verify] The time is the one the seller states. It is one moment.
[Notice] The buyer sees the time and location immediately.
```

`[Required]` is confirmed only from the system's own data, `[Verify]` only by the user, and `[Notice]` is told to the user and blocks nothing. How to write them is in [adopt example, section 1](./adopt-example/README.md#1-declare-the-tool-tooljson).

## Who does what

| | Does |
|---|---|
| Developer, tool provider | Writes **what** is checked, in the checklist |
| Model | Translates the lines into a comparable form, asks the user, finds the answers in the user's words, and tells the user why it stopped |
| System | Reads the facts from real APIs; code decides pass or fail and records it |

From outside, a model's "I checked" cannot be told apart from a real check. So the model translates, asks, finds and tells, and code decides.

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

A search order, not a ranking by trustworthiness. Text the user did not write cannot settle a value on its own; how the user's words are labelled is in [adopt example, section 3](./adopt-example/README.md#3-connect-your-system-connectjs).

**You do not have to run all of it. Apply it only to irreversible executions, and only the parts that fit (spec 1.2).**

---

## Where to read what

This file is the overview. **The specification is the standard; the adopt example is how it is applied.** The rest shows why each part is there. Each thing below is explained where it lives, not here.

| | |
|---|---|
| **The standard** | |
| [**The specification**](./spec.en.md) · [ko](./spec.ko.md) | What counts as confirmed, who judges, what is recorded. The problems this works through are §2; the three checklists are §4; the slot states and sources are §5 |
| **Applying it** | |
| [**Adopt example**](./adopt-example/) | **Start here.** The files you keep to use this, when you build the agent and its tools together: your declaration of each tool (the rules in words), the connections to your own model, tools and data, and the gate as LangChain `createAgent` middleware (`middleware.js`). The gate judges and records (`judge-only.js`), and the tool runs from the record. A whole agent to run is there (`agent.js`), the same for an agent with a loop of its own (`judge-only-example.js`), and the MCP server connection as comments |
| **The library** ([`execution-state-preflight.js`](./execution-state-preflight.js)) | What the adopt example runs: one file, no dependencies. Hook contracts, the record shape, and where it departs from the specification are in the source comments, beside the code they describe. **Pre-release:** being tested against real models; the API may still change |
| **Checking it** | |
| [**Tests**](./tests/) | The library's tests and the adopt example's, with stand-in models (`npm run check`); one run with a real model; the harness and raw results of the case report's repeated runs |
| **Why each part is there** | |
| [**The argument, in short**](./model-reasons-agent-executes.en.md) | Why what the model makes up must not reach execution, the two methods, and how this differs from current practice. An essay, not a guide |
| [**A case report**](./case-muse-marketplace.en.md) | A reported incident mapped onto the checklists |

---

## Quick start

Start from [`adopt-example/`](./adopt-example/), with the library next to it.

1. **Declare the tool** in [`tool.json`](./adopt-example/tool.json), an MCP tool definition: what it does, each rule on a labelled line, and the input schema.
2. **Connect** your model, your tool and your system's data in [`connect.js`](./adopt-example/connect.js).
3. **Put the gate in your agent** as LangChain `createAgent` middleware. Each tool call is judged before it runs; when the user has to answer, the call waits on `interrupt()`, and the tool runs with the record's arguments:

```js
const { createAgent } = require("langchain");
const { MemorySaver, Command } = require("@langchain/langgraph");
const { preflightMiddleware, humanMessage } = require("./middleware");
const connect = require("./connect");

const agent = createAgent({ model, tools, checkpointer: new MemorySaver(), middleware: [preflightMiddleware({ connect })] });
const config = { configurable: { thread_id: "conversation-1" } };    // one per conversation

let state = await agent.invoke({ messages: [humanMessage(connect.labelInput({ typed }))] }, config);
const asked = state.__interrupt__?.[0]?.value;                        // { type: "preflight_question", message, block, questions, notices }
if (asked) {
  // show asked.message exactly as it is, or render answerSchema(asked.questions) as a form
  state = await agent.invoke(new Command({ resume: { typed: "yes" } }), config);   // or the form's answers
}
```

[`agent.js`](./adopt-example/agent.js) wires this whole, with your tools from `tool.json`. An agent with a loop of its own uses the gate directly instead ([`judge-only-example.js`](./adopt-example/judge-only-example.js)).

To watch a whole run first, with stand-in models and no API key:

```
cd adopt-example && npm install
cd ../tests/adopt
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
MODEL=anthropic:<model-name> node agent.js "Set up the pickup for LST-2291, 2pm this Saturday, Hongdae station lockers."
```

As shipped, nothing is connected: the `[Required]` lines are unverified, and nothing runs. The run asks
nothing and ends by saying it did not run and which lines could not be checked. That is the gate
failing closed, not a fault: fill in `MEASUREMENTS` and `TOOLS` in `connect.js` and it asks and executes.
What stays yours, and the whole flow, are in the [adopt example](./adopt-example/).

To call the library without `judge-only.js`, see [the adopt example](./adopt-example/README.md#calling-the-library-directly).

---

## Why this exists

A tool's input schema defines the shape of the values it needs. It does not say why a value is needed, who asked for the execution, or whether the execution may run right now. The gap is not MCP's — it shows up anywhere natural language turns into execution, and when one owner has both sides it is invisible and the rules end up scattered across prompts and code.

**If you build the agent and the tool together, you are still the tool provider.** Sharing an owner removes the protocol, not the role. The failure mode of same-ownership is not that the declaration lands in the wrong place; it is that **nobody plays the provider role at all.**

So, a proposal for tool providers: declare conditions in the `description`, each on a labelled line ([Writing the provider's checklist](#writing-the-providers-checklist)). A hint the model may or may not follow becomes a condition checked before execution. It needs no protocol change and can be done today (spec 4.2.1).

The first version of the argument was posted as [If unsure, ask. Never guess. — AI Agent Pre-Execution Checklist](https://discuss.huggingface.co/t/if-unsure-ask-never-guess-ai-agent-pre-execution-checklist/176632). The discussion continues in [Misalignment is not required for an agent to act without authorization](https://discuss.huggingface.co/t/misalignment-is-not-required-for-an-agent-to-act-without-authorization/180541) and [We gave AI a trust we never gave people — The third axis, after capability and permission](https://discuss.huggingface.co/t/we-gave-ai-a-trust-we-never-gave-people-the-third-axis-after-capability-and-permission/183807/), where a team running its own agent is cross-checking the library against its cases ([`tests/library/crosscheck/`](./tests/library/crosscheck/)).

Contact: [hello@anna.software](mailto:hello@anna.software)

License: see [LICENSE.md](./LICENSE.md)
