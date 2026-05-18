import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CATALOG = path.join(ROOT, "data", "undermine-silvermoon-eu-crafting.json");
const API = "https://api.undermine.exchange";
const SITE = "https://undermine.exchange/";
const MS_DAY = 86400000;

export async function scrapeUndermineApi(options = {}) {
  const region = String(options.region ?? "eu").toLowerCase();
  const realmSlug = normalizeRealmSlug(options["realm-slug"] ?? options.realm ?? "silvermoon");
  const realmLabel = options["realm-label"] ?? `${titleCaseRealm(realmSlug)} ${region.toUpperCase()}`;
  const apiKey = String(options.apiKey ?? options["api-key"] ?? process.env.UNDERMINE_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("Undermine API key is missing. Save one in the app or set UNDERMINE_API_KEY.");
  }

  const defaultOut = path.join(ROOT, "data", `undermine-api-${realmSlug}-${region}-crafting.json`);
  const catalogPath = path.resolve(options.catalog ?? DEFAULT_CATALOG);
  const outPath = path.resolve(options.out ?? defaultOut);
  const maxTargets = options.limit ? Math.max(1, Number(options.limit)) : null;
  const historyLimit = options["no-history"] ? 0 : Math.max(0, Number(options["history-limit"] ?? 80));

  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const targetItems = maxTargets ? catalog.items.slice(0, maxTargets) : catalog.items.slice();
  const commoditySummary = await getUndermine(apiKey, `/v1/region/${region}/commodities.json`);
  const commodities = commoditySummary.result?.commodities || {};
  const snapshotUtc = normalizeIso(commoditySummary.result?.snapshot || commoditySummary.result?.lastUpdated);

  let historyRequests = 0;
  let movementItems = 0;
  let fallbackMovementItems = 0;
  let missingMarketItems = 0;
  const rows = [];

  for (const target of targetItems) {
    const marketRow = commodities[String(target.itemID)] || null;
    if (!marketRow) missingMarketItems += 1;
    const canFetchHistory = historyRequests < historyLimit;
    const history = canFetchHistory
      ? await getUndermine(apiKey, `/v1/region/${region}/commodities/${target.itemID}/hourly.json`)
          .then((payload) => {
            historyRequests += 1;
            return payload.result?.hourly || [];
          })
          .catch(() => {
            historyRequests += 1;
            return [];
          })
      : [];
    const movementStats = history.length >= 3 ? getMovementStats(history) : getFallbackMovementStats(target);
    if (history.length >= 3) movementItems += 1;
    else fallbackMovementItems += 1;

    const currentQuantity = Math.max(0, Number(marketRow?.quantity ?? target.currentQuantity ?? 0));
    const currentMinPriceCopper = Math.max(0, Number(marketRow?.price ?? target.currentMinPriceCopper ?? 0));

    rows.push({
      group: target.group,
      groupLabel: target.groupLabel,
      category: target.category,
      itemID: Number(target.itemID),
      name: target.name || `Item ${target.itemID}`,
      quality: target.quality ?? null,
      requiredLevel: target.requiredLevel ?? null,
      expansion: target.expansion ?? null,
      currentQuantity,
      currentQuantityFormatted: formatNumber(currentQuantity),
      currentMinPriceCopper,
      currentMinPrice: formatCopper(currentMinPriceCopper),
      sevenDayAverageQuantity: movementStats.avgQty7,
      sevenDayMinQuantity: movementStats.minQty7,
      sevenDayMaxQuantity: movementStats.maxQty7,
      sevenDayDropProxy: movementStats.drops7,
      sevenDayAddProxy: movementStats.rises7,
      sevenDayPoints: movementStats.points7,
      movementSource: history.length >= 3 ? "undermine-api-hourly" : "catalog-fallback",
      snapshotUtc: normalizeIso(marketRow?.snapshot || snapshotUtc),
    });
  }

  rows.sort((a, b) => (b.sevenDayDropProxy ?? 0) - (a.sevenDayDropProxy ?? 0) || a.name.localeCompare(b.name));
  rows.forEach((row, index) => {
    row.rankBySevenDayDrop = index + 1;
  });

  const snapshotMs = Math.max(...rows.map((row) => Date.parse(row.snapshotUtc)).filter(Number.isFinite), Date.now());
  const payload = {
    schemaVersion: 2,
    generatedAtUtc: new Date().toISOString(),
    snapshotUtc: new Date(snapshotMs).toISOString(),
    realm: realmLabel,
    region,
    market: "Undermine Exchange API region commodities",
    sourceLabel: "Undermine API",
    sourceUrl: SITE,
    groups: [
      {
        key: "cooking",
        label: "Cooking",
        sourceUrl: `${SITE}#${region}-${realmSlug}/search/cat=0.5/lmin=90/lmax=90`,
      },
      {
        key: "alchemy",
        label: "Alchemy",
        sourceUrl: `${SITE}#${region}-${realmSlug}/search/cat=0.1/era=12`,
      },
    ],
    notes: [
      "Current prices and quantities come from Undermine Exchange API commodity endpoints.",
      "Quantities are available/listed auction quantities, not confirmed sales.",
      "sevenDayDropProxy is the sum of decreases in hourly listed quantity; cancels, expiries, and reposts can affect it.",
      "Cooking is level 90 Food & Drink. Alchemy is current-expansion Potions and Flasks because those items are required level 81, not 90.",
    ],
    stats: {
      targetItems: targetItems.length,
      matchedMarketItems: targetItems.length - missingMarketItems,
      missingMarketItems,
      undermineMovementItems: movementItems,
      fallbackMovementItems,
      undermineHistoryRequests: historyRequests,
      undermineHistoryLimit: historyLimit,
    },
    items: rows,
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${outPath}`);
  console.log(`Items: ${rows.length}`);
  console.log(`Undermine current rows matched: ${payload.stats.matchedMarketItems}/${targetItems.length}`);
  console.log(`Movement from Undermine hourly API: ${movementItems}`);
  console.log(`Movement fallback: ${fallbackMovementItems}`);
  console.log(`History API requests: ${historyRequests}/${historyLimit}`);

  return { payload, outPath };
}

async function getUndermine(apiKey, apiPath) {
  const response = await fetch(API + apiPath, {
    headers: {
      Authorization: `ApiKey ${apiKey}`,
      Accept: "application/json",
      "Accept-Encoding": "gzip",
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${apiPath} returned ${response.status}: ${text.slice(0, 200)}`);
  }
  return await response.json();
}

