# Claude Code Guide

CraftingBuddy is a Windows-first WoW crafting helper. It combines CraftSim personal profit data, Auctionator scan data, and market movement snapshots into a simple "craft this" report.

Read first:

1. `CLAUDE.md`
2. `AGENTS.md`
3. `docs/HANDOFF.md`
4. `docs/ARCHITECTURE.md`
5. `docs/USER_FLOW.md`
6. `README.md`

Update docs beside behavior changes:

- `docs/HANDOFF.md` for status, verification, and next work.
- `docs/ARCHITECTURE.md` for app/addon/report boundaries.
- `docs/DATA_MODEL.md` for SavedVariables, snapshots, report JSON, or shopping-list payloads.
- `docs/USER_FLOW.md` and `README.md` for player-facing setup or wording.
- `AGENTS.md` and `CLAUDE.md` together for rule changes.

Common commands:

```powershell
npm run check
node .\scripts\build-craft-plan.mjs
npm run build:exe
```

Work style:

- Keep changes small and easy to review.
- Use JavaScript ESM for app/scripts and Lua for the addon.
- Do not introduce TypeScript yet.
- Do not modify CraftSim or Auctionator.
- Keep generated files, local config, logs, API keys, report output, and `.exe` builds out of git.
- Favor clear player wording over implementation terms.
- Keep dense optimizer evidence collapsed by default.

Product goal:

CraftingBuddy should be usable by a very casual player: open app, follow checklist, scan in WoW, generate report, buy listed mats, craft listed items.
