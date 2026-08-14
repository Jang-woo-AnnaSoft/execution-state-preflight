# Pre-Execution Validation Gate: Design Notes

## 1. Premise

### What we lost moving from forms to natural language

A form had five things built into it:

1. Deciding whether the conditions were met
2. Picking the form
3. Entering the values
4. Confirming where each value came from
5. Validating the required fields

Once input became natural language, the blanks and the judgment calls were handed to the LLM, and some of those safeguards disappeared along the way. They didn't stop being necessary. They moved somewhere nobody can see them.

An MCP input schema defines the shape of the values an execution needs. It doesn't tell you why those values are needed, who asked for the execution (the user, or the model filling something in), or whether this execution is allowed right now.

This isn't specific to MCP either. The same problem shows up anywhere language turns into execution. MCP just makes it easy to talk about, because the boundary is exposed as a protocol. When the same team owns both the agent and the tools, the boundary is invisible, and the rules end up scattered across prompts and code without being written down anywhere.

### Nobody gave the model a list

An LLM learns by filling in blanks. Now that we've moved from the conversation era to the action era, we're telling it to stop filling in blanks.

But we still haven't handed it a list of what it must not infer. We also haven't shown it how to fill a blank without inferring.

So the list comes first. Then the correct answer. Then where to go looking for that answer.

### And this doesn't get solved by performance

> **A model can't tell you what it failed to check.**
> That's a structural gap rather than a performance one, so it doesn't close as models improve.

You can ask about confidence in something that's there. You can't ask about awareness of something that isn't. Experienced surgeons still run checklists for the same reason: you can't remember what you skipped.

> **Tool selection is never going to be 100% accurate. Mis-selection is inevitable, so the first job is a structure where it can't reach execution.**

Those two sentences are why everything else exists. They're also the answer to "won't this be unnecessary once models get better?"

---

## 2. Summary

1. A model can't tell you what it failed to check. Structural, not performance.
2. So the list of things to check lives **outside** the model. Settle what the action is first, then fill the values and conditions that action requires.
3. Each slot gets filled by whoever can actually answer it.
4. An unfilled slot is unknown, and nothing runs while an unknown remains.
5. The decision is recorded, and execution reads only that record.

Line one is the premise. The other four are the structure.

---

## 3. What "outside" means

Two layers, and both are needed.

**The list sits outside the model's context.** Write it into the prompt and the model is still the one reading it and judging itself. The list has to live in code to be a data structure rather than an instruction.

**The decision sits outside the model's output.** You never ask whether it checked everything. The decision is `filter(f => f.status === "unknown").length`. It comes from the system counting its own state, not from parsing an answer.

> **Move the list outside and the decision stops being inference and becomes arithmetic. Counting doesn't hallucinate.**

Inference gives different answers to the same input, shifts when you swap models, and can't explain itself. Counting reproduces, doesn't care which model you're on, and the empty slot is the explanation.

This doesn't cut the model out. It still finds values, classifies when the action should happen, and extracts what the user is trying to do. The difference is that it has to return not just the value but which segment and which span it came from. It points at a location instead of producing a value.

> **The model proposes candidates. The counting happens outside.**

---

## 4. Structure

### 1. The checklists

The rules an action needs split three ways: conditions the system defines, conditions the tool provider defines, and conditions that have to be confirmed with the user. The split follows who can actually answer (section 5).

**Fixed checklist**, needed for every execution:

- Which tool? (C3)
- Are the execution conditions met, the When/Case? (C1)
- What does the user call this action? (C2)

**Provider checklist**, varying by tool:

- Required fields
- Type and format
- Pre-execution checks
- Prohibited conditions
- Conditions requiring extra confirmation

**User checklist**, varying by user context and preference:

- Intent
- Current context
- Execution limits
- Pre-execution checks
- Preferences

An `input schema` covers the first two lines of the provider checklist. Everything else is either written into the description as free text or written down nowhere at all. Every case where the arguments are all present and correctly typed but the execution still shouldn't happen (insufficient balance, missing permission, recipient doesn't exist) lands in that gap.

The user checklist can also carry **how** each condition gets confirmed. If tool providers declared that confirmation method in the input schema, the natural-language rules currently sitting in descriptions would become structured pre-execution conditions.

### 2. Provenance chain

Each slot is looked up in a fixed order, never generated.

```
user_answer → instruction → pre_set_data → measured_data → prior_state
```

| Source | What it is |
|---|---|
| `user_answer` | An answer given in response to a question this turn |
| `instruction` | The user's utterance |
| `pre_set_data` | Values configured in advance |
| `measured_data` | Observed values |
| `prior_state` | Values settled by a previous execution |

