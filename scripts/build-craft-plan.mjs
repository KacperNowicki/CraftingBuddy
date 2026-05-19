import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SNAPSHOT = path.join(ROOT, "data", "undermine-silvermoon-eu-crafting.json");
const DEFAULT_OUT_HTML = path.join(ROOT, "report", "craft-plan-report.html");
const DEFAULT_OUT_JSON = path.join(ROOT, "report", "craft-plan-report.json");
const DEFAULT_WOW_ACCOUNT_ROOT = "C:\\Program Files (x86)\\World of Warcraft\\_retail_\\WTF\\Account";
const AUCTION_HOUSE_CUT = 0.95;
const PROFIT_SOURCES = [
  { fileName: "CraftPlanExporter.lua", variableName: "CraftPlanExporterDB", label: "CraftPlan Exporter" },
  { fileName: "CraftSim.lua", variableName: "CraftSimProfitDB", label: "CraftSim patch" },
];

export async function buildCraftPlan(args = {}) {
  const snapshotPath = path.resolve(args.snapshot ?? DEFAULT_SNAPSHOT);
  const explicitProfitPath = args.profit ?? args.craftsim;
  const profitSource = explicitProfitPath
    ? await loadProfitSource(path.resolve(explicitProfitPath))
    : await findProfitSource(args);
  const outHtmlPath = path.resolve(args.out ?? DEFAULT_OUT_HTML);
  const outJsonPath = path.resolve(args.json ?? DEFAULT_OUT_JSON);
  const savedConcentration = inferSavedConcentration(profitSource.db);
  const explicitConcentrationBudget = args["concentration-budget"] ?? args.concentrationBudget;
  const concentrationBudget = explicitConcentrationBudget !== undefined
    ? Number(explicitConcentrationBudget)
    : savedConcentration?.currentAmountRounded ?? 1000;

  const options = {
    risk: clamp(Number(args.risk ?? 0.06), 0.01, 0.25),
    maxItemsPerRecipe: Math.max(1, Number(args["max-items"] ?? 80)),
    minProfitCopper: Math.max(0, Number(args["min-profit"] ?? 0)),
    maxRecipes: Math.max(1, Number(args["max-recipes"] ?? 18)),
    concentrationBudget: Math.max(0, Number(concentrationBudget)),
    concentrationBudgetSource: explicitConcentrationBudget !== undefined
      ? "command-line"
      : savedConcentration ? "addon-current-character" : "default",
    savedConcentration,
  };

  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const report = buildReport(snapshot, profitSource.db, { ...options, snapshotPath, profitSource });

  await mkdir(path.dirname(outHtmlPath), { recursive: true });
  await mkdir(path.dirname(outJsonPath), { recursive: true });
  await writeFile(outJsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(outHtmlPath, renderHtml(report), "utf8");

  console.log(`Wrote ${outHtmlPath}`);
  console.log(`Wrote ${outJsonPath}`);
  console.log(`Profit SavedVariables: ${profitSource.path} (${profitSource.variableName})`);
  console.log(`Profit records matched: ${report.summary.matchedProfitRecords}/${report.summary.snapshotItems}`);
  return { report, outHtmlPath, outJsonPath, profitSource };
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      result[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      result[arg.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return result;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findProfitSource(args = {}) {
  const candidates = [];
  const accountRoot = args["wow-account-root"] ?? DEFAULT_WOW_ACCOUNT_ROOT;
  const accountDirs = await readdir(accountRoot, { withFileTypes: true }).catch(() => []);

  for (const entry of accountDirs) {
    if (!entry.isDirectory()) continue;
    for (const [priority, source] of PROFIT_SOURCES.entries()) {
      const candidate = path.join(accountRoot, entry.name, "SavedVariables", source.fileName);
      if (await exists(candidate)) {
        const fileStat = await stat(candidate);
        candidates.push({ path: candidate, priority, mtimeMs: fileStat.mtimeMs });
      }
    }
  }

  if (!candidates.length) {
    throw new Error(`Could not find supported profit SavedVariables under ${accountRoot}. Pass --profit "path\\to\\CraftPlanExporter.lua".`);
  }

  candidates.sort((a, b) => a.priority - b.priority || b.mtimeMs - a.mtimeMs);

  let firstLoaded = null;
  for (const candidate of candidates) {
    try {
      const source = await loadProfitSource(candidate.path);
      firstLoaded ??= source;
      if (hasProfitRecords(source.db)) return source;
    } catch {
      // Keep scanning; old or partially written SavedVariables should not kill the report.
    }
  }

  if (firstLoaded) return firstLoaded;
  throw new Error(`Found SavedVariables files under ${accountRoot}, but none contained CraftPlanExporterDB or CraftSimProfitDB.`);
}

export async function loadProfitSource(filePath) {
  const lua = await readFile(filePath, "utf8");
  for (const source of PROFIT_SOURCES) {
    const db = parseLuaAssignment(lua, source.variableName);
    if (db) {
      return {
        path: filePath,
        variableName: source.variableName,
        label: source.label,
        db,
      };
    }
  }

  throw new Error(`No supported profit DB found in ${filePath}. Expected CraftPlanExporterDB or CraftSimProfitDB.`);
}

function hasProfitRecords(db) {
  return Object.keys(db?.recordsByItemID ?? {}).length > 0 ||
    Object.keys(db?.recordsByRecipeID ?? {}).length > 0;
}

function inferSavedConcentration(db) {
  const candidates = [];
  const addSnapshot = (snapshot) => {
    if (!snapshot || typeof snapshot !== "object") return;
    const amount = Number(snapshot.amount ?? snapshot.currentAmount ?? 0);
    const maxQuantity = Number(snapshot.maxQuantity ?? amount);
    const lastUpdated = Number(snapshot.lastUpdated ?? snapshot.updatedAt ?? 0);
    const rechargeTimePerPointMS = Number(snapshot.rechargeTimePerPointMS ?? snapshot.rechargeTimePerPoint ?? 0);
    const currentAmount = estimateCurrentConcentration(amount, lastUpdated, maxQuantity, rechargeTimePerPointMS);
    if (!Number.isFinite(currentAmount) || currentAmount < 0) return;
    candidates.push({
      ...snapshot,
      amount,
      currentAmount,
      currentAmountRounded: Math.floor(currentAmount),
      currentAmountFormatted: formatNumber(currentAmount),
      maxQuantity,
      maxQuantityFormatted: formatNumber(maxQuantity),
      lastUpdated,
      rechargeTimePerPointMS,
      updatedAt: Number(snapshot.updatedAt ?? lastUpdated ?? 0),
    });
  };

  addSnapshot(db?.concentration);
  for (const crafterMap of Object.values(db?.concentrationByCrafter ?? {})) {
    for (const snapshot of Object.values(crafterMap ?? {})) addSnapshot(snapshot);
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0) ||
    Number(b.currentAmount ?? 0) - Number(a.currentAmount ?? 0)
  );
  return candidates[0];
}

function estimateCurrentConcentration(amount, lastUpdated, maxQuantity, rechargeTimePerPointMS) {
  amount = Number(amount ?? 0);
  maxQuantity = Number(maxQuantity ?? amount);
  lastUpdated = Number(lastUpdated ?? 0);
  rechargeTimePerPointMS = Number(rechargeTimePerPointMS ?? 0);
  if (!lastUpdated || rechargeTimePerPointMS <= 0) return Math.min(maxQuantity, amount);
  const elapsed = Math.max(0, Date.now() / 1000 - lastUpdated);
  return Math.min(maxQuantity, amount + elapsed / (rechargeTimePerPointMS / 1000));
}

function normalizeMarketName(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function marketGroupKey(item) {
  return [
    String(item?.group ?? ""),
    String(item?.category ?? ""),
    normalizeMarketName(item?.name),
  ].join("|");
}

function buildMarketIndex(items) {
  const itemByID = new Map();
  const siblingsByName = new Map();
  for (const item of items || []) {
    const key = marketGroupKey(item);
    if (!siblingsByName.has(key)) siblingsByName.set(key, []);
    siblingsByName.get(key).push(item);
  }

  for (const [key, siblings] of siblingsByName.entries()) {
    const qualities = siblings
      .map((item) => Number(item.quality ?? 0))
      .filter((quality) => quality > 0);
    const hasUsefulQuality = new Set(qualities).size > 1;
    const sorted = [...siblings].sort((a, b) => {
      if (hasUsefulQuality) return Number(a.quality ?? 0) - Number(b.quality ?? 0);
      return Number(b.itemID ?? 0) - Number(a.itemID ?? 0);
    });
    const enriched = sorted.map((item, index) => ({
      ...item,
      inferredQuality: hasUsefulQuality ? Number(item.quality ?? index + 1) : index + 1,
      marketGroupKey: key,
    }));
    siblingsByName.set(key, enriched);
    for (const item of enriched) itemByID.set(Number(item.itemID), item);
  }

  return { itemByID, siblingsByName };
}

function resolveMarketResultItem(marketIndex, sourceItem, quality) {
  if (!marketIndex || !sourceItem) return sourceItem ?? null;
  const requestedQuality = Number(quality ?? 0);
  const sourceByID = marketIndex.itemByID.get(Number(sourceItem.itemID)) || sourceItem;
  if (!requestedQuality) return sourceByID;
  const siblings = marketIndex.siblingsByName.get(marketGroupKey(sourceByID)) || [];
  return siblings.find((item) => Number(item.inferredQuality ?? 0) === requestedQuality) ||
    siblings.find((item) => Number(item.itemID) === Number(sourceItem.itemID)) ||
    sourceByID;
}

function buildReport(snapshot, profitDB, config) {
  const recordsByItemID = profitDB.recordsByItemID ?? {};
  const marketIndex = buildMarketIndex(snapshot.items);
  const settings = {
    risk: config.risk,
    maxItemsPerRecipe: config.maxItemsPerRecipe,
    minProfitCopper: config.minProfitCopper,
    maxRecipes: config.maxRecipes,
    concentrationBudget: config.concentrationBudget,
    concentrationBudgetSource: config.concentrationBudgetSource,
    currentConcentration: config.savedConcentration,
  };
  const allRows = snapshot.items.map((item) => {
    const profit = recordsByItemID[String(item.itemID)] ?? null;
    return scoreItem(item, profit, { ...config, marketIndex });
  });

  const profitableRows = allRows
    .filter((row) => row.hasProfit && row.averageProfitCopper > config.minProfitCopper)

  const candidates = profitableRows
    .filter((row) => !row.usesConcentration)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.maxRecipes);

  const concentrationCandidates = allRows
    .filter(hasConcentrationData)
    .map((row) => addConcentrationSummary(row, config.concentrationBudget))
    .sort(compareConcentrationRows)
    .slice(0, Math.max(config.maxRecipes, 40));
  const concentrationVariants = buildConcentrationVariantRows(concentrationCandidates);
  const weeklyConcentrationPlan = buildConcentrationPlan(concentrationVariants, config.concentrationBudget);

  const missingProfit = allRows.filter((row) => !row.hasProfit);

  return {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    source: {
      snapshotPath: config.snapshotPath,
      profitSavedVariablesPath: config.profitSource.path,
      profitSavedVariablesName: config.profitSource.variableName,
      profitSourceLabel: config.profitSource.label,
      craftSimSavedVariablesPath: config.profitSource.variableName === "CraftSimProfitDB" ? config.profitSource.path : null,
      marketSourceUrl: snapshot.sourceUrl,
      marketSourceLabel: snapshot.sourceLabel ?? inferSourceLabel(snapshot.sourceUrl),
      movementSourceLabel: snapshot.sourceLabel ?? inferSourceLabel(snapshot.sourceUrl),
      undermineSourceUrl: snapshot.sourceUrl,
      snapshotUtc: snapshot.snapshotUtc,
      realm: snapshot.realm,
      market: snapshot.market,
      currentConcentration: config.savedConcentration,
    },
    settings,
    summary: {
      snapshotItems: snapshot.items.length,
      matchedProfitRecords: allRows.length - missingProfit.length,
      candidateCount: candidates.length,
      concentrationCandidateCount: concentrationCandidates.length,
      concentrationVariantCount: concentrationVariants.length,
      ingenuityAdjustedVariantCount: concentrationVariants.filter((variant) =>
        Math.abs(Number(variant.concentrationCost ?? 0) - Number(variant.effectiveConcentrationCost ?? variant.concentrationCost ?? 0)) >= 0.5
      ).length,
      weeklyConcentrationBudget: config.concentrationBudget,
      weeklyConcentrationUsed: weeklyConcentrationPlan.usedConcentration,
      weeklyConcentrationProfitCopper: weeklyConcentrationPlan.totalProfitCopper,
      weeklyConcentrationProfit: weeklyConcentrationPlan.totalProfit,
      positiveProfitItems: allRows.filter((row) => row.averageProfitCopper > 0).length,
      ingredientOptimizedItems: allRows.filter((row) => row.ingredientOptimization).length,
    },
    recommendations: candidates,
    concentrationRecommendations: concentrationCandidates,
    concentrationVariants,
    weeklyConcentrationPlan,
    allItems: allRows.sort((a, b) => b.score - a.score),
    missingProfit,
  };
}

function scoreItem(item, profit, config) {
  const explicitQualityTier = parseCraftingQualityTier(profit?.itemLink);
  const expectedQuality = profit?.expectedQuality ?? null;
  const expectedQualityConcentration = profit?.expectedQualityConcentration ?? expectedQuality;
  const qualityTier =
    explicitQualityTier ??
    (item.group === "alchemy" && Number(expectedQuality) > 0 ? Number(expectedQuality) : null);
  const concentrationQualityTier =
    Number(expectedQualityConcentration) > 0 ? Number(expectedQualityConcentration) : qualityTier;
  const qualityLabel = qualityTier ? `Q${qualityTier}` : "";
  const concentrationQualityLabel = concentrationQualityTier ? `Q${concentrationQualityTier}` : qualityLabel;
  const baseMarketItem = resolveMarketResultItem(config.marketIndex, item, qualityTier ?? expectedQuality);
  const concentrationMarketItem = resolveMarketResultItem(config.marketIndex, item, concentrationQualityTier);
  const currentQuantity = Number(baseMarketItem?.currentQuantity ?? item.currentQuantity ?? 0);
  const drop7 = Number(baseMarketItem?.sevenDayDropProxy ?? item.sevenDayDropProxy ?? 0);
  const avgQty7 = Number(baseMarketItem?.sevenDayAverageQuantity ?? item.sevenDayAverageQuantity ?? currentQuantity);
  const concentrationCurrentQuantity = Number(concentrationMarketItem?.currentQuantity ?? currentQuantity);
  const concentrationDrop7 = Number(concentrationMarketItem?.sevenDayDropProxy ?? drop7);
  const concentrationAvgQty7 = Number(concentrationMarketItem?.sevenDayAverageQuantity ?? concentrationCurrentQuantity);
  const dailyDrop = drop7 / 7;
  const concentrationDailyDrop = concentrationDrop7 / 7;
  const marketConfidence = getMarketConfidence(dailyDrop, currentQuantity);
  const concentrationMarketConfidence = getMarketConfidence(concentrationDailyDrop, concentrationCurrentQuantity);
  const yieldPerCraft = Math.max(1, Number(profit?.expectedYieldPerCraft ?? 1));
  const craftingCostsCopper = Number(profit?.craftingCosts ?? 0);
  const craftSimResultPriceCopper = Number(profit?.resultItemPrice ?? 0);
  const marketResultPriceCopper = Number(baseMarketItem?.currentMinPriceCopper ?? item.currentMinPriceCopper ?? 0);
  const concentrationMarketResultPriceCopper = Number(concentrationMarketItem?.currentMinPriceCopper ?? marketResultPriceCopper);
  const useMarketResultPrice = Boolean(profit) && config.useMarketResultPrice !== false && marketResultPriceCopper > 0;
  const useConcentrationMarketResultPrice = Boolean(profit) && config.useMarketResultPrice !== false && concentrationMarketResultPriceCopper > 0;
  const resultPriceCopper = useMarketResultPrice
    ? marketResultPriceCopper
    : craftSimResultPriceCopper || marketResultPriceCopper;
  const concentrationResultPriceCopper = useConcentrationMarketResultPrice
    ? concentrationMarketResultPriceCopper
    : resultPriceCopper;
  const averageProfitCopper = Boolean(profit)
    ? useMarketResultPrice
      ? getAuctionHouseSaleValue(resultPriceCopper, yieldPerCraft) - craftingCostsCopper
      : Number(profit?.averageProfit ?? 0)
    : 0;
  const concentrationAverageProfitCopper = Boolean(profit)
    ? getAuctionHouseSaleValue(concentrationResultPriceCopper, yieldPerCraft) - craftingCostsCopper
    : 0;
  const displayName = qualityLabel ? `${item.name} ${qualityLabel}` : item.name;
  const concentrationDisplayName = concentrationQualityLabel ? `${item.name} ${concentrationQualityLabel}` : displayName;
  const concentrationCost = Math.max(0, Number(profit?.concentrationCost ?? 0));
  const effectiveConcentrationCost = getEffectiveConcentrationCost(profit, concentrationCost);
  const usesConcentration = Boolean(profit?.concentration) || concentrationCost > 0;
  const profitPerConcentrationCopper =
    usesConcentration && effectiveConcentrationCost > 0 ? averageProfitCopper / effectiveConcentrationCost : 0;
  const concentrationProfitPerConcentrationCopper =
    usesConcentration && effectiveConcentrationCost > 0 ? concentrationAverageProfitCopper / effectiveConcentrationCost : 0;

  const stockPressure =
    avgQty7 > 0 && currentQuantity > avgQty7 * 1.4 ? 0.55 :
    avgQty7 > 0 && currentQuantity < avgQty7 * 0.75 ? 1.2 :
    1;

  const targetItemsRaw = Math.min(
    dailyDrop * config.risk,
    Math.max(10, avgQty7 * config.risk * 0.5),
    config.maxItemsPerRecipe,
  ) * stockPressure;
  let suggestedItems = averageProfitCopper > 0
    ? Math.min(config.maxItemsPerRecipe, roundNice(Math.max(1, targetItemsRaw)))
    : 0;
  let suggestedCrafts = suggestedItems > 0 ? Math.ceil(suggestedItems / yieldPerCraft) : 0;
  let craftLimit = "";
  if (usesConcentration && suggestedCrafts > 0) {
    suggestedCrafts = 1;
    suggestedItems = yieldPerCraft;
    craftLimit = "Concentration-limited";
  }
  const expectedProfitCopper = suggestedCrafts * averageProfitCopper;
  const estimatedCraftingCostCopper = suggestedCrafts * craftingCostsCopper;
  const movementScore = Math.sqrt(Math.max(0, dailyDrop));
  const profitGold = Math.max(0, averageProfitCopper / 10000);
  const score = profitGold * movementScore;
  const ingredientOptimization = normalizeIngredientOptimization(profit?.variantOptimization, {
    displayName,
    concentrationDisplayName,
    suggestedCrafts,
    marketResultPriceCopper: useMarketResultPrice ? resultPriceCopper : 0,
    concentrationMarketResultPriceCopper: useConcentrationMarketResultPrice ? concentrationResultPriceCopper : 0,
    useMarketResultPrice,
    sourceMarketItem: item,
    marketIndex: config.marketIndex,
    usesConcentration,
    concentrationBudget: config.concentrationBudget,
  });

  return {
    group: item.group ?? "unknown",
    groupLabel: item.groupLabel ?? "Crafting",
    category: item.category ?? "",
    requiredLevel: item.requiredLevel ?? null,
    expansion: item.expansion ?? null,
    itemID: item.itemID,
    name: item.name,
    displayName,
    hasProfit: Boolean(profit),
    recipeID: profit?.recipeID ?? null,
    recipeName: profit?.recipeName ?? null,
    crafterUID: profit?.crafterUID ?? null,
    expectedQuality,
    expectedQualityConcentration,
    qualityTier,
    qualityLabel,
    concentrationQualityTier,
    concentrationQualityLabel,
    concentrationDisplayName,
    usesConcentration,
    concentrationCost,
    concentrationCostFormatted: formatNumber(concentrationCost),
    effectiveConcentrationCost,
    effectiveConcentrationCostFormatted: formatNumber(effectiveConcentrationCost),
    concentrationCostLabel: formatConcentrationCost(concentrationCost, effectiveConcentrationCost),
    concentrationIngenuityNote: formatIngenuityNote(concentrationCost, effectiveConcentrationCost, profit),
    expectedIngenuityRefund: Math.max(0, concentrationCost - effectiveConcentrationCost),
    expectedIngenuityRefundFormatted: formatNumber(Math.max(0, concentrationCost - effectiveConcentrationCost)),
    craftingStats: profit?.craftingStats ?? null,
    profitPerConcentrationCopper,
    profitPerConcentration: formatCopper(profitPerConcentrationCopper),
    concentrationProfitPerConcentrationCopper,
    concentrationProfitPerConcentration: formatCopper(concentrationProfitPerConcentrationCopper),
    craftLimit,
    yieldPerCraft,
    yieldPerCraftFormatted: formatQuantity(yieldPerCraft),
    averageProfitCopper,
    averageProfit: formatCopper(averageProfitCopper),
    concentrationAverageProfitCopper,
    concentrationAverageProfit: formatCopper(concentrationAverageProfitCopper),
    resultPriceCopper,
    resultPrice: formatCopper(resultPriceCopper),
    concentrationResultPriceCopper,
    concentrationResultPrice: formatCopper(concentrationResultPriceCopper),
    resultPriceSource: useMarketResultPrice ? "market" : "craftsim",
    craftingCostsCopper,
    craftingCosts: formatCopper(craftingCostsCopper),
    currentQuantity,
    currentQuantityFormatted: formatNumber(currentQuantity),
    currentMinPrice: item.currentMinPrice,
    sevenDayAverageQuantity: avgQty7,
    sevenDayAverageQuantityFormatted: formatNumber(avgQty7),
    sevenDayDropProxy: drop7,
    sevenDayDropProxyFormatted: formatNumber(drop7),
    dailyDropProxy: dailyDrop,
    dailyDropProxyFormatted: formatNumber(Math.round(dailyDrop)),
    marketConfidenceLevel: marketConfidence.level,
    marketConfidenceLabel: marketConfidence.label,
    marketConfidenceWarning: marketConfidence.warning,
    concentrationItemID: concentrationMarketItem?.itemID ?? item.itemID,
    concentrationCurrentQuantity,
    concentrationCurrentQuantityFormatted: formatNumber(concentrationCurrentQuantity),
    concentrationSevenDayAverageQuantity: concentrationAvgQty7,
    concentrationSevenDayAverageQuantityFormatted: formatNumber(concentrationAvgQty7),
    concentrationSevenDayDropProxy: concentrationDrop7,
    concentrationSevenDayDropProxyFormatted: formatNumber(concentrationDrop7),
    concentrationDailyDropProxy: concentrationDailyDrop,
    concentrationDailyDropProxyFormatted: formatNumber(Math.round(concentrationDailyDrop)),
    concentrationMarketConfidenceLevel: concentrationMarketConfidence.level,
    concentrationMarketConfidenceLabel: concentrationMarketConfidence.label,
    concentrationMarketConfidenceWarning: concentrationMarketConfidence.warning,
    suggestedItems,
    suggestedItemsFormatted: formatQuantity(suggestedItems),
    suggestedCrafts,
    expectedProfitCopper,
    expectedProfit: formatCopper(expectedProfitCopper),
    estimatedCraftingCostCopper,
    estimatedCraftingCost: formatCopper(estimatedCraftingCostCopper),
    score,
    updatedAt: profit?.updatedAt ?? null,
    ingredientOptimization,
  };
}

function getMarketConfidence(dailyDrop, currentQuantity) {
  dailyDrop = Number(dailyDrop ?? 0);
  currentQuantity = Number(currentQuantity ?? 0);
  if (dailyDrop >= 5000 && currentQuantity >= 1000) {
    return { level: "strong", label: "strong market", warning: "" };
  }
  if (dailyDrop >= 1000 && currentQuantity >= 500) {
    return { level: currentQuantity < 1000 ? "steady" : "strong", label: currentQuantity < 1000 ? "steady, thin stock" : "steady market", warning: currentQuantity < 1000 ? "Current stock is thin, so re-check price before buying mats." : "" };
  }
  if (dailyDrop >= 500 && currentQuantity >= 250) {
    return { level: "thin", label: "thin market", warning: "Low movement. Good margin can vanish if a few auctions undercut." };
  }
  return { level: "rare", label: "rarely bought", warning: "Very low movement. Do not spend weekly concentration here unless you already know buyers exist." };
}

function isWeeklyPlannerEligible(option) {
  const dailyDrop = Number(option?.dailyDropProxy ?? 0);
  const currentQuantity = Number(option?.currentQuantity ?? 0);
  return dailyDrop >= 500 && currentQuantity >= 250;
}

function getEffectiveConcentrationCost(source, rawCost) {
  rawCost = Math.max(0, Number(rawCost ?? source?.concentrationCost ?? 0));
  const exportedCost = Number(source?.effectiveConcentrationCost);
  if (Number.isFinite(exportedCost) && exportedCost > 0) {
    return Math.min(rawCost || exportedCost, Math.max(0, exportedCost));
  }

  const value = Number(source?.concentrationValue ?? 0);
  const profit = Number(source?.concentrationProfit ?? 0);
  if (value > 0 && profit > 0) {
    return Math.min(rawCost || profit / value, Math.max(0, profit / value));
  }

  return rawCost;
}

function formatConcentrationCost(rawCost, effectiveCost) {
  rawCost = Math.max(0, Number(rawCost ?? 0));
  effectiveCost = Math.max(0, Number(effectiveCost ?? rawCost));
  const rawFormatted = formatNumber(rawCost);
  const effectiveFormatted = formatNumber(effectiveCost);
  if (!rawCost || Math.abs(rawCost - effectiveCost) < 0.5) return rawFormatted;
  return `${effectiveFormatted} expected (${rawFormatted} raw)`;
}

function formatIngenuityNote(rawCost, effectiveCost, source) {
  rawCost = Math.max(0, Number(rawCost ?? 0));
  effectiveCost = Math.max(0, Number(effectiveCost ?? rawCost));
  if (!rawCost || Math.abs(rawCost - effectiveCost) < 0.5) return "";
  const saved = Math.max(0, rawCost - effectiveCost);
  const chance = Number(source?.craftingStats?.ingenuity?.percent ?? source?.ingenuityChance ?? 0);
  const chanceText = chance > 0 ? `, ${formatPercent(chance)} Ingenuity` : "";
  return `${formatNumber(effectiveCost)} expected concentration after Ingenuity (${formatNumber(saved)} average refund${chanceText}).`;
}

function formatPercent(value) {
  value = Number(value ?? 0);
  if (!Number.isFinite(value)) return "0%";
  const percent = value * 100;
  if (Math.abs(percent - Math.round(percent)) < 0.05) return `${Math.round(percent)}%`;
  return `${percent.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

function normalizeIngredientOptimization(optimization, context = {}) {
  const variants = asArray(optimization?.variants);
  if (!variants.length) return null;
  const testedCount = Number(optimization?.testedCount ?? 0);
  const savedCount = Number(optimization?.savedCount ?? variants.length);
  const totalEstimated = Number(optimization?.totalEstimated ?? 0);
  const exportMode = String(optimization?.exportMode ?? "");
  const schemaVersion = Number(optimization?.schemaVersion ?? 1);
  const isFullBlob = exportMode === "all-tested" || savedCount >= testedCount || schemaVersion >= 2;
  const isPrunedExport = testedCount > 0 && savedCount < testedCount && !isFullBlob;
  const normalizedVariants = variants.map((variant, index) => {
    const craftingCostsCopper = Number(variant.craftingCosts ?? 0);
    const expectedYieldPerCraft = Number(variant.expectedYieldPerCraft ?? 1);
    const expectedQuality = variant.expectedQuality ?? null;
    const expectedQualityConcentration = variant.expectedQualityConcentration ?? expectedQuality;
    const baseMarketItem = resolveMarketResultItem(context.marketIndex, context.sourceMarketItem, expectedQuality);
    const concentrationMarketItem = resolveMarketResultItem(context.marketIndex, context.sourceMarketItem, expectedQualityConcentration);
    const marketResultPriceCopper = Number(baseMarketItem?.currentMinPriceCopper ?? context.marketResultPriceCopper ?? 0);
    const concentrationMarketResultPriceCopper = Number(concentrationMarketItem?.currentMinPriceCopper ?? context.concentrationMarketResultPriceCopper ?? marketResultPriceCopper);
    const resultItemPriceCopper = context.useMarketResultPrice && marketResultPriceCopper > 0
      ? marketResultPriceCopper
      : Number(variant.resultItemPrice ?? 0);
    const concentrationResultItemPriceCopper = context.useMarketResultPrice && concentrationMarketResultPriceCopper > 0
      ? concentrationMarketResultPriceCopper
      : resultItemPriceCopper;
    const averageProfitCopper = context.useMarketResultPrice && resultItemPriceCopper > 0
      ? getAuctionHouseSaleValue(resultItemPriceCopper, expectedYieldPerCraft) - craftingCostsCopper
      : Number(variant.averageProfit ?? 0);
    const concentrationAverageProfitCopper = context.useMarketResultPrice && concentrationResultItemPriceCopper > 0
      ? getAuctionHouseSaleValue(concentrationResultItemPriceCopper, expectedYieldPerCraft) - craftingCostsCopper
      : averageProfitCopper;
    const concentrationCost = Math.max(0, Number(variant.concentrationCost ?? 0));
    const effectiveConcentrationCost = getEffectiveConcentrationCost(variant, concentrationCost);
    const profitPerConcentrationCopper = effectiveConcentrationCost > 0 ? averageProfitCopper / effectiveConcentrationCost : 0;
    const concentrationProfitPerConcentrationCopper = effectiveConcentrationCost > 0 ? concentrationAverageProfitCopper / effectiveConcentrationCost : 0;
    const planningAverageProfitCopper = context.usesConcentration
      ? concentrationAverageProfitCopper
      : averageProfitCopper;
    const planningProfitPerConcentrationCopper = context.usesConcentration
      ? concentrationProfitPerConcentrationCopper
      : profitPerConcentrationCopper;
    const planningResultItemPriceCopper = context.usesConcentration
      ? concentrationResultItemPriceCopper
      : resultItemPriceCopper;
    const rank = Number(variant.rank ?? index + 1);
    const shoppingItems = buildShoppingItems(variant.allocation, context.suggestedCrafts);
    const shoppingListName = buildShoppingListName(context.usesConcentration ? context.concentrationDisplayName : context.displayName, rank);
    const allocationSummary = summarizeVariantAllocation(variant.allocation);
    return {
      rank,
      expectedQuality,
      expectedQualityConcentration,
      planningExpectedQuality: context.usesConcentration ? expectedQualityConcentration : expectedQuality,
      expectedYieldPerCraft,
      averageProfitCopper,
      averageProfit: formatCopper(averageProfitCopper),
      concentrationAverageProfitCopper,
      concentrationAverageProfit: formatCopper(concentrationAverageProfitCopper),
      planningAverageProfitCopper,
      planningAverageProfit: formatCopper(planningAverageProfitCopper),
      craftingCostsCopper,
      craftingCosts: formatCopper(craftingCostsCopper),
      resultItemPriceCopper,
      resultItemPrice: formatCopper(resultItemPriceCopper),
      concentrationResultItemPriceCopper,
      concentrationResultItemPrice: formatCopper(concentrationResultItemPriceCopper),
      planningResultItemPriceCopper,
      planningResultItemPrice: formatCopper(planningResultItemPriceCopper),
      concentration: Boolean(variant.concentration) || concentrationCost > 0,
      concentrationCost,
      concentrationCostFormatted: formatNumber(concentrationCost),
      effectiveConcentrationCost,
      effectiveConcentrationCostFormatted: formatNumber(effectiveConcentrationCost),
      concentrationCostLabel: formatConcentrationCost(concentrationCost, effectiveConcentrationCost),
      concentrationIngenuityNote: formatIngenuityNote(concentrationCost, effectiveConcentrationCost, variant),
      expectedIngenuityRefund: Math.max(0, concentrationCost - effectiveConcentrationCost),
      expectedIngenuityRefundFormatted: formatNumber(Math.max(0, concentrationCost - effectiveConcentrationCost)),
      craftingStats: variant.craftingStats ?? null,
      profitPerConcentrationCopper,
      profitPerConcentration: effectiveConcentrationCost > 0 ? formatCopper(profitPerConcentrationCopper) : "n/a",
      concentrationProfitPerConcentrationCopper,
      concentrationProfitPerConcentration: effectiveConcentrationCost > 0 ? formatCopper(concentrationProfitPerConcentrationCopper) : "n/a",
      planningProfitPerConcentrationCopper,
      planningProfitPerConcentration: effectiveConcentrationCost > 0 ? formatCopper(planningProfitPerConcentrationCopper) : "n/a",
      allocationText: allocationSummary.text,
      qualityProfile: allocationSummary.label,
      qualityProfileShort: allocationSummary.shortLabel,
      qualityProfileRank: allocationSummary.rank,
      qualityTierSummary: allocationSummary.tierSummary,
      shoppingItems,
      shoppingPayload: shoppingItems.length ? formatShoppingPayload(shoppingListName, shoppingItems) : "",
    };
  });
  const topVariant = normalizedVariants[0] ?? {};
  const bestPerConcentration = normalizedVariants.reduce(
    (best, variant) => variant.planningProfitPerConcentrationCopper > (best?.planningProfitPerConcentrationCopper ?? -Infinity) ? variant : best,
    null,
  );

  return {
    schemaVersion,
    updatedAt: optimization.updatedAt ?? null,
    exportMode,
    isFullBlob,
    isPrunedExport,
    savedCount,
    savedCountFormatted: formatNumber(savedCount),
    testedCount,
    testedCountFormatted: formatNumber(testedCount),
    totalEstimated,
    totalEstimatedFormatted: formatNumber(totalEstimated),
    truncated: Boolean(optimization.truncated),
    includeOptional: Boolean(optimization.includeOptional),
    includeFinishing: Boolean(optimization.includeFinishing),
    bestProfitVariantRank: topVariant.rank ?? null,
    bestPerConcentrationVariantRank: bestPerConcentration?.rank ?? null,
    variants: normalizedVariants.map((variant) => ({
      ...variant,
      concentrationDeltaFromTop: variant.concentrationCost - Number(topVariant.concentrationCost ?? 0),
      concentrationDeltaFromTopFormatted: formatSignedNumber(variant.concentrationCost - Number(topVariant.concentrationCost ?? 0)),
      profitDeltaFromTopCopper: variant.planningAverageProfitCopper - Number(topVariant.planningAverageProfitCopper ?? 0),
      profitDeltaFromTop: formatSignedCopper(variant.planningAverageProfitCopper - Number(topVariant.planningAverageProfitCopper ?? 0)),
      profitPerConcentrationDeltaCopper:
        variant.planningProfitPerConcentrationCopper - Number(bestPerConcentration?.planningProfitPerConcentrationCopper ?? 0),
      profitPerConcentrationDelta:
        formatSignedCopper(variant.planningProfitPerConcentrationCopper - Number(bestPerConcentration?.planningProfitPerConcentrationCopper ?? 0)),
      bestPerConcentration: variant.rank === bestPerConcentration?.rank,
    })),
  };
}

function hasConcentrationData(row) {
  if (row.usesConcentration && row.concentrationCost > 0) return true;
  return Boolean(row.ingredientOptimization?.variants?.some((variant) => Number(variant.concentrationCost ?? 0) > 0));
}

function getVariantBudgetStatsData(variant, budget) {
  budget = Math.max(0, Math.floor(Number(budget ?? 0)));
  const concentrationCost = Math.max(0, Math.round(Number(variant?.effectiveConcentrationCost ?? variant?.concentrationCost ?? 0)));
  const averageProfitCopper = Number(variant?.planningAverageProfitCopper ?? variant?.concentrationAverageProfitCopper ?? variant?.averageProfitCopper ?? 0);
  const crafts = concentrationCost > 0 ? Math.floor(budget / concentrationCost) : 0;
  const usedConcentration = crafts * concentrationCost;
  return {
    concentrationCost,
    crafts,
    usedConcentration,
    leftoverConcentration: Math.max(0, budget - usedConcentration),
    totalProfitCopper: crafts * averageProfitCopper,
  };
}

function pickBestVariant(variants, comparator) {
  return variants.reduce((best, variant) => {
    if (!best) return variant;
    return comparator(variant, best) > 0 ? variant : best;
  }, null);
}

function addConcentrationSummary(row, budget) {
  const variants = (row.ingredientOptimization?.variants ?? [])
    .filter((variant) => Number(variant.concentrationCost ?? 0) > 0);
  const positiveVariants = variants.filter((variant) =>
    Number(variant.planningAverageProfitCopper ?? variant.concentrationAverageProfitCopper ?? variant.averageProfitCopper ?? 0) > 0
  );
  const rankingVariants = positiveVariants.length ? positiveVariants : variants;
  const bestBudgetVariant = pickBestVariant(rankingVariants, (a, b) =>
    getVariantBudgetStatsData(a, budget).totalProfitCopper - getVariantBudgetStatsData(b, budget).totalProfitCopper ||
    Number(a.planningProfitPerConcentrationCopper ?? a.concentrationProfitPerConcentrationCopper ?? a.profitPerConcentrationCopper ?? 0) -
      Number(b.planningProfitPerConcentrationCopper ?? b.concentrationProfitPerConcentrationCopper ?? b.profitPerConcentrationCopper ?? 0) ||
    Number(a.planningAverageProfitCopper ?? a.concentrationAverageProfitCopper ?? a.averageProfitCopper ?? 0) -
      Number(b.planningAverageProfitCopper ?? b.concentrationAverageProfitCopper ?? b.averageProfitCopper ?? 0)
  );
  const bestProfitVariant = pickBestVariant(rankingVariants, (a, b) =>
    Number(a.planningAverageProfitCopper ?? a.concentrationAverageProfitCopper ?? a.averageProfitCopper ?? 0) -
      Number(b.planningAverageProfitCopper ?? b.concentrationAverageProfitCopper ?? b.averageProfitCopper ?? 0) ||
    Number(b.effectiveConcentrationCost ?? b.concentrationCost ?? 0) - Number(a.effectiveConcentrationCost ?? a.concentrationCost ?? 0)
  );
  const bestPerPointVariant = pickBestVariant(rankingVariants, (a, b) =>
    Number(a.planningProfitPerConcentrationCopper ?? a.concentrationProfitPerConcentrationCopper ?? a.profitPerConcentrationCopper ?? 0) -
      Number(b.planningProfitPerConcentrationCopper ?? b.concentrationProfitPerConcentrationCopper ?? b.profitPerConcentrationCopper ?? 0) ||
    Number(a.planningAverageProfitCopper ?? a.concentrationAverageProfitCopper ?? a.averageProfitCopper ?? 0) -
      Number(b.planningAverageProfitCopper ?? b.concentrationAverageProfitCopper ?? b.averageProfitCopper ?? 0)
  );
  const bestVariant = bestBudgetVariant || bestPerPointVariant || bestProfitVariant;
  const bestBudgetStats = getVariantBudgetStatsData(bestVariant, budget);
  const bestProfitCopper = Number(bestVariant?.planningAverageProfitCopper ?? bestVariant?.concentrationAverageProfitCopper ?? row.concentrationAverageProfitCopper ?? row.averageProfitCopper ?? 0);
  const bestRawConcentrationCost = Math.max(0, Math.round(Number(bestVariant?.concentrationCost ?? row.concentrationCost ?? 0)));
  const bestEffectiveConcentrationCost = Math.max(0, Number(bestVariant?.effectiveConcentrationCost ?? row.effectiveConcentrationCost ?? bestRawConcentrationCost));
  const bestCraftingCostCopper = Number(bestVariant?.craftingCostsCopper ?? row.craftingCostsCopper ?? 0);
  const bestPerPointCopper = bestEffectiveConcentrationCost > 0 ? bestProfitCopper / bestEffectiveConcentrationCost : 0;

  return {
    ...row,
    concentrationVariantCount: variants.length,
    positiveConcentrationVariantCount: positiveVariants.length,
    concentrationBestVariantRank: bestVariant?.rank ?? null,
    concentrationBestPath: bestVariant?.qualityProfileShort ?? row.qualityLabel ?? "Current path",
    concentrationBestAllocation: bestVariant?.allocationText ?? "",
    concentrationBestExpectedQuality: bestVariant?.planningExpectedQuality ?? bestVariant?.expectedQualityConcentration ?? row.expectedQualityConcentration,
    concentrationBestProfitCopper: bestProfitCopper,
    concentrationBestProfit: formatCopper(bestProfitCopper),
    concentrationBestCraftingCostCopper: bestCraftingCostCopper,
    concentrationBestCraftingCost: formatCopper(bestCraftingCostCopper),
    concentrationBestCost: bestEffectiveConcentrationCost,
    concentrationBestCostFormatted: formatNumber(bestEffectiveConcentrationCost),
    concentrationBestRawCost: bestRawConcentrationCost,
    concentrationBestRawCostFormatted: formatNumber(bestRawConcentrationCost),
    concentrationBestCostLabel: formatConcentrationCost(bestRawConcentrationCost, bestEffectiveConcentrationCost),
    concentrationBestIngenuityNote: bestVariant?.concentrationIngenuityNote ?? row.concentrationIngenuityNote ?? "",
    concentrationBestPerPointCopper: bestPerPointCopper,
    concentrationBestPerPoint: bestEffectiveConcentrationCost > 0 ? formatCopper(bestPerPointCopper) : "n/a",
    concentrationBestBudgetProfitCopper: bestBudgetStats.totalProfitCopper,
    concentrationBestBudgetProfit: formatCopper(bestBudgetStats.totalProfitCopper),
    concentrationBestBudgetCrafts: bestBudgetStats.crafts,
    concentrationBestBudgetLeftover: bestBudgetStats.leftoverConcentration,
  };
}

function compareConcentrationRows(a, b) {
  const aPositive = Number(a.positiveConcentrationVariantCount ?? 0) > 0 ? 1 : 0;
  const bPositive = Number(b.positiveConcentrationVariantCount ?? 0) > 0 ? 1 : 0;
  return bPositive - aPositive ||
    Number(b.concentrationBestBudgetProfitCopper ?? 0) - Number(a.concentrationBestBudgetProfitCopper ?? 0) ||
    Number(b.concentrationBestPerPointCopper ?? 0) - Number(a.concentrationBestPerPointCopper ?? 0) ||
    Number(b.concentrationBestProfitCopper ?? 0) - Number(a.concentrationBestProfitCopper ?? 0) ||
    Number(b.concentrationDailyDropProxy ?? b.dailyDropProxy ?? 0) - Number(a.concentrationDailyDropProxy ?? a.dailyDropProxy ?? 0);
}

function buildConcentrationVariantRows(rows) {
  const options = [];
  for (const row of rows) {
    const variants = row.ingredientOptimization?.variants?.length
      ? row.ingredientOptimization.variants
      : [{
          rank: 1,
          expectedQuality: row.expectedQualityConcentration ?? row.expectedQuality,
          planningExpectedQuality: row.expectedQualityConcentration ?? row.expectedQuality,
          expectedYieldPerCraft: row.yieldPerCraft,
          averageProfitCopper: row.concentrationAverageProfitCopper ?? row.averageProfitCopper,
          averageProfit: row.concentrationAverageProfit ?? row.averageProfit,
          planningAverageProfitCopper: row.concentrationAverageProfitCopper ?? row.averageProfitCopper,
          planningAverageProfit: row.concentrationAverageProfit ?? row.averageProfit,
          craftingCostsCopper: row.craftingCostsCopper,
          craftingCosts: row.craftingCosts,
          resultItemPriceCopper: row.concentrationResultPriceCopper ?? row.resultPriceCopper,
          resultItemPrice: row.concentrationResultPrice ?? row.resultPrice,
          planningResultItemPriceCopper: row.concentrationResultPriceCopper ?? row.resultPriceCopper,
          planningResultItemPrice: row.concentrationResultPrice ?? row.resultPrice,
          concentrationCost: row.concentrationCost,
          concentrationCostFormatted: row.concentrationCostFormatted,
          effectiveConcentrationCost: row.effectiveConcentrationCost,
          effectiveConcentrationCostFormatted: row.effectiveConcentrationCostFormatted,
          concentrationCostLabel: row.concentrationCostLabel,
          concentrationIngenuityNote: row.concentrationIngenuityNote,
          profitPerConcentrationCopper: row.concentrationProfitPerConcentrationCopper ?? row.profitPerConcentrationCopper,
          profitPerConcentration: row.concentrationProfitPerConcentration ?? row.profitPerConcentration,
          planningProfitPerConcentrationCopper: row.concentrationProfitPerConcentrationCopper ?? row.profitPerConcentrationCopper,
          planningProfitPerConcentration: row.concentrationProfitPerConcentration ?? row.profitPerConcentration,
          allocationText: "",
          qualityProfile: row.qualityLabel || "Current CraftSim path",
          qualityProfileShort: row.qualityLabel || "Current path",
          qualityProfileRank: 0,
          shoppingItems: [],
        }];

    for (const variant of variants) {
      const concentrationCost = Math.round(Number(variant.concentrationCost ?? row.concentrationCost ?? 0));
      const effectiveConcentrationCost = Number(variant.effectiveConcentrationCost ?? row.effectiveConcentrationCost ?? concentrationCost);
      const averageProfitCopper = Number(variant.planningAverageProfitCopper ?? variant.concentrationAverageProfitCopper ?? row.concentrationAverageProfitCopper ?? row.averageProfitCopper ?? 0);
      if (concentrationCost <= 0 || averageProfitCopper <= 0) continue;
      const expectedYieldPerCraft = Number(variant.expectedYieldPerCraft ?? row.yieldPerCraft ?? 1);
      const planningConcentrationCost = Math.max(0, effectiveConcentrationCost || concentrationCost);
      const profitPerConcentrationCopper = planningConcentrationCost > 0 ? averageProfitCopper / planningConcentrationCost : 0;
      const rank = Number(variant.rank ?? 1);
      const optionID = [
        row.itemID,
        row.recipeID || "",
        row.concentrationQualityLabel || row.qualityLabel || "",
        rank,
      ].join(":");

      options.push({
        optionID,
        itemID: row.itemID,
        recipeID: row.recipeID,
        recipeName: row.recipeName,
        name: row.name,
        displayName: row.concentrationDisplayName || row.displayName,
        groupLabel: row.groupLabel,
        category: row.category,
        qualityLabel: row.concentrationQualityLabel || row.qualityLabel,
        variantRank: rank,
        expectedQuality: variant.planningExpectedQuality ?? variant.expectedQualityConcentration ?? row.expectedQualityConcentration ?? row.expectedQuality,
        expectedYieldPerCraft,
        expectedYieldPerCraftFormatted: formatQuantity(expectedYieldPerCraft),
        concentrationCost,
        concentrationCostFormatted: formatNumber(concentrationCost),
        effectiveConcentrationCost: planningConcentrationCost,
        effectiveConcentrationCostFormatted: formatNumber(planningConcentrationCost),
        concentrationCostLabel: formatConcentrationCost(concentrationCost, planningConcentrationCost),
        concentrationIngenuityNote: variant.concentrationIngenuityNote ?? row.concentrationIngenuityNote ?? "",
        expectedIngenuityRefund: Math.max(0, concentrationCost - planningConcentrationCost),
        expectedIngenuityRefundFormatted: formatNumber(Math.max(0, concentrationCost - planningConcentrationCost)),
        averageProfitCopper,
        averageProfit: formatCopper(averageProfitCopper),
        profitPerConcentrationCopper,
        profitPerConcentration: formatCopper(profitPerConcentrationCopper),
        craftingCostsCopper: Number(variant.craftingCostsCopper ?? row.craftingCostsCopper ?? 0),
        craftingCosts: formatCopper(variant.craftingCostsCopper ?? row.craftingCostsCopper ?? 0),
        resultPriceCopper: Number(variant.planningResultItemPriceCopper ?? variant.concentrationResultItemPriceCopper ?? row.concentrationResultPriceCopper ?? row.resultPriceCopper ?? 0),
        resultPrice: formatCopper(variant.planningResultItemPriceCopper ?? variant.concentrationResultItemPriceCopper ?? row.concentrationResultPriceCopper ?? row.resultPriceCopper ?? 0),
        dailyDropProxy: row.concentrationDailyDropProxy ?? row.dailyDropProxy,
        dailyDropProxyFormatted: row.concentrationDailyDropProxyFormatted ?? row.dailyDropProxyFormatted,
        currentQuantity: row.concentrationCurrentQuantity ?? row.currentQuantity,
        currentQuantityFormatted: row.concentrationCurrentQuantityFormatted ?? row.currentQuantityFormatted,
        sevenDayAverageQuantity: row.concentrationSevenDayAverageQuantity ?? row.sevenDayAverageQuantity,
        sevenDayAverageQuantityFormatted: row.concentrationSevenDayAverageQuantityFormatted ?? row.sevenDayAverageQuantityFormatted,
        marketConfidenceLevel: row.concentrationMarketConfidenceLevel ?? row.marketConfidenceLevel,
        marketConfidenceLabel: row.concentrationMarketConfidenceLabel ?? row.marketConfidenceLabel,
        marketConfidenceWarning: row.concentrationMarketConfidenceWarning ?? row.marketConfidenceWarning,
        allocationText: variant.allocationText || "",
        qualityProfile: variant.qualityProfile || "Optimizer path",
        qualityProfileShort: variant.qualityProfileShort || "Optimizer path",
        qualityProfileRank: Number(variant.qualityProfileRank ?? 0),
        concentrationDeltaFromTop: Number(variant.concentrationDeltaFromTop ?? 0),
        concentrationDeltaFromTopFormatted: variant.concentrationDeltaFromTopFormatted ?? "0",
        profitDeltaFromTopCopper: Number(variant.profitDeltaFromTopCopper ?? 0),
        profitDeltaFromTop: variant.profitDeltaFromTop ?? "0c",
        profitPerConcentrationDeltaCopper: Number(variant.profitPerConcentrationDeltaCopper ?? 0),
        profitPerConcentrationDelta: variant.profitPerConcentrationDelta ?? "0c",
        bestPerConcentration: Boolean(variant.bestPerConcentration),
        shoppingItems: variant.shoppingItems || [],
        shoppingPayload: variant.shoppingPayload || "",
      });
    }
  }

  return options.sort((a, b) =>
    b.profitPerConcentrationCopper - a.profitPerConcentrationCopper ||
    b.averageProfitCopper - a.averageProfitCopper ||
    a.effectiveConcentrationCost - b.effectiveConcentrationCost ||
    a.concentrationCost - b.concentrationCost
  );
}

function getOptionBudgetStats(option, budget) {
  budget = Math.max(0, Math.floor(Number(budget ?? 0)));
  const concentrationCost = Math.max(0, Math.round(Number(option?.effectiveConcentrationCost ?? option?.concentrationCost ?? 0)));
  const averageProfitCopper = Number(option?.averageProfitCopper ?? 0);
  const crafts = concentrationCost > 0 ? Math.floor(budget / concentrationCost) : 0;
  const usedConcentration = crafts * concentrationCost;
  return {
    concentrationCost,
    crafts,
    usedConcentration,
    leftoverConcentration: Math.max(0, budget - usedConcentration),
    totalProfitCopper: crafts * averageProfitCopper,
  };
}

function buildPlannerCandidatePool(options, budget, limit = 720) {
  const valid = (options || []).filter((option) => option.concentrationCost > 0 && option.averageProfitCopper > 0);
  if (valid.length <= limit) return valid;

  const selected = [];
  const seen = new Set();
  const add = (option) => {
    if (!option || seen.has(option.optionID)) return;
    seen.add(option.optionID);
    selected.push(option);
  };
  const addSorted = (comparator, count) => {
    for (const option of [...valid].sort(comparator).slice(0, count)) add(option);
  };

  addSorted((a, b) =>
    getOptionBudgetStats(b, budget).totalProfitCopper - getOptionBudgetStats(a, budget).totalProfitCopper ||
    b.profitPerConcentrationCopper - a.profitPerConcentrationCopper ||
    a.effectiveConcentrationCost - b.effectiveConcentrationCost,
    220,
  );
  addSorted((a, b) => b.profitPerConcentrationCopper - a.profitPerConcentrationCopper, 180);
  addSorted((a, b) => b.averageProfitCopper - a.averageProfitCopper, 140);
  addSorted((a, b) =>
    a.effectiveConcentrationCost - b.effectiveConcentrationCost ||
    a.concentrationCost - b.concentrationCost ||
    b.averageProfitCopper - a.averageProfitCopper,
    140,
  );

  const byRecipe = new Map();
  for (const option of valid) {
    const key = [option.itemID, option.recipeID, option.qualityLabel || ""].join(":");
    if (!byRecipe.has(key)) byRecipe.set(key, []);
    byRecipe.get(key).push(option);
  }
  for (const group of byRecipe.values()) {
    add(group.reduce((best, option) =>
      !best || getOptionBudgetStats(option, budget).totalProfitCopper > getOptionBudgetStats(best, budget).totalProfitCopper
        ? option
        : best,
      null,
    ));
    add(group.reduce((best, option) =>
      !best || option.profitPerConcentrationCopper > best.profitPerConcentrationCopper ? option : best,
      null,
    ));
    add(group.reduce((best, option) =>
      !best || option.averageProfitCopper > best.averageProfitCopper ? option : best,
      null,
    ));
    add(group.reduce((best, option) =>
      !best ||
      option.effectiveConcentrationCost < best.effectiveConcentrationCost ||
      (option.effectiveConcentrationCost === best.effectiveConcentrationCost && option.averageProfitCopper > best.averageProfitCopper)
        ? option
        : best,
      null,
    ));
  }

  return selected.slice(0, limit);
}

function buildConcentrationPlan(options, budget) {
  budget = Math.max(0, Math.floor(Number(budget ?? 0)));
  const positiveOptions = (options || []).filter((option) => option.concentrationCost > 0 && option.averageProfitCopper > 0);
  const eligibleOptions = positiveOptions.filter(isWeeklyPlannerEligible);
  const plannerOptions = eligibleOptions.length ? eligibleOptions : positiveOptions;
  const validOptions = buildPlannerCandidatePool(plannerOptions, budget);
  const marketFilteredCount = positiveOptions.length - eligibleOptions.length;

  const empty = {
    budget,
    usedConcentration: 0,
    usedConcentrationFormatted: "0",
    leftoverConcentration: budget,
    leftoverConcentrationFormatted: formatNumber(budget),
    totalProfitCopper: 0,
    totalProfit: "0c",
    totalCrafts: 0,
    marketFilteredCount,
    items: [],
  };
  if (!budget || !validOptions.length) return empty;

  const dp = Array.from({ length: budget + 1 }, () => null);
  dp[0] = { profit: 0, picks: [] };
  for (let spent = 0; spent <= budget; spent += 1) {
    const state = dp[spent];
    if (!state) continue;
    for (const option of validOptions) {
      const optionCost = Math.max(0, Math.round(Number(option.effectiveConcentrationCost ?? option.concentrationCost ?? 0)));
      if (!optionCost) continue;
      const nextSpent = spent + optionCost;
      if (nextSpent > budget) continue;
      const nextProfit = state.profit + option.averageProfitCopper;
      if (!dp[nextSpent] || nextProfit > dp[nextSpent].profit) {
        dp[nextSpent] = { profit: nextProfit, picks: [...state.picks, option.optionID] };
      }
    }
  }

  let bestSpent = 0;
  for (let spent = 1; spent <= budget; spent += 1) {
    const state = dp[spent];
    if (!state) continue;
    const best = dp[bestSpent];
    if (
      !best ||
      state.profit > best.profit ||
      (state.profit === best.profit && spent > bestSpent)
    ) {
      bestSpent = spent;
    }
  }

  const best = dp[bestSpent] ?? dp[0];
  const optionsByID = new Map(validOptions.map((option) => [option.optionID, option]));
  const counts = new Map();
  for (const optionID of best.picks) counts.set(optionID, (counts.get(optionID) || 0) + 1);

  const items = [...counts.entries()]
    .map(([optionID, crafts]) => {
      const option = optionsByID.get(optionID);
      const shoppingItems = multiplyShoppingItems(option.shoppingItems, crafts);
      return {
        ...option,
        crafts,
        itemsProduced: crafts * option.expectedYieldPerCraft,
        itemsProducedFormatted: formatQuantity(crafts * option.expectedYieldPerCraft),
        totalConcentration: crafts * option.effectiveConcentrationCost,
        totalConcentrationFormatted: formatNumber(crafts * option.effectiveConcentrationCost),
        totalRawConcentration: crafts * option.concentrationCost,
        totalRawConcentrationFormatted: formatNumber(crafts * option.concentrationCost),
        totalExpectedIngenuityRefund: Math.max(0, crafts * (option.concentrationCost - (option.effectiveConcentrationCost ?? option.concentrationCost))),
        totalExpectedIngenuityRefundFormatted: formatNumber(Math.max(0, crafts * (option.concentrationCost - (option.effectiveConcentrationCost ?? option.concentrationCost)))),
        totalProfitCopper: crafts * option.averageProfitCopper,
        totalProfit: formatCopper(crafts * option.averageProfitCopper),
        shoppingItems,
        shoppingPayload: shoppingItems.length
          ? formatShoppingPayload(buildShoppingListName(`Weekly ${option.displayName}`, option.variantRank), shoppingItems)
          : "",
      };
    })
    .sort((a, b) => b.totalProfitCopper - a.totalProfitCopper);

  return {
    budget,
    usedConcentration: bestSpent,
    usedConcentrationFormatted: formatNumber(bestSpent),
    leftoverConcentration: budget - bestSpent,
    leftoverConcentrationFormatted: formatNumber(budget - bestSpent),
    totalProfitCopper: best.profit,
    totalProfit: formatCopper(best.profit),
    totalCrafts: items.reduce((sum, item) => sum + item.crafts, 0),
    marketFilteredCount,
    items,
  };
}

function buildShoppingItems(allocation, craftCount) {
  const multiplier = Math.max(1, Math.ceil(Number(craftCount ?? 1)));
  const byKey = new Map();

  const addItem = (name, tier, quantityPerCraft) => {
    name = String(name ?? "").trim();
    const quantity = Math.ceil(Number(quantityPerCraft ?? 0) * multiplier);
    tier = Math.max(0, Number(tier ?? 0) || 0);
    if (!name || quantity <= 0) return;

    const key = `${name.toLowerCase()}:${tier}`;
    const current = byKey.get(key) ?? { name, tier, quantity: 0 };
    current.quantity += quantity;
    byKey.set(key, current);
  };

  for (const reagent of asArray(allocation?.required)) {
    for (const quality of asArray(reagent.qualities)) {
      addItem(quality.itemName || reagent.name, quality.qualityID, quality.quantity);
    }
  }

  for (const slot of [
    ...asArray(allocation?.requiredSelectable),
    ...asArray(allocation?.optional),
    ...asArray(allocation?.finishing),
  ]) {
    if (slot.type === "currency" || slot.currencyID) continue;
    addItem(slot.itemName, slot.qualityID, 1);
  }

  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.tier - b.tier);
}

function multiplyShoppingItems(items, multiplier) {
  multiplier = Math.max(1, Math.ceil(Number(multiplier ?? 1)));
  return asArray(items).map((item) => ({
    ...item,
    quantity: Math.max(1, Math.ceil(Number(item.quantity ?? 1) * multiplier)),
  }));
}

function buildShoppingListName(displayName, rank) {
  const base = `CraftPlan - ${displayName || "Recipe"} v${rank}`;
  return base.length > 64 ? `${base.slice(0, 61)}...` : base;
}

function formatShoppingPayload(listName, items) {
  return [
    "CPE_AUCTIONATOR_LIST_V1",
    `list\t${sanitizePayloadField(listName)}`,
    ...items.map((item) =>
      `item\t${sanitizePayloadField(item.name)}\t${Math.max(0, Number(item.tier ?? 0) || 0)}\t${Math.max(1, Math.ceil(Number(item.quantity ?? 1)))}`
    ),
  ].join("\n");
}

function sanitizePayloadField(value) {
  return String(value ?? "").replace(/[\t\r\n]/g, " ").trim();
}

function cleanReagentName(name, fallback) {
  name = String(name ?? "").trim();
  if (!name || name.toLowerCase() === "reagent") return fallback;
  return name;
}

function summarizeVariantAllocation(allocation) {
  const required = asArray(allocation?.required);
  const parts = [];
  const profileParts = [];
  const tierTotals = new Map();
  let allSingleTier = true;
  let totalQuantity = 0;

  for (const reagent of required) {
    const qualities = asArray(reagent.qualities);
    const activeQualities = qualities.filter((quality) => Number(quality.quantity ?? 0) > 0);
    if (!activeQualities.length) continue;

    const fallbackName = activeQualities.find((quality) => quality.itemName)?.itemName || `Ingredient ${reagent.index ?? parts.length + 1}`;
    const name = cleanReagentName(reagent.name, fallbackName);
    const qualityText = activeQualities
      .map((quality) => {
        const tier = Math.max(0, Number(quality.qualityID ?? 0) || 0);
        const quantity = Number(quality.quantity ?? 0);
        tierTotals.set(tier, (tierTotals.get(tier) || 0) + quantity);
        totalQuantity += quantity;
        return `Q${tier} x${formatQuantity(quantity)}`;
      })
      .join(", ");
    if (qualityText) {
      parts.push(`${name}: ${qualityText}`);
      allSingleTier &&= activeQualities.length === 1;
      profileParts.push(activeQualities.map((quality) => `Q${quality.qualityID ?? "?"}`).join("+"));
    }
  }

  const activeSlots = [
    ...asArray(allocation?.requiredSelectable),
    ...asArray(allocation?.optional),
    ...asArray(allocation?.finishing),
  ].map((slot) => {
    const label = slot.itemName || slot.currencyName;
    if (!label) return "";
    return slot.qualityID ? `${label} Q${slot.qualityID}` : label;
  }).filter(Boolean);

  if (activeSlots.length) {
    parts.push(`slots: ${activeSlots.join(", ")}`);
  }

  const uniqueProfiles = [...new Set(profileParts)];
  const tierSummary = [...tierTotals.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tier, quantity]) => `Q${tier} x${formatQuantity(quantity)}`)
    .join(", ");
  const dominant = [...tierTotals.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const averageTier = totalQuantity > 0
    ? [...tierTotals.entries()].reduce((sum, [tier, quantity]) => sum + tier * quantity, 0) / totalQuantity
    : 0;

  let shortLabel = "No quality mats";
  if (profileParts.length && allSingleTier && uniqueProfiles.length === 1) {
    shortLabel = `All ${uniqueProfiles[0]}`;
  } else if (profileParts.length && allSingleTier) {
    shortLabel = `${uniqueProfiles.join("/")} path`;
  } else if (dominant) {
    shortLabel = `Mostly Q${dominant[0]} mix`;
  }

  return {
    text: parts.join(" | "),
    label: tierSummary ? `${shortLabel} (${tierSummary})` : shortLabel,
    shortLabel,
    tierSummary,
    rank: averageTier,
  };
}

function formatVariantAllocation(allocation) {
  return summarizeVariantAllocation(allocation).text;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.keys(value)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => value[key]);
}

function parseCraftingQualityTier(itemLink) {
  const match = /Professions-ChatIcon-Quality-\d+-Tier(\d+)/.exec(String(itemLink ?? ""));
  return match ? Number(match[1]) : null;
}

function roundNice(value) {
  if (value < 10) return Math.ceil(value);
  if (value < 100) return Math.round(value / 5) * 5;
  if (value < 1000) return Math.round(value / 25) * 25;
  return Math.round(value / 100) * 100;
}

function inferSourceLabel(sourceUrl) {
  const value = String(sourceUrl || "");
  if (value.includes("goblinexchange.com")) return "Goblin Exchange";
  if (value.includes("undermine.exchange")) return "Undermine";
  return "market";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value) {
  return Math.round(Number(value ?? 0)).toLocaleString("en-US");
}

function formatSignedNumber(value) {
  const number = Math.round(Number(value ?? 0));
  if (number === 0) return "0";
  return `${number > 0 ? "+" : "-"}${Math.abs(number).toLocaleString("en-US")}`;
}

function formatQuantity(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "0";
  if (Math.abs(number - Math.round(number)) < 0.05) return formatNumber(number);
  return number.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function getAuctionHouseSaleValue(priceCopper, expectedYieldPerCraft) {
  return Number(priceCopper ?? 0) * Number(expectedYieldPerCraft ?? 1) * AUCTION_HOUSE_CUT;
}

function formatSignedCopper(copper) {
  copper = Number(copper ?? 0);
  if (Math.abs(copper) < 0.5) return "0c";
  return `${copper > 0 ? "+" : "-"}${formatCopper(Math.abs(copper))}`;
}

function formatCopper(copper) {
  copper = Math.round(Number(copper ?? 0));
  const sign = copper < 0 ? "-" : "";
  copper = Math.abs(copper);
  const gold = Math.floor(copper / 10000);
  const silver = Math.floor((copper % 10000) / 100);
  const copperPart = copper % 100;
  if (gold) return `${sign}${gold.toLocaleString("en-US")}g ${silver}s${copperPart ? ` ${copperPart}c` : ""}`;
  if (silver) return `${sign}${silver}s${copperPart ? ` ${copperPart}c` : ""}`;
  return `${sign}${copperPart}c`;
}

function parseLuaAssignment(source, name) {
  const match = new RegExp(`\\b${escapeRegExp(name)}\\s*=`).exec(source);
  if (!match) return null;
  const valueStart = match.index + match[0].length;
  const parser = new LuaParser(source.slice(valueStart));
  return parser.parseValue();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class LuaParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  parseValue() {
    this.skip();
    const ch = this.peek();
    if (ch === "{") return this.parseTable();
    if (ch === '"' || ch === "'") return this.parseString();
    if (ch === "-" || /[0-9]/.test(ch)) return this.parseNumber();
    const identifier = this.parseIdentifier();
    if (identifier === "true") return true;
    if (identifier === "false") return false;
    if (identifier === "nil") return null;
    return identifier;
  }

  parseTable() {
    this.expect("{");
    const table = {};
    let arrayIndex = 1;
    while (true) {
      this.skip();
      if (this.peek() === "}") {
        this.index += 1;
        break;
      }

      let key;
      let value;
      if (this.peek() === "[") {
        this.index += 1;
        key = this.parseValue();
        this.skip();
        this.expect("]");
        this.skip();
        this.expect("=");
        value = this.parseValue();
      } else {
        const start = this.index;
        const maybeIdentifier = this.tryIdentifier();
        this.skip();
        if (maybeIdentifier && this.peek() === "=") {
          this.index += 1;
          key = maybeIdentifier;
          value = this.parseValue();
        } else {
          this.index = start;
          key = arrayIndex++;
          value = this.parseValue();
        }
      }

      table[String(key)] = value;
      this.skip();
      if (this.peek() === "," || this.peek() === ";") this.index += 1;
    }
    return table;
  }

  parseString() {
    const quote = this.peek();
    this.index += 1;
    let value = "";
    while (this.index < this.source.length) {
      const ch = this.source[this.index++];
      if (ch === quote) break;
      if (ch !== "\\") {
        value += ch;
        continue;
      }
      const next = this.source[this.index++];
      if (/[0-9]/.test(next)) {
        let digits = next;
        for (let i = 0; i < 2 && /[0-9]/.test(this.peek()); i += 1) digits += this.source[this.index++];
        value += String.fromCharCode(Number(digits));
      } else {
        const map = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"', "'": "'" };
        value += map[next] ?? next;
      }
    }
    return value;
  }

  parseNumber() {
    const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index));
    if (!match) throw new Error(`Expected number at ${this.index}`);
    this.index += match[0].length;
    return Number(match[0]);
  }

  parseIdentifier() {
    const identifier = this.tryIdentifier();
    if (!identifier) throw new Error(`Expected identifier at ${this.index}`);
    return identifier;
  }

  tryIdentifier() {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.index));
    if (!match) return null;
    this.index += match[0].length;
    return match[0];
  }

  skip() {
    while (this.index < this.source.length) {
      if (/\s/.test(this.peek())) {
        this.index += 1;
        continue;
      }
      if (this.peek() === "-" && this.source[this.index + 1] === "-") {
        this.index += 2;
        while (this.index < this.source.length && !/[\r\n]/.test(this.peek())) this.index += 1;
        continue;
      }
      break;
    }
  }

  peek() {
    return this.source[this.index] ?? "";
  }

  expect(ch) {
    if (this.peek() !== ch) throw new Error(`Expected ${ch} at ${this.index}`);
    this.index += 1;
  }
}

function renderHtml(report) {
  const data = JSON.stringify(report).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Craft Plan</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #070907;
      --panel: #101511;
      --panel-2: #151d17;
      --ink: #f1efe4;
      --muted: #a6aa9b;
      --line: #2d3b31;
      --accent: #3cc6a2;
      --accent-2: #e0b35a;
      --danger: #e66d55;
      --good: #8be28d;
      font-family: "Bahnschrift", "Aptos", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 20% 0%, rgba(60, 198, 162, .18), transparent 34rem),
        radial-gradient(circle at 82% 12%, rgba(224, 179, 90, .12), transparent 30rem),
        linear-gradient(135deg, rgba(255,255,255,.04) 1px, transparent 1px) 0 0 / 28px 28px,
        var(--bg);
    }
    main { width: min(1120px, calc(100vw - 28px)); margin: 28px auto 54px; }
    header {
      display: grid;
      grid-template-columns: 1.2fr auto;
      gap: 18px;
      align-items: end;
      border-bottom: 1px solid var(--line);
      padding-bottom: 18px;
    }
    h1 { margin: 0; font-size: clamp(32px, 5vw, 64px); line-height: .9; letter-spacing: 0; text-transform: uppercase; }
    .lede { max-width: 760px; color: var(--muted); margin: 10px 0 0; font-size: 15px; }
    .stamp { text-align: right; font-size: 13px; color: var(--muted); }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 10px;
    }
    .action-button {
      appearance: none;
      border: 1px solid rgba(60,198,162,.6);
      border-radius: 999px;
      background: linear-gradient(180deg, rgba(60,198,162,.22), rgba(60,198,162,.08));
      color: var(--ink);
      cursor: pointer;
      min-height: 36px;
      padding: 0 13px;
      font: inherit;
      font-weight: 800;
      box-shadow: 0 10px 28px rgba(0,0,0,.24);
    }
    .action-button:hover { border-color: rgba(139,226,141,.8); }
    .action-button:active { transform: translateY(1px); }
    .share-status {
      min-height: 18px;
      margin-top: 6px;
      color: var(--accent);
      font-size: 12px;
    }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); gap: 10px; margin: 18px 0; }
    .stat { border: 1px solid var(--line); background: rgba(16,21,17,.86); padding: 12px; border-radius: 6px; }
    .stat strong { display: block; font-size: 24px; line-height: 1.1; }
    .stat span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .notice {
      border: 1px solid rgba(224,179,90,.45);
      background: rgba(224,179,90,.09);
      padding: 12px 14px;
      margin: 18px 0;
      border-radius: 6px;
      font-size: 14px;
    }
    .tabs { margin-top: 18px; }
    .tablist {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 10px;
      margin-bottom: 14px;
    }
    .tab-button {
      appearance: none;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,.035);
      color: var(--muted);
      cursor: pointer;
      min-height: 38px;
      padding: 0 14px;
      font: inherit;
      font-weight: 800;
    }
    .tab-button[aria-selected="true"] {
      color: var(--ink);
      border-color: rgba(60,198,162,.68);
      background: linear-gradient(180deg, rgba(60,198,162,.2), rgba(60,198,162,.07));
      box-shadow: 0 0 0 3px rgba(60,198,162,.08);
    }
    .tab-panel[hidden] { display: none; }
    .plan-list { display: grid; gap: 10px; }
    .subcategory {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(16,21,17,.5);
      overflow: hidden;
    }
    .subcategory summary {
      padding: 10px 12px;
      border-bottom: 1px solid transparent;
    }
    .subcategory[open] summary { border-bottom-color: var(--line); }
    .subcategory-title {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      color: var(--ink);
      font-weight: 800;
    }
    .subcategory-title span {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .06em;
      white-space: nowrap;
    }
    .subcategory-body {
      display: grid;
      gap: 10px;
      padding: 10px;
    }
    .empty-state {
      border: 1px dashed var(--line);
      background: rgba(16,21,17,.62);
      border-radius: 8px;
      padding: 22px;
      color: var(--muted);
    }
    .craft-card {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(21,29,23,.96), rgba(11,15,12,.96));
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 16px 44px rgba(0,0,0,.28);
    }
    .craft-card[open] { border-color: rgba(60,198,162,.55); }
    .craft-card.done {
      border-color: rgba(139,226,141,.65);
      background: linear-gradient(180deg, rgba(21,45,28,.9), rgba(9,18,12,.94));
    }
    .craft-card.done .sentence { color: rgba(241,239,228,.6); text-decoration: line-through; }
    summary {
      cursor: pointer;
      list-style: none;
      padding: 14px 16px;
    }
    summary::-webkit-details-marker { display: none; }
    .command { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; }
    .sentence { font-size: clamp(18px, 2vw, 25px); line-height: 1.15; font-weight: 800; }
    .sentence b { color: var(--accent); }
    .profit { color: var(--good); }
    .loss { color: var(--danger); }
    .tag-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; color: var(--muted); font-size: 12px; }
    .tag {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 9px;
      background: rgba(255,255,255,.035);
    }
    .tag.quality { border-color: rgba(224,179,90,.55); color: var(--accent-2); }
    .tag.concentration { border-color: rgba(60,198,162,.55); color: var(--accent); }
    .tag.rate { border-color: rgba(139,226,141,.42); color: var(--good); }
    .tag.market-strong { border-color: rgba(139,226,141,.45); color: var(--good); }
    .tag.market-steady { border-color: rgba(60,198,162,.45); color: var(--accent); }
    .tag.market-thin { border-color: rgba(224,179,90,.55); color: var(--accent-2); }
    .tag.market-rare { border-color: rgba(230,109,85,.55); color: var(--danger); }
    .rank {
      color: var(--accent-2);
      border: 1px solid rgba(224,179,90,.45);
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 13px;
      white-space: nowrap;
    }
    .card-side { display: grid; gap: 8px; justify-items: end; }
    .card-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .mini-action {
      appearance: none;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 999px;
      background: rgba(255,255,255,.055);
      color: var(--ink);
      min-height: 30px;
      padding: 0 10px;
      font: inherit;
      font-size: 12px;
      font-weight: 800;
      cursor: pointer;
    }
    .mini-action:hover { border-color: rgba(60,198,162,.65); }
    .mini-action.done-toggle.active {
      border-color: rgba(139,226,141,.75);
      background: rgba(139,226,141,.15);
      color: var(--good);
    }
    .details-body { border-top: 1px solid var(--line); padding: 14px 16px 16px; }
    .craft-path {
      border: 1px solid rgba(224,179,90,.28);
      background: rgba(224,179,90,.045);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .craft-path-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .craft-path-head strong { color: var(--ink); display: block; margin-bottom: 3px; }
    .craft-path-head span { color: var(--muted); font-size: 13px; display: block; line-height: 1.35; }
    .path-items { display: flex; flex-wrap: wrap; gap: 6px; }
    .path-item {
      border: 1px solid rgba(255,255,255,.11);
      background: rgba(255,255,255,.04);
      border-radius: 999px;
      padding: 5px 9px;
      color: var(--ink);
      font-size: 13px;
    }
    .path-item span { color: var(--muted); }
    .path-empty { color: var(--muted); line-height: 1.35; }
    .detail-grid { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); gap: 10px; }
    .metric { border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.035); border-radius: 6px; padding: 10px; }
    .metric strong { display: block; font-size: 18px; }
    .metric span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
    .weekly-planner {
      border: 1px solid rgba(60,198,162,.35);
      background: rgba(60,198,162,.055);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 10px;
    }
    .weekly-head {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 14px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .weekly-head h2 { margin: 0; font-size: 20px; }
    .budget-control {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-weight: 800;
    }
    .budget-control input {
      width: 110px;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 6px;
      background: rgba(0,0,0,.28);
      color: var(--ink);
      padding: 8px 10px;
      font: inherit;
      font-weight: 800;
    }
    .weekly-summary { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); gap: 10px; }
    .weekly-card { border-color: rgba(60,198,162,.32); }
    .drawer { margin-top: 16px; border: 1px solid var(--line); background: rgba(16,21,17,.82); border-radius: 8px; }
    .drawer summary { font-weight: 800; }
    .drawer-body { padding: 0 16px 16px; color: var(--muted); }
    .optimizer {
      margin-top: 14px;
      border: 1px solid rgba(60,198,162,.35);
      background: rgba(60,198,162,.055);
      border-radius: 8px;
      overflow: hidden;
    }
    .optimizer-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(60,198,162,.22);
      font-size: 13px;
      color: var(--muted);
    }
    .optimizer-head strong { color: var(--ink); }
    .optimizer-table-toggle {
      border-top: 1px solid rgba(60,198,162,.18);
      background: rgba(0,0,0,.12);
    }
    .optimizer-table-toggle summary {
      padding: 10px 12px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
    }
    .optimizer-warning {
      margin: 10px 12px 0;
      border: 1px solid rgba(224,179,90,.4);
      border-radius: 6px;
      background: rgba(224,179,90,.08);
      color: var(--accent-2);
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.35;
    }
    .optimizer-compare {
      padding: 12px;
      border-bottom: 1px solid rgba(60,198,162,.18);
      background: rgba(0,0,0,.12);
    }
    .optimizer-compare-title {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .strategy-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 8px;
    }
    .strategy-card {
      border: 1px solid rgba(255,255,255,.1);
      border-radius: 8px;
      background: rgba(255,255,255,.035);
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .strategy-card.best { border-color: rgba(139,226,141,.42); background: rgba(139,226,141,.06); }
    .strategy-title { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
    .strategy-title strong { color: var(--ink); font-size: 14px; }
    .strategy-title span { color: var(--muted); font-size: 12px; text-align: right; }
    .strategy-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
    .strategy-stat {
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 6px;
      padding: 6px 7px;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .strategy-stat b { display: block; color: var(--ink); font-size: 14px; letter-spacing: 0; text-transform: none; }
    .strategy-path {
      color: var(--muted);
      line-height: 1.35;
      font-size: 12px;
    }
    .table-scroll { overflow-x: auto; }
    .variant-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .variant-table th,
    .variant-table td {
      padding: 9px 12px;
      border-top: 1px solid rgba(255,255,255,.07);
      text-align: left;
      vertical-align: top;
    }
    .variant-table th {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .variant-table .money { color: var(--good); font-weight: 800; white-space: nowrap; }
    .variant-table .delta-good { color: var(--good); white-space: nowrap; }
    .variant-table .delta-warn { color: var(--accent-2); white-space: nowrap; }
    .variant-table .quality-path strong { display: block; color: var(--ink); white-space: nowrap; }
    .variant-table .quality-path span { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; line-height: 1.25; }
    .variant-table .allocation { color: var(--muted); line-height: 1.35; }
    .shopping-cart {
      margin: 18px 0;
      border: 1px solid rgba(224,179,90,.36);
      background: rgba(224,179,90,.055);
      border-radius: 8px;
      padding: 14px;
    }
    .cart-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .cart-head h2 { margin: 0; font-size: 18px; }
    .cart-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .cart-list { display: grid; gap: 6px; }
    .cart-row {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 10px;
      align-items: center;
      border: 1px solid rgba(255,255,255,.09);
      background: rgba(255,255,255,.035);
      border-radius: 6px;
      padding: 8px 10px;
    }
    .cart-row strong { overflow-wrap: anywhere; }
    .cart-row span { color: var(--muted); white-space: nowrap; }
    .cart-empty { color: var(--muted); border: 1px dashed rgba(255,255,255,.16); border-radius: 6px; padding: 12px; }
    .pill { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; font-size: 12px; background: rgba(255,255,255,.04); margin: 3px; color: var(--ink); }
    code { background: rgba(255,255,255,.08); padding: 1px 5px; border-radius: 4px; }
    @media (max-width: 900px) {
      header { grid-template-columns: 1fr; }
      .stamp { text-align: left; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .detail-grid { grid-template-columns: repeat(2, 1fr); }
      .weekly-summary { grid-template-columns: repeat(2, 1fr); }
      .command { grid-template-columns: 1fr; }
      .card-side { justify-items: start; }
      .card-actions { justify-content: flex-start; }
      .tablist { flex-wrap: wrap; overflow-x: visible; padding-bottom: 12px; }
      .tab-button { white-space: nowrap; flex: 1 1 auto; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Craft Plan</h1>
        <p class="lede">Craft from the top down. Open a line only when you want prices, demand, or the exact reagent path.</p>
      </div>
      <div class="stamp">
        <div>Snapshot: <strong id="snapshot"></strong></div>
        <div>Generated: <strong id="generated"></strong></div>
        <div>Profit: <strong id="profit-source"></strong></div>
        <div>Concentration: <strong id="current-concentration"></strong></div>
        <div class="actions">
          <button class="action-button" id="regenerate-report" type="button">Regenerate</button>
          <button class="action-button" id="share-png" type="button">Generate PNG</button>
        </div>
        <div class="share-status" id="share-status" aria-live="polite"></div>
      </div>
    </header>
    <section class="stats" id="stats"></section>
    <section id="notice"></section>
    <section class="shopping-cart" aria-label="Auctionator shopping list">
      <div class="cart-head">
        <div>
          <h2>Auctionator shopping list</h2>
          <p class="lede">Add reagent-quality variants here, then copy once and paste into CPE in WoW.</p>
        </div>
        <div class="cart-actions">
          <button class="action-button" id="copy-shopping-cart" type="button">Copy list for CPE</button>
          <button class="action-button" id="clear-shopping-cart" type="button">Clear</button>
        </div>
      </div>
      <div class="cart-list" id="shopping-cart-list"></div>
    </section>
    <section class="tabs" data-tabs>
      <div class="tablist" role="tablist" aria-label="Craft plan views">
        <button class="tab-button" id="tab-batch" role="tab" aria-selected="true" aria-controls="panel-batch" tabindex="0">Batch craft</button>
        <button class="tab-button" id="tab-concentration" role="tab" aria-selected="false" aria-controls="panel-concentration" tabindex="-1">Concentration</button>
        <button class="tab-button" id="tab-weekly-concentration" role="tab" aria-selected="false" aria-controls="panel-weekly-concentration" tabindex="-1">Weekly concentration</button>
      </div>
      <section class="tab-panel plan-list" id="panel-batch" role="tabpanel" tabindex="0" aria-labelledby="tab-batch"></section>
      <section class="tab-panel plan-list" id="panel-concentration" role="tabpanel" tabindex="0" aria-labelledby="tab-concentration" hidden></section>
      <section class="tab-panel plan-list" id="panel-weekly-concentration" role="tabpanel" tabindex="0" aria-labelledby="tab-weekly-concentration" hidden></section>
    </section>
    <details class="drawer">
      <summary>Missing CraftSim profit records</summary>
      <div class="drawer-body">
        <p>Open these recipes in WoW/CraftSim, then run <code>/reload</code> and rebuild this report.</p>
        <div id="missing"></div>
      </div>
    </details>
  </main>
  <script>
    const report = ${data};
    const shoppingVariants = new Map();
    let shoppingCart = loadShoppingCart();
    const fmtDate = (iso) => iso ? new Date(iso).toLocaleString() : "n/a";
    document.querySelector("#snapshot").textContent = fmtDate(report.source.snapshotUtc);
    document.querySelector("#generated").textContent = fmtDate(report.generatedAtUtc);
    document.querySelector("#profit-source").textContent = report.source.profitSourceLabel || report.source.profitSavedVariablesName || "n/a";
    document.querySelector("#current-concentration").textContent = formatConcentrationSource(report.settings.currentConcentration, report.settings.concentrationBudgetSource);
    const stats = [
      [report.summary.candidateCount, "batch crafts"],
      [report.summary.concentrationCandidateCount, "concentration"],
      [report.summary.weeklyConcentrationProfit || "0c", "weekly conc plan"],
      [report.summary.matchedProfitRecords + "/" + report.summary.snapshotItems, "profit records"],
      [report.summary.positiveProfitItems, "profitable"],
    ];
    document.querySelector("#stats").innerHTML = stats.map(([value, label]) => '<div class="stat"><strong>' + value + '</strong><span>' + label + '</span></div>').join("");
    const notice = document.querySelector("#notice");
    if (!report.summary.matchedProfitRecords) {
      notice.innerHTML = '<div class="notice">No profit records matched yet. In WoW, run CraftSim Recipe Scan or open a recipe and use <code>/cpe open</code>, then <code>/reload</code> and rebuild this report.</div>';
    } else {
      notice.innerHTML = '<div class="notice">Batch craft skips concentration. Use the Concentration and Weekly concentration tabs for scarce-resource crafts.</div>';
    }
    renderRows("#panel-batch", report.recommendations, "batch");
    renderRows("#panel-concentration", report.concentrationRecommendations || [], "concentration");
    renderWeeklyConcentration(report.weeklyConcentrationPlan || buildWeeklyConcentrationPlan(report.concentrationVariants || [], Number(report.settings.concentrationBudget || 1000)));
    renderShoppingCart();
    setupFollowButtons();
    setupTabs();
    document.querySelector("#regenerate-report").addEventListener("click", regenerateReport);
    document.querySelector("#share-png").addEventListener("click", generateSharePng);
    document.querySelector("#copy-shopping-cart").addEventListener("click", copyShoppingCart);
    document.querySelector("#clear-shopping-cart").addEventListener("click", clearShoppingCart);
    document.querySelector("#missing").innerHTML = report.missingProfit.map((row) => '<span class="pill">' + escapeHtml(row.displayName || row.name) + '</span>').join(" ");

    function renderRows(selector, rows, mode) {
      const target = document.querySelector(selector);
      if (!rows.length) {
        target.innerHTML = '<div class="empty-state">No ' + (mode === "concentration" ? "concentration" : "profitable batch") + ' crafts matched this snapshot.</div>';
        return;
      }
      let rank = 0;
      target.innerHTML = groupRowsBySubcategory(rows).map((group, groupIndex) => {
        const body = group.rows.map((row) => renderCard(row, rank++, mode)).join("");
        return '<details class="subcategory"' + (groupIndex < 2 ? " open" : "") + '>' +
          '<summary><div class="subcategory-title"><strong>' + escapeHtml(group.label) + '</strong><span>' + group.rows.length.toLocaleString() + ' craft' + (group.rows.length === 1 ? "" : "s") + '</span></div></summary>' +
          '<div class="subcategory-body">' + body + '</div>' +
        '</details>';
      }).join("");
    }

    function groupRowsBySubcategory(rows) {
      const groups = new Map();
      for (const row of rows || []) {
        const label = [row.groupLabel, row.category].filter(Boolean).join(" / ") || "Other";
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(row);
      }
      return [...groups.entries()].map(([label, groupRows]) => ({ label, rows: groupRows }));
    }

    function renderWeeklyConcentration(plan) {
      const target = document.querySelector("#panel-weekly-concentration");
      const budget = Number(plan.budget || report.settings.concentrationBudget || 1000);
      const items = plan.items || [];
      const rows = items.length
        ? items.map((item, index) => {
            const shoppingVariant = { ...item, rank: item.variantRank || 1 };
            const shoppingKey = item.shoppingItems && item.shoppingItems.length
              ? registerShoppingVariant(item, shoppingVariant, "weekly")
              : "";
            return '<details class="craft-card weekly-card"' + (index < 3 ? " open" : "") + '>' +
              '<summary>' +
                '<div class="command">' +
                  '<div>' +
                    '<div class="sentence">Craft <b>' + Number(item.crafts || 0).toLocaleString() + '</b> ' + escapeHtml(item.displayName || item.name) +
                      ' variant #' + escapeHtml(item.variantRank || 1) + ' for <span class="profit">' + escapeHtml(item.totalProfit) + '</span> weekly profit.</div>' +
                    '<div class="tag-row">' +
                      tag(item.totalConcentrationFormatted + " expected conc", "concentration") +
                      (item.totalRawConcentrationFormatted && item.totalRawConcentrationFormatted !== item.totalConcentrationFormatted ? tag(item.totalRawConcentrationFormatted + " raw conc", "concentration") : "") +
                      tag(item.profitPerConcentration + " per expected conc", "rate") +
                      tag(item.qualityProfileShort || "optimizer path", "quality") +
                      tag((item.dailyDropProxyFormatted || "n/a") + "/day", "market-" + (item.marketConfidenceLevel || "steady")) +
                      tag(item.marketConfidenceLabel || "market check", "market-" + (item.marketConfidenceLevel || "steady")) +
                      tag("per craft " + item.averageProfit) +
                      tag("produces " + item.itemsProducedFormatted) +
                    '</div>' +
                  '</div>' +
                  '<div class="card-side">' +
                    '<span class="rank">#' + (index + 1) + '</span>' +
                    '<div class="card-actions">' +
                      (shoppingKey ? '<button class="mini-action add-shopping-list" type="button" data-shopping-key="' + escapeAttr(shoppingKey) + '">Add mats</button>' : '') +
                    '</div>' +
                  '</div>' +
                '</div>' +
              '</summary>' +
              '<div class="details-body">' +
                renderWeeklyCraftPath(item, shoppingKey) +
                '<div class="detail-grid">' +
                  metric("Variant", "#" + (item.variantRank || 1)) +
                  metric("Expected conc/craft", item.effectiveConcentrationCostFormatted || item.concentrationCostFormatted) +
                  (item.effectiveConcentrationCostFormatted !== item.concentrationCostFormatted ? metric("Raw conc/craft", item.concentrationCostFormatted) : "") +
                  metric("Crafts", Number(item.crafts || 0).toLocaleString()) +
                  metric("Total expected conc", item.totalConcentrationFormatted) +
                  (item.totalRawConcentrationFormatted !== item.totalConcentrationFormatted ? metric("Total raw conc", item.totalRawConcentrationFormatted) : "") +
                  (Number(item.totalExpectedIngenuityRefund || 0) > 0 ? metric("Avg Ingenuity refund", item.totalExpectedIngenuityRefundFormatted) : "") +
                  metric("Profit/craft", item.averageProfit) +
                  metric("Profit/expected conc", item.profitPerConcentration) +
                  metric("Ingredient path", item.qualityProfile || item.allocationText || "optimizer path") +
                  metric("Yield/craft", item.expectedYieldPerCraftFormatted) +
                  metric("Daily drop proxy", item.dailyDropProxyFormatted || "n/a") +
                  metric("Current stock", item.currentQuantityFormatted || "n/a") +
                  metric("Market confidence", item.marketConfidenceLabel || "n/a") +
                '</div>' +
              '</div>' +
            '</details>';
          }).join("")
        : '<div class="empty-state">No positive concentration variants fit this budget.</div>';

      target.innerHTML =
        '<section class="weekly-planner">' +
          '<div class="weekly-head">' +
            '<div>' +
              '<h2>Weekly concentration plan</h2>' +
              '<p class="lede">Treat concentration as a budget. When Ingenuity data is available, the planner uses expected concentration after refunds and keeps the raw cost in details.</p>' +
            '</div>' +
            '<label class="budget-control">Budget <input id="concentration-budget" type="number" min="0" step="1" value="' + escapeAttr(budget) + '"></label>' +
          '</div>' +
          '<div class="weekly-summary">' +
            metric("Planned profit", plan.totalProfit || "0c") +
            metric("Expected concentration", (plan.usedConcentrationFormatted || "0") + " / " + Number(budget).toLocaleString()) +
            metric("Leftover", plan.leftoverConcentrationFormatted || Number(budget).toLocaleString()) +
            metric("Crafts", Number(plan.totalCrafts || 0).toLocaleString()) +
          '</div>' +
          (!Number(report.summary && report.summary.ingenuityAdjustedVariantCount || 0) ? '<div class="notice">Ingenuity refund math will appear after you rescan with this updated addon. Until then, concentration uses raw CraftSim cost.</div>' : '') +
          (plan.marketFilteredCount ? '<div class="notice">' + Number(plan.marketFilteredCount).toLocaleString() + ' profitable low-movement variant(s) stayed out of the weekly spender. They are still visible in the Concentration tab.</div>' : '') +
        '</section>' +
        rows;

      const input = target.querySelector("#concentration-budget");
      input.addEventListener("change", () => {
        const nextBudget = Math.max(0, Math.floor(Number(input.value || 0)));
        renderWeeklyConcentration(buildWeeklyConcentrationPlan(report.concentrationVariants || [], nextBudget));
      });
    }

    function renderWeeklyCraftPath(item, shoppingKey) {
      const items = (item.shoppingItems || []).map((mat) =>
        '<span class="path-item">' +
          escapeHtml(mat.name) +
          ' <span>' + (mat.tier ? 'Q' + mat.tier : 'Any') + '</span>' +
          ' x' + Number(mat.quantity || 0).toLocaleString() +
        '</span>'
      ).join("");
      return '<section class="craft-path">' +
        '<div class="craft-path-head">' +
          '<div><strong>Weekly craft path</strong><span>' + escapeHtml(item.allocationText || "optimizer variant") + '</span></div>' +
          (shoppingKey ? '<button class="mini-action add-shopping-list" type="button" data-shopping-key="' + escapeAttr(shoppingKey) + '">Add mats</button>' : '') +
        '</div>' +
        '<div class="path-items">' + (items || '<span class="path-empty">No shopping items saved for this variant.</span>') + '</div>' +
      '</section>';
    }

    function renderCard(row, index, mode) {
      const concentrationMode = mode === "concentration";
      const cardProfitCopper = concentrationMode && row.concentrationBestProfitCopper !== undefined
        ? Number(row.concentrationBestProfitCopper || 0)
        : Number(row.averageProfitCopper || 0);
      const profitClass = cardProfitCopper >= 0 ? "profit" : "loss";
      const open = index < 3 ? " open" : "";
      const displayName = concentrationMode ? row.concentrationDisplayName || row.displayName : row.displayName;
      const name = escapeHtml(displayName || row.name);
      const cardKey = mode + ":" + row.itemID + ":" + (row.recipeID || "") + ":" + (row.qualityLabel || "");
      const copyText = buildCraftCommandText(row, mode);
      const shoppingVariant = getBestShoppingVariant(row, mode);
      const shoppingKey = shoppingVariant ? registerShoppingVariant(row, shoppingVariant, mode) : "";
      const shoppingButton = shoppingKey
        ? '<button class="mini-action add-shopping-list" type="button" data-shopping-key="' + escapeAttr(shoppingKey) + '">Add mats</button>'
        : "";
      const marketLevel = concentrationMode ? row.concentrationMarketConfidenceLevel || row.marketConfidenceLevel : row.marketConfidenceLevel;
      const marketLabel = concentrationMode ? row.concentrationMarketConfidenceLabel || row.marketConfidenceLabel : row.marketConfidenceLabel;
      const dailyDropLabel = concentrationMode ? row.concentrationDailyDropProxyFormatted || row.dailyDropProxyFormatted : row.dailyDropProxyFormatted;
      const tags = [
        (concentrationMode ? row.concentrationQualityLabel || row.qualityLabel : row.qualityLabel) ? tag(concentrationMode ? row.concentrationQualityLabel || row.qualityLabel : row.qualityLabel, "quality") : "",
        row.usesConcentration ? tag("conc " + (concentrationMode ? row.concentrationBestCostLabel || row.concentrationCostLabel || row.concentrationCostFormatted : row.concentrationCostLabel || row.concentrationCostFormatted), "concentration") : "",
        tag("profit/craft " + (concentrationMode ? row.concentrationBestProfit || row.averageProfit : row.averageProfit)),
        concentrationMode ? tag((row.concentrationBestPerPoint || row.profitPerConcentration) + " per expected conc", "rate") : "",
        dailyDropLabel ? tag(dailyDropLabel + "/day", "market-" + (marketLevel || "steady")) : "",
        marketLabel ? tag(marketLabel, "market-" + (marketLevel || "steady")) : "",
      ].join("");
      const sentence = concentrationMode
        ? (cardProfitCopper > 0
          ? 'Craft <b>1</b> ' + name + ' using ' + escapeHtml(row.concentrationBestPath || "best saved path") + ' for <span class="' + profitClass + '">' + escapeHtml(row.concentrationBestProfit || row.averageProfit) + '</span> profit at <b>' + escapeHtml(row.concentrationBestCostLabel || row.concentrationCostLabel || row.concentrationCostFormatted || "0") + '</b>.'
          : 'Do not craft ' + name + ' today: best saved path is <span class="' + profitClass + '">' + escapeHtml(row.concentrationBestProfit || row.averageProfit) + '</span> per craft at <b>' + escapeHtml(row.concentrationBestCostLabel || row.concentrationCostLabel || row.concentrationCostFormatted || "0") + '</b>. Open details for Q1/Q2 paths.')
        : 'Craft <b>' + row.suggestedCrafts.toLocaleString() + '</b> ' + name + ' (' + row.suggestedItemsFormatted + ' items) for <span class="' + profitClass + '">' + row.expectedProfit + '</span> profit today.';
      return '<details class="craft-card" data-card-key="' + escapeAttr(cardKey) + '"' + open + '>' +
        '<summary>' +
          '<div class="command">' +
            '<div>' +
              '<div class="sentence">' + sentence + '</div>' +
              '<div class="tag-row">' + tags + '</div>' +
            '</div>' +
            '<div class="card-side">' +
              '<span class="rank">#' + (index + 1) + '</span>' +
              '<div class="card-actions">' +
                '<button class="mini-action copy-line" type="button" data-copy-text="' + escapeAttr(copyText) + '">Copy</button>' +
                shoppingButton +
                '<button class="mini-action done-toggle" type="button">Done</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</summary>' +
        '<div class="details-body">' +
          renderCraftPath(row, mode) +
          renderDetailGrid(row, concentrationMode) +
          renderIngredientOptimizer(row) +
        '</div>' +
      '</details>';
    }

    function renderDetailGrid(row, concentrationMode) {
      const metrics = [
        ["Expected conc", row.usesConcentration ? (concentrationMode ? row.concentrationBestCostLabel || row.concentrationCostLabel : row.concentrationCostLabel || row.concentrationCostFormatted) + " per craft" : ""],
        ["Raw conc", row.usesConcentration && concentrationMode && row.concentrationBestRawCostFormatted !== row.concentrationBestCostFormatted ? (row.concentrationBestRawCostFormatted + " before Ingenuity") : ""],
        ["Profit/expected conc", row.usesConcentration ? (concentrationMode ? row.concentrationBestPerPoint || row.profitPerConcentration : row.profitPerConcentration) : ""],
        ["Ingenuity", concentrationMode ? row.concentrationBestIngenuityNote || row.concentrationIngenuityNote : row.concentrationIngenuityNote],
        ["Yield/craft", row.yieldPerCraftFormatted],
        ["7d drop proxy", concentrationMode ? row.concentrationSevenDayDropProxyFormatted || row.sevenDayDropProxyFormatted : row.sevenDayDropProxyFormatted],
        ["Daily drop proxy", concentrationMode ? row.concentrationDailyDropProxyFormatted || row.dailyDropProxyFormatted : row.dailyDropProxyFormatted],
        ["Current stock", concentrationMode ? row.concentrationCurrentQuantityFormatted || row.currentQuantityFormatted : row.currentQuantityFormatted],
        ["7d avg stock", concentrationMode ? row.concentrationSevenDayAverageQuantityFormatted || row.sevenDayAverageQuantityFormatted : row.sevenDayAverageQuantityFormatted],
        ["Market confidence", concentrationMode ? row.concentrationMarketConfidenceLabel || row.marketConfidenceLabel : row.marketConfidenceLabel],
        ["Craft cost", concentrationMode ? row.concentrationBestCraftingCost || row.craftingCosts : row.craftingCosts],
      ].filter(([label, value]) => shouldShowMetric(label, value));
      if (!metrics.length) return "";
      return '<div class="detail-grid">' + metrics.map(([label, value]) => metric(label, value)).join("") + '</div>';
    }

    function shouldShowMetric(label, value) {
      if (value === null || value === undefined || value === "") return false;
      const text = String(value);
      if (text === "0" || text === "0c" || text === "n/a") return false;
      if (label === "Craft cost" && /^0[gsc ]*$/.test(text.trim())) return false;
      return true;
    }

    function renderIngredientOptimizer(row) {
      const optimizer = row.ingredientOptimization;
      if (!optimizer || !optimizer.variants || !optimizer.variants.length) return "";
      const budget = Math.max(0, Math.floor(Number(report.settings.concentrationBudget || 0)));
      const mode = [
        optimizer.includeOptional ? "optional slots" : "",
        optimizer.includeFinishing ? "finishing slots" : "",
      ].filter(Boolean).join(" + ") || "required quality reagents";
      const note = optimizer.truncated
        ? "tested " + optimizer.testedCountFormatted + " of " + optimizer.totalEstimatedFormatted + ", saved " + (optimizer.savedCountFormatted || optimizer.variants.length)
        : "tested all " + optimizer.testedCountFormatted + ", saved " + (optimizer.savedCountFormatted || optimizer.variants.length);
      const optimizerWarning = optimizer.isPrunedExport
        ? '<div class="optimizer-warning">This scan was saved by an older CPE build and only kept ' +
          escapeHtml(optimizer.savedCountFormatted || optimizer.variants.length) + ' of ' +
          escapeHtml(optimizer.testedCountFormatted || "?") +
          ' tested paths. Rescan variants in WoW so Q2/low-concentration paths can appear here.</div>'
        : "";
      const tableVariants = pickOptimizerTableVariants(optimizer.variants || [], budget);
      const rows = tableVariants.map((variant) => {
          const budgetStats = getVariantBudgetStats(variant, budget);
          const variantProfit = variant.planningAverageProfit || variant.averageProfit;
          const variantProfitPerConcentration = variant.planningProfitPerConcentration || variant.profitPerConcentration;
          const variantOutputQuality = variant.planningExpectedQuality || variant.expectedQuality || "n/a";
          const shoppingKey = variant.shoppingItems && variant.shoppingItems.length
            ? registerShoppingVariant(row, variant, "variant")
            : "";
          return (
        '<tr>' +
          '<td>#' + variant.rank + '</td>' +
          '<td class="quality-path"><strong>' + escapeHtml(variant.qualityProfileShort || "Optimizer path") + '</strong><span>' + escapeHtml(variant.qualityTierSummary || variant.qualityProfile || "") + '</span></td>' +
          '<td class="money">' + variantProfit + '</td>' +
          '<td>' + escapeHtml(variant.concentrationCostLabel || variant.effectiveConcentrationCostFormatted || variant.concentrationCostFormatted || "0") + '</td>' +
          '<td class="money">' + escapeHtml(variantProfitPerConcentration || "n/a") + '</td>' +
          '<td>' + budgetStats.crafts.toLocaleString() + 'x</td>' +
          '<td class="money">' + formatCopperBrowser(budgetStats.totalProfitCopper) + '</td>' +
          '<td>' + variant.craftingCosts + '</td>' +
          '<td>Q' + escapeHtml(variantOutputQuality) + '</td>' +
          '<td class="allocation">' + escapeHtml(variant.allocationText || "current allocation") + '</td>' +
          '<td>' + (shoppingKey ? '<button class="mini-action add-shopping-list" type="button" data-shopping-key="' + escapeAttr(shoppingKey) + '">Add</button>' : '') + '</td>' +
        '</tr>'
          );
        }
      ).join("");

      return '<section class="optimizer">' +
        '<div class="optimizer-head"><strong>Ingredient optimizer</strong><span>' + escapeHtml(note + " - " + mode) + '</span></div>' +
        optimizerWarning +
        renderOptimizerBudgetComparison(row, optimizer, budget) +
        '<details class="optimizer-table-toggle">' +
          '<summary>Show variant table (' + tableVariants.length.toLocaleString() + ' selected path' + (tableVariants.length === 1 ? "" : "s") + ')</summary>' +
          '<div class="table-scroll"><table class="variant-table">' +
            '<thead><tr><th>Rank</th><th>Path</th><th>Profit/craft</th><th>Expected conc</th><th>Profit/conc</th><th>Crafts @ budget</th><th>Budget profit</th><th>Mats/craft</th><th>Output</th><th>Ingredients</th><th>List</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table></div>' +
        '</details>' +
      '</section>';
    }

    function renderOptimizerBudgetComparison(row, optimizer, budget) {
      if (!budget || !row.usesConcentration) return "";
      const strategies = pickOptimizerStrategies(optimizer.variants || [], budget);
      if (!strategies.length) return "";
      const cards = strategies.map((strategy) => {
        const variant = strategy.variant;
        const stats = getVariantBudgetStats(variant, budget);
        const shoppingVariant = stats.crafts > 0 ? {
          ...variant,
          rank: String(variant.rank || 1) + "-" + strategy.key + "-" + stats.crafts,
          shoppingItems: multiplyShoppingItemsBrowser(variant.shoppingItems || [], stats.crafts),
        } : null;
        const shoppingKey = shoppingVariant && shoppingVariant.shoppingItems.length
          ? registerShoppingVariant(row, shoppingVariant, "budget-strategy")
          : "";
        return '<div class="strategy-card ' + (strategy.best ? "best" : "") + '">' +
          '<div class="strategy-title"><strong>' + escapeHtml(strategy.label) + '</strong><span>' + escapeHtml(variant.qualityProfileShort || "Optimizer path") + '</span></div>' +
          '<div class="strategy-stats">' +
            '<div class="strategy-stat"><b>' + escapeHtml(variant.effectiveConcentrationCostFormatted || variant.concentrationCostFormatted || "0") + '</b>expected conc/craft</div>' +
            '<div class="strategy-stat"><b>' + stats.crafts.toLocaleString() + 'x</b>fits budget</div>' +
            '<div class="strategy-stat"><b>' + formatCopperBrowser(stats.totalProfitCopper) + '</b>budget profit</div>' +
            '<div class="strategy-stat"><b>' + formatNumberBrowser(stats.leftoverConcentration) + '</b>conc left</div>' +
          '</div>' +
          '<div class="strategy-path">' + escapeHtml(variant.allocationText || "current allocation") + '</div>' +
          (shoppingKey
            ? '<button class="mini-action add-shopping-list" type="button" data-shopping-key="' + escapeAttr(shoppingKey) + '">Add mats for ' + stats.crafts.toLocaleString() + 'x</button>'
            : '<span class="path-empty">Does not fit current budget.</span>') +
        '</div>';
      }).join("");
      return '<div class="optimizer-compare">' +
        '<div class="optimizer-compare-title"><span>Concentration budget comparison</span><span>Budget ' + formatNumberBrowser(budget) + '</span></div>' +
        '<div class="strategy-grid">' + cards + '</div>' +
      '</div>';
    }

    function pickOptimizerTableVariants(variants, budget) {
      const selected = [];
      const seen = new Set();
      const add = (variant) => {
        if (!variant) return;
        const id = String(variant.rank || "") + ":" + String(variant.concentrationCost || "") + ":" + String(variant.allocationText || "");
        if (seen.has(id)) return;
        seen.add(id);
        selected.push(variant);
      };
      for (const variant of (variants || []).slice(0, 8)) add(variant);
      for (const strategy of pickOptimizerStrategies(variants || [], budget)) add(strategy.variant);
      const profileRows = [...groupBestByProfile(variants || [], budget).values()].sort((a, b) =>
        Number(a.qualityProfileRank || 0) - Number(b.qualityProfileRank || 0) ||
        variantConcentrationCost(a) - variantConcentrationCost(b) ||
        variantProfitCopper(b) - variantProfitCopper(a)
      );
      for (const variant of profileRows.slice(0, 8)) add(variant);
      const lowConcentrationRows = [...(variants || [])].sort((a, b) =>
        variantConcentrationCost(a) - variantConcentrationCost(b) ||
        variantProfitCopper(b) - variantProfitCopper(a)
      );
      for (const variant of lowConcentrationRows.slice(0, 4)) add(variant);
      return selected.slice(0, 16);
    }

    function variantProfitCopper(variant) {
      return Number(variant && (variant.planningAverageProfitCopper ?? variant.concentrationAverageProfitCopper ?? variant.averageProfitCopper) || 0);
    }

    function variantProfitPerConcentrationCopper(variant) {
      return Number(variant && (variant.planningProfitPerConcentrationCopper ?? variant.concentrationProfitPerConcentrationCopper ?? variant.profitPerConcentrationCopper) || 0);
    }

    function variantConcentrationCost(variant) {
      return Math.max(0, Number(variant && (variant.effectiveConcentrationCost ?? variant.concentrationCost) || 0));
    }

    function pickOptimizerStrategies(variants, budget) {
      const valid = (variants || []).filter((variant) =>
        Number(variant.concentrationCost || 0) > 0 && variantProfitCopper(variant) > 0
      );
      const strategies = [];
      const seen = new Map();
      const add = (key, label, variant, best = false) => {
        if (!variant) return;
        const id = String(variant.rank || "") + ":" + String(variant.concentrationCost || "") + ":" + String(variant.allocationText || "");
        const existing = seen.get(id);
        if (existing !== undefined) {
          strategies[existing].best = strategies[existing].best || best;
          return;
        }
        seen.set(id, strategies.length);
        strategies.push({ key, label, variant, best });
      };
      const bestBudget = valid.reduce((best, variant) => {
        if (!best) return variant;
        const variantStats = getVariantBudgetStats(variant, budget);
        const bestStats = getVariantBudgetStats(best, budget);
        if (variantStats.totalProfitCopper !== bestStats.totalProfitCopper) {
          return variantStats.totalProfitCopper > bestStats.totalProfitCopper ? variant : best;
        }
        if (variantStats.crafts !== bestStats.crafts) {
          return variantStats.crafts > bestStats.crafts ? variant : best;
        }
        return variantConcentrationCost(variant) < variantConcentrationCost(best) ? variant : best;
      }, null);
      add("budget", "Best with this budget", bestBudget, true);

      const profileRows = [...groupBestByProfile(valid, budget).values()].sort((a, b) =>
        Number(a.qualityProfileRank || 0) - Number(b.qualityProfileRank || 0) ||
        variantConcentrationCost(a) - variantConcentrationCost(b) ||
        variantProfitCopper(b) - variantProfitCopper(a)
      );
      for (const variant of profileRows.slice(0, 5)) {
        add("profile-" + (variant.rank || strategies.length + 1), variant.qualityProfileShort || "Quality path", variant);
      }

      add("rate", "Best gold per point", valid.reduce((best, variant) =>
        !best || variantProfitPerConcentrationCopper(variant) > variantProfitPerConcentrationCopper(best) ? variant : best,
        null
      ));
      add("low-conc", "Lowest concentration", valid.reduce((best, variant) =>
        !best ||
        variantConcentrationCost(variant) < variantConcentrationCost(best) ||
        (variantConcentrationCost(variant) === variantConcentrationCost(best) && variantProfitCopper(variant) > variantProfitCopper(best))
          ? variant
          : best,
        null
      ));
      return strategies.slice(0, 7);
    }

    function groupBestByProfile(variants, budget) {
      const groups = new Map();
      for (const variant of variants || []) {
        const key = variant.qualityProfileShort || variant.qualityProfile || ("Variant #" + (variant.rank || "?"));
        const current = groups.get(key);
        const variantScore = getVariantBudgetStats(variant, budget).totalProfitCopper;
        const currentScore = current ? getVariantBudgetStats(current, budget).totalProfitCopper : -Infinity;
        if (
          !current ||
          variantScore > currentScore ||
          (variantScore === currentScore && variantProfitCopper(variant) > variantProfitCopper(current))
        ) {
          groups.set(key, variant);
        }
      }
      return groups;
    }

    function getVariantBudgetStats(variant, budget) {
      budget = Math.max(0, Math.floor(Number(budget || 0)));
      const concentrationCost = Math.max(0, Math.round(variantConcentrationCost(variant)));
      const averageProfitCopper = variantProfitCopper(variant);
      const crafts = concentrationCost > 0 ? Math.floor(budget / concentrationCost) : 0;
      const usedConcentration = crafts * concentrationCost;
      return {
        concentrationCost,
        crafts,
        usedConcentration,
        leftoverConcentration: Math.max(0, budget - usedConcentration),
        totalProfitCopper: crafts * averageProfitCopper,
      };
    }

    function renderCraftPath(row, mode) {
      const variant = getBestShoppingVariant(row, mode);
      if (!variant) {
        return '<section class="craft-path">' +
          '<div class="craft-path-head"><strong>Craft path</strong><span>No optimized reagent path saved for this row.</span></div>' +
          '<div class="path-empty">Run CPE variants in WoW, /reload, then regenerate to show exact mixed-quality ingredients here.</div>' +
        '</section>';
      }

      const shoppingKey = registerShoppingVariant(row, variant, mode + ":path");
      const items = (variant.shoppingItems || []).map((item) =>
        '<span class="path-item">' +
          escapeHtml(item.name) +
          ' <span>' + (item.tier ? 'Q' + item.tier : 'Any') + '</span>' +
          ' x' + Number(item.quantity || 0).toLocaleString() +
        '</span>'
      ).join("");

      const pathLabel = mode === "concentration" ? "best budget variant" : "top optimizer variant";
      const qualityLabel = variant.qualityProfileShort ? variant.qualityProfileShort + ", " : "";
      const craftCount = mode === "concentration" ? 1 : Number(row.suggestedCrafts || 1);
      return '<section class="craft-path">' +
        '<div class="craft-path-head">' +
          '<div><strong>Craft path</strong><span>' + escapeHtml(qualityLabel + pathLabel) + ' #' + escapeHtml(variant.rank || 1) + ' for ' + craftCount.toLocaleString() + ' craft(s)</span></div>' +
          '<button class="mini-action add-shopping-list" type="button" data-shopping-key="' + escapeAttr(shoppingKey) + '">Add mats</button>' +
        '</div>' +
        '<div class="path-items">' + items + '</div>' +
      '</section>';
    }

    function setupFollowButtons() {
      restoreDoneCards();
      document.addEventListener("click", async (event) => {
        const shoppingButton = event.target.closest(".add-shopping-list");
        if (shoppingButton) {
          event.preventDefault();
          event.stopPropagation();
          addShoppingVariant(shoppingButton.dataset.shoppingKey || "");
          return;
        }

        const copyButton = event.target.closest(".copy-line");
        if (copyButton) {
          event.preventDefault();
          event.stopPropagation();
          await copyText(copyButton.dataset.copyText || "");
          setTransientStatus("Copied craft line.");
          return;
        }

        const doneButton = event.target.closest(".done-toggle");
        if (doneButton) {
          event.preventDefault();
          event.stopPropagation();
          const card = doneButton.closest(".craft-card");
          if (!card) return;
          const active = !card.classList.contains("done");
          setCardDone(card, active);
          saveDoneCards();
          setTransientStatus(active ? "Marked done." : "Marked not done.");
        }
      });
    }

    function buildCraftCommandText(row, mode) {
      if (mode === "concentration") {
        const name = row.concentrationDisplayName || row.displayName || row.name;
        if (Number(row.concentrationBestProfitCopper || 0) <= 0) {
          return "Do not craft " + name + " today. Best saved path is " +
            (row.concentrationBestProfit || row.averageProfit) + " per craft at " +
            (row.concentrationBestCostLabel || row.concentrationCostLabel || row.concentrationCostFormatted || "0") +
            ".";
        }
        return "Craft 1 " + name + " using " +
          (row.concentrationBestPath || "best saved path") + " for " +
          (row.concentrationBestProfit || row.averageProfit) + " profit at " +
          (row.concentrationBestCostLabel || row.concentrationCostLabel || row.concentrationCostFormatted || "0") +
          ".";
      }
      const base = "Craft " + row.suggestedCrafts.toLocaleString() + " " +
        (row.displayName || row.name) + " (" + row.suggestedItemsFormatted + " items) for " +
        row.expectedProfit + " profit today.";
      return base;
    }

    function getBestShoppingVariant(row, mode) {
      const variants = row.ingredientOptimization && Array.isArray(row.ingredientOptimization.variants)
        ? row.ingredientOptimization.variants
        : [];
      const candidates = variants.filter((candidate) => candidate.shoppingItems && candidate.shoppingItems.length);
      if (mode === "concentration" && row.usesConcentration) {
        const budget = Math.max(0, Math.floor(Number(report.settings.concentrationBudget || 0)));
        return candidates.reduce((best, candidate) => {
          if (!best) return candidate;
          return getVariantBudgetStats(candidate, budget).totalProfitCopper > getVariantBudgetStats(best, budget).totalProfitCopper
            ? candidate
            : best;
        }, null);
      }
      return candidates[0] || null;
    }

    function buildWeeklyConcentrationPlan(options, budget) {
      budget = Math.max(0, Math.floor(Number(budget || 0)));
      const positive = (options || []).filter((option) =>
        Number(option.concentrationCost || 0) > 0 && Number(option.averageProfitCopper || 0) > 0
      );
      const eligible = positive.filter(isWeeklyPlannerEligibleBrowser);
      const valid = eligible.length ? eligible : positive;
      const empty = {
        budget,
        usedConcentration: 0,
        usedConcentrationFormatted: "0",
        leftoverConcentration: budget,
        leftoverConcentrationFormatted: formatNumberBrowser(budget),
        totalProfitCopper: 0,
        totalProfit: "0c",
        totalCrafts: 0,
        marketFilteredCount: positive.length - eligible.length,
        items: [],
      };
      if (!budget || !valid.length) return empty;

      const dp = Array.from({ length: budget + 1 }, () => null);
      dp[0] = { profit: 0, picks: [] };
      for (let spent = 0; spent <= budget; spent += 1) {
        const state = dp[spent];
        if (!state) continue;
        for (const option of valid) {
          const cost = Math.round(variantConcentrationCost(option));
          if (!cost) continue;
          const nextSpent = spent + cost;
          if (nextSpent > budget) continue;
          const nextProfit = state.profit + Number(option.averageProfitCopper || 0);
          if (!dp[nextSpent] || nextProfit > dp[nextSpent].profit) {
            dp[nextSpent] = { profit: nextProfit, picks: [...state.picks, option.optionID] };
          }
        }
      }

      let bestSpent = 0;
      for (let spent = 1; spent <= budget; spent += 1) {
        const state = dp[spent];
        const best = dp[bestSpent];
        if (state && (!best || state.profit > best.profit || (state.profit === best.profit && spent > bestSpent))) {
          bestSpent = spent;
        }
      }

      const best = dp[bestSpent] || dp[0];
      const byID = new Map(valid.map((option) => [option.optionID, option]));
      const counts = new Map();
      for (const id of best.picks) counts.set(id, (counts.get(id) || 0) + 1);
      const items = [...counts.entries()].map(([id, crafts]) => {
        const option = byID.get(id);
        const produced = crafts * Number(option.expectedYieldPerCraft || 1);
        return {
          ...option,
          crafts,
          itemsProduced: produced,
          itemsProducedFormatted: formatQuantityBrowser(produced),
          totalConcentration: crafts * variantConcentrationCost(option),
          totalConcentrationFormatted: formatNumberBrowser(crafts * variantConcentrationCost(option)),
          totalRawConcentration: crafts * Number(option.concentrationCost || 0),
          totalRawConcentrationFormatted: formatNumberBrowser(crafts * Number(option.concentrationCost || 0)),
          totalExpectedIngenuityRefund: Math.max(0, crafts * (Number(option.concentrationCost || 0) - variantConcentrationCost(option))),
          totalExpectedIngenuityRefundFormatted: formatNumberBrowser(Math.max(0, crafts * (Number(option.concentrationCost || 0) - variantConcentrationCost(option)))),
          totalProfitCopper: crafts * Number(option.averageProfitCopper || 0),
          totalProfit: formatCopperBrowser(crafts * Number(option.averageProfitCopper || 0)),
          shoppingItems: multiplyShoppingItemsBrowser(option.shoppingItems || [], crafts),
        };
      }).sort((a, b) => b.totalProfitCopper - a.totalProfitCopper);

      return {
        budget,
        usedConcentration: bestSpent,
        usedConcentrationFormatted: formatNumberBrowser(bestSpent),
        leftoverConcentration: budget - bestSpent,
        leftoverConcentrationFormatted: formatNumberBrowser(budget - bestSpent),
        totalProfitCopper: best.profit,
        totalProfit: formatCopperBrowser(best.profit),
        totalCrafts: items.reduce((sum, item) => sum + item.crafts, 0),
        marketFilteredCount: positive.length - eligible.length,
        items,
      };
    }

    function isWeeklyPlannerEligibleBrowser(option) {
      const dailyDrop = Number(option && option.dailyDropProxy || 0);
      const currentQuantity = Number(option && option.currentQuantity || 0);
      return dailyDrop >= 500 && currentQuantity >= 250;
    }

    function formatConcentrationSource(snapshot, source) {
      if (!snapshot) {
        return source === "command-line" ? "manual budget" : "default budget";
      }
      const current = Math.floor(Number(snapshot.currentAmount ?? snapshot.currentAmountRounded ?? 0));
      const max = Math.floor(Number(snapshot.maxQuantity ?? 0));
      const label = max > 0 ? current.toLocaleString() + "/" + max.toLocaleString() : current.toLocaleString();
      const profession = snapshot.professionName ? " " + snapshot.professionName : "";
      return label + profession;
    }

    function multiplyShoppingItemsBrowser(items, multiplier) {
      multiplier = Math.max(1, Math.ceil(Number(multiplier || 1)));
      return (items || []).map((item) => ({
        ...item,
        quantity: Math.max(1, Math.ceil(Number(item.quantity || 1) * multiplier)),
      }));
    }

    function formatNumberBrowser(value) {
      return Math.round(Number(value || 0)).toLocaleString();
    }

    function formatQuantityBrowser(value) {
      const number = Number(value || 0);
      if (Math.abs(number - Math.round(number)) < 0.05) return formatNumberBrowser(number);
      return number.toLocaleString(undefined, { maximumFractionDigits: 1 });
    }

    function formatCopperBrowser(copper) {
      copper = Math.round(Number(copper || 0));
      const sign = copper < 0 ? "-" : "";
      copper = Math.abs(copper);
      const gold = Math.floor(copper / 10000);
      const silver = Math.floor((copper % 10000) / 100);
      const copperPart = copper % 100;
      if (gold) return sign + gold.toLocaleString() + "g " + silver + "s" + (copperPart ? " " + copperPart + "c" : "");
      if (silver) return sign + silver + "s" + (copperPart ? " " + copperPart + "c" : "");
      return sign + copperPart + "c";
    }

    function registerShoppingVariant(row, variant, mode) {
      const key = [
        mode,
        row.itemID,
        row.recipeID || "",
        row.qualityLabel || "",
        variant.rank || 1,
      ].join(":");
      shoppingVariants.set(key, { row, variant });
      return key;
    }

    function addShoppingVariant(key) {
      const entry = shoppingVariants.get(key);
      if (!entry || !entry.variant.shoppingItems || !entry.variant.shoppingItems.length) {
        setTransientStatus("No optimized mats found for that row.");
        return;
      }

      for (const item of entry.variant.shoppingItems) {
        const tier = Math.max(0, Number(item.tier || 0));
        const name = String(item.name || "").trim();
        const quantity = Math.max(1, Math.ceil(Number(item.quantity || 1)));
        if (!name) continue;
        const cartKey = name.toLowerCase() + ":" + tier;
        const current = shoppingCart.items[cartKey] || { name, tier, quantity: 0 };
        current.quantity += quantity;
        shoppingCart.items[cartKey] = current;
      }

      saveShoppingCart();
      renderShoppingCart();
      setTransientStatus("Added mats for " + (entry.row.displayName || entry.row.name) + ".");
    }

    function renderShoppingCart() {
      const list = document.querySelector("#shopping-cart-list");
      const items = getShoppingCartItems();
      document.querySelector("#copy-shopping-cart").disabled = items.length === 0;
      document.querySelector("#clear-shopping-cart").disabled = items.length === 0;
      if (!items.length) {
        list.innerHTML = '<div class="cart-empty">No mats added yet. Use <b>Add mats</b> on a craft with optimizer data.</div>';
        return;
      }

      list.innerHTML = items.map((item) =>
        '<div class="cart-row">' +
          '<strong>' + escapeHtml(item.name) + '</strong>' +
          '<span>' + (item.tier ? 'Q' + item.tier : 'Any quality') + '</span>' +
          '<span>x' + item.quantity.toLocaleString() + '</span>' +
        '</div>'
      ).join("");
    }

    function getShoppingCartItems() {
      return Object.values(shoppingCart.items || {})
        .filter((item) => item && item.name && Number(item.quantity) > 0)
        .sort((a, b) => a.name.localeCompare(b.name) || Number(a.tier || 0) - Number(b.tier || 0));
    }

    async function copyShoppingCart() {
      const items = getShoppingCartItems();
      if (!items.length) {
        setTransientStatus("Shopping list is empty.");
        return;
      }
      await copyText(formatShoppingCartPayload(items));
      setTransientStatus("Copied shopping list. Paste it into CPE in WoW.");
    }

    function clearShoppingCart() {
      shoppingCart = { items: {} };
      saveShoppingCart();
      renderShoppingCart();
      setTransientStatus("Shopping list cleared.");
    }

    function formatShoppingCartPayload(items) {
      const listName = "CraftPlan - " + (report.source.realm || "Mats");
      return [
        "CPE_AUCTIONATOR_LIST_V1",
        "list\\t" + sanitizePayloadField(listName),
        ...items.map((item) =>
          "item\\t" + sanitizePayloadField(item.name) + "\\t" +
          Math.max(0, Number(item.tier || 0)) + "\\t" +
          Math.max(1, Math.ceil(Number(item.quantity || 1)))
        ),
      ].join("\\n");
    }

    function shoppingCartStorageKey() {
      return "craft-plan-shopping:" + (report.source.realm || "realm") + ":" + (report.source.snapshotUtc || "");
    }

    function loadShoppingCart() {
      try {
        return JSON.parse(localStorage.getItem(shoppingCartStorageKey()) || '{"items":{}}');
      } catch {
        return { items: {} };
      }
    }

    function saveShoppingCart() {
      localStorage.setItem(shoppingCartStorageKey(), JSON.stringify(shoppingCart));
    }

    function sanitizePayloadField(value) {
      return String(value ?? "").replace(/[\\t\\r\\n]/g, " ").trim();
    }

    async function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch {
          // Fall through to the textarea copy path for file:// or strict browsers.
        }
      }

      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.setAttribute("readonly", "");
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      document.body.appendChild(textArea);
      textArea.select();
      const copied = document.execCommand("copy");
      textArea.remove();
      if (!copied) {
        window.prompt("Copy this craft line:", text);
      }
    }

    function doneStorageKey() {
      return "craft-plan-done:" + (report.source.realm || "realm") + ":" + (report.source.snapshotUtc || "");
    }

    function restoreDoneCards() {
      const saved = JSON.parse(localStorage.getItem(doneStorageKey()) || "{}");
      document.querySelectorAll(".craft-card").forEach((card) => {
        setCardDone(card, Boolean(saved[card.dataset.cardKey]));
      });
    }

    function saveDoneCards() {
      const saved = {};
      document.querySelectorAll(".craft-card.done").forEach((card) => {
        saved[card.dataset.cardKey] = true;
      });
      localStorage.setItem(doneStorageKey(), JSON.stringify(saved));
    }

    function setCardDone(card, active) {
      card.classList.toggle("done", active);
      const button = card.querySelector(".done-toggle");
      if (button) {
        button.classList.toggle("active", active);
        button.textContent = active ? "Undo" : "Done";
      }
    }

    function setTransientStatus(message) {
      const status = document.querySelector("#share-status");
      status.textContent = message;
      window.clearTimeout(setTransientStatus.timer);
      setTransientStatus.timer = window.setTimeout(() => {
        if (status.textContent === message) status.textContent = "";
      }, 2200);
    }

    function setupTabs() {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
      for (const tab of tabs) {
        tab.addEventListener("click", () => showTab(tab, tabs, panels));
        tab.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          showTab(tab, tabs, panels);
        });
      }
    }

    function showTab(targetTab, tabs, panels) {
      for (const tab of tabs) {
        const active = tab === targetTab;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
      }
      const targetPanel = document.getElementById(targetTab.getAttribute("aria-controls"));
      for (const panel of panels) panel.hidden = panel !== targetPanel;
    }

    function tag(value, className = "") {
      if (value === null || value === undefined || value === "") return "";
      return '<span class="tag ' + className + '">' + escapeHtml(value) + '</span>';
    }

    function metric(label, value) {
      return '<div class="metric"><strong>' + escapeHtml(value) + '</strong><span>' + escapeHtml(label) + '</span></div>';
    }

    function generateSharePng() {
      const status = document.querySelector("#share-status");
      status.textContent = "Rendering share card...";
      const canvas = document.createElement("canvas");
      const scale = 2;
      const width = 1200;
      const height = 1500;
      canvas.width = width * scale;
      canvas.height = height * scale;
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      drawShareCard(ctx, width, height);
      canvas.toBlob((blob) => {
        if (!blob) {
          status.textContent = "Could not render PNG.";
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "craft-plan-" + fileSlug(report.source.realm || "realm") + "-" + fileDate(new Date(report.generatedAtUtc)) + ".png";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.textContent = "PNG generated.";
      }, "image/png");
    }

    async function regenerateReport() {
      const status = document.querySelector("#share-status");
      const defaultAppBase = "http://127.0.0.1:8791";
      const appBase = window.location.protocol.startsWith("http") ? window.location.origin : defaultAppBase;
      const apiToken = window.CRAFTINGBUDDY_API_TOKEN || "";
      status.textContent = "Regenerating report...";
      try {
        const response = await fetch(appBase + "/api/generate", {
          method: "POST",
          headers: apiToken ? { "x-craftingbuddy-token": apiToken } : {},
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "app returned " + response.status);
        }
        status.textContent = "Regenerated. Opening updated report...";
        window.setTimeout(() => {
          if (window.location.href.startsWith(appBase)) window.location.reload();
          else window.location.href = appBase + "/report";
        }, 600);
      } catch (error) {
        status.textContent = "Open this report from CraftingBuddy first, then press Regenerate again. The app handles report generation.";
      }
    }

    function drawShareCard(ctx, width, height) {
      const batch = (report.recommendations || []).slice(0, 5);
      const concentration = (report.concentrationRecommendations || []).slice(0, 5);
      const generated = new Date(report.generatedAtUtc).toLocaleString();
      const snapshot = new Date(report.source.snapshotUtc).toLocaleString();
      const marketLabel = report.source.marketSourceLabel || "Market";
      const realmLabel = report.source.realm || "Unknown realm";
      const bg = ctx.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, "#07110d");
      bg.addColorStop(.58, "#101511");
      bg.addColorStop(1, "#1a160d");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      drawGlow(ctx, 160, 90, 360, "rgba(60,198,162,.22)");
      drawGlow(ctx, 1030, 230, 380, "rgba(224,179,90,.18)");
      drawGrid(ctx, width, height);

      ctx.fillStyle = "#f1efe4";
      ctx.font = "900 68px Bahnschrift, Aptos, sans-serif";
      ctx.fillText("Craft Plan", 68, 104);
      ctx.fillStyle = "#a6aa9b";
      ctx.font = "24px Bahnschrift, Aptos, sans-serif";
      ctx.fillText(realmLabel + "  |  " + generated, 72, 148);
      ctx.fillText(marketLabel + " snapshot: " + snapshot, 72, 182);

      drawStat(ctx, 72, 228, "Batch", report.summary.candidateCount);
      drawStat(ctx, 342, 228, "Concentration", report.summary.concentrationCandidateCount);
      drawStat(ctx, 704, 228, "Profit records", report.summary.matchedProfitRecords + "/" + report.summary.snapshotItems);

      drawSection(ctx, "Batch craft", batch, 72, 390, false);
      drawSection(ctx, "Concentration", concentration, 72, 920, true);

      ctx.fillStyle = "#a6aa9b";
      ctx.font = "20px Bahnschrift, Aptos, sans-serif";
      ctx.fillText("Profit is CraftSim expected profit. Daily movement is market quantity drop proxy.", 72, 1440);
    }

    function drawSection(ctx, title, rows, x, y, isConcentration) {
      ctx.fillStyle = isConcentration ? "#3cc6a2" : "#e0b35a";
      ctx.font = "900 34px Bahnschrift, Aptos, sans-serif";
      ctx.fillText(title, x, y);
      if (!rows.length) {
        ctx.fillStyle = "#a6aa9b";
        ctx.font = "24px Bahnschrift, Aptos, sans-serif";
        ctx.fillText("No profitable rows in this view.", x, y + 56);
        return;
      }
      rows.forEach((row, index) => {
        drawShareRow(ctx, row, index + 1, x, y + 46 + index * 82, isConcentration);
      });
    }

    function drawShareRow(ctx, row, rank, x, y, isConcentration) {
      roundRect(ctx, x, y, 1056, 66, 8, "rgba(255,255,255,.045)", "rgba(255,255,255,.1)");
      ctx.fillStyle = isConcentration ? "#3cc6a2" : "#e0b35a";
      ctx.font = "900 24px Bahnschrift, Aptos, sans-serif";
      ctx.fillText("#" + rank, x + 22, y + 42);
      ctx.fillStyle = "#f1efe4";
      ctx.font = "900 27px Bahnschrift, Aptos, sans-serif";
      fitText(ctx, row.displayName || row.name, x + 78, y + 30, 440);
      ctx.fillStyle = "#a6aa9b";
      ctx.font = "20px Bahnschrift, Aptos, sans-serif";
      const command = "Craft " + row.suggestedCrafts.toLocaleString() + " (" + row.suggestedItemsFormatted + " items)";
      fitText(ctx, command, x + 78, y + 55, 430);
      ctx.fillStyle = "#8be28d";
      ctx.font = "900 25px Bahnschrift, Aptos, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(row.expectedProfit, x + 1030, y + 30);
      ctx.fillStyle = isConcentration ? "#3cc6a2" : "#a6aa9b";
      ctx.font = "20px Bahnschrift, Aptos, sans-serif";
      const note = isConcentration ? row.profitPerConcentration + "/conc" : row.dailyDropProxyFormatted + "/day proxy";
      ctx.fillText(note, x + 1030, y + 55);
      ctx.textAlign = "left";
    }

    function drawStat(ctx, x, y, label, value) {
      roundRect(ctx, x, y, 236, 104, 8, "rgba(255,255,255,.05)", "rgba(255,255,255,.12)");
      ctx.fillStyle = "#f1efe4";
      ctx.font = "900 38px Bahnschrift, Aptos, sans-serif";
      ctx.fillText(String(value), x + 20, y + 46);
      ctx.fillStyle = "#a6aa9b";
      ctx.font = "18px Bahnschrift, Aptos, sans-serif";
      ctx.fillText(label.toUpperCase(), x + 20, y + 78);
    }

    function drawGlow(ctx, x, y, radius, color) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, color);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, 1200, 1500);
    }

    function drawGrid(ctx, width, height) {
      ctx.strokeStyle = "rgba(255,255,255,.045)";
      ctx.lineWidth = 1;
      for (let x = 0; x < width; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y < height; y += 32) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    }

    function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + width - radius, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
      ctx.lineTo(x + width, y + height - radius);
      ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
      ctx.lineTo(x + radius, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.stroke();
      }
    }

    function fitText(ctx, text, x, y, maxWidth) {
      const value = String(text ?? "");
      if (ctx.measureText(value).width <= maxWidth) {
        ctx.fillText(value, x, y);
        return;
      }
      let clipped = value;
      while (clipped.length > 3 && ctx.measureText(clipped + "...").width > maxWidth) {
        clipped = clipped.slice(0, -1);
      }
      ctx.fillText(clipped + "...", x, y);
    }

    function fileDate(date) {
      const pad = (number) => String(number).padStart(2, "0");
      return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "-" + pad(date.getHours()) + pad(date.getMinutes());
    }

    function fileSlug(value) {
      return String(value || "realm").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "realm";
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    function escapeAttr(value) {
      return escapeHtml(value).split(String.fromCharCode(96)).join("&#96;");
    }
  </script>
</body>
</html>`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildCraftPlan(parseArgs(process.argv.slice(2)));
}
