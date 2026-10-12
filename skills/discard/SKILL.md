---
name: discard
description: Abandon a software factory job, deleting its branch and worktree. Only when the user types /factory:discard <job-id>.
argument-hint: "<job-id> [reason]"
disable-model-invocation: true
---

# Discard a job

Arguments: $ARGUMENTS (job id, then an optional reason).
A unique id prefix such as `004` is fine.

Board script: `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"` (run from the project root).

1. Run `show <id>`.
   If the job is already `merged` or `discarded`, say so and stop.
2. Tell the user what will be lost: the branch, and any commits on it that are not on the base branch (`git log <base>..<branch> --oneline`).
3. Run `discard <id> --note "<reason>"` and confirm.