**This is search order, not a trust ranking.** If an earlier source has the answer, the value is already settled; you only move down when it doesn't.

Three things follow.

**Values are looked up, not produced.** Whether a condition holds is answered by observation, not by the model reasoning about it.

**The model doesn't report the source.** The pre-execution stage queries the defined sources itself. Leave the reporting to the model and invented values get a provenance label too.

> **The model must not manufacture the grounds for an execution. Those come from defined sources and from pre-execution checks.**

**Empty at the end of the chain means `unknown`.** Not a declaration, just what's left over once the search finishes. It holds even though nobody said "I don't know." If the value is needed, ask the user.

Whatever the execution was based on gets recorded so it can be verified and audited (piece 4).

### 3. Three gates

Intent, then tool, then execution. A lower gate doesn't run until the one above clears.

| Gate | Checks | On failure |
|---|---|---|
| Intent | When (C1), what (C2) | "Say that again" |
| Tool | Is this action really this tool? (C3) | "Confirm which operation" |
| Execution | Are all values and conditions filled? | Ask for the empty slots |

Intent and tool stay separate because they carry their own re-ask limits and because what you say to the user differs. Different question, different gate.

The tool gate sits above the execution gate for two reasons. Until the tool is settled you don't know which values are required. And the two failures aren't the same size: a wrong value sends the intended action to the wrong target, while a wrong tool produces an action that was never in the intent at all. A request to list something turning into a delete is not something argument validation catches.

### 4. Recorded decisions

The gate result is stored, and execution reads that record and nothing else.

The first three pieces are rules. This one is enforcement. When the decision and the execution live in the same flow, the decision is an `if` somebody can skip. When execution only reads a stored decision, no path exists that runs without one.

Blocks get recorded too. A log holding only successful executions lies to you: two rejections followed by a success reads as a first-try success.

---

## 5. Who answers, and in which direction

There are three checklists because there are three parties who can answer.

| Party | Can answer | Power at the gate |
|---|---|---|
| **User** | What and when, plus the values | The only one who can produce a `known` |
| **Provider** (tool server) | What is required | **Can require, cannot permit** |
| **System** (adopting org) | The decision | **Can reject, cannot generate** |

> Only the user can create a value. The tool server can require but never authorize. The system can reject but never fill in.

That single line is why every hook only rejects or downgrades.

The provider is self-reporting, so it doesn't get pass authority. If an empty `required` means unconditional pass, our safety depends on something someone else can edit. And giving the enforcer the power to generate turns the enforcement layer into a new source of errors.

**Don't ask someone who can't answer.** The user isn't in a position to answer C3. Ask anyway and you'll get an answer with nothing behind it, and the moment they answer, responsibility has shifted to them. So when the tool is unsettled, we ask them to restate the action instead of asking which tool.

Conditions split the same way. Ones a question can resolve (confirm the recipient) become questions; ones it can't (insufficient balance) become a stop. Skip that distinction and you trap the user in a loop they can't get out of.

---

## 6. Expected objections

**"Why not put the checklist in the prompt and take JSON back?"**
Because the model is still the one deciding a slot is empty. If it reports everything filled, the system has no way to check. Being able to say what it didn't look at is exactly the thing it can't do, and that was the starting point. Move the list outside and it holds regardless of what the model claims. Empty is empty whether or not it says otherwise.

**"Won't this be unnecessary once models get better?"**
Accuracy and containment are sequential, not substitutes. The higher the accuracy, the less people supervise, so the odds of the remaining errors slipping through go up rather than down.

**"What if someone just doesn't call it?"**
Fair. See section 8. It's outside the boundary of this design, and saying so first is better than being asked.

**"Why not write it all in the description?"**
A description is free text and self-reported. The model is the one reading it, so it may or may not be followed, and there's no way to check whether it was. Half of this proposal is taking that same content, structuring it, and putting it where the schema goes.

---

## 7. Effects

### Incidents it blocks

| Incident | Today | With the gate |
|---|---|---|
| An argument that was never stated gets invented and executed | No mechanism to stop it | A value with no source can't become an argument |
| A list request executes as a delete | Argument validation doesn't catch it | Stopped at the tool gate |
| An instruction planted in an email or document executes | A filter has to recognize the phrasing | Values from untrusted paths aren't eligible as arguments |
| A scheduled job triggers with missing arguments | Nobody is there to ask at trigger time | Scheduling is refused if values aren't settled at instruction time |
| A scheduled job runs against stale conditions | The pre-checked value is reused as-is | Conditions are only checked at trigger time |
| The user is trapped in a question they can't answer | Endless re-asking | Re-ask limits, and a stop where a question won't help |

