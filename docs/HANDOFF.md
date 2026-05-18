# CraftingBuddy Handoff

Last updated: 2026-05-18

## Current State

CraftingBuddy has a clean public repository layout in `D:\4fun\CraftingBuddy` and is pushed to:

https://github.com/KacperNowicki/CraftingBuddy

The project contains:

- `CraftPlanExporter/` - the separate WoW addon.
- `app/` - the local Windows helper app served by Node.
- `scripts/` - market scraping and report generation.
- `data/` - small sample market snapshots used for development/fallback packaging.
- `docs/` - architecture, data, user-flow, and GitHub Pages documentation.

Generated outputs are intentionally ignored: `dist/`, `report/`, `runtime/`, `output/`, `.playwright-cli/`, local config, and copied third-party addon repos.

Updater downloads are also ignored: `updates/`.

## Verified Commands

Run after meaningful changes:

```powershell
npm run check
```

Before publishing a Windows build:

```powershell
npm run build:exe
```

Release updater check:

```powershell
gh release create v0.3.0 dist\CraftPlanApp.exe --title "CraftingBuddy v0.3.0" --notes "Initial updater-capable build."
```

The app updater reads GitHub Releases and expects the asset to be named `CraftPlanApp.exe`.

Report generation from source expects a local WoW SavedVariables export:

```powershell
node .\scripts\build-craft-plan.mjs
```

## Product Decisions

- CraftSim remains untouched. CraftPlan Exporter reads CraftSim data through available Lua APIs and saved UI state.
- Auctionator remains untouched. CraftingBuddy can create shopping-list payloads that the addon passes into Auctionator.
- The app writes local config/runtime/report files next to the executable/source checkout, not AppData.
- The app updater stages release assets in `updates/` and only applies them from the packaged exe.
- Undermine API keys are optional and stored through Windows user-scope protection when possible.
- Goblin Exchange remains a no-key fallback.
- Weekly concentration planning excludes very low movement markets by default.
- Report cards show demand confidence and keep optimizer tables collapsed.

## Known Risks

- CraftSim API/UI internals can change. Keep addon integration defensive.
- Market movement data is an estimate. UI should never promise guaranteed profit.
- Multi-realm support depends on SavedVariables realm detection plus market-source coverage.
- The current sample snapshots are Silvermoon EU development data, not universal defaults.
- Packaging should be checked from a fresh clone before public releases.
- A release must include `CraftPlanApp.exe` or the updater will report that no installable asset exists.

## Next Useful Work

1. Add screenshots or a short demo GIF for the README and GitHub Pages.
2. Add release workflow or documented manual release steps.
3. Add a tiny fixture-based test for report JSON ranking.
4. Improve addon panel copy so "Scan all + variants" is unmistakable in game.
5. Add a beginner mode in the report that hides all negative/rarely-bought rows unless toggled.
