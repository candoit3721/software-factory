---
name: rework
description: Send a software factory job back to the builder with human feedback, then run it through verify, review and approval again. Use when the user types /factory:rework <job-id> <feedback>.
argument-hint: "<job-id> <feedback>"
---

# Rework a job

Arguments: $ARGUMENTS

The first word is the job id (a unique prefix such as `004` is fine).
The rest is the feedback.

Board script: `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"` (run from the project root).

1. Without an id or feedback, run `list`, show the active jobs, ask for both, and stop.
2. Run `show <id>`.
   If the stage is `merged` or `discarded`, say so and suggest `/factory:new` instead, then stop.
3. Append the feedback to the job's `request.md`, under a heading `## Human feedback (<date>)`.
   `paths <id>` gives the file paths.
4. Run `stage <id> build --note "human feedback"`.
5. Read `${CLAUDE_PLUGIN_ROOT}/reference/job-loop.md` and follow it from **step 3 (build)**, with:
   - plugin root `${CLAUDE_PLUGIN_ROOT}`;
   - the human feedback as the builder's rework input.
