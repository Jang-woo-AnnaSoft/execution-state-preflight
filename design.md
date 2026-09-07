# Pre-Execution Validation: Implementation Notes

These are implementation notes. The argument — why the checklist has to sit outside the model — is in the specification. What follows assumes it and describes only the structure needed to build the thing.

The model still extracts values, converses, and matches tool candidates. One thing is taken away: certifying that the state it filled is complete enough to execute.

---

## 1. Two axes

Two questions get confused with each other. **Who defines the obligation** decides which checklist an item belongs to. **What can resolve it** decides where the value comes from. They cross. A provider declares that the balance must be sufficient; a system measurement resolves whether it is. A user declares a spending limit; current state decides whether this execution satisfies it.

---

## 2. The checklists — who defines

**Fixed checklist**, defined by the adopting system, applied to every call:

- Which tool is this action, and does that tool actually produce the requested state change
- When does it run — immediately, or on a condition or event
- What the user calls the action, and what state change they want

This settles the execution unit. Until it is settled you do not know which other checklists to load, so it comes first.

**Provider checklist**, defined by the tool provider, varying per tool:

- Required fields, type and format
- Pre-execution checks and prohibited conditions
- Conditions requiring explicit confirmation

An input schema covers the first line. The rest is prose in the description, or written down nowhere. Every case where the arguments are present and correctly typed but execution still should not happen — insufficient balance, missing permission, recipient does not exist — lands in that space.

**User checklist**, defined by the user, varying with context rather than with the tool: intent and permitted range within the settled execution unit, execution limits, exceptions, preferences.


---

## 3. The sources — what resolves

Each slot is looked up in a fixed order, never generated.

```
user_answer → instruction → pre_set_data → measured_data → prior_state
```

| Source | What it is |
|---|---|
| `user_answer` | An answer already collected for this execution unit |
| `instruction` | A trusted segment of the user's utterance, with coordinates |
| `pre_set_data` | Values the user approved and stored in advance |
| `measured_data` | State read from a system API at that moment |
| `prior_state` | Values inherited from a previous execution whose record says `executed` |

**This is lookup order, not a trust ranking.** If an earlier source has the answer, the value is settled; you move down only when it does not. Reaching the end with nothing means `UNKNOWN`.

Values are read, never produced: whether a condition holds is answered by observation. And provenance is not self-reported — the pre-execution step queries the source itself, because if the model reports it, invented values get a source label too.

---

## 4. Three states

| State | Meaning |
|---|---|
| `KNOWN` | A source was found, or an approval completed |
| `NULL` | The lookup ran and confirmed there is nothing there |
| `UNKNOWN` | The lookup has not finished |

`NULL` exists so that "there is nothing" is a normal thing to write down. Forbid it and the only available move is to invent something.

**These three distinguish whether the check happened, not whether the requirement is satisfied.** A `NULL` required argument does not permit execution — a separate judgment, and not this layer's.

---

## 5. Unresolved is not the same as ask the user

`UNKNOWN` routes by who can resolve it.

| Route | When |
|---|---|
| **Ask** | The user can answer |
| **Measure** | Only the system can answer. Do not re-ask |
| **Hold** | The lookup ran, the condition is settled, and it prohibits execution. No longer unresolved |
| **Repair the definition** | The condition was never declared, or the middleware cannot interpret it. No user answer fixes this |

The last two differ. Insufficient balance is a finished check; a condition the provider never declared is a missing one. Collapsing both into "cannot resolve" loses the distinction that says where the work goes. Skip the routing entirely and the user is trapped in a loop over questions they cannot answer.

---

## 6. Counting

Count `UNKNOWN`. Nothing else.

```
Unknown Count == 0  →  the check is complete
```

`KNOWN` and `NULL` are finished lookups and do not enter the count. The count measures verification, not fulfillment.

Counting requires a settled list, so an error in deciding that list is not detectable by counting. Section 9 says where that lands.

---

## 7. The decision record

The result of the check is stored. Execution reads that record and nothing else.

Everything above is rules; this is what makes them hold. When decision and execution live in the same flow, the decision is an `if` somebody can skip. When execution only reads a stored decision, no path exists that runs without one.

The record holds the verdict and stops there — each slot's state, the source that produced it, and the route an `UNKNOWN` took. Whether to proceed is the executing party's own decision, written to its own record.

Blocked runs get recorded too. A log holding only successful executions lies: two rejections followed by a success reads as a first-try success.

When the action is not immediate, the run splits into two phases under one key. Values are resolved at instruction time, while the user is still present — that is the last moment you can ask. Conditions are checked at trigger time, because a condition verified earlier would be stale by the time the call fires. Intent carries forward (instruction, checklists, answers), reality is re-fetched (schema, pre-set data, policy), and measurements are never carried.

---

## 8. What goes where

| Where | What goes there |
|---|---|
| **Checklist** | Anything a defining party owns. Changes without a deploy |
| **Principle** (prompt) | Anything whose violation the code can detect. Reduces how often the check fails; does not decide execution |
| **Code** | The same procedure whoever defined the item: look up, compare, count, record. Adding items does not change it |

If a violation is not observable from outside, it cannot live in the prompt. Making it a slot gives it a source and a state, which is what makes it observable at all.

---

## 9. Boundaries

**Tool selection.** Selection happens before this layer and is only checked here. Whether the action really is this tool is judged from the description, which is prose — mitigation by prompt, not verification by code. A wrong pick among several tools that could all do the job still gets through.

**Forged records.** Separating decision from execution blocks execution without a decision, not execution on a fabricated one. Raising that to enforcement means signing decisions, with TTL and nonce.

**The calling layer.** Whoever picks up the tool, carries the counters, and agrees not to route around the check. It answers nothing; it runs the structure. Compliance here is a contract, enforced by code review and convention.

**Reversibility.** The check is uniform, so a read and a delete clear it the same way. Scope it to irreversible actions instead — transfers, deletions, sends, publishes. For reversible work, checking the outcome and correcting it is the cheaper control.

Scale the structure down as well. No timing slot if everything is immediate, no tool confirmation if there is one tool. If the same team owns the agent and the tools, the per-tool checklist goes where the input schema goes.
