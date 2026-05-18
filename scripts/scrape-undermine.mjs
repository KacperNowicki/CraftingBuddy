import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "undermine-silvermoon-eu-crafting.json");
const BASE = "https://undermine.exchange/";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const COMMODITY_CONNECTED_ID = 32513;
const MS_SECOND = 1000;
const MS_DAY = 86400000;

const groups = [
  {
    key: "cooking",
    label: "Cooking",
    sourceUrl: "https://undermine.exchange/#eu-silvermoon/search/cat=0.5/lmin=90/lmax=90",
    includes: (item) => item.class === 0 && item.subclass === 5 && item.reqLevel === 90,
  },
  {
    key: "alchemy",
    label: "Alchemy",
    sourceUrl: "https://undermine.exchange/#eu-silvermoon/search/cat=0.1/era=12",
    includes: (item) => item.class === 0 && [1, 3].includes(item.subclass) && item.expansion === 12,
  },
];

const [itemsU, itemsB, namesU, namesB, categories, commodityState, globalState] = await Promise.all([
  getJson("json/items.unbound.json"),
  getJson("json/items.bound.json").catch(() => ({})),
  getJson("json/names.unbound.enus.json"),
  getJson("json/names.bound.enus.json").catch(() => ({})),
  getJson("json/categories.enus.json"),
  getBuffer(`data/${COMMODITY_CONNECTED_ID}/state.bin`),
  getBuffer("data/global/state.bin"),
]);

const items = { ...itemsU, ...itemsB };
const names = { ...namesU, ...namesB };
const subcategoryNames = getSubcategoryNames(categories);
const summary = parseStateSummary(commodityState.buffer).summary;
const snapshotList = parseGlobalState(globalState.buffer).snapshotsByConnectedId[COMMODITY_CONNECTED_ID] || [];
const rows = [];

for (const [idText, item] of Object.entries(items)) {
  const id = Number(idText);
  const group = groups.find((candidate) => candidate.includes(item));
  if (!group) continue;
  const current = summary[idText];
  if (!current || current.quantity <= 0) continue;

  const detailBuffer = await getBuffer(`data/${COMMODITY_CONNECTED_ID}/${id & 255}/${id}.bin`).catch(() => null);
  const detail = detailBuffer ? parseItemDetail(detailBuffer.buffer, snapshotList) : null;
  const stats = detail ? getMovementStats(detail) : null;

  rows.push({
    group: group.key,
    groupLabel: group.label,
    category: subcategoryNames[item.subclass] || "Unknown",
    itemID: id,
    name: names[idText] || `Item ${id}`,
    quality: item.quality ?? null,
    requiredLevel: item.reqLevel ?? null,
    expansion: item.expansion ?? null,
    currentQuantity: stats?.current ?? current.quantity,
    currentQuantityFormatted: formatNumber(stats?.current ?? current.quantity),
    currentMinPriceCopper: stats?.price ?? current.price,
    currentMinPrice: formatCopper(stats?.price ?? current.price),
    sevenDayAverageQuantity: stats?.avgQty7 ?? null,
    sevenDayMinQuantity: stats?.minQty7 ?? null,
    sevenDayMaxQuantity: stats?.maxQty7 ?? null,
    sevenDayDropProxy: stats?.drops7 ?? null,
    sevenDayAddProxy: stats?.rises7 ?? null,
    sevenDayPoints: stats?.points7 ?? null,
    snapshotUtc: new Date(stats?.endTime ?? current.snapshot).toISOString(),
  });
}

rows.sort((a, b) => (b.sevenDayDropProxy ?? 0) - (a.sevenDayDropProxy ?? 0) || a.name.localeCompare(b.name));
rows.forEach((row, index) => {
  row.rankBySevenDayDrop = index + 1;
});

