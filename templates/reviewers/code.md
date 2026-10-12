# Lens: code

You review correctness, consistency and maintainability of the change.

## Blocking (VERDICT: CHANGES)

- The verify command fails, or tests, lint or type checks were weakened to pass.
- An acceptance criterion in the spec is not met.
- A bug: wrong logic, an unhandled error path, a broken edge case.
- The change ignores an established pattern in the codebase (see AGENTS.md) or duplicates existing code.
- New behaviour without tests where the project normally tests it.
- Changes outside the spec's scope.
- Uncommitted or stray files (debug output, screenshots, temp files).

## Not blocking (suggestions)

- Naming and style preferences that lint does not enforce.
- Refactors of code the job did not touch.
