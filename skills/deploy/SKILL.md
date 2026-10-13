---
name: deploy
description: Deploy the current base branch of a factory project with the profile's deploy commands (migrate, deploy, wait, smoke check). Only when the user types /factory:deploy [job-id].
argument-hint: "[job-id]"
disable-model-invocation: true
---

# Deploy

Arguments: $ARGUMENTS (optional job id, a unique prefix such as `004` is fine; its job gets the `deploy.log`).

Board script: `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"` (run from the project root).

1. If `factory/profile.md` has no `deploy` command, explain the deploy keys (see `${CLAUDE_PLUGIN_ROOT}/templates/profile.md`), offer to fill them in for this project, and stop.
2. Run `deploy [<id>]` with a long timeout (up to `deploy_timeout` seconds, 20 minutes by default).
   It deploys what is committed on the base branch:
   - `migrate`, when migration files changed since the last good deploy;
   - `deploy`, then `deploy_wait`;
   - the `smoke` check of the live url.
3. Report the result: the commit, the live url, and the jobs it shipped.
   On failure, show the failed `step` and the end of the log.
   A failed `migrate` deployed nothing; for a failed `deploy`, `deploy_wait` or `smoke`, the site may be on the old or the new version, so check the url.
