# Taking Definition and Verdict Authority Out of the Model
*Values, conditions, intent: **people** should declare them, not the model.*

> This specification deals with missing inputs, not with the correctness of computation.
> Don't trust what the model says. Have code count only whether each check was carried out.

*RFC: Declare, judge, record, execute — separating authority from the model*

---

## 0. How this differs from existing approaches

Existing work raises model accuracy and validates input arguments with schemas and hard-coded guardrails. This specification proposes taking back the authority the model has been carrying because no standard existed. What has to be filled in is for the provider to say; filling the blanks that remain is for the user. Without that division, the model took on both. Until now, definition, verdict, and execution all happened in one place: the model. Nothing was recorded. So execution had no grounds.

| Axis | Existing | This specification |
| --- | --- | --- |
| **Who sets the rules** | Nobody, so the model sets them on every call. What to ask and what to skip changes from call to call, and since nothing is kept as a rule, the rules cannot be listed (2.3). | Parties with definition authority (provider, user, adopting system) declare them in external checklists. They change without a deploy, live in a fixed place, and can be listed. |
| **What gets checked** | Arguments only. Structured Outputs and Tools schemas check data type and format; there is no field for conditions or intent (2.5). | Values, conditions (balance, permission), and intent become slots on the same footing. Because the verdict is about the action, conditions need no separate mechanism, and confidence scores are not used (3.3). |
| **Do missing rules show up** | An undeclared item is missing from the record too, so it looks like an item that never existed rather than one that was missed (2.7). | An item that cannot be checked stays UNKNOWN and routes to definition repair (4.5). The gap is not filled, but the record shows who failed to declare what. |
| **Is there a reason to trust a filled value** | A looked-up value and an invented one are the same string, so neither the user nor the validator can tell them apart (2.4). | A value filled in by the model does not settle the slot. If every designated source has been looked up and nothing is found, the slot is fixed at UNKNOWN (5.2). |
| **Who judges that what was filled is everything** | The model hands over a neat, completed form and a person clicks through(2.2). | Counting code does. People receive blanks, not a filled-in form, and only the items only they can answer come back to them (3.5). |
| **Who decides to execute** | Validation is a branch inside the execution flow, so it can be skipped, and the skip leaves no trace. | The verdict ends in a record. An external executing party reads that record and makes its own decision. No execution path bypasses the record. |

The model's output is not grounds for execution. It is input for preparing execution. The model does not do less work: value extraction, conversation, and tool candidate matching stay with the model.

Two decision authorities move out of the model. Definition authority, the authority to decide what gets checked, goes to whoever declares the checklist. Verdict authority, the authority to judge whether every checklist item has been checked, goes to the counting code. The verdict ends in a record, and execution is left to an external party that reads that record.

### 0.1 Relationship to existing assets

- This is not a new architecture. It extends two assets that already exist, the tool list and the input schema, by adding items to them.
- Format validators and tool-server validation are not replaced. This specification only produces a decision record, and both validations stay on the execution path.
- It does not replace post-execution verification layers. Before execution, it counts whether values, conditions, and intent were confirmed from their declared sources, and judges deterministically whether the state is executable (3.5). The purpose is not blocking but reaching an executable state. The decision record becomes the grounds for execution and for later verification.

---

## 1. Scope

This specification is not applied to every tool call across the board. What it covers, and which slots it uses, is scaled down per domain.

### 1.1 What it covers

- Applies: irreversible execution. Payments, orders, transfers, deletions, physical control.
- Does not apply: read-only calls are not gated.
- The trade: statements about answer quality are removed from the grounds for a verdict, and input completeness is gained in return. For reversible execution, the gain does not cover the cost. Checking the result and fixing it is the cheaper control.

#### Deciding what counts as irreversible

An execution is reversible when the party that ran it can restore the prior state on its own. It is irreversible when restoring requires the other party's consent or a third party's cooperation. The presence of an undo does not decide this.

| Execution | Undo | What remains |
|---|---|---|
| Transfer | Conditional | The money already reached the other account |
| Email send | Recall | The recipient may already have read it |
| File delete | Trash restore | The change already propagated to outside systems |
| Robot motion | Stop | It may already have touched a person or an object |

An undo restores the state held by the party that ran the execution. It does not restore what was left outside. That is what this decides on.

### 1.2 Slot reduction rules

