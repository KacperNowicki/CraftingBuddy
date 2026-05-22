import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliDecompressSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CATALOG = path.join(ROOT, "data", "undermine-silvermoon-eu-crafting.json");
const ARTIFACTS = "https://goblinexchange.com/artifacts/";
const SITE = "https://goblinexchange.com/";
let REGION = "eu";
let REALM_SLUG = "silvermoon";
let REALM_LABEL = "Silvermoon EU";
const LOCALE = "en";
const MS_DAY = 86400000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export async function scrapeGoblin(options = {}) {
REGION = String(options.region ?? "eu").toLowerCase();
REALM_SLUG = normalizeRealmSlug(options["realm-slug"] ?? options.realm ?? "silvermoon");
REALM_LABEL = options["realm-label"] ?? `${titleCaseRealm(REALM_SLUG)} ${REGION.toUpperCase()}`;
const defaultOut = path.join(ROOT, "data", `goblin-${REALM_SLUG}-${REGION}-crafting.json`);
const catalogPath = path.resolve(options.catalog ?? DEFAULT_CATALOG);
const outPath = path.resolve(options.out ?? defaultOut);
const maxTargets = options.limit ? Math.max(1, Number(options.limit)) : null;
const historyLimit = options["no-history"] ? 0 : Math.max(0, Number(options["history-limit"] ?? 70));

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const targetItems = maxTargets ? catalog.items.slice(0, maxTargets) : catalog.items.slice();
const targetById = new Map(targetItems.map((item) => [Number(item.itemID), item]));

const realms = await getArtifact(`realms/${REGION}/index.json.br`);
const realm = (realms.realms || []).find((candidate) =>
  (candidate.realmSlugs || [])
    .flatMap((slug) => [normalizeRealmSlug(slug), compactRealmSlug(slug)])
    .includes(REALM_SLUG) || compactRealmSlug(candidate.name || candidate.realmName) === compactRealmSlug(REALM_SLUG),
);
if (!realm?.connectedRealmId) {
  throw new Error(`Could not resolve Goblin Exchange realm ${REALM_SLUG}/${REGION}.`);
}

const connectedRealmId = Number(realm.connectedRealmId);
const manifest = await getArtifact(`market/${REGION}/manifest.json`);
const marketUpdatedAt = manifest?.market?.marketUpdatedAt || manifest?.generatedAt || new Date().toISOString();
const marketRows = await getMarketRows(manifest, connectedRealmId, targetById, [
  "consumables/food-drink",
  "consumables/potions",
  "consumables/flasks",
]);

const rowsByItemId = new Map();
for (const row of marketRows.rows) {
  const itemId = Number(row.itemId || row.id);
  if (!targetById.has(itemId)) continue;
  const previous = rowsByItemId.get(itemId);
  if (!previous || Number(row.quantity || 0) > Number(previous.quantity || 0)) {
    rowsByItemId.set(itemId, row);
  }
}

const historyManifest = await getArtifact(`item/${REGION}/history-shards/manifest.json`).catch(() => null);
const historyCache = new Map();
let goblinMovementItems = 0;
let fallbackMovementItems = 0;
let missingMarketItems = 0;

const rows = [];
for (const target of targetItems) {
  const marketRow = rowsByItemId.get(Number(target.itemID));
  if (!marketRow) missingMarketItems += 1;

  const canFetchHistory = historyManifest && historyCache.size < historyLimit;
  const movement = canFetchHistory
    ? await getGoblinMovementStats(historyManifest, historyCache, target.itemID, marketRow?.variantId, marketUpdatedAt).catch(() => null)
    : null;
  const movementStats = movement ?? getFallbackMovementStats(target);
  if (movement) goblinMovementItems += 1;
  else fallbackMovementItems += 1;

  const currentQuantity = Math.max(0, Number(marketRow?.quantity ?? target.currentQuantity ?? 0));
  const currentMinPriceCopper = Math.max(
    0,
    Number(
      marketRow?.currentMinBuyout ??
        marketRow?.price ??
        marketRow?.minBuyout ??
        target.currentMinPriceCopper ??
        0,
    ),
  );

  rows.push({
    group: target.group,
    groupLabel: target.groupLabel,
    category: target.category || humanizeCategory(marketRow?.sub || marketRow?.categoryPath),
    itemID: Number(target.itemID),
    name: marketRow?.name || target.name || `Item ${target.itemID}`,
    quality: target.quality ?? marketRow?.quality ?? null,
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
    movementSource: movement ? "goblin-exchange-history" : "catalog-fallback",
    snapshotUtc: normalizeIso(marketRow?.marketUpdatedAt || marketUpdatedAt),
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
  realm: REALM_LABEL,
  region: REGION,
  market: "Goblin Exchange public market artifacts",
  sourceLabel: "Goblin Exchange",
  sourceUrl: SITE,
  connectedRealmId,
  groups: [
    {
      key: "cooking",
      label: "Cooking",
      sourceUrl: `${SITE}en/codex/market?region=${REGION}&realm=${REALM_SLUG}&category=consumables/food-drink`,
    },
    {
      key: "alchemy",
      label: "Alchemy",
      sourceUrl: `${SITE}en/codex/market?region=${REGION}&realm=${REALM_SLUG}&category=consumables/potions`,
    },
  ],
  notes: [
    "Current prices and quantities come from Goblin Exchange public market view artifacts.",
    "Quantities are available/listed auction quantities, not confirmed sales.",
    "sevenDayDropProxy uses Goblin item history when there are enough recent points; otherwise it carries the previous catalog movement baseline so the report remains rankable.",
    "Cooking is level 90 Food & Drink. Alchemy is current-expansion Potions and Flasks because those items are required level 81, not 90.",
  ],
  stats: {
    targetItems: targetItems.length,
    matchedMarketItems: rowsByItemId.size,
    missingMarketItems,
    goblinMovementItems,
    fallbackMovementItems,
    goblinHistoryArtifactRequests: historyCache.size,
    goblinHistoryArtifactLimit: historyLimit,
    marketArtifactSource: marketRows.source,
    marketArtifactRequests: marketRows.requests,
    viewArtifactRequests: marketRows.source === "view-slices" ? marketRows.requests : 0,
  },
  items: rows,
};

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
console.log(`Wrote ${outPath}`);
console.log(`Items: ${rows.length}`);
console.log(`Goblin current rows matched: ${rowsByItemId.size}/${targetItems.length}`);
console.log(`Movement from Goblin history: ${goblinMovementItems}`);
console.log(`Movement fallback: ${fallbackMovementItems}`);
console.log(`History artifact requests: ${historyCache.size}/${historyLimit}`);

return { payload, outPath };
}

async function getGoblinMovementStats(manifest, cache, itemId, variantId, marketUpdatedAt) {
  const histories = [];
  for (const artifactPath of resolveHistoryPaths(manifest, itemId)) {
    let artifact = cache.get(artifactPath);
    if (!artifact) {
      artifact = await getArtifact(artifactPath);
      cache.set(artifactPath, artifact);
    }
    histories.push(...expandOptimizedItemHistoryShard(artifact).histories.filter((history) => Number(history.itemId) === Number(itemId)));
  }

  const history = findBestHistory(histories, variantId);
  const scope = findBestScope(history);
  if (!scope) return null;

  const sampleSeries = normalizeSeries(scope.samples, "ts");
  const dailySeries = normalizeSeries(scope.daily, "bucketStart");
  const sourceSeries = sampleSeries.length >= 8 ? sampleSeries : dailySeries;
  const latestTime = Math.max(...sourceSeries.map((point) => point.time).filter(Number.isFinite));
  const marketTime = Date.parse(marketUpdatedAt);
  if (!Number.isFinite(latestTime) || sourceSeries.length < 3) return null;
  if (Number.isFinite(marketTime) && marketTime - latestTime > 3 * MS_DAY) return null;

  const windowStart = latestTime - 7 * MS_DAY;
  const series = sourceSeries.filter((point) => point.time >= windowStart).sort((a, b) => a.time - b.time);
  if (series.length < 3) return null;

  return getMovementStats(series);
}

function getMovementStats(series) {
  const quantities = series.map((point) => Math.max(0, Number(point.quantity || 0)));
  let drops7 = 0;
  let rises7 = 0;
  for (let i = 1; i < quantities.length; i += 1) {
    const delta = quantities[i] - quantities[i - 1];
    if (delta < 0) drops7 += Math.abs(delta);
    else rises7 += delta;
  }

  return {
    avgQty7: Math.round(quantities.reduce((sum, value) => sum + value, 0) / quantities.length),
    minQty7: Math.min(...quantities),
    maxQty7: Math.max(...quantities),
    drops7,
    rises7,
    points7: series.length,
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

async function getMarketRows(manifest, connectedRealmId, targetById, categories) {
  const viewFiles = resolveViewFiles(manifest, connectedRealmId, categories);
  if (viewFiles.length) {
    const artifacts = await Promise.all(viewFiles.map((file) => getArtifact(file.file.path)));
    return {
      source: "view-slices",
      requests: viewFiles.length,
      rows: artifacts.flatMap((artifact) => getArtifactRows(artifact)),
    };
  }

  const realmStateFiles = resolveRealmStateFiles(manifest, connectedRealmId);
  if (!realmStateFiles.length) {
    throw new Error(`No Goblin Exchange market artifacts found for connected realm ${connectedRealmId}.`);
  }

  const rows = [];
  const found = new Set();
  let requests = 0;
  for (const file of realmStateFiles) {
    const artifact = await getArtifact(file.file.path);
    requests += 1;

    for (const row of getArtifactRows(artifact)) {
      const itemId = Number(row.itemId || row.id);
      if (!targetById.has(itemId)) continue;
      rows.push(row);
      found.add(itemId);
    }

    if (found.size >= targetById.size) break;
  }

  return {
    source: "realm-state-shards",
    requests,
    rows,
  };
}

function resolveViewFiles(manifest, connectedRealmId, categories) {
  const files = Array.isArray(manifest?.market?.viewSlices?.files) ? manifest.market.viewSlices.files : [];
  const wanted = new Set(categories.map((category) => String(category).toLowerCase()));
  return files
    .filter((file) => Number(file.connectedRealmId) === Number(connectedRealmId))
    .filter((file) => String(file.sort || "").toLowerCase() === "available_desc")
    .filter((file) => wanted.has(String(file.filters?.category || "").toLowerCase()))
    .sort((a, b) => String(a.filters?.category || "").localeCompare(String(b.filters?.category || "")));
}

function resolveRealmStateFiles(manifest, connectedRealmId) {
  const files = Array.isArray(manifest?.market?.realmStates?.files) ? manifest.market.realmStates.files : [];
  const realmState = files.find((file) => Number(file.connectedRealmId) === Number(connectedRealmId));
  return (realmState?.shards || [])
    .filter((shard) => shard?.file?.path)
    .sort((a, b) => Number(a.rowStart ?? 0) - Number(b.rowStart ?? 0));
}

function getArtifactRows(artifact) {
  if (Array.isArray(artifact?.rows)) return artifact.rows;
  return expandColumnRows(artifact);
}

function expandColumnRows(artifact) {
  const columns = artifact?.columns;
  if (!columns || typeof columns !== "object") return [];

  const rowCount = Object.values(columns)
    .filter(Array.isArray)
    .reduce((max, column) => Math.max(max, column.length), 0);
  const rows = [];

  for (let index = 0; index < rowCount; index += 1) {
    const row = {};
    for (const [key, column] of Object.entries(columns)) {
      if (Array.isArray(column) && index < column.length) row[key] = column[index];
    }
    rows.push(row);
  }

  return rows;
}

function resolveHistoryPaths(manifest, itemId) {
  const bucket = buildItemBucket(itemId);
  const shard = (manifest.shards || []).find((candidate) => String(candidate.bucket) === bucket);
  if (Array.isArray(shard?.parts) && shard.parts.length) {
    return shard.parts
      .filter((part) => itemIdMatchesPartRange(part, itemId))
      .map((part) => part.file?.path || part.file?.Path)
      .filter(Boolean);
  }
  return [`item/${REGION}/history-shards/v3/${bucket}.json.br`];
}

function expandOptimizedItemHistoryShard(compact) {
  if (!compact || compact.artifact !== "item/history-shard-v3") {
    return { histories: [] };
  }

  const scopesByHistoryIndex = {};
  for (const compactScope of compact.scopes || []) {
    const historyIndex = Number(compactScope?.i || 0);
    const current = expandItemHistoryPoints(compactScope?.c)[0];
    if (!current) continue;
    scopesByHistoryIndex[historyIndex] ??= [];
    scopesByHistoryIndex[historyIndex].push({
      scope: compactScope.s,
      connectedRealmId: compactScope.r == null ? null : Number(compactScope.r),
      updatedAt: compactScope.u,
      current,
      samples: expandItemHistoryPoints(compactScope.p),
      daily: expandItemHistoryOhlcPoints(compactScope.d),
    });
  }

  return {
    histories: (compact.itemIds || []).map((itemId, historyIndex) => ({
      itemId: Number(itemId),
      variantId: compact.variantIds?.[historyIndex] || null,
      updatedAt: compact.updatedAts?.[historyIndex] || compact.updatedAt,
      scopes: scopesByHistoryIndex[historyIndex] || [],
    })),
  };
}

function expandItemHistoryPoints(columns) {
  const source = columns || {};
  const timestamps = Array.isArray(source.t) ? source.t : [];
  return timestamps.map((ts, index) => ({
    ts,
    price: Number(source.p?.[index] || 0),
    quantity: Number(source.q?.[index] || 0),
    listingCount: Number(source.n?.[index] || 0),
  }));
}

function expandItemHistoryOhlcPoints(columns) {
  const source = columns || {};
  const days = Array.isArray(source.d) ? source.d : [];
  return days.map((bucketStart, index) => ({
    bucketStart,
    open: Number(source.o?.[index] || 0),
    high: Number(source.h?.[index] || 0),
    low: Number(source.l?.[index] || 0),
    close: Number(source.c?.[index] || 0),
    quantity: Number(source.q?.[index] || 0),
    listingCount: Number(source.n?.[index] || 0),
  }));
}

function findBestHistory(histories, variantId) {
  const normalizedVariantId = normalizeVariantId(variantId);
  const candidates = histories.filter((history) => {
    const historyVariantId = normalizeVariantId(history.variantId);
    return historyVariantId === normalizedVariantId || !historyVariantId;
  });
  return candidates.sort((a, b) => scoreHistory(b) - scoreHistory(a))[0] || null;
}

function findBestScope(history) {
  const scopes = Array.isArray(history?.scopes) ? history.scopes : [];
  return scopes
    .filter((scope) => scope.scope === "commodity" || scope.scope === "connected-realm-auction")
    .sort((a, b) => scoreScope(b) - scoreScope(a))[0] || null;
}

function scoreHistory(history) {
  return (history.scopes || []).reduce((score, scope) => Math.max(score, scoreScope(scope)), 0);
}

function scoreScope(scope) {
  return (scope.daily?.length || 0) * 24 + (scope.samples?.length || 0);
}

function normalizeSeries(points, key) {
  const byTime = new Map();
  for (const point of points || []) {
    const rawTime = point[key];
    const time = Date.parse(rawTime);
    const quantity = Number(point.quantity ?? 0);
    if (!Number.isFinite(time) || !Number.isFinite(quantity)) continue;
    byTime.set(time, { time, quantity });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function getArtifact(relativePath) {
  const response = await fetch(ARTIFACTS + relativePath, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json,*/*",
      Referer: SITE,
    },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`${relativePath} returned ${response.status}`);
  }

  for (const buffer of [bytes, tryBrotli(bytes)].filter(Boolean)) {
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      // Try the next representation; Node may already decompress content-encoded .br files.
    }
  }

  throw new Error(`${relativePath} was not parseable JSON`);
}

function tryBrotli(bytes) {
  try {
    return brotliDecompressSync(bytes);
  } catch {
    return null;
  }
}

function buildItemBucket(itemId) {
  return (Math.trunc(Number(itemId) || 0) % 4096).toString(16).padStart(3, "0");
}

function itemIdMatchesPartRange(part, itemId) {
  const first = Number(part?.firstItemId || 0);
  const last = Number(part?.lastItemId || 0);
  if (!(first > 0) || !(last > 0)) return true;
  return Number(itemId || 0) >= first && Number(itemId || 0) <= last;
}

function normalizeVariantId(variantId) {
  const value = String(variantId || "").trim();
  return value && value !== "base" ? value : null;
}

function normalizeIso(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function humanizeCategory(value) {
  return String(value || "Unknown")
    .split("/")
    .pop()
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
  if (gold) return `${sign}${gold}g ${silver}s${bronze ? ` ${bronze}c` : ""}`;
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
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "silvermoon";
}

function compactRealmSlug(value) {
  return normalizeRealmSlug(value).replace(/-/g, "");
}

function titleCaseRealm(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await scrapeGoblin(parseArgs(process.argv.slice(2)));
}