const snapshotMs = Math.max(...rows.map((row) => Date.parse(row.snapshotUtc)).filter(Boolean), Date.now());
const payload = {
  schemaVersion: 2,
  generatedAtUtc: new Date().toISOString(),
  snapshotUtc: new Date(snapshotMs).toISOString(),
  realm: "Silvermoon EU",
  region: "eu",
  market: "EU commodity auction house",
  sourceUrl: "https://undermine.exchange/",
  groups: groups.map(({ key, label, sourceUrl }) => ({ key, label, sourceUrl })),
  notes: [
    "Quantities are available/listed auction quantities, not confirmed sales.",
    "sevenDayDropProxy is the sum of decreases in visible quantity across Undermine hourly snapshots; cancels, expiries, and reposts can affect it.",
    "Cooking is level 90 Food & Drink. Alchemy is current-expansion Potions and Flasks & Phials because those items are required level 81, not 90.",
  ],
  items: rows,
};

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(payload, null, 2), "utf8");
console.log(`Wrote ${OUT}`);
console.log(`Items: ${rows.length}`);
console.log(`Cooking: ${rows.filter((row) => row.group === "cooking").length}`);
console.log(`Alchemy: ${rows.filter((row) => row.group === "alchemy").length}`);

async function getJson(relativePath) {
  const response = await fetch(BASE + relativePath, {
    headers: { "User-Agent": USER_AGENT, Referer: BASE, Accept: "application/json,*/*" },
  });
  if (!response.ok) throw new Error(`${relativePath} returned ${response.status}`);
  return await response.json();
}

async function getBuffer(relativePath) {
  const response = await fetch(BASE + relativePath, {
    headers: { "User-Agent": USER_AGENT, Referer: BASE, Accept: "*/*" },
  });
  if (!response.ok) throw new Error(`${relativePath} returned ${response.status}`);
  return { buffer: await response.arrayBuffer(), lastModified: response.headers.get("last-modified") };
}

function getSubcategoryNames(categories) {
  const consumables = categories.find((category) => category.class === 0);
  return Object.fromEntries((consumables?.subcategories || []).map((subcategory) => [subcategory.subClass, subcategory.name]));
}

function parseGlobalState(buffer) {
  const view = new DataView(buffer);
  let offset = 0;
  const take = (bytes) => {
    const start = offset;
    offset += bytes;
    return start;
  };
  const version = view.getUint8(take(1));
  if (version !== 2) throw new Error(`Unknown global state version ${version}`);
  const skipped = view.getUint16(take(2), true);
  offset += skipped * 6;
  const snapshotsByConnectedId = {};
  for (let count = view.getUint16(take(2), true); count > 0; count -= 1) {
    const connectedId = view.getUint16(take(2), true);
    snapshotsByConnectedId[connectedId] = [];
    for (let inner = view.getUint16(take(2), true); inner > 0; inner -= 1) {
      snapshotsByConnectedId[connectedId].push(view.getUint32(take(4), true) * MS_SECOND);
    }
  }
  return { version, snapshotsByConnectedId };
}

function parseStateSummary(buffer) {
  const view = new DataView(buffer);
  let offset = 0;
  const take = (bytes) => {
    const start = offset;
    offset += bytes;
    return start;
  };
  const version = view.getUint8(take(1));
  if (version !== 4) throw new Error(`Unknown state version ${version}`);
  const snapshot = view.getUint32(take(4), true) * MS_SECOND;
  const lastCheck = view.getUint32(take(4), true) * MS_SECOND;
  const snapshots = [];
  for (let count = view.getUint16(take(2), true); count > 0; count -= 1) {
    snapshots.push(view.getUint32(take(4), true) * MS_SECOND);
  }
  const summary = {};
  for (let count = view.getUint32(take(4), true); count > 0; count -= 1) {
    const id = view.getUint32(take(4), true);
    const level = view.getUint16(take(2), true);
    const suffix = view.getUint16(take(2), true);
    const key = level ? `${id}-${level}${suffix ? `-${suffix}` : ""}` : `${id}`;
    summary[key] = {
      id,
      level,
      suffix,
      snapshot: view.getUint32(take(4), true) * MS_SECOND,
      price: view.getUint32(take(4), true) * 100,
      quantity: view.getUint32(take(4), true),
    };
  }
  return { version, snapshot, lastCheck, snapshots, summary };
}

