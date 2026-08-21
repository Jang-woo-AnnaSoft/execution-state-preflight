# Who Fills In the Form — We Only Sign What the Model Drafted

Ask when you don't know. Everyone puts that in the prompt. And the model does ask. When a value is missing, it asks the user.

The problem is upstream. The model decides what to ask about. It asks about whatever appears to be missing. So if it cannot recognize that it does not know something, it does not ask, and if it fills an empty slot itself, there is nothing left to ask about. No matter how strongly the instruction is written, it gets stuck at the same point.

## The signature stayed, the drafting moved

A form used to have five steps. The user decided when and under what conditions to act, selected the form, entered the values, checked where those values came from, and confirmed that every required field was filled. Entering the values was also a human task. A person looked at each blank, filled it, and then pressed confirm.

A person still confirms at the end. Approval has not gone away. What moved is the **first draft**. The model fills in the values inside the form. The person now looks at the form presented to them and signs it.

So the nature of the check changes. It is no longer "is this right?" but "shall we go ahead?" The first requires judgment; the second is simply a pass-through. Ask someone to approve what you have shown them, and you get click-through rather than review.

Worse, the form looks clean. If it looked ragged, you would notice immediately. But a looked-up value and an invented value look identical, so reading the form tells you nothing, and a missing condition never appears on the form at all. Nothing reveals that you are approving a field you never actually checked.

So what needs to be taken back is not the signature. It is the drafting.

## The shift

Treat what happens before execution not as validation, but as a place that **asks questions using an external list**. Seen as a validator, the work becomes about refining the criteria for a verdict. Seen as a place that asks questions, the work becomes about what gets asked.

> Solve it by making the model more accurate → An external list decides what to ask, and the model asks the questions.

That one line is the argument of this piece. The existing approach already asks questions. What matters is what decides what to ask.

You can ask for confidence about what is there. You cannot ask for awareness of what is missing. That is why even an experienced surgeon uses a checklist.

What goes into the form is not something to infer, but something to look up, and for that, the only place to look is the user. Better computation does not make missing information exist.

Errors surface. A wrong computation leaves no visible trace, but when you ask, the user says no. A correction path appears.

**And this is where the role of the list is settled.** If what to ask is not defined externally, that judgment goes back to the model.

## Change the goal

Two terms are defined up front. A **slot** is one line item that has to be confirmed for this execution. An **unknown** is a slot that remains empty after every designated source has been checked.

Make the goal of the computation the list of unknowns, not the decision of whether to execute. Whether to execute follows from the length of that list; it is not the goal itself. Correcting a wrong answer also becomes a matter of filling one slot.

If the goal is execution, an ordering emerges between slots. If the goal is the list, the slots no longer relate to one another. Adding a step sounds like it would be slower, but it is the opposite: lookups run in parallel, they are memory comparisons rather than extra inference calls, and the round trips spent asking about blanks one at a time collapse into one.

If the goal is the list, the verdict is separated from execution. If execution accepts only a recorded verdict as its basis, there is no path that runs without one.

The rest follows from here: there has to be a list of what is needed, and it has to be divided by where it lives.

## So what list

There are three ways execution goes wrong today.

- **Wrong execution** — the value was wrong. An invented account number, an invented ID.
- **Uninstructed execution** — there were no conditions. It ran without checking authority or timing.
- **Off-target execution** — the intent wasn't caught. That was not what the user meant to do.

So the list needs three things as well: values, conditions, and intent.

Two of these already exist: the **tool list** and the **input schema**. Nothing new needs to be built. The additional information goes here.

### Values alone aren't enough

The input schema holds values, and nothing else. But conditions also have to be filled before something can run. Is the balance sufficient? Does the recipient exist? When does this happen? Under what circumstances? Is there authority? Have safety considerations been addressed? This is where every argument is present and every type checks out, yet the action still must not run.

Put values and conditions on the same list, and there is one way to handle both. Both are slots; each is either filled or not. No separate machinery for conditions is needed.

There is no need to ask anyone to write conditions from scratch. Providers already write them in the tool description. There is simply no way to confirm that the model recognized that free text and acted on it.

Intent becomes a slot in the same way: what the user calls the action, and what change the user wants. If a tool is chosen while these remain empty, the result is an off-target execution.

A name is a label; what a tool can do is separate. One provider may call "turn off the living room light" `turn_off_light`, another may call it `set_device_power`, while `light_control` might only adjust brightness. So matching has to be based on **whether the tool can produce the state change the user wants**, not on matching names.

### So here is how the list is organized

The axis for dividing the slots is who can answer them.

**Fixed checklist** — attached to every execution.

