# Factory job loop

Shared by `/factory:new`, `/factory:next` and `/factory:rework`.
The skill that sent you here says which step to start at.

## Your role

You are the **orchestrator**.
You run the loop below, spawn every agent, and run the board script.
You **never** write specs, code, reviews or decisions yourself, and you never edit job files.
Agents get all context from files, never from this conversation.

The board script prints JSON.
Run it from the project root:

```bash
node "<plugin root>/scripts/board.mjs" <command> ...
```

The skill that sent you here gives the plugin root.
Below, `BOARD` means that command.

The agents are `factory:spec-writer`, `factory:builder`, `factory:reviewer` and `factory:approver`.
If the Agent tool rejects a name, use the listed agent type whose name ends in the same word.

## Steps

0. **Preflight.**
   `factory/profile.md` must exist; otherwise tell the user to run `/factory:init` and stop.
   Read the profile front matter once for `max_rounds`, the reviewers, and any `model_<lens>` values.
1. **Create.**
   Write the request text (verbatim, plus any clarifications the user gave in this conversation) to a temporary file.
   Then run `BOARD new "<short title, 3 to 8 words>" --request-file <tmp> [--backlog "<item>"]`.
   Keep the returned paths (`jobDir`, `worktree`, `spec`, `build`, `decision`, `verifyLog`, `branch`) and the reviewers.
   If `new` fails because the main tree is dirty, show the user the files and stop.
2. **Setup and spec, in parallel.**
   Start `BOARD setup <id>` (Bash, in the background) and spawn **spec-writer** with: request path, spec path, worktree, profile path.
   When both finish and `spec.md` exists:
   - if the spec Goal starts with `BLOCKED:`, run `BOARD stage <id> needs-human --note "<reason>"` and report;
   - otherwise run `BOARD stage <id> build`.
3. **Build.**
   Spawn **builder** with: worktree, spec path, build path, profile path.
   On rework, also give it the review files with `VERDICT: CHANGES`, `verify.log`, or the human feedback to address.
   If it replies `STUCK`, go to step 6 with the reason.
4. **Verify (deterministic gate).**
   `BOARD verify <id>`.
   This merges the latest base branch into the job and runs the profile's verify command.
   On failure:
   - if this is the third failed verify in a row for this round, go to step 6;
   - otherwise spawn **builder** again with `verify.log` as the rework input, then repeat step 4.
5. **Review.**
   `BOARD round <id>` returns this round's review paths.
   Spawn one **reviewer** per lens **in a single message, in parallel**.
   Give each:
   - its lens file (`factory/reviewers/<lens>.md`) and its review path;
   - the spec path and build path;
   - the worktree and base branch;
   - the earlier review files for that lens.

   Pass `model` from `model_<lens>` in the profile when set.
   Then run `BOARD collect <id>`.
   - Any `MISSING`: re-spawn just those reviewers once, then collect again.
   - `allPass`: go to step 6.
   - Otherwise, if `roundsLeft > 0`: run `BOARD stage <id> build --note "changes requested by <lenses>"`, and go to step 3 with the CHANGES review files.
   - Otherwise: run `BOARD stage <id> needs-human --note "still has required changes after <n> review rounds"`, and report.
6. **Approve.**
   Run `BOARD stage <id> approve`, then spawn **approver** with:
   - profile, request, spec and build;
   - every review file and `verify.log`;
   - worktree, base branch and decision path.

   Then run `BOARD decision <id>`.
   - `APPROVE`: run `BOARD verify <id>` (re-sync with the base), then `BOARD merge <id>`.
     If verify fails because the base moved, go back to step 3 with `verify.log`.
     If merge exits with code 3 ("needs a human"), the job changes paths that only a person may approve: run `BOARD stage <id> needs-human --note "<the message>"`.
     Never pass `--human` yourself.
     After a successful merge, deploy (step 7).
   - `ESCALATE`: run `BOARD stage <id> needs-human --note "<reason>"`.
   - A `STUCK` builder or exhausted verify attempts also end here: write no decision, just run `BOARD stage <id> needs-human --note "<reason>"`.
7. **Deploy.**
   Only after a merge, and only when the profile has a `deploy` command and `deploy_when` is `auto` (the default).
   Run `BOARD deploy <id>` with a long timeout (it can take up to `deploy_timeout` seconds, 20 minutes by default).
   It runs, from the main tree:
   - `migrate`, when migration files changed since the last good deploy;
   - `deploy`, then `deploy_wait`;
   - the `smoke` check of the live url.

   If it fails, the merge stands: report the failed `step`, the end of `deploy.log`, and `/factory:deploy <id>` to retry once fixed.
   With `deploy_when: ask`, do not deploy; mention `/factory:deploy <id>` in the report.
8. **Preview.**
   When the job ended in `needs-human` after a build (not for a `BLOCKED:` spec), and the profile has a `preview` command, run `BOARD preview <id> --open`.
   It starts the job's app from its worktree on a free port, opens it in the browser, and prints the `url`.
   If it fails, keep going and mention the `preview.log` path in the report.
9. **Report** in at most 8 lines:
   - the job id and final stage, and the deploy result with the live url;
   - what was built, or why it stopped;
   - review verdicts per round;
   - for needs-human: the preview url, what to try there (pages and paths), plus the commands `/factory:approve <id>` and `/factory:rework <id> <note>`.

Keep the user informed with one short line per stage change.
Several sessions may run jobs at once; the board script handles locking.