function parseItemDetail(buffer, snapshotList) {
  const view = new DataView(buffer);
  let offset = 0;
  const take = (bytes) => {
    const start = offset;
    offset += bytes;
    return start;
  };
  const version = view.getUint8(take(1));
  let hasSpecificModifiers = true;
  let hasDaily = true;
  switch (version) {
    case 3:
      hasSpecificModifiers = false;
    case 4:
      hasDaily = false;
    case 5:
      break;
    default:
      throw new Error(`Unknown item detail version ${version}`);
  }
  const result = {
    version,
    snapshot: view.getUint32(take(4), true) * MS_SECOND,
    price: view.getUint32(take(4), true) * 100,
    quantity: view.getUint32(take(4), true),
    snapshots: [],
    rawSnapshots: [],
    daily: [],
  };
  for (let count = view.getUint16(take(2), true); count > 0; count -= 1) {
    take(4);
    take(4);
  }
  for (let count = view.getUint16(take(2), true); count > 0; count -= 1) {
    take(4);
    if (hasSpecificModifiers) {
      for (let mods = view.getUint8(take(1)); mods > 0; mods -= 1) {
        take(2);
        take(4);
      }
    } else {
      take(1);
    }
    for (let bonuses = view.getUint8(take(1)); bonuses > 0; bonuses -= 1) {
      take(2);
    }
  }
  const sparse = {};
  let previous;
  for (let count = view.getUint16(take(2), true); count > 0; count -= 1) {
    const snapshot = view.getUint32(take(4), true) * MS_SECOND;
    const price = view.getUint32(take(4), true) * 100;
    const quantity = view.getUint32(take(4), true);
    sparse[snapshot] = { snapshot, price, quantity };
    if (quantity === 0 && previous && price === 0) sparse[snapshot].price = previous.price;
    previous = sparse[snapshot];
  }
  result.rawSnapshots = Object.values(sparse).sort((a, b) => a.snapshot - b.snapshot);
  if (previous && snapshotList.length) {
    let fill = sparse[Number(Object.keys(sparse)[0])];
    for (const snapshot of snapshotList) {
      if (sparse[snapshot]) {
        fill = sparse[snapshot];
        result.snapshots.push(sparse[snapshot]);
      } else if (fill && fill.snapshot < snapshot) {
        result.snapshots.push({ snapshot, price: fill.price, quantity: fill.quantity });
      } else {
        result.snapshots.push({ snapshot, price: 0, quantity: 0 });
      }
    }
  }
  if (hasDaily) {
    for (let count = view.getUint16(take(2), true); count > 0; count -= 1) {
      const row = {
        snapshot: view.getUint16(take(2), true) * MS_DAY,
        price: view.getUint32(take(4), true) * 100,
        quantity: view.getUint32(take(4), true),
      };
      result.daily.push(row);
    }
  }
  return result;
}

function getMovementStats(detail) {
  const snapshots = (detail.snapshots.length ? detail.snapshots : detail.rawSnapshots).filter((row) => row.quantity > 0);
  const endTime = Math.max(detail.snapshot, snapshots.at(-1)?.snapshot ?? 0);
  const last7 = snapshots.filter((row) => row.snapshot >= endTime - 7 * MS_DAY);
  const quantities = last7.map((row) => row.quantity);
  let drops7 = 0;
  let rises7 = 0;
  let previous;
  for (const row of last7) {
    if (previous) {
      const diff = row.quantity - previous.quantity;
      if (diff < 0) drops7 += -diff;
      if (diff > 0) rises7 += diff;
    }
    previous = row;
  }
  return {
    current: detail.quantity,
    price: detail.price,
    avgQty7: Math.round(avg(quantities)),
    minQty7: quantities.length ? Math.min(...quantities) : 0,
    maxQty7: quantities.length ? Math.max(...quantities) : 0,
    drops7,
    rises7,
    points7: last7.length,
    endTime,
  };
}

function avg(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
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
  const copperPart = copper % 100;
  if (gold) return `${sign}${gold.toLocaleString("en-US")}g ${silver}s${copperPart ? ` ${copperPart}c` : ""}`;
  if (silver) return `${sign}${silver}s${copperPart ? ` ${copperPart}c` : ""}`;
  return `${sign}${copperPart}c`;
}
