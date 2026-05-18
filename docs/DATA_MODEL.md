# Data Model

CraftingBuddy intentionally keeps data simple and file-based.

## SavedVariables

Source:

```text
World of Warcraft\_retail_\WTF\Account\<account>\SavedVariables\CraftPlanExporter.lua
```

Main table:

```lua
CraftPlanExporterDB = {
  meta = {},
  recordsByItemID = {},
  recordsByRecipeID = {},
  concentration = {},
}
```

Important concepts:

- `meta` identifies player, realm, normalized realm, and region.
- `recordsByItemID` lets the report match market items to CraftSim profit data.
- `recordsByRecipeID` preserves recipe-level data when item IDs are ambiguous.
- `variantOptimization` stores tested ingredient quality paths.
- `concentration` stores current/max concentration when Blizzard APIs expose it.

## Market Snapshot

Market snapshot files live in `data/`.

Important fields:

- item id and item name
- current minimum price
- current quantity
- seven-day average quantity
- seven-day drop proxy
- source/realm/region metadata

The report uses movement and stock to estimate confidence:

- `strong market`
- `steady market`
- `steady, thin stock`
- `thin market`
- `rarely bought`

## Report JSON

Generated file:

```text
report/craft-plan-report.json
```

Top-level groups:

- `recommendations` - batch crafts that do not require concentration.
- `concentrationRecommendations` - per-recipe concentration recommendations.
- `concentrationVariants` - flattened variant options for budget planning.
- `weeklyConcentrationPlan` - optimized weekly spend under the chosen concentration budget.
- `missingProfit` - market items without matching CraftSim/CPE data.

## Shopping Payload

The report copies a simple text payload into the addon paste box.

Shape:

```text
CPE_AUCTIONATOR_LIST_V1
list    CraftPlan - Example
item    Mana Lily    1    6
item    Sunglass Vial    1    10
```

The important part is reagent quality. `tier=1`, `tier=2`, and `tier=3` must stay distinct so the player buys the same path the optimizer recommended.

## Data Hygiene

Do not commit:

- real SavedVariables
- Undermine API keys
- generated reports
- runtime extraction folders
- logs
- screenshots
- generated executables

Small sample market snapshots can stay committed as development fixtures until a better fixture set exists.
