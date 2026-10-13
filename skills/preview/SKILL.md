---
name: preview
description: Run the app of a software factory job from its worktree, so a human can try it before approving. Use when the user types /factory:preview <job-id>, or asks to see or try a job's changes.
argument-hint: "<job-id> [stop]"
---

# Preview a job

Arguments: $ARGUMENTS (a job id, a unique prefix such as `004` is fine, then optionally `stop`).

Board script: `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"` (run from the project root).

1. Without a job id, run `list`, show the `needs-human` jobs and their previews, and stop.
2. With `stop`, run `preview <id> --stop` and confirm.
3. Otherwise run `preview <id> --open`.
   It starts the profile's `preview` command in the job's worktree on a free port (or reuses a preview of the same commit), waits until it answers, and opens it in the browser.
   - On success, give the user the `url` and remind them of `/factory:approve <id>` and `/factory:rework <id> <note>`.
   - If the profile has no `preview` command, offer to add one to `factory/profile.md` (it must listen on `$FACTORY_PORT`).
   - If it did not start, show the end of `preview.log` from the error.

The preview stops by itself when the job is merged, discarded or sent back for rework.
