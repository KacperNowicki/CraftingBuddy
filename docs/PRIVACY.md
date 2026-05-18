# Privacy

CraftingBuddy is local-first.

It reads:

- your selected World of Warcraft folder
- CraftPlan Exporter SavedVariables
- generated local market/report files
- optional Undermine API key saved on your Windows user account

It writes:

- addon files into `_retail_\Interface\AddOns\CraftPlanExporter`
- local config next to the app
- market snapshots in `data/`
- generated reports in `report/`
- runtime extraction files in `runtime/`

It can contact:

- Undermine Exchange API when you save an API key
- Goblin Exchange as fallback market data

It does not intentionally upload your SavedVariables, character data, or API key to a CraftingBuddy server. There is no CraftingBuddy server.
