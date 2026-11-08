# Cross-check: someone else's cases through the actual skeleton

`run_crosscheck.js` runs a case file written in this skeleton's input shape through the real `execution-state-preflight.js`, and compares the decisions with the case authors' own expected results.

It was built for the case file the covenant project shared in the Hugging Face thread ["We gave AI a trust we never gave people"](https://discuss.huggingface.co/t/we-gave-ai-a-trust-we-never-gave-people-the-third-axis-after-capability-and-permission/183807): transaction cases where someone claims consent to use another party's card or account, with each hook's output given as case data, and expected decisions computed by a Python port they wrote from the text of this code. Their files are in their [gist](https://gist.github.com/LAWLESS1987/117e08135744b6f79c95005744bcb2a7) and are not copied into this repository.

## What it tests, and what it does not

**It tests what the skeleton decides, given the claims.** Every hook here is a stand-in that returns the case data: the located C2 claim, each extractor result, each measurement, each provider verdict. So a match says that the case authors' port and this skeleton agree on the decision logic.

**It does not test `hooks.js`, extraction, or real measurement.** The claims are assumed correct. Nothing here says how good a model's claims would be, or whether a record that a measurement reads is genuine.

**It runs none of the case authors' code.** `cases.json` and the expected-results file are read with `JSON.parse` and used as data.

## Run

```bash
cd hooks-example
npm run crosscheck -- path/to/cases.json path/to/esp_results.json --out results.json
```

The expected-results file and `--out` are optional. Without the expected file it prints the skeleton's decisions per variant only. `--out` writes case IDs, variants and decisions, with no case text, so it can be shared without the case file.

Before comparing, it checks each located claim: the text at the claim's span must be the claimed value. A claim that points elsewhere is printed as a `CASE DATA` warning. A stale span stops a run at the intent gate or rejects the value, so every variant can agree for a reason the case was not written to test.

## Case-data conventions

These follow the case authors' runner.

- Each transaction case has `esp_base` (`input`, `measured_data`, `hooks`) and named `variants`; a run is `esp_base` composed with one variant (`provider_conditions`, `provider_verdicts`, `provider_verifier`, `measured`, `ask_attempt`).
- In `hooks`: `c1` is what `classifyWhenCase` returns, `c2_claim` what `extractUserActionName` returns, `tool_match` what `confirmToolNameMatchesIntent` returns, and `extract[field]` what `extractFromInstruction` returns for that field.
- A missing key is `undefined` (no report). `{"__throw__": "message"}` means the hook threw.
- A provider condition is verified by `provider_verdicts[condition id]` when given. Otherwise, with `provider_verifier: "measured"`, it reads `measured_data[condition.measured_key]` as `{ valid, value }` and reports `measured_data` as the source: `value: true` is `checked`, `false` is `unmet`, no measurement is `unverified`.
- `hooks.candidate_slots`, when given, is what an adopter's `getCandidateSlots` override returns. Without it the skeleton's own candidate set is used. Cases that need it are listed under `candidate_set_cases`, and their expected results under `candidate_set`. `runner-test.js` checks this wiring with a case written here.
- A deferred instruction-time decision is also run as the trigger would run it (`c1` set to `immediate`), and that decision is the one compared.
- The cases are written in the skeleton's earlier input shape. The gate now reads the tool, the measurements and the user's replies through its ports, so the runner hands the case data to them unchanged: `input.mcpTool` is what `readToolDefinition` returns, `measured_data` what `measure` reads, and the tool call is `{ name: input.mcpTool.name }`.
- A reply counts only for a question the unit was asked, in the user's words after it, and the gate counts each route's tries from the unit's records. So each case run is one unit: one key, one storage, for all its rounds. A case whose `input` carries `userAnswers` or `checklistAnswers` is read as the round after the question: the runner first runs the round that asked (showing each value in `userAnswers` for the user to approve), then appends the user's reply to the instruction, where `readReplies` finds a yes to each value and a yes or no to each item. A reply to something that round did not ask is refused. The asking round is a recorded ask, so it counts toward the ask ceiling with any `ask_attempt` the case gives (the larger of the two is used).
- Validators: the cases do not exercise them, so the runner reports values checked, unless `hooks.validators` is `"default"` (the skeleton's own, which cannot check and send the run to definition repair).
- Case-data keys this runner does not wire yet (`span_support`, `allowed_sources`, `checklist_verdicts`, `supplied_unsafe_hooks`) stop the run with an error rather than being ignored.

## Results so far

The first case file (34 transaction cases and a trust-label case, 253 case/variant runs), against the skeleton at `6604c31`:

- The skeleton's decision, phase and one-line summary matched the authors' expected results in all 253 runs. The same held for the skeleton before the candidate-set fix (`699158e`), because no case in the file narrows the candidate set.
- Four cases (`H10-ai`, `H11-ai`, `H12-ai`, `P04-ai`) have spans shifted by two to four characters, apparently from renaming parties before posting. Their runs all stop at the intent gate (`ask_user`), in the port and in the skeleton alike, so they did not reach the owner condition. With the spans corrected they follow the same pattern as the other cases.

The second case file adds 18 variants (revoked and altered approvals, and a positive control) and one candidate-set case, `N01-narrow`, against the skeleton at `89f894d`:

- The skeleton's decision, phase and one-line summary matched the authors' expected results in all 271 transaction runs and in `N01-narrow`. The four cases above have corrected spans, and no located claim raised a `CASE DATA` warning.
- `N01-narrow` narrows the candidate set to `purpose`, so `card` and `amount` are never looked up. It is `definition_repair` with both slots routed. Against the skeleton at `699158e`, before the fix in `fb5366d`, the same case executes.
- Seven runs execute where a secure outcome would not, and the authors tagged each one. Three are the approval binding that spec 6.3 requires and the skeleton does not implement: an approval given for another amount still reads as given. Two are a withdrawn `[Verify]` approval that the verifier still reports. Two are a `[Required]` verifier that returns a stale `checked` from a system source. The skeleton takes a verdict's status and source as reported, so those are the verifier's contract, not the gate's.