- Domains with immediate execution only: no trigger slot.
- Systems with a single tool: no tool-matching item in the intent slot.
- When the same party owns the agent and the tools: the agent's own checklist is still needed, and the per-tool checklist goes where the input schema goes.

---

## 2. Problem definition

Premise: the model is an engine that fills blanks. This is not a defect but trained behavior, so neither prohibitions nor better performance will remove it. **It does not presume malice or error. Malice requires breaking something declared, and error requires missing a settled answer. Where nothing was declared, neither exists.** The items below are the failures that appear when this property meets the way systems are built.

### 2.1 Confusing inference with execution authority

- Current systems treat arguments extracted by probabilistic text generation as if they carried the authority to call the API. However high the confidence, inference does not create the authority to change resources or take irreversible action.
- A confidence score measures the probability that a prediction is right. Score an invented value and it gets a high score too. Whether a value was looked up or made up is a fact, not a probability. Scores are not used, not because they are inaccurate, but because they measure something else.
- Authority comes from ownership, not accuracy. Being able to write a rule and being accountable for it go together, and the output of a model that is not accountable cannot be accepted as complete either.

### 2.2 The first draft moves to the model, and automation bias follows

- With traditional forms, the user both filled in the form and reviewed it before approving. In an agent, the model becomes the author of the first draft.
- The more polished the parameters, the more the user skips judgment and just gets through the step. Higher accuracy makes this weakness worse.

### 2.3 Why re-asking and after-the-fact exclusion don't work

- Shared reason: the model is the one deciding what to ask and what to exclude. There is no standard to compare against.
- Re-asking: an instruction to "ask when unclear" is not guaranteed to work. If the model doesn't notice what is missing, or has already filled the blank with a hallucination, the ambiguity is already gone.
- After-the-fact exclusion: "search again, excluding inferred values" cannot be carried out. For the reason in 2.4, they cannot be told apart.
- Output that skipped a question carries no mark that it did. The omission shows up only after execution.

### 2.4 Grounds for trusting a filled value

- A looked-up value and an invented one have the same string form. Nothing in the result tells them apart. Not for the user, and not for a validator.
- Adding another validator (LLM-as-a-Judge) does not solve this. What the judge receives is a call that has already been assembled, and the information needed to tell the two apart is not in it.
- Passing the value along with a source label does not work either. The label is produced by the model, so an invented value gets a source too.
  
### 2.5 No place to declare conditions

- The input schema is a format for assembling a call, so only arguments get fields. There is no field for conditions.
- The chain: nowhere to write it → not something to validate → nobody declares it → the model assumes it.
- Current validators check schema conformance only. They don't check whether a value is real or whether a condition is missing.
- This is the space where every argument is present and correctly typed, yet execution should not happen. Examples: insufficient balance, a recipient that doesn't exist, unsettled timing, no permission.
- Tool servers sometimes check conditions. But a check after the call means unnecessary calls. A tool server's rejection reason doesn't end up in a decision record, and it can become a hint for the model to change the value and retry.
- Conditions written as free text in the description go unverified as well, since there is no way to confirm the model took them in.

### 2.6 Failure types

Failures are not different kinds of fault. They differ in what was filled in by inference. In all three cases, something the model filled in without a declared source reached execution. The same outcome belongs in a different place depending on what was inferred.

- When a value is inferred (→ wrong execution): no source is designated for looking up the value, so the model fills it in at call time.
- When a condition is inferred (→ execution without instruction): the condition was never declared, so the model assumes whether it holds.
- When intent is inferred: intent and permitted range were never declared, so there is nothing to compare against.
  - If what to do (the tool and the state change) is inferred (→ a different execution): the item that settles the checklist changes, so the tool choice diverges, and the values and conditions to check change with it.
  - If the permitted range or the timing (when, or on which event, to run) is inferred (→ execution without instruction): the action is the right one, but it runs outside the range or at a time the user never allowed. Examples: a reservation is full, so the agent cancels the user's existing reservation and books again; given "buy it when the price drops," the model sets the threshold itself and buys at a moment the user didn't expect.

Many blanks start with what the user didn't say. People usually don't know what they left out, so an incomplete instruction is the normal case. The problem is that the model fills the blank, the gap never shows, and the next instruction comes with the same blank.

### 2.7 No record of the verdict

