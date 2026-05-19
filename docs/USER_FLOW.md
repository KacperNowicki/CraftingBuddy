# User Flow

CraftingBuddy should feel like a checklist for a normal player, not a profession simulator.

## The Simple Promise

Open app. Follow four steps. Get a report that says:

> Craft X item for Y quantity and Z estimated profit today.

Then the player can add mats to a shopping list, copy it, paste it into the addon, and create an Auctionator list.

## Friend-Friendly Flow

1. Open CraftingBuddy.
2. Pick the World of Warcraft folder if needed.
3. Install the addon.
4. In WoW, open the Auction House and run an Auctionator scan.
5. Open CraftPlan Exporter from the minimap.
6. Press **Scan all + variants**.
7. Type `/reload`.
8. Press **Generate report** in CraftingBuddy.
9. Open the report.
10. Craft from the top down, respecting market confidence.

## Updating The App

The app has an **App updates** panel.

Simple user wording:

1. Press **Check update**.
2. If a new version exists, press **Download**.
3. When download finishes, press **Restart to install**.

In source/developer mode, update checking and downloading work, but install is disabled. Only `CraftPlanApp.exe` can replace itself.

## App Copy Rules

Use player language:

- Say "WoW folder", not "root path".
- Say "Scan all + variants", not "export optimization blob".
- Say "I reloaded", not "refresh SavedVariables".
- Say "Generate report", not "build artifact".
- Say "Market source", not "data provider adapter".
- Say "Restart to install", not "apply staged binary".

## Report Rules

The top of each card should answer:

- item name and quality
- craft count
- expected output count
- estimated profit
- concentration cost when relevant
- demand confidence

Hide these behind details:

- raw item ids
- full optimizer tables
- variant rank comparisons
- missing-profit diagnostics

## Market Confidence

Very simple player meaning:

- `strong market`: usually safe to try small batches.
- `steady market`: fine, but do not overcraft.
- `steady, thin stock`: price may move fast; re-check before buying mats.
- `thin market`: only craft if you understand the listing risk.
- `rarely bought`: do not spend weekly concentration here by default.

## Concentration

Concentration is a scarce weekly budget. The weekly tab should help the player spend it where it produces the most gold without choosing dead markets.

Default behavior:

- use current character concentration when exported
- otherwise assume 1000
- use expected concentration after Ingenuity refunds when the updated addon export includes it
- skip very low movement markets in the weekly planner
- still show low movement recipes in the concentration tab for manual investigation
- show raw concentration cost only as detail when it differs from expected cost
