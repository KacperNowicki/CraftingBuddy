# Agent Guide

CraftingBuddy is a small Windows-first helper for World of Warcraft crafting profit planning. Keep it understandable for normal players first, and clever for power users second.

## Required Reading Before Work

Before changing code, read these files in this order:

1. `AGENTS.md` or `CLAUDE.md` - shared project rules.
2. `docs/HANDOFF.md` - current state, verified commands, and next decisions.
3. `docs/ARCHITECTURE.md` - addon, app, report, and data boundaries.
4. `docs/USER_FLOW.md` - the player-facing workflow and wording goals.
5. `README.md` - the public project contract.

When behavior changes, update the matching docs in the same change:

- `docs/HANDOFF.md` for current status, known risks, verification, and next steps.
- `docs/ARCHITECTURE.md` for runtime shape, data flow, app/addon boundaries, or storage changes.
- `docs/DATA_MODEL.md` for SavedVariables, market snapshots, report JSON, or shopping-list payload changes.
- `docs/USER_FLOW.md` and `README.md` for user-facing flow, wording, and setup changes.
- `AGENTS.md` and `CLAUDE.md` together when agent rules change.

## Product Direction

The goal is a simple gold-making assistant for players who do not want to understand CraftSim internals.

The app should answer, in this order:

1. What do I press next?
2. What should I craft?
3. How many should I craft?
4. What exact reagent qualities should I buy?
5. Is this market safe enough to bother with?

Avoid exposing raw implementation language when plain player language works. Prefer "Scan all + variants" over "export optimization records"; prefer "rarely bought" over "low movement proxy."

## Start Here

Common commands:

```powershell
npm run check
node .\scripts\build-craft-plan.mjs
npm run build:exe
```

Run the local helper app from source:

```powershell
npm run app
```

## Code Style

- JavaScript ESM only; no TypeScript for now.
- The WoW addon is Lua and must stay compatible with retail WoW addon APIs.
- Keep the app local-first. No cloud backend.
- Keep file writes next to the executable/source checkout, not AppData.
- Prefer obvious data transforms over dense cleverness.
- Keep report calculations deterministic and inspectable.
- Do not modify CraftSim or Auctionator. CraftPlan Exporter must remain a separate addon.

## Data And Safety

- Do not commit real SavedVariables, API keys, logs, generated reports, generated executables, local runtime folders, screenshots, or copied third-party addon repos.
- Undermine keys must stay local and protected with Windows user scope when possible.
- Market snapshots are estimates, not guarantees. UI must show movement/stock confidence when recommending crafts.
- Validate WoW paths before installing addon files.
- Do not add generic shell execution or remote command features to the app.
- Do not claim guaranteed profit. Always frame recommendations as "today's best plan from current scan data."

## UX Rules

- The Windows app is a guided checklist. Keep the next action obvious.
- The report is an action list. Default view should show craft quantity, expected profit, demand confidence, and shopping-list buttons.
- Hide dense evidence behind details. Details are for trust and debugging, not the main path.
- Weekly concentration planning should avoid very low movement items by default.
- Shopping list output must preserve reagent quality.

## Public Repo Hygiene

- Keep `README.md` friendly and short.
- Keep deeper explanations in `docs/`.
- Keep GitHub Pages in `docs/index.html`.
- Keep releases reproducible from source with `npm run build:exe`.
- Use focused commits with clear messages.