Executions are recorded; verdicts are not. What gets recorded is the tool that was called and the final argument values. Where each value came from, and which conditions were checked, are not recorded.

- Values carry no provenance, so what couldn't be observed before execution stays unobservable in later analysis.
- Undeclared conditions are missing from the record too, so an item that was never checked looks like an item that never existed rather than one that was missed.
- Blocked executions are not recorded. When only executed runs remain, what was filtered out is lost.
- An approval record keeps the fact of approval but not what was shown, so after an incident there is no way to reconstruct what the approver signed off on.

### 2.8 Internal rules scattered everywhere

An agent's own rules are spread across prompts, branches in tool wrappers, and undocumented habits. The problem is not the scattering itself but the cost of change and the inability to check.

- Changing a single rule takes a code change and a deploy.
- With rules in many places, there is no way to list every rule currently in effect.

---

## 3. Core architecture principles

### 3.1 Pipeline

```
[Current structure]
LLM Output ─> [Schema Syntax Check] ─> API Execution
                                        (risk: undeclared conditions guessed)

[Proposed structure]
LLM Output ─> [External Declarative Slots] ─> [Deterministic Gate Counter]
                        │                              │
                        ├─ Source Verification         ├─ Unknown Count == 0
                        └─ Authority Check             └─ KNOWN / NULL / UNKNOWN
                                                       │
                                                       ▼
                                               [Decision Record]
                                                 unknown_count
                                                       │
              ┌────────────────────────────────────────┘
              │  (executing party reads the decision record)
              ▼
              [Execution Path] ─> [Schema Syntax Check] ─> API Execution
                                       (existing validator kept)
```

### 3.2 Changing what the verdict is about (right answer → correct execution)

- In irreversible execution, what has to be correct is not the generated text but the action taken. An action is correct when it is the action the user intended and it meets the conditions the provider requires.
- What this specification judges is input completeness, the precondition for that correctness. Correctness can only be assessed once values, conditions, and intent are all declared and every slot is confirmed from its designated source. Whether the confirmed requirements are met is recorded separately.
- Moving the verdict from the generated answer to the action has three consequences. An action is a fact, not a probability, so it is judged by counting, not scoring. An unconfirmed value, condition, or intent is in every case the same action, "proceeding without checking," so one counter covers all three. And an action is decided before it happens, so the verdict can come before execution.

### 3.3 Slots on the same footing (Value, Condition, Intent)

- Values, conditions, and intent are all treated as verification slots. A value is what goes into a tool argument; a condition is a fact whose truth is checked before execution (balance, permission, and so on); intent is the execution unit the user wants and the permitted range within it. Because the verdict is about the action, conditions need no separate mechanism. Counting works the same way for all three, and in the order of settling, intent comes first.
- Once the verdict is separated from execution, a slot can be in the state "condition not checked." Only then can free-text conditions become something to verify.

### 3.4 Deterministic slot counter gate

- The verdict involves no model reasoning and no scoring.
- An external validator tallies slot states and, when Unknown Count == 0, judges the check complete. A complete check does not mean the requirements are met.

### 3.5 Changing what is computed (whether to execute → unconfirmed slots)

- The goal of the computation is not whether to execute but pinning down the unconfirmed slots.
- When the model decides what counts as unresolved, it can hide what is unresolved. When an external checklist decides, the system can detect it.
- What a person receives is blanks. The blanks are finite, each one carries its source, and the person answers only the items only they can answer.
- The gate only checks unconfirmed slots and records the result.
- The executing party sits outside this specification and decides separately whether to execute, consulting only the decision record.
- A structure that branches on the return value of the verdict function is not separation. There must be no execution path that does not go through the record.

---

## 4. Declarative slot system

Every value, condition, and intent item is registered in an external checklist, separated by the party that holds definition authority. Who defines an item and what resolves it are different axes. A condition declared by the provider may be resolved by a system measurement. Section 4 covers who defines; Section 5 covers the sources that resolve.

```
                  ┌─────────────────────────────────────────┐
                  │             Fixed Checklist             │
                  │  - Intent (incl. Tool Match) / Trigger  │
                  └───────────────────┬─────────────────────┘
            ┌──────────────────────────┴──────────────────────────┐
            ▼                                                     ▼
┌───────────────────────────────────────┐ ┌───────────────────────────────────────┐
│       Provider Checklist              │ │         User Checklist                │
│ - Schema / Type Validation            │ │ - User Intent Bounds / Context        │
│ - Mandatory Pre-conditions (Balance)  │ │ - Execution Limits & Scope            │
│ - State Changes & Action Labels       │ │ - User Preference / Approval          │
└───────────────────────────────────────┘ └───────────────────────────────────────┘
```