- Which tool to choose
- Whether the execution conditions are met — the timing and the circumstance
- What the user calls this action

**Provider checklist** — differs per tool.

- Required fields, types and formats, pre-execution confirmation, prohibiting conditions, extra-approval conditions
- What changes if it runs — the state change this tool can produce

**User checklist** — differs per user and environment.

- Intent, current context, execution limits, pre-execution confirmation, preferences

The fixed side is intent and context. The provider and user sides are values and conditions.

## Where to look

A lookup is only a lookup if each slot has a designated source.

> The user's answer → the instruction → preset values → observed values → prior state

**This is a search order, not a trust ranking.** It does not mean that earlier sources are more reliable. It means that when an answer is found, you stop there.

**If it is still empty after checking every source, it is an unknown.** It is not the model declaring that it does not know. It is what remains after the search ends. If the value is needed, ask the user.

Needed values get answered by the user. No inference.

### Telling it to exclude won't work, giving it places to look will

The instruction "search, but leave out what you inferred" does not work. What was left out is not visible from outside, and the instruction cannot be carried out in the first place. Since a value that was retrieved and a value that was invented look the same, asking the model to leave things out amounts to asking it to classify its own output after the fact, and that classification is inference again.

So it has to be a whitelist, not a blacklist. Not: look at everything and subtract the inferences. Instead: define what may be looked at, add one item at a time, and record the source. Then nothing needs to be classified.

The same goes for the slot list. Not "don't omit anything you need to confirm," but writing down everything to be confirmed. An instruction not to omit anything only works for someone who knows what they omitted, and that is precisely what the model cannot do.

### No result and unknown are different

The model records what it finds at the source it checked, and if nothing is there, that is **no result**. They are two outcomes of the same action, not two different judgments. **Unknown** is the state that remains outside, after all those reports come in.

Unknown should not be part of the model's vocabulary. Make *unknown* a legitimate entry and the model gains one more answer it can choose. It has to be able to write "no result," because when there is nothing to write, it invents. Filling a blank when one is encountered is trained behavior, not a defect, so it does not disappear simply by being forbidden. **What stops invention is not a prohibition, but a place to say there is nothing.**

### How far does the instruction reach

Tool use is rarely decided by a single instruction. The user starts with a vague request, a few exchanges narrow down what they are trying to do, and the tool is settled at the end. So the scope of the conversation is not a single exchange in which a blank is asked about and answered. It is the entire interaction leading up to the point where tool use is decided.

That also defines the scope of the instruction. If the instruction used as a value source is limited to the last prompt, an account number mentioned three turns ago has nowhere to be found. The instruction therefore covers the entire conversation, and the number of values that do not need to be asked for again grows accordingly.

## Split it into principles and code

> **A principle can only be used where code can catch a violation. Anything whose violation would otherwise go unnoticed has to live in code.**

- Take slots from the list, values from lookup, and what is absent from the user. Do not assemble.
- Recognize when it was requested and what it was called, then decide the tool.
- If the timing is unclear, do not default to immediate execution. Ask.
- If more than one candidate remains, do not show the tool names. Ask the user to clarify the action.
- Do not invent values; search in the fixed order. Point to the location, not the value.
- Values that will be used again should be recorded with the user's consent.
- What is recorded should be looked up, not asked again. Do not retrieve it from memory.
- Ask about blanks in one batch, naturally.

A principle is not a prompt. A sentence written into a prompt gets diluted as the conversation grows, and whether it has been lost is not visible from outside. A principle should sit outside the prompt, like the list, and be applied every time a tool is involved.

> **Note.** Tool selection is not caught by code. If the model narrows to one without asking back, that tool is on the list and has the required capability, so it passes every later stage. There is no way to move this into code, which is why it remains a principle and a residual risk. State changes also have to be written in the description rather than the schema, so this part relies more heavily on confirming user intent. Recording what the user calls the action is one way to help.

**Code** — break these and nothing shows from outside.

- Build the list and count it.
- Check the pointed-at location to confirm that the value is actually there.
- Read the labels and enforce them. Bind approval to the `{slot, value}` pair so that the approval becomes invalid if the value changes.
- Record the verdict, and let execution accept only that record. Record what was blocked as well. If you keep only what executed, what caused the block disappears from the log.

All the code knows is **form**. Which slots are needed and what each label means are both data.

## What is left for the model

The model **looks up** values, code **counts** what is empty, and what remains gets asked in **conversation**. Only the remainder goes to conversation, so the number of questions does not multiply.

| | Where it comes from |
|---|---|
| Value | Lookup, or the user |
| Slot | The list |
| Verdict | Counting |
| Timing · the user's words | The user makes it, the model confirms it. If it can't be confirmed, conversation finds the common ground |
| Which tool | Matched from the list. What is not on the list can't be chosen |