function getMovementStats(points) {
  const series = points
    .map((point) => ({
      time: Date.parse(point.snapshot),
      quantity: Math.max(0, Number(point.quantity || 0)),
    }))
    .filter((point) => Number.isFinite(point.time))
    .sort((a, b) => a.time - b.time);
  const latestTime = Math.max(...series.map((point) => point.time));
  const windowStart = latestTime - 7 * MS_DAY;
  const window = series.filter((point) => point.time >= windowStart);
  const quantities = window.map((point) => point.quantity);
  let drops7 = 0;
  let rises7 = 0;
  for (let i = 1; i < quantities.length; i += 1) {
    const delta = quantities[i] - quantities[i - 1];
    if (delta < 0) drops7 += Math.abs(delta);
    else rises7 += delta;
  }
  return {
    avgQty7: quantities.length ? Math.round(quantities.reduce((sum, value) => sum + value, 0) / quantities.length) : 0,
    minQty7: quantities.length ? Math.min(...quantities) : 0,
    maxQty7: quantities.length ? Math.max(...quantities) : 0,
    drops7,
    rises7,
    points7: window.length,
  };
}

function getFallbackMovementStats(item) {
  const current = Math.max(0, Number(item.currentQuantity ?? 0));
  return {
    avgQty7: item.sevenDayAverageQuantity ?? current,
    minQty7: item.sevenDayMinQuantity ?? current,
    maxQty7: item.sevenDayMaxQuantity ?? current,
    drops7: item.sevenDayDropProxy ?? 0,
    rises7: item.sevenDayAddProxy ?? 0,
    points7: item.sevenDayPoints ?? null,
  };
}

function normalizeIso(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function formatNumber(value) {
  return Math.round(Number(value ?? 0)).toLocaleString("en-US");
}

function formatCopper(copper) {
  copper = Math.round(Number(copper ?? 0));
  const sign = copper < 0 ? "-" : "";
  copper = Math.abs(copper);
  const gold = Math.floor(copper / 10000);
  const silver = Math.floor((copper % 10000) / 100);
  const bronze = copper % 100;
  if (gold) return `${sign}${gold.toLocaleString("en-US")}g ${silver}s${bronze ? ` ${bronze}c` : ""}`;
  if (silver) return `${sign}${silver}s${bronze ? ` ${bronze}c` : ""}`;
  return `${sign}${bronze}c`;
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

function normalizeRealmSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "silvermoon";
}

function titleCaseRealm(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await scrapeUndermineApi(parseArgs(process.argv.slice(2)));
}