### 4.1 Fixed Checklist: settles the execution unit. Applies to every tool call.

- Tool match validity: does this tool actually provide the requested state change?
- Timing: immediate, at a set time, or when a specific event occurs?
- Intent: the purpose of use and the desired state change.

**Role of the fixed checklist: the minimum needed to settle the execution unit. The tool match depends on it, so it comes before the intent in 4.3.**

### 4.2 Provider Checklist: varies per tool.

- Required arguments, and their type and format.
- Conditions that prohibit or permit execution: ownership, access permission, checks before execution or termination, safety, permitted execution modes (whether split execution is allowed, and so on).
- Declaration of the state change that execution causes.

#### 4.2.1 Description labels

Providers already describe conditions in the tool description. The description arrives with the tool list, so string parsing alone turns it into slots. What keeps it from being an enforced checklist is that nobody has agreed on what is required. Three labels are proposed.

- [Required]: attached to an argument or a condition. An item whose source location must be matched against an external source. On a condition, user approval does not satisfy it; it is confirmed only from the declared system source.
- [Verify]: attached to a condition. Creates a user approval slot.
- [Notice]: attached to a constraint. The user must be informed before execution.

A condition can also declare how it is to be checked (by user approval, or by looking up and comparing a particular system state). Conditions declared by the provider serve only as grounds not to execute. Passing a condition does not justify execution. Using the labels as an enforced checklist makes the parsing contract part of the gate: the declaring party is trusted, the syntax is fixed, and parsing is deterministic.

### 4.3 User Checklist: varies per user and environment.

- Making intent and context specific.
- Execution limits and scope, checks before execution or termination, safety, user preferences, and so on.

**Role of the user checklist: sets the permitted range within the settled execution unit. It is filled in after the unit is settled, so it comes after the intent in 4.1.**

### 4.4 When checklists are obtained and slots are created

- Slots are created when each of the three checklists is obtained. The fixed checklist comes before tool selection. The provider checklist comes from the tool's declarations once the tool is settled. The user checklist comes from the trusted segments of the instruction once the execution unit is settled.
- The user checklist can grow until execution. The user is still in the conversation until the call starts and can add conditions while answering.

### 4.5 Resolution routes for unconfirmed state

Items are counted the same way, but resolve differently when unconfirmed. An implementation needs to branch.

- The user can usually answer for values; for conditions, often not. The actual branch, though, is not value versus condition but who can resolve the item.
- There are three routes. The route follows from the allowed sources declared on the slot and from the lookup result. The model does not choose it.
  - (a) Ask the user (ask_user): items the user can answer.
  - (b) System lookup (system_lookup): items only the system can answer. The user is not asked again.
  - (c) Definition repair (definition_repair): the condition itself was never declared, or the middleware cannot interpret it. No user answer fills this; it is a gap on the provider's or the implementer's side. A failed lookup hook also belongs here.
- Hold is not a resolution route. It is the case where the condition was checked and it prohibits execution: the slot is KNOWN, does not go back to asking, and is recorded as unmet. Hold is a finished check (insufficient balance); definition repair is a missing check (an undeclared condition). Merge the two into "cannot resolve" and you lose the information about where the work should go.
- The ask-the-user route has a ceiling. When it is reached, the slot stays UNKNOWN, resolution moves to conversation outside this logic, and reaching the ceiling is itself written to the decision record. The adopting system sets the ceiling. Without one, an unanswerable item is asked again forever, and the record cannot tell that apart from the user giving up.
- What is confirmed by asking the user is confirmed at instruction time. Everything else is checked again at trigger time.

### 4.6 Carrying out the ask

