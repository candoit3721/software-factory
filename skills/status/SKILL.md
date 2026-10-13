---
name: status
description: Show the software factory jobs of the current project and their stages. Use when the user types /factory:status or asks how factory jobs are doing.
---

# Factory status

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" list` from the project root.
Show the jobs as a short table: id, stage, round and the latest review verdicts.

Then:
- if any job is `needs-human`, name it, give its preview url if `list` shows one, and mention `/factory:preview <id>`, `/factory:approve <id>` and `/factory:rework <id> <note>`;
- if `factory/profile.md` is missing, say the factory is not set up here and mention `/factory:init`.
