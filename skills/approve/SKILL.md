---
name: approve
description: Approve a software factory job that is waiting for a human, then verify and merge it. Only when the user types /factory:approve <job-id>.
argument-hint: "<job-id>"
disable-model-invocation: true
---

# Approve a job

Job: $ARGUMENTS

Board script: `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"` (run from the project root).

1. If no job id was given, run `list`, show the `needs-human` jobs and stop.
   A unique prefix such as `004` is fine: match it against the ids from `list`.
2. Run `show <id>`.
   If the stage is not `needs-human` or `approve`, say what stage it is in and stop.
3. Run `verify <id>`.
   This merges the latest base branch into the job and runs the full check.
   If it fails, show the tail of `verify.log` and suggest `/factory:rework <id> <note>`, then stop.
4. Run `merge <id>`, and report the merge commit.
