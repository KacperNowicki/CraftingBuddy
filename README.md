# CraftingBuddy

CraftingBuddy is a small WoW crafting helper built around CraftSim, Auctionator, and market movement data.

It includes:

- `CraftPlanExporter`, a companion addon that reads CraftSim data without modifying CraftSim.
- A Windows helper app that installs the addon, reads SavedVariables, refreshes market data, and generates a local report.
- Report tooling for batch crafts, concentration crafts, reagent-quality variants, and Auctionator shopping-list export.

## Normal Flow

1. Run `dist/CraftPlanApp.exe`, or run the app from source with `npm run app`.
2. Select your World of Warcraft folder if it is not detected.
3. Install the addon.
4. In WoW, open the Auction House and run an Auctionator scan.
5. Open CraftPlan Exporter from the minimap and press **Scan all + variants**.
6. Type `/reload` so WoW writes SavedVariables.
7. Generate the report.

## Development

```powershell
npm run check
node .\scripts\build-craft-plan.mjs
npm run build:exe
```

The app stores local config, generated reports, runtime files, and market refresh output next to the executable. Those files are ignored by git.

See [craft-plan-README.md](craft-plan-README.md) for the longer working notes.
