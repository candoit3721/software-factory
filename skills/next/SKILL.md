---
name: next
description: Start a software factory job for the first open item in factory/backlog.md. Use when the user types /factory:next.
---

# Next backlog item

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" next` from the project root.
2. If `item` is null, say the backlog is empty (or every open item already has a job) and stop.
3. Otherwise read `${CLAUDE_PLUGIN_ROOT}/reference/job-loop.md` and follow it from step 0, with:
   - the item text as the request;
   - plugin root `${CLAUDE_PLUGIN_ROOT}`;
   - `--backlog "<item>"` added to `BOARD new`, so the item is checked off when the job merges.