- Items routed to asking the user in 4.5 can be carried out by the model.
- Code builds the list of blanks. Asking the user and bringing the answers back can be the model's job. The list decides what to ask. The model decides how to ask it.
- What the model decides is the form of the asking. It can ask several items at once, choose the order, explain why it is asking, and gather answers that arrive across several turns.
- What the model does not decide is the list itself. It does not drop items or add them, and it does not mark a slot confirmed because an answer came back. The answer is looked up again as the user_answer source, and the verdict stays with code.
- Nothing is asked that does not need asking. Items the system can measure never reach the user (previous section), and a value that came up earlier in the conversation is looked up rather than asked again (5.3, 6.2).
- The gate stands only in front of irreversible execution (1). Reversible calls such as reads do not go through this at all.
- This part gets better as models get better. Because the verdict sits outside the model, a gain in capability goes into the quality of the asking rather than into more authority.

---

## 5. Whitelist lookup pipeline

### 5.1 Three-state slot model

- KNOWN: the data source was confirmed by whitelist lookup, or approval is complete.
- NULL (no result): the lookup ran and confirmed there is nothing.
- UNKNOWN: a required check has not finished yet. This is what remains after the lookup ends, not something the model reports about itself.
- UNKNOWN does not mean "question for the user." Asking the user is only one of the three routes in 4.5.
- Why NULL is its own state: the way to stop invention is not to prohibit it, but to offer "nothing there" as a normal thing to write down.
- The three states distinguish whether the check happened. Whether requirements are met is not a state; unmet items are recorded separately.

### 5.2 Lookup cascade

The order below is a search order, not a trust tier. Once a value is confirmed at an earlier source, the lookup stops there. No per-source trust weights are computed.

user_answer → instruction → pre_set_data → measured_data → prior_state

- user_answer: a response the user entered directly after an ask_user interaction. Empty on the first round.
- instruction: a value taken, with its location specified, from a segment the user typed directly.
- pre_set_data: settings the user approved and stored in advance. A value that was used can become pre_set_data with the user's approval.
- measured_data: system state confirmed on the spot by calling a system API. The lookup must be a live measurement.
- prior_state: a value inherited from a previous execution that the record confirms was executed. Applies to values only; conditions are not inherited. Inheritance alone does not confirm a slot. The value counts only after the user confirms it.
  - A value found at this source does not end the lookup. Once the user confirms it, it is confirmed as user_answer.
- If no value is confirmed by the last step, the slot is fixed at UNKNOWN. Even when the model offers a value, that is only a claim about a location, and the gate checks whether a value is actually there. This structure does not assume the model is honest.

### 5.3 What instruction covers

- Users start vague and settle on a tool after several exchanges. So instruction covers not just the last prompt, but the whole conversation segment leading up to the point where tool use was settled.
- Implement it as a single prompt, and a value mentioned N turns earlier (an account number, for example) is found in no source, which leads to needless re-asking.

---

## 6. Implementation

### 6.1 How to split checklist, principles, and code

- Checklist: items the owning party decides. They differ by tool, by user, and by regulation, and change without a deploy.
- Principles (prompt): items whose violation code can detect. The prompt is a way to reduce how often the gate catches something, and when it fails, the verdict still filters it out. An item whose violation cannot be observed from outside cannot live in the prompt. It has to become a slot, with a source and a slot state, before it can be observed.
- Code (gate): a procedure that is the same whoever the party is: counting, comparing, recording. It does not change as checklists grow.
- Prompts get diluted as a conversation grows long, and there is no way to confirm whether something was dropped. Principles are applied again in every tool-related exchange.

### 6.2 Principles

The six items below are examples of the preceding rules written as prompt sentences. They are not new rules, so violations are detected in the decision record. They can be added to or changed.

- Slots come from the checklist, values from lookup, and whatever is missing from the user and from observation. Do not assemble.
- If the timing is unclear, ask. Do not default to immediate execution.
- Fix at instruction time only what was confirmed by asking the user. Check again at trigger time whatever was filled in by lookup.
- Do not generate values. Search in the specified order. Point to a location, not a value.
- Record reusable values with the user's consent.
- Look up recorded values instead of asking again. Do not pull them from memory in the model's context.

The two items below are different in kind. They concern tool selection, so violations are not detected by code and are mitigated by the prompt only.

- Decide on the tool only after taking in when the user said to do it and what they called it.
- If there are two or more candidates, ask about the action without showing tool names.

### 6.3 Responsibilities of the code gate

