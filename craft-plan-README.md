# Craft Plan Helper

This workspace has two inputs:

- `data/undermine-silvermoon-eu-crafting.json` - Undermine snapshot for Silvermoon EU cooking plus current-expansion alchemy.
- `C:\Program Files (x86)\World of Warcraft\_retail_\WTF\Account\...\SavedVariables\CraftPlanExporter.lua` - companion addon SavedVariables after WoW writes `CraftPlanExporterDB`.

`CraftPlanExporter` is a separate addon. It reads CraftSim through `CraftSimAPI` and hooks Recipe Scan, so CraftSim updates should not overwrite the export code.

The live addon folder is:

```text
C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns\CraftPlanExporter
```

## Friend-Facing Flow

Use `dist\CraftPlanApp.exe` for the normal workflow. The app installs the addon, detects the WoW folder, refreshes market data for the player realm, and generates the report.

1. Open `dist\CraftPlanApp.exe`.
2. Choose the World of Warcraft folder if it is not detected automatically.
3. Click **Install Addon**.
4. In WoW, open the Auction House and run an Auctionator scan.
5. Open CraftPlan Exporter from the minimap button and press **Scan all + variants**.
6. Run `/reload` so WoW writes SavedVariables to disk.
7. Click **Generate** in the app.

The app writes `craft-plan-app.config.json`, `data\`, `report\`, and `runtime\` next to the executable.

## Developer Refresh

1. Install or reload WoW with `CraftPlanExporter` enabled.
2. Open the Auction House and run an Auctionator scan.
3. Open CraftPlan Exporter from the minimap and press **Scan all + variants**.
4. Run `/reload` or log out so WoW writes SavedVariables to disk.
5. Refresh market data when wanted:

```powershell
node .\scripts\scrape-goblin.mjs
```

6. Build the report:

```powershell
node .\scripts\build-craft-plan.mjs
```

Open `report/craft-plan-report.html`. Batchable crafts and concentration crafts are split into separate tabs; the concentration tab is sorted by profit per concentration point.

The report has a `Generate PNG` button in the top-right corner. It exports a share card with the top batch crafts and top concentration crafts.

Useful in-game commands:

```text
/cpe open   - export the currently open CraftSim recipe
/cpe scan   - export the selected CraftSim Recipe Scan result list
/cpe variants 20000 top=25       - test required ingredient quality combinations for the open recipe
/cpe variants 50000 all top=25   - also include optional and finishing slot choices
/cpe scanvariants 5000 top=10    - test variants for each selected Recipe Scan result
/cpe stats  - show saved export counts
/cpe clear  - clear exported data
```

The exporter saves CraftSim's selected reagent allocation plus every available quality option for each required reagent. The variant commands go further: they copy CraftSim's recipe data, try ingredient allocations, let CraftSim recalculate quality/cost/profit, and save the best ranked results into the report.

## Useful Options

```powershell
node .\scripts\build-craft-plan.mjs --risk 0.08 --max-items 750 --max-recipes 12
```

`risk` controls how much of the 7-day movement the starter batch should target. The default is conservative. Concentration recipes are capped to one craft in the report because CraftSim marks them as scarce-resource crafts.