Prompt injection defense works by cutting the path rather than detecting the phrasing, which matters because it behaves the same against wording nobody has seen yet.

### What changes operationally

When an agent executes the wrong thing today, there's one question available: why did the model do that. There's no answer. If you can't locate the cause you don't know what to fix, and swapping in a better model becomes the only move.

Split the decision across recorded points and the question changes.

| Failure | Today | With the gate |
|---|---|---|
| Wrong tool executed | Blame the model | Did the tool check approve it, and on what basis |
| Wrong argument | Blame the model | Which source produced the value, and where did it originate |
| Executed when it shouldn't have | Blame the model | Did condition validation pass it, or did it not run |
| Endless re-asking | Blame the model | Which source came back empty, or did a hook throw |

All of these have answers, and each answer points directly at what to fix. It also means you can measure whether a change helped.

### Other effects

**Model-agnostic.** No probability thresholds to tune, so gate behavior survives a model swap.

**Failures land somewhere harmless.** A hook that throws produces `unknown`, not a pass. Silence from a hook isn't approval either. Bugs stop things instead of misfiring them.

**Audit requirements come for free.** Approval points, rejection reasons, the original source of each value, retention windows. In finance and public sector work these are requirements on their own.

**Blast radius is explicit.** How far a settled value gets reused shows up in code. Normally nobody decides this and it quietly leaks wider than anyone assumed.

**Human confirmation doesn't become a rubber stamp.** The question is "what is this value" rather than "should I run this?" Show someone a candidate and ask them to approve it, and you've built a click-through, not a check.

**Rules become data rather than code.** The checklist attaches to the tool. Changing a rule doesn't need a deploy. Today the same rule is scattered across prompt and code, so step one is finding where it lives.

**Defects get names.** A slot empty because the user never said it (instruction gap) is distinguishable from one empty because the tool definition is thin (action definition gap). The first goes back as a question, the second goes back to the tool provider. Without names, both collapse into "the model didn't understand."

**Things that can't run yet aren't thrown away.** A condition that hasn't arrived is deferred, not failed. Values are settled up front and only the conditions are checked at trigger time, so scheduled and delayed execution fall out of the same structure instead of needing their own.

### Costs

If you're going to make the argument, make this part too.

**Latency and cost go up.** Every field adds an extraction call. Caching and batching need their own design.

**Questions go up.** Things that used to get filled in silently now reach the user. Re-ask limits and learned mappings have to ship alongside.

**It puts demands on tool providers.** Plenty of servers don't declare their schemas carefully, and that's outside your control.

**Demos get less impressive.** The "it just handles everything" impression fades. In practice this is the biggest source of resistance.

### Where to apply it

Applying this everywhere is neither realistic nor necessary. Gate the irreversible actions: transfers, deletions, sends, publishes. Let reads through.

Scale the structure down to fit as well. No When/Case if everything is immediate. No tool gate if there's one tool. Plenty of domains need no user checklist at all. This isn't all-or-nothing.

If the same team owns the agent and the tools, the per-tool checklist goes where the input schema goes. The boundary isn't exposed as a protocol there, but the point where language turns into execution is the same one.

---

## 8. Boundaries and limits

### Not covered by this design

**The runtime (caller) layer.** Whoever picks the tool up front, carries the counters, and agrees not to route around the gate. This layer doesn't answer anything; it runs the structure, which makes it a different kind of participant from the three above (3+1). Compliance here isn't enforced from inside this design and stays a contract. It belongs to code review, CI, and architectural convention.

**Forged decisions.** Separating decision from execution blocks execution without a decision. It doesn't block execution on a fabricated one. Raising that to enforcement means signing decisions, with TTL and nonce.

**Tool selection itself.** Selection happens elsewhere; this framework only checks it. Which is why it can't distinguish "chose wrong" from "hasn't decided yet" and asks instead.

### Next

1. **A reversibility axis.** Right now `list_records` and `delete_all_records` clear the same gate. The asymmetric cost of mis-selection is a premise of this design, but the gate is still uniform. Reads pass, deletes confirm. Without this axis, the objection that it puts needless friction on reads is a fair one.
2. **Signed decisions.** Turning the contract into enforcement.

---

## Why this framing

This design doesn't claim to make anything safe. It claims something narrower: right now, when an agent does the wrong thing, there is no way to find out why. Every argument above is downstream of that.
