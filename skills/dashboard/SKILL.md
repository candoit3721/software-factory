---
name: dashboard
description: Open the software factory dashboard, which shows the jobs and open backlog items of every factory project. Use when the user types /factory:dashboard or asks to see the factory board.
---

# Factory dashboard

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" register` from the project root.
   It prints this project's dashboard `url`.
   If it fails because `factory/profile.md` is missing, use `http://localhost:4700` instead.
2. Start `node "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.mjs"` in the background.
   If a dashboard is already running, it says so and exits; that is fine.
3. Give the user the url.
   One dashboard on port 4700 shows every factory project; the url opens it filtered to this one.
