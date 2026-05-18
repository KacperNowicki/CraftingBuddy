# CraftingBuddy

CraftingBuddy is a local WoW gold-making helper for players who use CraftSim and Auctionator but want a simple answer:

> Craft this item, this many times, with these reagent qualities, for this estimated profit today.

It is not a bot and it does not post auctions. It turns your own CraftSim scan plus current market movement into an easy report.

## What It Does

- Installs a separate addon: `CraftPlanExporter`.
- Reads CraftSim profit and ingredient-quality variants without modifying CraftSim.
- Reads your realm from the addon export.
- Pulls market data from Undermine API when you save a key, or Goblin Exchange as fallback.
- Builds a local dark-mode report with batch crafts, concentration crafts, weekly concentration planning, and Auctionator shopping-list export.

## Simple Flow

1. Open `CraftPlanApp.exe`.
2. Pick your World of Warcraft folder if needed.
3. Click **Install addon**.
4. In WoW, open the Auction House and run an Auctionator scan.
5. Open CraftPlan Exporter from the minimap and press **Scan all + variants**.
6. Type `/reload`.
7. Click **Generate report**.
8. Follow the report from the top down.

## From Source

```powershell
npm run app
npm run check
node .\scripts\build-craft-plan.mjs
npm run build:exe
```

The app stores local config, generated reports, runtime files, and market refresh output next to the executable/source checkout. Those files are ignored by git.

## Project Docs

- [User flow](docs/USER_FLOW.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Data model](docs/DATA_MODEL.md)
- [Roadmap](docs/ROADMAP.md)
- [Privacy](docs/PRIVACY.md)
- [Working notes](craft-plan-README.md)

GitHub Pages lives in `docs/index.html`.
