# From Inference to Provenance Lookup

**Unknown is a normal state.**
- Arguments are never generated.
- Only the provenance chain is looked up.
- All five tiers are checked. If all are empty, the field is `unknown`.
- If even one `unknown` remains, do not execute — ask, and record.

## Provenance Chain

| # | Source | Meaning |
|---|--------|---------|
| 0 | `user_answer` | Answered by the user after an `ask_user` |
| 1 | `instruction` | Taken from a trusted segment, with a span |
| 2 | `pre_set_data` | Settled earlier through a decision path |
| 3 | `measured_data` | Observed from the environment |
| 4 | `prior_state` | Inherited from a prior `executed` record |

The first hit wins — lower tiers are not consulted. If every tier is empty, the answer is `unknown`, never a guess.

## What a blocked call looks like

`to_account` was never supplied, so the gate holds. The other two fields are known, and each one names where it came from.

```json
{
  "action_key": "u_01:bank.transfer",
  "fields": [
    { "name": "to_account", "status": "unknown", "source": null },
    { "name": "amount",  "value": 50000,  "status": "known", "source": "instruction" },
    { "name": "balance", "value": 820000, "status": "known", "source": "measured_data" }
  ],
  "gate": {
    "unknown_fields": [{ "name": "to_account" }],
    "unverified_checklist": [{ "id": "chk_recipient" }]
  },
  "execution_decision": "ask_user",
  "reason": "ask_user: unknown_fields=1, unverified_checklist=1"
}
```

Records accumulate under one `action_key`: `ask_user` → `execute` → `executed`. Only `executed` becomes the baseline for tier 4 on the next run.

## Files

- **[execution-state-preflight.js](./execution-state-preflight.js)** — the skeleton. Read it from the top; the header comment explains how the rest is organized.
- **[`lookupField`](./execution-state-preflight.js#L180-L242)** — the core. If you read one function, read this one.

## Status

This file is a specification, not a library. Hooks marked `[REQUIRED-OP]` throw `not implemented` by default, and `createPreflight` refuses to build without them. Layer boundaries are deliberately left to the adopting system.

## Reference

This code is the reference implementation of
[**If unsure, ask. Never guess. — AI Agent Pre-Execution Checklist**](https://discuss.huggingface.co/t/if-unsure-ask-never-guess-ai-agent-pre-execution-checklist/176632).

---

## Ownership & License

Copyright © 2026 AnnaSoft Inc. (Republic of Korea)

**Commercial Licensing** — A commercial license is required only for organizations with annual revenue of USD 1 billion or more that commercially deploy products or services based on this work. All other use is permitted free of charge.

Contact: hello@anna.software
