# mend-patch-tool

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ocoyan31-sys/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ocoyan31-sys/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. AI models write edits as unified diffs (often
with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, or text-editor tool calls as JSON;
mend reads all four, finds the lines each edit names at the first of three matching tiers (exact,
trailing-whitespace-insensitive, fully whitespace-insensitive with re-indentation), and writes
every change or none, printing what it changed or why it failed. It creates, deletes and moves
files, preserves each file's own line breaks and final-newline state, honours `--check` (dry run)
and `--strict` (exact matching only), and runs on Node 22 with the standard library alone.
SPEC.md is the full contract it implements.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

---
<sub>Entered on [make.fun](https://make.fun/?ref=z9jnae29&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
