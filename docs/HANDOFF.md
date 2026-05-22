# CraftingBuddy Handoff

Last updated: 2026-05-22

## Current State

CraftingBuddy has a clean public repository layout in `D:\4fun\CraftingBuddy` and is pushed to:

https://github.com/KacperNowicki/CraftingBuddy

The project contains:

- `CraftPlanExporter/` - the separate WoW addon.
- `app/` - the local Windows helper app served by Node.
- `scripts/` - market scraping and report generation.
- `data/` - small sample market snapshots used for development/fallback packaging.
- `assets/icons/` - generated app icon candidates, the selected SVG/PNG/ICO, and preview sheet.
- `docs/` - architecture, data, user-flow, and GitHub Pages documentation.

Generated outputs are intentionally ignored: `dist/`, `report/`, `runtime/`, `output/`, `.playwright-cli/`, local config, and copied third-party addon repos.

Updater downloads are also ignored: `updates/`.

## Verified Commands

Run after meaningful changes:

```powershell
npm run check
```

Regenerate app/addon icon assets after changing the icon script:

```powershell
npm run generate:icons
```

Before publishing a Windows build:

```powershell
npm run build:exe
```

The build script runs a packaged-exe smoke test after building. It starts `dist\CraftPlanApp.exe` with `CRAFTINGBUDDY_NO_OPEN=1`, waits briefly, and fails if the executable exits immediately.

Release updater check:

```powershell
gh release create v0.3.7 dist\CraftPlanApp.exe --title "CraftingBuddy v0.3.7" --notes "Fixes packaged startup, large addon scans, and Goblin Exchange fallback market data."
```

The app updater reads GitHub Releases and expects the asset to be named `CraftPlanApp.exe`.

`npm run build:exe` now stamps `assets/icons/craftingbuddy-icon.ico` into the pkg Node base binary before packaging. Do not edit resources on the finished pkg exe; that corrupts pkg's appended snapshot and makes the app close immediately at startup.

Report generation from source expects a local WoW SavedVariables export:

```powershell
node .\scripts\build-craft-plan.mjs
```

Recent verification also covered:

```powershell
node .\scripts\build-craft-plan.mjs --concentration-budget 1000
```

The generated report was opened with Playwright through a local static server on `127.0.0.1:4177`.

## Product Decisions

- CraftSim remains untouched. CraftPlan Exporter reads CraftSim data through available Lua APIs and saved UI state.
- Auctionator remains untouched. CraftingBuddy can create shopping-list payloads that the addon passes into Auctionator.
- The app writes local config/runtime/report files next to the executable/source checkout, not AppData.
- The app updater stages release assets in `updates/` and only applies them from the packaged exe.
- The local helper API requires a per-launch browser token and loopback host/origin checks. Reports served through the app receive that token for the **Regenerate** button; reports opened directly from disk cannot call the API.
- The updater only accepts the exact release asset name `CraftPlanApp.exe`.
- The selected icon is "Gem Spark" from `assets/icons/preview.html`; the addon minimap button uses the generated TGA in `CraftPlanExporter/Media/`.
- Undermine API keys are optional and stored through Windows user-scope protection when possible.
- Goblin Exchange remains a no-key fallback.
- Goblin Exchange category view slices may be absent in the current artifact manifest. The scraper falls back to per-realm `realm-state` shards and stops once it has found the target catalog items.
- Weekly concentration planning excludes very low movement markets by default.
- Weekly concentration planning uses expected concentration after CraftSim-style Ingenuity refunds when the updated addon export includes those fields, and falls back to raw concentration for older scans.
- Report cards show demand confidence and keep optimizer tables collapsed.
- CraftPlan Exporter queues Recipe Scan variant saves across short timer ticks and caches reagent price snapshots by CraftSim price-data table so large scans do not trip WoW's "script ran too long" watchdog. Players should wait for the "saved ingredient variants" message before typing `/reload`.

## Known Risks

- CraftSim API/UI internals can change. Keep addon integration defensive.
- Large scan exports still depend on CraftSim recipe data staying valid while queued variant saves finish.
- Market movement data is an estimate. UI should never promise guaranteed profit.
- Multi-realm support depends on SavedVariables realm detection plus market-source coverage.
- The current sample snapshots are Silvermoon EU development data, not universal defaults.
- Packaging should be checked from a fresh clone before public releases.
- Post-build resource editors can corrupt pkg executables if they change offsets after pkg has appended the app snapshot. Brand the pkg base binary first instead.
- A release must include `CraftPlanApp.exe` or the updater will report that no installable asset exists.

## Next Useful Work

1. Add screenshots or a short demo GIF for the README and GitHub Pages.
2. Add release workflow or documented manual release steps.
3. Add a tiny fixture-based test for report JSON ranking.
4. Add an in-addon completion hint after **Scan all + variants** so players know when to type `/reload`.
5. Add a beginner mode in the report that hides all negative/rarely-bought rows unless toggled.
