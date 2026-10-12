---
name: init
description: Tailor the software factory to the current project. Fills in factory/profile.md, review lenses and backlog from the repository. Use when the user types /factory:init.
---

# Set up the factory in this project

The plugin is normally installed by `npx -y github:candoit3721/software-factory`, which also copies starter files into `factory/`.
This skill makes those files fit **this** repository.

1. **Check git.**
   The project must be a git repository.
2. **Starter files.**
   If `factory/profile.md`, `factory/backlog.md` or `factory/reviewers/` are missing, copy them from `${CLAUDE_PLUGIN_ROOT}/templates/`.
   Never overwrite files the user has edited.
3. **Tailor `factory/profile.md`.**
   Read `AGENTS.md`, `CLAUDE.md`, the README and the package manifest, then:
   - fill in `base_branch`, `setup` (installing dependencies in a fresh worktree) and `verify` (the full merge gate);
   - write the lanes, escalation rules and conventions for this project, replacing every `<placeholder>`;
   - choose reviewer lenses, adding domain lenses where they matter (for example "pedagogy" for learning content or "security" for logins and payments), with a lens file in `factory/reviewers/` for each;
   - remove the `<!-- factory:untailored ... -->` line.

   If the project has no real verify command or no `AGENTS.md`, say so plainly and offer to help create them.
   The factory follows the project's conventions, so it needs both before its first job.
4. **Ports.**
   If the verify command starts a web server, make its port come from the `FACTORY_PORT` environment variable, because parallel jobs run at the same time.
5. **Ignore runtime files.**
   `.gitignore` must contain `factory/jobs/`, `factory/board.json` and `factory/.board.lock`.
6. **Register** the project on the dashboard: `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" init`.
7. **Hand over.**
   Show the user the escalation rules and ask them to confirm or adjust them before the first job.
   Then commit the factory files: `chore(factory): tailor the factory to this project`.