**The making step disappears.** Not a constraint against inventing, but no room left to invent in. The shape of the execution is not assembled. Once the list is full, it is already there.

## The record produces audit and improvement

Execution starts from a record. That record contains every answer. Which field was empty, what was filled in incorrectly, which required field did not exist — a record from the moment of execution remains.

- **A field empty because the user did not say.** Asking resolves it.
- **A field absent because the provider did not declare it.** Asking does not resolve it. You cannot ask the user what this tool's preconditions are.

Right now, every anomaly in an agent lands in front of the agent developer. The cause may be an incomplete tool definition. Attach a source to the empty field and that case can be sent to the provider, and it remains in a form that can be sent. Responsibility is not being moved. The place where it already sat is being made visible.

What needs to be fixed is not only inside the agent.

> Everything to this point is required. The two sections below are about filling the same list from different sources, and skipping them leaves everything above running as it is.

## Internal rules

Today, internal rules live partly in prompts, partly in branches inside tool wrappers, and partly only as convention. The problem is less the scattering itself than what it makes impossible, and the fact that correct operation cannot be confirmed.

- Changing one rule requires a deployment.
- You cannot ask which rules applied to a given execution.
- You cannot explain why that case landed in the approval queue.

Once the list is structured this way, a rule you set for yourself can be added as one line in the same place. No separate code is needed to enforce the rule. **It means the code for that rule stops existing altogether.**

Policy bodies, companies, and regulators are the same in kind, so they can be added under the provider list without a separate axis. These are mostly conditions rather than values.

## Provider conditions, proposed as a minimal implementation

Nothing new needs to be written on the provider side. What is already in the tool description simply becomes one line on the list. **Once it is separated from execution, the answer "the condition was not met" can exist, and only then can the model verify the condition.**

- **[required]** — subject to source checking. If it is not in state, it goes on the unknown list.
- **[confirm]** — a slot that cannot be filled without user approval.
- **[notice]** — something the user should know in advance, during the conversation.

The description is already available to the middleware when the tool list is fetched. Since the vocabulary is fixed, extracting the labels is just string parsing.

Once this way of expressing conditions is established, it can then be added to the input schema as a format. Declare what each condition is checked against, and the three-label split can become more precise: whether it is user approval, or which state gets looked up and compared.

## Open questions

**How far does this apply.** Put only irreversible actions through it and let reads pass. If everything is immediate, the timing slot is not needed; if there is only one tool, the tool-selection slot is not needed; and some domains have no reason to hold user conditions. Even when the agent and the tool have the same owner, a list still has to be created, and the per-tool list can sit where the input schema sits.

**Won't this be unnecessary once models get better.** That would mean using model performance to fill in absent information, which does not hold. And this structure benefits from improvements as models improve. It is not about fixing the model. It is about not having to.

**Why not put the checklist in the prompt and get JSON back?** That hands the job of deciding what to ask back to the model. If the model is the one that judges whether a slot is empty, there is no way to verify its report when it says everything is full.

**Does this stop the wrong tool from being chosen?** Tool selection itself is outside this structure. It only narrows the candidates and forces a clarification; which of the remaining candidates gets picked is still the model's call. An invented tool is blocked because it is not on the list, and if state changes are declared, tools that cannot perform the requested change get filtered out as well. What remains is choosing the wrong tool among several tools that could all do it. That risk remains.

**What if the record is forged?** Separating the verdict from execution prevents execution without a verdict. It does not prevent a fabricated verdict.

## This builds on what recent frameworks have achieved

Isolating tools and context behind a protocol. Binding output to a schema so that the source comes out with the value. These are capabilities recently established by agent orchestration and frameworks such as LangGraph and MCP. So this is not a criticism of that direction, nor a call to reverse it. It builds on it.

## What this proposal claims

This is not a structure designed for safety. The aim is to know what is empty; safety follows from that. A value with no source cannot become an argument, a remaining blank halts execution, and without a verdict there is no path to execution. And when something goes wrong, the cause and the responsibility remain in the record.

Today, when an agent executes incorrectly, the only question available is "why did the model do that?" and there is no answer. Put the list outside, and the question changes. Which slot was empty? Which source failed to produce an answer? At which stage did it stop?

The black box does not open completely. Why that tool was chosen is still not visible. What becomes visible is what went into the decision and what came out. Since what you usually need to know after an incident is not the model's internal state but where a value came from, even that much answers part of the question.

**Asking is something models already do well. Keeping the model from deciding what to ask — that is the one thing that needs to move outside. And the missing parts of the list still have to be filled in.**
