# Executions are happening that nobody asked for

Forms had five things in place: judging the condition, picking the form, entering the values, knowing where each value came from, and validating required fields.

When input moved from forms to natural language, the blanks and the judgment got handed to the LLM. Some of those safeguards didn't come along.

MCP's input schema can define the shape of the values a tool needs in order to run. It doesn't automatically tell you **why a value is needed, who asked for the execution (the user, or the model), or whether this execution is allowed right now**.

This isn't specific to MCP. Anywhere natural language turns into execution, the same gap shows up. MCP is just easy to talk about because the boundary is written down as a protocol. When the same owner has both the agent and the tool, the boundary is invisible, and the rules end up scattered across prompts and code, stated nowhere in particular.

## Checklist

LLMs were trained by filling in blanks.
Now that we've moved from the age of conversation to the age of action, we tell them not to fill in blanks.

But nobody has handed them **a list of what they aren't allowed to infer**. Nobody has told them how to fill a blank without inferring.

So the list comes first. Then correct values. Then somewhere to get correct values from. The rules an action needs split into three kinds: conditions the system defines, conditions the tool provider defines, and conditions that have to be confirmed with the user.

I ended up organizing this as three checklists.

**Fixed checklist**
•	Which tool do we pick?
•	Are the execution conditions met? (when / case)

**Provider checklist**
•	Required fields, type / format, pre-execution checks, prohibited conditions, extra confirmation conditions

**User checklist**
•	User intent, current context, execution limits, pre-execution checks, user preferences

The fixed checklist applies to every execution. The provider checklist changes per tool. The user checklist changes with the user's environment and preferences.



## From Inference to Provenance Lookup

A validator can't tell an account number the user typed from one the model invented. Worse, a required field pressures the model to fill the blank.
So this layer doesn't validate arguments. It looks up where each one came from.

**Unknown is a normal state.**

When an instruction is incomplete, unknown isn't an error. It's the valid output. If even one remains: don't execute. Ask, and record.

- Arguments are never generated.
- Only the provenance chain is looked up.
- All five tiers are checked. If all are empty, the field is `unknown`.
- If even one `unknown` remains, do not execute — ask, and record.


## Provenance Chain

Which leaves the next problem. **How do you find the correct value?**

| # | Source | Meaning |
|---|--------|---------|
| 0 | `user_answer` | Answered by the user after an `ask_user` |
| 1 | `instruction` | Taken from a trusted segment, with a span |
| 2 | `pre_set_data` | Settled earlier through a decision path |
| 3 | `measured_data` | Observed from the environment |
| 4 | `prior_state` | Inherited from a prior `executed` record |

This order isn't a ranking by trustworthiness. It's a lookup order. If an earlier source has the answer, that value is already decided; if it doesn't, you go down one. Values are not generated. They're read from a defined source. Whether a condition holds is answered by observation, not by the model's reasoning. If a value isn't found in any defined source, it's unknown. If the execution needs it, ask the user.

The source isn't something the model declares about itself either. A pre-execution step queries the defined source directly and fills the value in. Leave it to self-reporting and invented values get provenance attached too. **The model must not manufacture the grounds for its own execution**. Those grounds have to come from defined sources and from the results of pre-execution checks. And whatever it ran on should be recorded, so it can be verified and audited.

This layer doesn't block execution. It fills, with a source, the blanks that guessing used to fill. Only when no source has it does it ask, and the user's answer lets the call go through. Execution is still the goal.

The point is that you're not only validating whether the tool's inputs are well-formed. Before execution you should be able to say why this is running, under what conditions it's allowed, and where each value came from.

> **Tool selection accuracy is never going to hit 100%. Wrong picks are inevitable, so the first job is a structure where a wrong pick doesn't reach execution.**

## What a blocked call looks like

`to_account` was never supplied, so the gate holds. The other two fields are known, and each one names where it came from.

```json
{
  "action_key": "u_01:bank.transfer",
  "fields": [
    { "name": "to_account", "status": "unknown", "source": null },
    { "name": "amount", "value": 50000, "status": "known", "source": "instruction" }
  ],
  "gate": { "unknown_fields": [{ "name": "to_account" }] },
  "execution_decision": "ask_user"
}
```

Records accumulate under one `action_key`: `ask_user` → `execute` → `executed`. Only `executed` becomes the baseline for tier 4 on the next run.

## Code (the skeleton)

- **[execution-state-preflight.js](./execution-state-preflight.js)** — the skeleton. the header comment explains how the rest is organized.

I built this out as execution-state-preflight. It assumes a range of cases: immediate execution only, a single tool, no user checklist needed, and so on. Use whichever part matches your case. If the agent and the tool have the same owner, drop the per-tool list into the slot where the MCP input schema would go.

## Status

This file is a specification, not a library. Hooks marked `[REQUIRED-OP]` throw `not implemented` by default, and `createPreflight` refuses to build without them. Layer boundaries are deliberately left to the adopting system.

## MCP Improvement Proposal

The user checklist can also carry how each condition gets checked. If tool providers put that check method into the MCP input schema, the rules currently sitting in the description as prose can be structured into conditions you actually evaluate before running.

## Reference

This code is the reference implementation of
[**If unsure, ask. Never guess. — AI Agent Pre-Execution Checklist**](https://discuss.huggingface.co/t/if-unsure-ask-never-guess-ai-agent-pre-execution-checklist/176632).

This structure is aiming at one thing: fewer wrong executions.

Getting that one thing took working through eight separate problems.

1. Separating execution from verification — and separating who verifies (system / provider / user)
2. Verifying conditions, not just values
3. The system decides what counts as unknown, not the model
4. Human involvement is guaranteed by the structure, not by good intentions
5. Per-field provenance records — the raw material for auditing and for assigning responsibility
6. Rules become data attached to the tool instead of code (change them without a deploy)
7. Failures get names (instruction gap / action definition gap)
8. What can't run now isn't discarded; it's held
   
---

## Ownership & License

Copyright © 2026 AnnaSoft Inc. (Republic of Korea)

**Commercial Licensing** — A commercial license is required only for organizations with annual revenue of USD 1 billion or more that commercially deploy products or services based on this work. All other use is permitted free of charge.

Contact: hello@anna.software