- Build the checklist and count UNKNOWN slots. When Unknown Count == 0, judge the check complete. What is counted is whether checks happened.
- Compare each confirmed slot with its declared requirement, and record the ones that fall short as unmet. A requirement is the standard the checklist declares on the slot (for a value, whether it is required; for a condition, what prohibits or permits). This covers a confirmed condition that prohibits execution (hold) and a required value confirmed as NULL. Unmet items are not counted. The comparison must be deterministic. A condition that cannot be compared stays UNKNOWN and routes to definition repair.
- Walk the search order in 5.2, and check that a value actually exists at the location the slot points to.
- Route each UNKNOWN slot to one of the three routes in 4.5, and record the route taken on that slot in the decision record.
- Read labels, expand them into slots, and include them in the verdict.
- Bind each approval to a {slot_id, value} pair, invalidate it when the value changes, and record in the approval record the set of slots that were shown with it.
- Record the verdict. The gate's output is the decision record.

### 6.4 Decision record and execution record

- The record is the only grounds for the next execution.
- Runs that were not executed are recorded too.
- Which slot failed, and how, is recorded along with it.
- Records for the same execution unit accumulate under one key. Both instruction time and trigger time must be kept.

Field names and structure are up to the adopting system. The decision record must hold each slot's state, source, and kind; the route each UNKNOWN took; unknown_count; and the unmet items. When no verdict has been made yet, unknown_count is stored as a distinct value, not as 0.

```json
{
  "action_key": "u_1042:transfer_funds",
  "phase": "at_trigger",
  "tool_name": "transfer_funds",
  "slots": [
    {"slot_id": "recipient_account",     "status": "known",   "source": "user_answer"},
    {"slot_id": "amount",                "status": "known",   "source": "instruction"},
    {"slot_id": "daily_limit_check",     "status": "known",   "source": "measured_data"},
    {"slot_id": "account_balance_check", "status": "unknown", "source": null,
     "allowed_sources": ["measured_data"], "lookup_failed": true,
     "route": "definition_repair"}
  ],
  "user_checklist": [
    {"item_id": "confirm_recipient", "status": "known",    "source": "user_answer"}
  ],
  "unknown_count": 1,
  "unmet": [
    {"slot_id": "daily_limit_check", "reason": "prohibited"}
  ],
  "timestamp": "2026-03-11T09:24:07Z"
}
```

The executing party reads this record and writes its own decision to a separate record.

```json
{
  "action_key": "u_1042:transfer_funds",
  "ref_phase": "at_trigger",
  "actor": "executor",
  "execution_decision": "not_executed",
  "timestamp": "2026-03-11T09:24:09Z"
}
```

---

## 7. Operational consequences

### 7.1 Audit trail and accountability

With authority outside the model, decisions and accountability stay with the party that declared them. Which checklist an empty slot belongs to tells you where the work goes.

| What was inferred | What was not declared | Where the work goes |
| --- | --- | --- |
| **Value** | No source designated for looking up the value | Review backend API/DB integration |
| **Condition** | The condition was not declared | Fill in OpenAPI Specification / description metadata |
| **Intent** | Intent and permitted range were not declared | Improve UX and conversation flow design. Tool selection errors belong here too. |

- None of the three calls for a model training budget. What changes is not how fast things improve, but what kind of improvement is made.
- Today, an agent's anomalies are attributed to the agent developer inside the organization and to the model outside it. Neither is the result of an investigation. Both are explanations left over because there is no record.
- When values and conditions are empty because the user didn't state them, the work goes to when the question is asked and how it is worded. Once conditions are declared, the items that belong to the provider separate out.
- A case routed to 4.5 (c) because the middleware couldn't interpret a condition is a problem in the parser and the lookup path. It belongs to the implementation side and is not handed to the user or the provider.

### 7.2 What adoption brings

- Conditions become something to verify. A validator that only looked at values now walks the conditions too.
- Rules become data. A tool provider's conditions, your own rules, and rules from policy bodies, companies or regulators all register as a line in a checklist, change without a deploy, and can be listed in full.
- Adding a tool does not change the execution path. A new tool adds a declaration, not new execution logic.
- Scaling cost is fixed and independent of model performance. Adding tools and conditions, or swapping the model, leaves the gate code unchanged.
- Questions don't multiply; they become visible. Values and conditions were always the user's to decide. Only the blanks go back to the user, and items that keep coming up are promoted to pre-set settings.
- Decision records become input for model development. You get data by failure type, and undeclared and unsourced cases are separated out.

