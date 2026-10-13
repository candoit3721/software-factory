# Installing the software factory

## The one command

Run it in a project folder:

```bash
npx -y github:candoit3721/software-factory
```

To create a new project folder first:

```bash
npx -y github:candoit3721/software-factory my-app
```

| Option | Effect |
|---|---|
| `--remove` | Take the factory out of the project (see "Removing it from a project"). |
| `--init` | Afterwards, open Claude Code with `/factory:init` to tailor the profile. |
| `--no-commit` | Leave the changes uncommitted. |
| `--repo owner/name` | Install from a fork instead of `candoit3721/software-factory`. |

It is safe to run again: it updates the plugin and never overwrites files you edited.

### What it does

1. Checks for Node.js 22+, git and Claude Code.
2. Creates a git repository (branch `main`) if the folder is not one yet.
3. Removes an old locally-installed factory (`software-factory@software-factory-local` or `factory@software-factory-local`), if present.
4. Installs the plugin **for this project**:

   ```bash
   claude plugin marketplace add candoit3721/software-factory --scope project
   claude plugin install factory@software-factory --scope project
   ```

   This records the GitHub source in `.claude/settings.json`, so anyone who clones the project gets the same factory.
   On later runs it updates instead.
5. Copies `factory/profile.md`, `factory/backlog.md` and `factory/reviewers/` from the templates, skipping files that exist.
6. Adds `factory/jobs/`, `factory/board.json` and `factory/.board.lock` to `.gitignore`.
7. Registers the project in `~/.config/software-factory/projects.json`, for the dashboard.
8. Commits only those files: `factory/`, `.gitignore` and `.claude/settings.json`.
   Your other uncommitted work is left alone.

## Then: `/factory:init` (once per project)

Open Claude Code in the project and run `/factory:init`.
It reads your repository and tailors `factory/profile.md`:
- `base_branch`;
- the `setup` command (installing dependencies in a fresh worktree);
- the `verify` command (the full check);
- the `preview` command (serves the app for you to try a job that waits for review);
- lanes, escalation rules, and reviewer lenses.

Review the escalation rules before the first job: they decide what merges without you.

The factory follows your project's conventions, so the project should have:
- an `AGENTS.md` (or `CLAUDE.md`) explaining how it works;
- one command that checks everything.

`/factory:init` tells you if either is missing, and offers to help.
If the check starts a web server, make its port come from the `FACTORY_PORT` environment variable, because jobs run in parallel.
The `preview` command must listen on `$FACTORY_PORT` too, for example `preview: npm run dev -- --port $FACTORY_PORT`.
A slow first start can take up to `preview_timeout` seconds (default 180).

## Updating

Run the install command again, or:

```bash
claude plugin marketplace update software-factory
claude plugin update factory@software-factory --scope project
```

Then restart Claude Code (or run `/reload-plugins`).
Running jobs keep the version they started with.

If the dashboard is running, restart it to pick up a new version: stop it (Ctrl-C, or `pkill -f scripts/dashboard.mjs`), then run `/factory:dashboard`.

## A cloned project or a new machine

Projects that use the factory record its GitHub source in `.claude/settings.json`.
After cloning, run the install command once in the project.
It sees the existing settings and factory files, installs the plugin for you, and changes nothing else.

Job history (`factory/board.json`, `factory/jobs/`) stays on the machine that ran the jobs; it is not committed.

## Removing it from a project

1. Finish or discard active jobs: `/factory:status`, then `/factory:discard <id>`.
2. In the project folder, run:

   ```bash
   npx -y github:candoit3721/software-factory --remove
   ```

   This:
   - uninstalls the plugin;
   - removes it from `.claude/settings.json`;
   - takes the project off the dashboard.
3. Commit the change to `.claude/settings.json`.
4. Optionally delete `factory/` (profile, reviewers, backlog and job history) and the empty `../<project>.worktrees/` folder.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/factory:` commands don't appear | Run the install command again, then restart Claude Code. `claude plugin list` should show `factory@software-factory` as enabled. |
| `npx` fails to fetch the package | Check that `git ls-remote https://github.com/candoit3721/software-factory` works from your machine. |
| "the main working tree has uncommitted changes" | Commit or stash; jobs start from, and merge into, a clean main branch. |
| "not verified at its current commit" or "base moved" | Run `/factory:approve <id>` again; it re-checks against the latest main first. |
| "board is locked by another process" | Another factory command is running. A lock older than a minute is cleared automatically. |
| Dashboard shows "Disconnected" | Restart it (see "Updating"). |
| A project is missing from the dashboard | Run `/factory:dashboard` in that project. |
| The check fails on port conflicts | Make the web server port read `FACTORY_PORT`. |
| A preview does not start | Read `factory/jobs/<id>/preview.log`. The command must listen on `$FACTORY_PORT`. |
| A preview keeps running after you are done | `/factory:preview <id> stop`. Merging, discarding or reworking the job also stops it. |
