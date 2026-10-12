# What the model makes up must not reach the agent

Models reason. That is their job. The trouble starts when reasoning fills a blank that has no source. If the tool, the criteria, or a value an agent executes with was filled in that way, it was made up, and the execution has no grounds.

## Today the model and the agent are treated as one

So the question becomes "how far can we trust the model?", and the answer points to a better model or a stronger prompt.

But models fill blanks. In *[Why Language Models Hallucinate](https://arxiv.org/abs/2509.04664)*, researchers at OpenAI and Georgia Tech asked for a person's birthday and added, "If you know, just respond with DD-MM." A state-of-the-art open-source model was asked three times and gave three different wrong dates. The paper traces this to training and evaluation that reward a guess over an admission of not knowing.

The paper's fix is to change how models are scored, so that a model that doesn't know says so. That is a fix on the model side. But the blanks in front of an execution are usually not about what the model knows.

**No model can know a value the user never gave, or a condition nobody declared.**

## The model reasons, the agent executes

The model reasons. It plans, picks candidates, looks up values, and asks the user. None of that shrinks.

The agent executes, and keeps the model's reasoning from crossing into execution. Here "agent" means the execution layer, not the model-and-tools loop the word usually refers to.

Reasoning gets into execution in three places:

- **Which tool**: what action, and when
- **Which criteria**: what must be checked before it runs
- **Which values**: what goes into the tool

## There is nowhere to write the criteria

An input schema has room for argument names and types, and nothing else. Rules from tool providers and users, such as "the balance must cover the amount", "confirm with the user before running", or "the daily limit is X", end up as prose in a description, or nowhere.

So the model's assumptions decide which tool to use, which criteria to pass, and which values to put in.

## Two methods

**Declare the checklist.** If the model decides what has to be checked, that checklist is reasoning too. What gets asked and what gets skipped changes from run to run, and a missing item doesn't look missing. It looks like it was never there. So the criteria are declared before execution, outside the model, by whoever is responsible for them. Providers write the conditions for their tools. Users write the scope of what they delegate.

**Check the source.** Checking a value after it arrives is too late. An account number the user typed and one the model made up are the same string. From the value alone, neither the user, a validator, nor another model can tell them apart. Asking the model to label where each value came from doesn't help, because the model writes the label too.

So the agent doesn't take a value and validate it. It takes a pointer to where the value is supposed to be, and checks that location itself, in a defined source. The sources are what the user said, settings the user approved in advance, and system measurements. A value found in none of them stays unknown, and while anything is unknown, the execution is not in an executable state.

Checking sources is what separates the model from the agent. A value whose source can't be confirmed was made up, and what was made up does not get into the agent. **Criteria come from declarations. Values come from sources.**

Tool selection can't be proven by source checks the way argument values can. It can be compared against the declared scope, the allowed tools, and what the user asked for, but nothing fully proves that a tool matches an intent stated in natural language. The spec states this limit as it is.

| | Model's reasoning | Grounds for execution |
|---|---|---|
| Tool | Proposes which tool to use | Compared with what the user called the action and when they said to do it |
| Criteria | Guesses what to check and whether it holds | Checklists declared by providers and users before execution |
| Values | Proposes values and where they are | Checked directly in what the user said, pre-approved settings, or system measurements |
| Execution | Produces a call | The decision record. Executable only when nothing is unknown |

## The verdict ends in a record

The record holds the intent and purpose the user stated, the source of every value used, the conditions checked, the items left unknown, and the criteria nobody declared. Intent the user stated is kept apart from intent that was interpreted. Whoever calls the tool reads that record and nothing else.

So the record holds more than what was executed. It holds what was meant to happen, on what grounds the execution was judged executable, and what could not be confirmed.

Schema validation, tool-server checks, permission layers, and prompts stay as they are. Nothing is being replaced. The point is to build the place that was missing. The appendix sets out what changes compared with current practice.

**Specification**: [*Taking Definition and Verdict Authority Out of the Model*](./spec.en.md)

---

## Appendix. How this differs from current practice

Current practice checks capability and permission, leaves the rest to the model, and blocks what it can't verify. This spec moves the rest outside the model, and treats what isn't confirmed as something to resolve, not only something to block.

| | Current practice | This spec |
|---|---|---|
| The question | How far can we trust the model? | Has everything this execution needs been confirmed? |
| Model and agent | Treated as one. Reasoning and execution share a single flow | The model reasons, the agent executes. What the model makes up does not get into the agent |
| Who sets the criteria | Nobody, so the model decides on every call. Nothing is kept as a rule, so the rules can't be listed | Providers, users, and the adopting team declare them in checklists outside the model. They change without a deploy and can be listed |
| Where to write them | The input schema holds argument names and types. Conditions and intent have no field | Values, conditions, and intent are slots of the same kind |
| Grounds to trust a value | A looked-up value and a made-up one are the same string. Any source label is written by the model too | The location the model points to is queried directly in a declared source |
| Tool | The model picks one. If the input schema passes, it runs | Compared with what the user called the action and when they asked for it. Not provable in code |
| Blanks | The model fills them and leaves no sign it did | They stay unknown. Nothing the model filled in passes through |
| When something can't be verified | AI governance and security controls usually block execution when a required condition is unmet or can't be verified (fail-closed). What happens after the block is left open | The block is not the end. If the user can answer, the user is asked. If only the system can, it is measured. If nobody can, it goes back to whoever declared it, for definition repair. Once everything is confirmed, the execution is executable. A confirmed condition that prohibits execution is recorded as a hold |
| Who decides the check is complete | A person clicks through a form the model filled in | Code that counts unknowns. No confidence scores |
| Who decides to execute | Verification is a branch inside the execution flow, so it can be skipped, and skipping leaves no trace | The verdict ends in a record. The executing party reads it and decides |
| Record | The tool called and its final arguments. Sources, checked conditions, and runs that didn't execute are not kept | Each slot's state and source, unknown items and their routes, unmet items, and runs that didn't execute |
| After an incident | Ask the model, which produces a plausible story | Look in the record. Responsibility splits by whether a value, a condition, or the intent was left undeclared |
| As models improve | They fill blanks more convincingly and pass review more easily | They ask better questions. Their authority to decide does not grow |

Unchanged: schema validation, tool-server checks, permission layers, prompts.
