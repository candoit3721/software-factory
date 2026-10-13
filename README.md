# Software Factory

A small software factory for Claude Code that you own and understand.
You describe a change, and a team of agents takes it to your main branch:

```
/factory:new Add a dark mode that follows the system setting
  -> spec-writer        writes spec.md with testable acceptance criteria
  -> builder            implements it in its own git worktree and commits
  -> verify (script)    merges the latest main into the job and runs your project's full check
  -> reviewers          one per lens, in parallel, each writes VERDICT: PASS or CHANGES
       (CHANGES -> builder again, up to max_rounds)
  -> approver           applies your project's escalation rules
  -> APPROVE: verify again, merge to main      ESCALATE: waits for you, with the app running from the job's worktree
  -> deploy (script)    migrate the database if needed, deploy, wait for CI, check the live site
```

Inspired by the ZazenCodes video "Build Your Own AI Software Factory with Claude Code".

## Install

In a project folder (or `npx ... my-app` to create a new one):

```bash
npx -y github:candoit3721/software-factory
```

That one command:
1. creates a git repository if there is none;
2. installs the `factory` plugin for the project from this GitHub repo;
3. adds starter files in `factory/`;
4. ignores the factory's runtime files;
5. registers the project on the dashboard;
6. commits only those files.

Then open Claude Code in the project and run `/factory:init` once.
It tailors `factory/profile.md` (check command, approval rules, reviewers) to your repository.
Add `--init` to the npx command to open Claude Code with it straight away.

Run the same command again at any time to update to the latest version.
It never overwrites factory files you edited.
`--remove` takes the factory out of a project again.

Requirements: Claude Code, Node.js 22 or later, and git.
See [docs/INSTALL.md](docs/INSTALL.md) for options, updating, removing, and troubleshooting.

## Use

```
/factory:new <what to build or change>
/factory:next                          # first open item in factory/backlog.md
/factory:status
/factory:dashboard                     # http://localhost:4700, all your factory projects
/factory:preview 004                   # run job 004's app so you can try it (a unique id prefix is enough)
/factory:approve 004
/factory:deploy                        # deploy main again, for example after fixing a failed deploy
/factory:rework 004 "Use a Lake Ontario example"
/factory:discard 004 "no longer needed"
/factory:init                          # tailor the factory to this project
```

`approve`, `deploy` and `discard` run only when you type them.

When a job waits for you, the factory starts the app from the job's worktree and opens it in your browser, so you review the real thing, not just the diff.
It runs the profile's `preview` command on a free port, and stops it when the job is merged, discarded or reworked.
The dashboard links to running previews, and can start one.

After a merge, the factory deploys with the project's own commands, if the profile has them.
Database migrations run first, and only when they changed; paths listed in `human_only` (such as migrations) never merge without a person's `/factory:approve`.
A failed deploy never undoes the merge: the job shows "deploy failed" and `/factory:deploy` retries.
The factory never sees passwords or tokens; it runs CLIs you are already logged in to (`gh`, `supabase`, `render`).
Run several Claude Code sessions to build several jobs at once; each job has its own worktree and port.

## What a project provides

The factory knows nothing about your project.
It follows the project's own conventions, so the project needs:

| File | Purpose |
|---|---|
| `AGENTS.md` (or `CLAUDE.md`) | How the project works. Every agent reads it first. |
| One command that checks everything | `verify` in the profile, for example `npm run verify`. Nothing merges unless it passes. |
| `factory/profile.md` | Front matter: `base_branch`, `setup`, `verify`, `preview`, `reviewers`, `max_rounds`, `model_<lens>`, and the deploy keys. Body: lanes, escalation rules, conventions. |
| `factory/reviewers/<lens>.md` | What each reviewer checks and what counts as blocking. |
| `factory/backlog.md` | `- [ ] item` lines for `/factory:next`; merged items are checked off. |
| `.claude/skills/*` (optional) | Recipes the builder follows, for example `add-lesson` or `add-endpoint`. |

For a brand-new project, build that foundation first (by hand or with Claude), then let the factory take over.

## How it is built

| Part | Where | Role |
|---|---|---|
| Commands | `skills/<name>/SKILL.md` | `new`, `next`, `status`, `preview`, `approve`, `deploy`, `rework`, `discard`, `dashboard`, `init`. |
| Orchestrator loop | `reference/job-loop.md` | The steps `new`, `next` and `rework` follow. The Claude session runs it and spawns agents; it never writes code itself. |
| Agents | `agents/*.md` | `spec-writer`, `builder`, `reviewer` (one generic agent used per lens), `approver`. |
| Board | `scripts/board.mjs` | Deterministic state and git: jobs, stages, verdicts, worktrees, verify, merge, backlog. Locked for parallel sessions. |
| Dashboard | `scripts/dashboard.mjs`, `scripts/registry.mjs`, `dashboard/index.html` | One live board for every factory project, with a project filter. Projects with deploys get a Deploy column. |
| Previews | `scripts/preview.mjs` | Runs a job's app from its worktree for review, detached, and stops it again. |
| Deploys | `scripts/deploy.mjs` | Waits for GitHub Actions and smoke-checks the live site; `board.mjs deploy` runs the steps. |
| Installer | `scripts/setup.mjs` | The `npx` command above. |
| Templates | `templates/` | Starter profile, backlog and review lenses. |

Design rules:
- Agents read context from files and write only their own file.
- Every state change goes through the board script, never through an agent editing JSON.
- Nothing merges unless the exact commit being merged passed the project's check after syncing with main.
- Nothing deploys except committed work on the base branch, one deploy at a time.
- Job worktrees live outside the repository, in `../<repo>.worktrees/<job>`.

## Developing the factory

```bash
git clone git@github.com:candoit3721/software-factory.git
cd software-factory
npm test                    # board, dashboard, installer and plugin structure tests
npm run validate            # plugin and marketplace manifests
claude --plugin-dir .       # try local changes in a session (run it from a test project)
```

To release:
1. Bump `version` in `.claude-plugin/plugin.json` and `package.json`.
2. Commit and push to `main`.
3. In each project, re-run the npx command, or run `claude plugin update factory@software-factory --scope project`.

## License

MIT