### 7.3 Why now

- A provider declaring its rules in advance is meeting its responsibility, and the declaration stays on record. Writing conditions into the description is possible today.
- Incomplete human instructions and undeclared conditions won't be supplied by the next model either. If decision authority stays with the model, the capability that better performance adds widens its reach into deciding what was never declared.
- **The model cannot stand in for this. Only the party that owns a tool knows what the tool requires and which executions are irreversible.**
- There is no reason to wait. Nothing new is needed, and applied to even a single tool, it holds for that tool immediately.
- Prepare for disputes and insurance. Products that handle irreversible execution ship on the assumption that incidents will happen. A decision record cannot be created after the fact.
- The irreversible domain is expanding. In robotics and autonomous driving, irreversibility is even stronger. Writing checklists now is an early investment.

---

## 8. Residual risks and limits

### 8.1 Tool selection errors

- A tool name is a label, separate from what the tool can do. Different names can produce the same state change, and a matching name can come with a different capability.
- Tool selection is not verified by code. Narrow down to a single candidate without asking, and a tool may be chosen just because it is on the list. Whether it passes is then decided by that tool's input schema.
- Mitigation: state-change declarations depend on the description, so this point leans more on intent confirmation. Recording what the user calls the action helps.

### 8.2 Forged records and hook implementation

- Separating the verdict from execution exposes an execution without a verdict as an execution without grounds. It does not expose an execution grounded on a forged decision record.
- This specification does not define how hooks are implemented. If a hook calls a model to decide, that decision is probabilistic, and the gate does not check what the hook returns.

### 8.3 Conflicts between requests and conditions

A user may try to lift a condition the provider has prohibited. This specification does not decide that conflict. Provider conditions do not list user answers as an allowed source, so the user's request does not change the comparison result. The condition stays checked and unmet (hold), and the record shows who declared what and who requested what.

Whether to allow the request is decided by regulators' rules or the adopting system's policy. This specification supplies the record that decision needs. If the agreement changes, the new rule is reflected as one line in the checklist.

### 8.4 Alternatives considered

Putting the checklist in the prompt and receiving JSON back hands the authority to decide what to ask back to the model. If the model is the one judging that a slot is empty, its report that the slot was filled cannot be verified from outside. This specification requires two things: the checklist lives outside the prompt, and code does the counting.

---

## 9. Relationship to prior work

This specification does not criticize or replace what recent frameworks have achieved. It builds on them. Those achievements are isolating tools and context behind a protocol (MCP), binding output to a schema so that values and their sources can be extracted together, and agent orchestration (LangGraph and others).

### 9.1 Provenance-based gates and clarification research

Provenance-based gates have been explored in injection defense, and the blank problem in research on asking clarifying questions. This specification sits between the two.

| Area | Target problem | Who judges | Focus |
| --- | --- | --- | --- |
| **CaMeL ([arXiv:2503.18813v2](https://arxiv.org/abs/2503.18813v2)) / Fides ([arXiv:2505.23643v2](https://arxiv.org/abs/2505.23643v2))** | Unauthorized actions caused by prompt injection and information flow | Policy and information-flow control outside the model | Controlling malicious external input and information flow |
| **Ask-when-Needed ([arXiv:2409.00557v4](https://arxiv.org/abs/2409.00557v4))** | Missing arguments and unclear instructions | The model's judgment (prompt-guided) | Recovering missing information by asking back |
| **This specification** | Omissions and guesses that occur even without an attack | Verification code outside the model | Declaring what to check, having code judge unconfirmed state, and separating the verdict from execution |

---

## 10. Conclusion

- This specification is not a technique for removing hallucination. The model's output remains, as it is, the input for preparing execution.
- Its goal is not to block execution, but to establish what execution needs and settle an executable state. Safety follows from that.
- The black box is not fully opened. What is opened is what went into the verdict and what came out. After an incident, what you usually need is not the model's internal state but where the values came from, so this scope answers a good share of the questions.

The authority to decide what gets checked and the authority to judge whether it was checked belong outside the model. Things went wrong not because these authorities were in the model, but because they were nowhere. The model filled the empty place. What narrows is the model's authority. What widens is what the model can be used for.

---

*This is the English version of [spec.ko.md](./spec.ko.md). If the two differ, the Korean version takes precedence.*
