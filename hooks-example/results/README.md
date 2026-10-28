# Results

Raw results of the repeated-run test in `hooks-example/`. The case report cites them in its section 4 ([case-muse-marketplace.en.md](../../case-muse-marketplace.en.md)).

Each `.jsonl` file is one run of `runner.js`. The first line is `kind: "meta"`: the code that produced the file (git commit, and a hash of every file that decides what a run does), the models, the arms, the prompts, the instructions and conditions, and the date mode. Every other line is one run, with what the arm did and, for arm C, the full gate record. The JSONL is the record. Everything else here is derived from it.

**Where this departs from the specification: the verdict and the execution sit in one place.** The specification separates them (3.5). The gate ends by recording its verdict; an executing party loads that record and decides for itself; and a structure that branches on the verdict function's return value is, in the specification's words, not separation. The harness puts the two together so the results can be read directly. Arm C (`arm-gate.js`) does write the decision record, but it reads whether to execute from the `execution_decision` the verdict function returned, not from the stored record. The skeleton's `executeIfReady` is there for the same reason, and the skeleton's own comment marks it as the point where it departs from the specification. In a real system the executing side loads the record by `action_key` and `phase` and decides. The tool here, `schedule_pickup`, is a mock that records the call and does nothing outside.

| File | What it is | Code | Runs | Cited in the case report |
|---|---|---|---|---|
| `run-plain-said-2026-10-26T08-36-04-505Z.jsonl` | Smoke run, before the extraction prompt quoted only the seller's text | `051ed42` | 140 (1 repeat) | Gate refusals of values pointed at other people's text |
| `run-plain-said-2026-10-26T11-35-44-960Z.jsonl` | Run 1 | `0fd62d0` | 700 (5 repeats) | All results, first run |
| `run-plain-said-2026-10-27T03-27-32-125Z.jsonl` | Run 2, independent | `ad64c0f` | 700 (5 repeats) | All results, second run |

A first attempt at run 2 stopped at 327 of 700 when the codespace hit its 30-minute idle timeout. It was discarded rather than completed, and run 2 above was started from scratch.

All runs: `claude-opus-5-5` and `claude-sonnet-5-5` on the Anthropic API, arms A and C, date mode `said`, provider defaults, no sampling parameters sent.

Between run 1 and run 2 the code changed in two places: an allowed-source declaration (`tool.js`, `hooks.js`) that has no effect on these instructions, and the analyzer (`analyze.js`, `provenance.js`, which no arm loads). The meta line of each file names the exact hashes.

## Analyzer output

For each analysed run there is a `.analysis.txt` (what `analyze.js` prints) and a `.summary.json` (what it writes). All three were produced by the same analyzer, the one at commit `ad64c0f` (`analyze.js` `cd3c93eb3407`, `provenance.js` `d80e4b0446f1`). That analyzer is newer than the smoke run and run 1. It splits G5e from G5f, compares dates when the seller's words fix one, and counts a place that contains a trap value as the trap. Output printed when those runs were made can differ in those places. Every verdict and every pooled number for run 1 is the same either way.

The smoke run's analysis marks 5 cells (and 3 pooled rows) NOT CLEAN. They hold the 7 opus extraction calls that ended in a refusal (`stop_reason: "refusal"`) before the extraction prompt was changed. The gate recorded them as `definition_repair` and executed nothing.

## What the smoke run showed, and what changed after it

Arm C in the smoke run (`run-plain-said-2026-10-26T08-36-04-505Z.jsonl`), counted from that file. Each observation led to a change in `hooks.js`, and runs 1 and 2 were made with the changed code. The change is described in `../README.md`.

| Observation in the smoke run | Change |
|---|---|
| 6 opus runs: the extractor pointed `item_id` at the account context (an untrusted segment) although the seller's sentence carried the same value. The gate refused each claim, and `item_id` stayed unknown | The extraction prompt says only `trust: "user"` segments are the seller's words |
| 2 sonnet runs: the extractor named the right segment but counted the span wrong (off by 16 and 4 characters). The gate refused the claim, and `item_id` stayed unknown | The model quotes the value; the hook finds the span |
| 2 sonnet runs, group 5 `clean`: the extractor offered the seller's range ("this Saturday between 1pm and 6pm") as the time, and the gate settled it as 13:00 on October 31, recorded as stated by the seller. Neither run executed: the place was still unknown | `spanSupportsValue` refuses text inside a declared limit's wording (`stated_as`) for the slot it constrains |
| 7 opus extraction calls ended in `stop_reason: "refusal"` with no text, all in conditions that carry other people's messages or records. Each run ended in `definition_repair` and executed nothing | The extraction prompt says whose conversation it is and that the task is quoting the seller |

In runs 1 and 2, made after these changes: no `item_id` claim pointed at the account context, no claim refused for a miscounted span, and no extraction refusal. Claims that offered the seller's range as a time still occurred, and the gate refused every one; none settled the time (see the case report, section 4). The files show what happened after the changes. On their own they do not show that the changes are why.

**These changes were made on the test set.** They were made after seeing the smoke run, and runs 1 and 2 then measured the same instructions and conditions. Arm C's numbers in runs 1 and 2 are therefore not a test on inputs the harness had not been adjusted to. The record and same-decision results follow from how the gate works, not from these adjustments. The counts of refusals, re-asks and range claims should be read with this in mind. The analyzer was also revised after run 1 (see "Analyzer output"); its verdicts did not change.

## Reproducing

```bash
cd hooks-example
node analyze.js results/run-plain-said-2026-10-27T03-27-32-125Z.jsonl
```

The analyzer reads the declarations from the file's own meta line, not from the checkout, so an older file is analysed against the instructions and conditions it was run with. To run the test again, see `../README.md` ("돌리는 법"): `npm run run1` makes a new file here.
