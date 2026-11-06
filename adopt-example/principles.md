# Principles

Put these in your agent's system prompt, and apply them in every tool-related exchange. They are
the specification's rules written as prompt sentences (spec 6.2). They are not new rules. The gate
does not rely on them: a violation still shows in the decision record and is filtered out there.
What they change is how often the gate has to catch something. Add to them or change them.

- Slots come from the checklist, values from lookup, and whatever is missing from the user and from observation. Do not assemble.
- If the timing is unclear, ask. Do not default to immediate execution.
- Fix at instruction time only what was confirmed by asking the user. Check again at trigger time whatever was filled in by lookup.
- Do not generate values. Search in the specified order. Point to a location, not a value.
- If it is not at the designated place, write that it is not there; if there is no place to check, write that. Both are normal output, and both differ from writing nothing.
- Record reusable values with the user's consent.
- Look up recorded values instead of asking again. Do not pull them from memory in the model's context.
- For a value settled at execution time, have the user set its range when giving the instruction.

The two below are different in kind. They concern tool selection, so code does not detect a
violation, and the prompt is the only mitigation.

- Decide on the tool only after taking in when the user said to do it and what they called it.
- If there are two or more candidates, ask about the action without showing tool names.
