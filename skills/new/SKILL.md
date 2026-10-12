---
name: new
description: Start a software factory job for a request in the current project. The request goes through spec, build, parallel reviews and approval, then auto-merges or waits for a human. Use when the user types /factory:new <request>.
argument-hint: "<what to build or change>"
---

# New factory job

Request: $ARGUMENTS

If the request is empty, ask the user what to build and stop.

Read `${CLAUDE_PLUGIN_ROOT}/reference/job-loop.md` and follow it from step 0, with:
- this request;
- plugin root `${CLAUDE_PLUGIN_ROOT}`.
