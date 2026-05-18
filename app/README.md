# CraftPlan App

`dist/CraftPlanApp.exe` is the friend-facing wrapper around the CraftPlan flow.

## Flow

1. Open `CraftPlanApp.exe`.
2. Choose the World of Warcraft folder if it is not detected automatically.
3. Click **Install** to copy `CraftPlanExporter` into `_retail_/Interface/AddOns`.
4. In WoW:
   - open the Auction House and run Auctionator scan,
   - open CraftSim Recipe Scan,
   - open CraftPlan Exporter from the minimap button,
   - run the CPE scan/variants button,
   - type `/reload` so WoW writes SavedVariables to disk.
5. Click **Generate** in the app.

The app reads `CraftPlanExporter.lua`, detects the player's region and realm from addon metadata, fetches matching Goblin Exchange public market artifacts, and opens the generated HTML report.

Generated files are written next to the executable:

- `craft-plan-app.config.json`
- `data/`
- `report/`
- `runtime/`

## Build

```powershell
npm run check
npm run build:exe
```

The packaged executable includes Node and is intentionally bigger than a native WinForms app, but friends only need to open the exe.
