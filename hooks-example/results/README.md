# Results

Raw results of the repeated-run test in `hooks-example/`. The case report cites them in its section 4 ([case-muse-marketplace.en.md](../../case-muse-marketplace.en.md)).

Each `.jsonl` file is one run of `runner.js`. The first line is `kind: "meta"`: the code that produced the file (git commit, and a hash of every file that decides what a run does), the models, the arms, the prompts, the instructions and conditions, and the date mode. Every other line is one run, with what the arm did and, for arm C, the full gate record. The JSONL is the record. Everything else here is derived from it.

| File | What it is | Code | Runs | Cited in the case report |
|---|---|---|---|---|
| `run-plain-said-2026-10-26T08-36-04-505Z.jsonl` | Smoke run, before the extraction prompt quoted only the seller's text | `051ed42` | 140 (1 repeat) | Gate refusals of values pointed at other people's text |
| `run-plain-said-2026-10-26T11-35-44-960Z.jsonl` | Run 1 | `0fd62d0` | 700 (5 repeats) | All results, first run |
| `run-plain-said-2026-10-27T03-27-32-125Z.jsonl` | Run 2, independent | `ad64c0f` | 700 (5 repeats) | All results, second run |
| `run-plain-said-2026-10-27T02-16-29-053Z.jsonl` | Run 2's first attempt. The codespace stopped on its 30-minute idle timeout and the run ended at 327 of 700. Not analysed | `ad64c0f` | 327 of 700 | No |

All runs: `claude-opus-5-5` and `claude-sonnet-5-5` on the Anthropic API, arms A and C, date mode `said`, provider defaults, no sampling parameters sent.

Between run 1 and run 2 the code changed in two places: an allowed-source declaration (`tool.js`, `hooks.js`) that has no effect on these instructions, and the analyzer (`analyze.js`, `provenance.js`, which no arm loads). The meta line of each file names the exact hashes.

## Analyzer output

For each analysed run there is a `.analysis.txt` (what `analyze.js` prints) and a `.summary.json` (what it writes). All three were produced by the same analyzer, the one at commit `ad64c0f` (`analyze.js` `cd3c93eb3407`, `provenance.js` `d80e4b0446f1`). That analyzer is newer than the smoke run and run 1. It splits G5e from G5f, compares dates when the seller's words fix one, and counts a place that contains a trap value as the trap. Output printed when those runs were made can differ in those places. Every verdict and every pooled number for run 1 is the same either way.

The smoke run's analysis marks 5 cells (and 3 pooled rows) NOT CLEAN. They hold the 7 opus extraction calls that ended in a refusal (`stop_reason: "refusal"`) before the extraction prompt was changed. The gate recorded them as `definition_repair` and executed nothing.

## Reproducing

```bash
cd hooks-example
node analyze.js results/run-plain-said-2026-10-27T03-27-32-125Z.jsonl
```

The analyzer reads the declarations from the file's own meta line, not from the checkout, so an older file is analysed against the instructions and conditions it was run with. To run the test again, see `../README.md` ("돌리는 법"): `npm run run1` makes a new file here.
