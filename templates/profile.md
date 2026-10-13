---
base_branch: main
max_rounds: 2
setup: npm ci --prefer-offline --no-audit --no-fund
verify: npm test
preview: npm run dev -- --port $FACTORY_PORT
# Deploy after each merge (delete what does not apply; see docs/INSTALL.md in the plugin):
# deploy: git push origin main
# deploy_wait: github-actions
# smoke: https://example.com/
# migrate: npx supabase db push
# migrations: [supabase/migrations/]
# human_only: [supabase/migrations/]
# deploy_when: auto
reviewers: [code, experience]
model_code: sonnet
model_experience: sonnet
---

# Factory profile

<!-- factory:untailored - /factory:init replaces the placeholders below and removes this line -->

This file tells the factory how this project works.
The front matter is read by the board script.
The sections below are read by the agents.

## Lanes

- **content**: <changes that only add or edit data or content>.
- **platform**: everything else.

## Escalation rules (the approver applies these literally)

Escalate to a human when any of these is true:

1. The change is in the platform lane.
2. The diff touches files outside the spec's scope.
3. <project-specific risk, for example authentication, payments, deployment, data migrations>.

Otherwise, a job where every review passed and verify succeeded may auto-merge.

## Conventions

- Read `AGENTS.md` first.
- <Anything the agents must always do or never do.>
