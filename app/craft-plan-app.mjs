import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = process.pkg ? path.dirname(process.execPath) : ROOT;
const ADDON_SOURCE = path.join(ROOT, "CraftPlanExporter");
const CONFIG_DIR = APP_DIR;
const CONFIG_PATH = path.join(CONFIG_DIR, "craft-plan-app.config.json");
const OUTPUT_DIR = path.join(APP_DIR, "report");
const DATA_DIR = path.join(APP_DIR, "data");
const DEFAULT_PORT = 8791;
const DEFAULT_CATALOG = path.join(ROOT, "data", "undermine-silvermoon-eu-crafting.json");
const REPORT_HTML = path.join(OUTPUT_DIR, "craft-plan-report.html");
const REPORT_JSON = path.join(OUTPUT_DIR, "craft-plan-report.json");

let config = await loadConfig();
let lastJob = null;
let scriptModulesPromise = null;
let runtimeScriptDirPromise = null;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    if (request.method === "OPTIONS") return sendEmpty(response);
    if (request.method === "GET" && url.pathname === "/") return sendHtml(response, renderApp());
    if (request.method === "GET" && url.pathname === "/report") return sendFile(response, REPORT_HTML, "text/html; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/api/status") return sendJson(response, await getStatus());
    if (request.method === "POST" && url.pathname === "/api/choose-wow-folder") return sendJson(response, await chooseWowFolder());
    if (request.method === "POST" && url.pathname === "/api/set-wow-folder") return sendJson(response, await setWowFolder(await readJson(request)));
    if (request.method === "POST" && url.pathname === "/api/set-undermine-key") return sendJson(response, await setUndermineKey(await readJson(request)));
    if (request.method === "POST" && url.pathname === "/api/install-addon") return sendJson(response, await installAddon());
    if (request.method === "POST" && (url.pathname === "/api/generate" || url.pathname === "/regenerate")) {
      return sendJson(response, await generateReport());
    }
    if (request.method === "POST" && url.pathname === "/api/open-report") {
      openUrl(`http://127.0.0.1:${server.address().port}/report`);
      return sendJson(response, { ok: true });
    }
    sendJson(response, { ok: false, error: "Not found" }, 404);
  } catch (error) {
    sendJson(response, { ok: false, error: error.message || String(error) }, 500);
  }
});

server.listen(DEFAULT_PORT, "127.0.0.1", () => {
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  console.log(`CraftPlan app running at ${url}`);
  openUrl(url);
});

async function loadConfig() {
  const defaultWow = findDefaultWowRoot();
  let loaded;
  try {
    loaded = { wowRoot: defaultWow, ...JSON.parse(await readFile(CONFIG_PATH, "utf8")) };
  } catch {
    loaded = { wowRoot: defaultWow };
  }
  return await migrateConfigSecrets(loaded);
}

async function saveConfig() {
  const saved = { ...config };
  delete saved.undermineApiKey;
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(saved, null, 2), "utf8");
}

async function migrateConfigSecrets(loaded) {
  if (loaded.undermineApiKey && !loaded.undermineApiKeyProtected) {
    try {
      loaded.undermineApiKeyProtected = await protectSecret(String(loaded.undermineApiKey));
      delete loaded.undermineApiKey;
      await mkdir(CONFIG_DIR, { recursive: true });
      await writeFile(CONFIG_PATH, JSON.stringify(loaded, null, 2), "utf8");
    } catch {
      // Keep the old value in memory so this launch still works, but saveConfig will not write it back.
    }
  }
  return loaded;
}

function hasUndermineApiKey() {
  return Boolean(config.undermineApiKeyProtected || config.undermineApiKey);
}

async function getUndermineApiKey() {
  if (config.undermineApiKeyProtected) return await unprotectSecret(config.undermineApiKeyProtected);
  return String(config.undermineApiKey || "").trim();
}

function findDefaultWowRoot() {
  const candidates = [
    "C:\\Program Files (x86)\\World of Warcraft",
    "C:\\Program Files\\World of Warcraft",
    path.join(process.env.PUBLIC || "C:\\Users\\Public", "Games", "World of Warcraft"),
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "_retail_"))) || "";
}

function normalizeWowRoot(input) {
  let selected = path.resolve(String(input || "").trim());
  if (!selected) return "";
  if (path.basename(selected).toLowerCase() === "_retail_") selected = path.dirname(selected);
  if (existsSync(path.join(selected, "_retail_"))) return selected;
  if (existsSync(path.join(selected, "Interface", "AddOns")) && path.basename(selected).toLowerCase() === "_retail_") {
    return path.dirname(selected);
  }
  return selected;
}

function retailPath() {
  return config.wowRoot ? path.join(config.wowRoot, "_retail_") : "";
}

function accountRoot() {
  return retailPath() ? path.join(retailPath(), "WTF", "Account") : "";
}

async function getStatus() {
  const wowRoot = config.wowRoot || "";
  const retail = retailPath();
  const addonPath = retail ? path.join(retail, "Interface", "AddOns", "CraftPlanExporter") : "";
  const addonInstalled = addonPath ? await exists(addonPath) : false;
  const exportSource = await findCraftPlanSavedVariables().catch(() => null);
  const exportInfo = exportSource ? await readExportInfo(exportSource).catch((error) => ({ path: exportSource, error: error.message })) : null;
  const reportExists = await exists(REPORT_HTML);
  return {
    ok: true,
    config: {
      ...config,
      undermineApiKey: undefined,
      undermineApiKeyProtected: undefined,
      hasUndermineApiKey: hasUndermineApiKey(),
    },
    wowRoot,
    retail,
    accountRoot: accountRoot(),
    addonPath,
    addonInstalled,
    exportInfo,
    reportExists,
    lastJob,
  };
}

async function chooseWowFolder() {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Select your World of Warcraft folder'",
    "$dialog.ShowNewFolderButton = $false",
    config.wowRoot ? `$dialog.SelectedPath = ${psQuote(config.wowRoot)}` : "",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
  ].filter(Boolean).join("; ");
  const selected = (await execFileText("powershell.exe", ["-NoProfile", "-STA", "-Command", script])).trim();
  if (!selected) return { ok: false, cancelled: true };
  return setWowFolder({ wowRoot: selected });
}

async function setWowFolder(body) {
  const wowRoot = normalizeWowRoot(body?.wowRoot);
  if (!wowRoot || !existsSync(path.join(wowRoot, "_retail_"))) {
    throw new Error("That does not look like a World of Warcraft folder with _retail_ inside it.");
  }
  config.wowRoot = wowRoot;
  await saveConfig();
  return { ok: true, wowRoot };
}

async function setUndermineKey(body) {
  const key = String(body?.apiKey || "").trim().replace(/^ApiKey\s+/i, "");
  if (key) {
    config.undermineApiKeyProtected = await protectSecret(key);
    delete config.undermineApiKey;
  } else {
    delete config.undermineApiKey;
    delete config.undermineApiKeyProtected;
  }
  await saveConfig();
  return { ok: true, hasUndermineApiKey: hasUndermineApiKey() };
}

async function installAddon() {
  if (!config.wowRoot) throw new Error("Choose your World of Warcraft folder first.");
  const target = path.join(retailPath(), "Interface", "AddOns", "CraftPlanExporter");
  await mkdir(target, { recursive: true });
  for (const fileName of ["CraftPlanExporter.toc", "Main.lua"]) {
    await writeFile(path.join(target, fileName), await readFile(path.join(ADDON_SOURCE, fileName), "utf8"), "utf8");
  }
  return { ok: true, addonPath: target };
}

async function generateReport() {
  if (lastJob?.running) return { ok: false, error: "Generation is already running." };
  lastJob = { running: true, startedAt: new Date().toISOString(), message: "Starting..." };
  try {
    const { scrapeGoblin, scrapeUndermineApi, buildCraftPlan } = await loadScriptModules();
    if (!config.wowRoot) throw new Error("Choose your World of Warcraft folder first.");
    const exportPath = await findCraftPlanSavedVariables();
    const exportInfo = await readExportInfo(exportPath);
    const realm = resolveRealm(exportInfo);
    const undermineApiKey = await getUndermineApiKey();
    const useUndermineApi = Boolean(undermineApiKey);
    const marketSource = useUndermineApi ? "Undermine API" : "Goblin Exchange";
    lastJob.message = `Fetching ${realm.realmSlug} ${realm.region.toUpperCase()} ${marketSource} market data...`;
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(OUTPUT_DIR, { recursive: true });
    const snapshotOut = path.join(DATA_DIR, `${useUndermineApi ? "undermine-api" : "goblin"}-${realm.realmSlug}-${realm.region}-crafting.json`);
    if (useUndermineApi) {
      await scrapeUndermineApi({
        region: realm.region,
        realm: realm.realmSlug,
        "realm-label": realm.label,
        catalog: DEFAULT_CATALOG,
        out: snapshotOut,
        limit: 80,
        "history-limit": 70,
        apiKey: undermineApiKey,
      });
    } else {
      await scrapeGoblin({
        region: realm.region,
        realm: realm.realmSlug,
        "realm-label": realm.label,
        catalog: DEFAULT_CATALOG,
        out: snapshotOut,
        limit: 80,
        "history-limit": 70,
      });
    }
    lastJob.message = "Building craft report...";
    const result = await buildCraftPlan({
      snapshot: snapshotOut,
      profit: exportPath,
      out: REPORT_HTML,
      json: REPORT_JSON,
      "max-items": 80,
    });
    lastJob = {
      running: false,
      ok: true,
      finishedAt: new Date().toISOString(),
      realm,
      marketSource,
      reportUrl: "/report",
      matchedProfitRecords: result.report.summary.matchedProfitRecords,
      snapshotItems: result.report.summary.snapshotItems,
    };
    return { ok: true, ...lastJob };
  } catch (error) {
    lastJob = { running: false, ok: false, finishedAt: new Date().toISOString(), error: error.message || String(error) };
    throw error;
  }
}

async function findCraftPlanSavedVariables() {
  const root = accountRoot();
  if (!root) throw new Error("Choose your World of Warcraft folder first.");
  const candidates = [];
  const accounts = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of accounts) {
    if (!entry.isDirectory() || entry.name === "SavedVariables") continue;
    const filePath = path.join(root, entry.name, "SavedVariables", "CraftPlanExporter.lua");
    if (await exists(filePath)) {
      const fileStat = await stat(filePath);
      candidates.push({ path: filePath, mtimeMs: fileStat.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates.length) {
    throw new Error("I cannot find CraftPlanExporter.lua yet. Install the addon, log into a character, then /reload once.");
  }
  return candidates[0].path;
}

async function readExportInfo(filePath) {
  const { loadProfitSource } = await loadScriptModules();
  const source = await loadProfitSource(filePath);
  const db = source.db || {};
  const recordsByItemID = db.recordsByItemID || {};
  const recordsByRecipeID = db.recordsByRecipeID || {};
  return {
    path: filePath,
    meta: db.meta || null,
    recordsByItemID: Object.keys(recordsByItemID).length,
    recordsByRecipeID: Object.keys(recordsByRecipeID).length,
    lastExportAt: db.lastExportAt || 0,
  };
}

async function loadScriptModules() {
  const runtimeScripts = await ensureRuntimeScripts();
  scriptModulesPromise ??= Promise.all([
    import(pathToFileURL(path.join(runtimeScripts, "scrape-goblin.mjs")).href),
    import(pathToFileURL(path.join(runtimeScripts, "scrape-undermine-api.mjs")).href),
    import(pathToFileURL(path.join(runtimeScripts, "build-craft-plan.mjs")).href),
  ]).then(([goblin, undermineApi, builder]) => ({
    scrapeGoblin: goblin.scrapeGoblin,
    scrapeUndermineApi: undermineApi.scrapeUndermineApi,
    buildCraftPlan: builder.buildCraftPlan,
    loadProfitSource: builder.loadProfitSource,
  }));
  return scriptModulesPromise;
}

async function ensureRuntimeScripts() {
  runtimeScriptDirPromise ??= (async () => {
    const target = path.join(CONFIG_DIR, "runtime", "scripts");
    await mkdir(target, { recursive: true });
    for (const name of ["scrape-goblin.mjs", "scrape-undermine-api.mjs", "build-craft-plan.mjs"]) {
      const source = path.join(ROOT, "scripts", name);
      const destination = path.join(target, name);
      await writeFile(destination, await readFile(source, "utf8"), "utf8");
    }
    return target;
  })();
  return runtimeScriptDirPromise;
}

function resolveRealm(exportInfo) {
  const meta = exportInfo?.meta || {};
  const region = normalizeRegion(meta.region);
  const realmSlug = normalizeRealmSlug(meta.realmName || meta.normalizedRealmName);
  if (!region || !realmSlug) {
    throw new Error("The addon has not saved realm metadata yet. Log into the character with CraftPlan Exporter enabled, then /reload.");
  }
  return {
    region,
    realmSlug,
    label: `${meta.realmName || titleCaseRealm(realmSlug)} ${region.toUpperCase()}`,
    playerName: meta.playerName || "",
    faction: meta.faction || "",
  };
}

function normalizeRegion(value) {
  const region = String(value || "").trim().toLowerCase();
  return ["us", "eu", "kr", "tw", "cn"].includes(region) ? region : "";
}

function normalizeRealmSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleCaseRealm(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message || "").trim()));
      else resolve(stdout);
    });
  });
}

function execFileStdin(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code) reject(new Error((err || `Command exited with ${code}`).trim()));
      else resolve(out);
    });
    child.stdin.end(input);
  });
}

async function protectSecret(secret) {
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$plain = [Console]::In.ReadToEnd()",
    "$bytes = [Text.Encoding]::UTF8.GetBytes($plain)",
    "$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($protected))",
  ].join("; ");
  return (await execPowerShellWithStdin(script, secret)).trim();
}

async function unprotectSecret(protectedText) {
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$encoded = [Console]::In.ReadToEnd().Trim()",
    "$protected = [Convert]::FromBase64String($encoded)",
    "$bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))",
  ].join("; ");
  return (await execPowerShellWithStdin(script, protectedText)).trim();
}

function execPowerShellWithStdin(script, input) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return execFileStdin("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], input);
}

function openUrl(url) {
  spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function responseHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
    ...extra,
  };
}

function sendEmpty(response, status = 204) {
  response.writeHead(status, responseHeaders());
  response.end();
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, responseHeaders({ "content-type": "application/json; charset=utf-8" }));
  response.end(JSON.stringify(payload));
}

function sendHtml(response, html) {
  response.writeHead(200, responseHeaders({ "content-type": "text/html; charset=utf-8" }));
  response.end(html);
}

async function sendFile(response, filePath, contentType) {
  if (!(await exists(filePath))) return sendJson(response, { ok: false, error: "Report has not been generated yet." }, 404);
  response.writeHead(200, responseHeaders({ "content-type": contentType }));
  response.end(await readFile(filePath));
}

function renderApp() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CraftingBuddy</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23060807'/%3E%3Cpath d='M18 38 32 12l14 26-14 14z' fill='%234ed0a4'/%3E%3Cpath d='M25 38h14l-7 9z' fill='%23e0b35a'/%3E%3C/svg%3E">
  <style>
    :root {
      color-scheme: dark;
      --bg: #060807;
      --surface: #101411;
      --surface-2: #171d19;
      --text: #f3efe2;
      --muted: #aeb5a8;
      --line: rgba(255,255,255,.12);
      --green: #4ed0a4;
      --gold: #e0b35a;
      --red: #ff7f73;
      --blue: #8db7ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(120deg, rgba(78,208,164,.12), transparent 34%),
        linear-gradient(260deg, rgba(224,179,90,.12), transparent 42%),
        var(--bg);
      color: var(--text);
      font-family: Bahnschrift, Aptos, "Segoe UI", sans-serif;
    }
    main { max-width: 1120px; margin: 0 auto; padding: 36px 24px 44px; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-end; margin-bottom: 26px; }
    h1 { margin: 0; font-size: clamp(32px, 5vw, 58px); line-height: .95; letter-spacing: 0; }
    .sub { margin: 10px 0 0; color: var(--muted); max-width: 620px; font-size: 16px; line-height: 1.45; }
    .status-pill { border: 1px solid var(--line); border-radius: 999px; padding: 10px 14px; color: var(--muted); background: rgba(255,255,255,.04); white-space: nowrap; }
    .next-card {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: center;
      margin-bottom: 18px;
      padding: 18px;
      border: 1px solid rgba(78,208,164,.36);
      border-radius: 9px;
      background: linear-gradient(180deg, rgba(78,208,164,.13), rgba(16,20,17,.88));
      box-shadow: 0 18px 60px rgba(0,0,0,.32);
    }
    .next-card h2 { font-size: 24px; }
    .next-card p { max-width: 760px; }
    .next-badge {
      border: 1px solid rgba(78,208,164,.42);
      border-radius: 999px;
      padding: 8px 12px;
      color: var(--green);
      font-weight: 900;
      white-space: nowrap;
    }
    .layout { display: grid; grid-template-columns: 1.05fr .95fr; gap: 18px; }
    section, aside { background: rgba(16,20,17,.88); border: 1px solid var(--line); border-radius: 8px; padding: 18px; box-shadow: 0 18px 60px rgba(0,0,0,.32); }
    .step { display: grid; grid-template-columns: 40px 1fr auto; gap: 14px; align-items: center; padding: 16px 0; border-top: 1px solid var(--line); }
    .step:first-child { border-top: 0; padding-top: 0; }
    .num { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); color: var(--gold); font-weight: 900; }
    .step.done .num { color: #07100d; background: var(--green); }
    .step.active .num { color: #07100d; background: var(--gold); }
    .step small { display: block; margin-top: 7px; color: var(--blue); font-weight: 800; }
    h2, h3 { margin: 0; letter-spacing: 0; }
    h2 { font-size: 20px; }
    h3 { font-size: 16px; }
    p { margin: 6px 0 0; color: var(--muted); line-height: 1.42; }
    a { color: var(--green); font-weight: 800; text-decoration: none; }
    a:hover { text-decoration: underline; }
    button {
      border: 0;
      border-radius: 7px;
      padding: 10px 14px;
      min-height: 38px;
      background: var(--green);
      color: #06100c;
      font-weight: 900;
      cursor: pointer;
      font-family: inherit;
    }
    button.secondary { background: #252d27; color: var(--text); border: 1px solid var(--line); }
    button.gold { background: var(--gold); color: #141006; }
    button:disabled { opacity: .45; cursor: wait; }
    input {
      width: 100%;
      min-height: 38px;
      border-radius: 7px;
      border: 1px solid var(--line);
      background: #080b09;
      color: var(--text);
      padding: 9px 10px;
      font-family: Consolas, "Cascadia Mono", monospace;
    }
    .path-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: 10px; }
    .meta { display: grid; gap: 10px; margin-top: 14px; }
    .metric { display: grid; grid-template-columns: 140px 1fr; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); color: var(--muted); }
    .metric:first-child { border-top: 0; }
    .metric strong { color: var(--text); font-weight: 800; overflow-wrap: anywhere; }
    .log { min-height: 92px; margin-top: 14px; padding: 12px; border-radius: 7px; background: #090c0a; color: var(--muted); border: 1px solid var(--line); white-space: pre-wrap; }
    .warning { color: var(--gold); }
    .bad { color: var(--red); }
    .good { color: var(--green); }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    .key-box { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
    .key-box p { font-size: 13px; }
    .help-box {
      margin-top: 16px;
      padding: 14px;
      border: 1px solid rgba(224,179,90,.34);
      border-radius: 8px;
      background: rgba(224,179,90,.06);
    }
    .help-box ul { margin: 8px 0 0; padding-left: 18px; color: var(--muted); }
    .help-box li { margin: 4px 0; }
    @media (max-width: 860px) {
      header, .layout, .step, .next-card { grid-template-columns: 1fr; }
      header { align-items: stretch; }
      .step { gap: 10px; }
      .path-row { grid-template-columns: 1fr; }
      .status-pill { white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>CraftingBuddy</h1>
        <p class="sub">A local checklist that turns your CraftSim scan, Auctionator prices, and market movement into a simple craft plan.</p>
      </div>
      <div id="top-status" class="status-pill">Checking...</div>
    </header>

    <div class="next-card">
      <div>
        <h2 id="next-title">Checking your setup...</h2>
        <p id="next-body">CraftingBuddy is reading the local app state.</p>
      </div>
      <div class="next-badge" id="next-badge">Next step</div>
    </div>

    <div class="layout">
      <section>
        <div id="step-wow" class="step">
          <div class="num">1</div>
          <div>
            <h2>World of Warcraft folder</h2>
            <p>Select the folder that contains <b>_retail_</b>.</p>
            <small id="hint-wow"></small>
            <div class="path-row">
              <input id="wow-path" spellcheck="false">
              <button id="choose-wow" class="secondary">Choose</button>
            </div>
          </div>
          <button id="save-wow">Save</button>
        </div>

        <div id="step-addon" class="step">
          <div class="num">2</div>
          <div>
            <h2>Install addon</h2>
            <p>Copies CraftPlan Exporter into your retail AddOns folder. CraftSim stays untouched.</p>
            <small id="hint-addon"></small>
          </div>
          <button id="install-addon">Install</button>
        </div>

        <div id="step-game" class="step">
          <div class="num">3</div>
          <div>
            <h2>Scan in WoW</h2>
            <p>Open the Auction House, run an Auctionator scan, open CraftPlan Exporter from the minimap, press <b>Scan all + variants</b>, then type <b>/reload</b>.</p>
            <small id="hint-game"></small>
          </div>
          <button id="refresh-status" class="secondary">I reloaded</button>
        </div>

        <div id="step-report" class="step">
          <div class="num">4</div>
          <div>
            <h2>Generate report</h2>
            <p>The app reads your exported CraftSim/CPE data, detects your realm, then uses Undermine API when a key is saved or Goblin Exchange as fallback.</p>
            <small id="hint-report"></small>
          </div>
          <button id="generate-report" class="gold">Generate</button>
        </div>
      </section>

      <aside>
        <h2>Current state</h2>
        <div class="meta" id="meta"></div>
        <div class="key-box">
          <h3>Undermine API</h3>
          <p>Optional. Log in on Undermine with Patreon, open the API page, create or copy your key, then paste it here. The saved file keeps a Windows user-protected blob, not the raw key.</p>
          <p><a href="https://undermine.exchange/api.html" target="_blank" rel="noreferrer">Open Undermine API page</a></p>
          <div class="path-row">
            <input id="undermine-key" type="password" spellcheck="false" placeholder="ApiKey ...">
            <button id="save-undermine-key" class="secondary">Save key</button>
          </div>
        </div>
        <div class="actions">
          <button id="open-report" class="secondary">Open report</button>
          <button id="refresh-status-2" class="secondary">Refresh</button>
        </div>
        <div class="help-box">
          <h3>In-game checklist</h3>
          <ul>
            <li>Run an Auctionator scan at the Auction House.</li>
            <li>Press <b>Scan all + variants</b> in CraftPlan Exporter.</li>
            <li>Type <b>/reload</b> before generating the report.</li>
          </ul>
        </div>
        <div id="log" class="log">Ready.</div>
      </aside>
    </div>
  </main>
  <script>
    const $ = (selector) => document.querySelector(selector);
    let state = null;

    async function api(path, body) {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) throw new Error(payload.error || "Request failed");
      return payload;
    }

    async function refresh() {
      state = await api("/api/status");
      render();
    }

    function render() {
      $("#wow-path").value = state.wowRoot || "";
      $("#top-status").textContent = state.exportInfo?.meta
        ? "Detected " + (state.exportInfo.meta.realmName || state.exportInfo.meta.normalizedRealmName) + " " + String(state.exportInfo.meta.region || "").toUpperCase()
        : state.addonInstalled ? "Addon installed; waiting for /reload export" : "Setup needed";

      const hasWow = Boolean(state.wowRoot && state.retail);
      const hasAddon = Boolean(state.addonInstalled);
      const hasExport = Boolean(state.exportInfo && state.exportInfo.recordsByItemID > 0);
      const hasReport = Boolean(state.reportExists);
      const next = getNextAction({ hasWow, hasAddon, hasExport, hasReport });

      $("#next-title").textContent = next.title;
      $("#next-body").textContent = next.body;
      $("#next-badge").textContent = next.badge;

      setStepState("#step-wow", hasWow, next.step === "wow");
      setStepState("#step-addon", hasAddon, next.step === "addon");
      setStepState("#step-game", hasExport, next.step === "game");
      setStepState("#step-report", hasReport, next.step === "report");

      $("#hint-wow").textContent = hasWow ? "Ready: " + state.wowRoot : "Choose the folder named World of Warcraft, not _retail_ itself.";
      $("#hint-addon").textContent = hasAddon ? "Ready: addon is installed." : hasWow ? "Next: install CraftPlan Exporter." : "Pick the WoW folder first.";
      $("#hint-game").textContent = hasExport ? "Ready: " + infoLabel(state.exportInfo) : hasAddon ? "Next: scan in WoW, then /reload." : "Install the addon first.";
      $("#hint-report").textContent = hasReport ? "Ready: report exists. Generate again after every new scan." : hasExport ? "Next: generate the report." : "Scan in WoW first.";

      const info = state.exportInfo || {};
      const meta = info.meta || {};
      $("#undermine-key").placeholder = state.config?.hasUndermineApiKey ? "Undermine API key saved" : "ApiKey ...";
      $("#meta").innerHTML = [
        metric("WoW folder", state.wowRoot || "not selected"),
        metric("Addon", state.addonInstalled ? "installed" : "not installed"),
        metric("Market source", state.config?.hasUndermineApiKey ? "Undermine API" : "Goblin fallback"),
        metric("Export file", info.path || "not found yet"),
        metric("Player", meta.playerName || "unknown"),
        metric("Realm", meta.realmName ? meta.realmName + " " + String(meta.region || "").toUpperCase() : "unknown"),
        metric("Profit items", info.recordsByItemID == null ? "0" : String(info.recordsByItemID)),
        metric("Recipes", info.recordsByRecipeID == null ? "0" : String(info.recordsByRecipeID)),
      ].join("");

      if (state.lastJob?.running) setLog(state.lastJob.message || "Working...");
      else if (state.lastJob?.ok) setLog("Report generated for " + state.lastJob.realm.label + " via " + (state.lastJob.marketSource || "market data") + ". Matched " + state.lastJob.matchedProfitRecords + "/" + state.lastJob.snapshotItems + " profit rows.");
      else if (state.lastJob?.error) setLog(state.lastJob.error, "bad");
    }

    function getNextAction(status) {
      if (!status.hasWow) {
        return {
          step: "wow",
          badge: "Step 1",
          title: "Choose your World of Warcraft folder",
          body: "CraftingBuddy needs the folder that contains _retail_ so it can install the addon and read your scan after /reload.",
        };
      }
      if (!status.hasAddon) {
        return {
          step: "addon",
          badge: "Step 2",
          title: "Install CraftPlan Exporter",
          body: "This copies the small companion addon into WoW. CraftSim and Auctionator are left alone.",
        };
      }
      if (!status.hasExport) {
        return {
          step: "game",
          badge: "Step 3",
          title: "Scan in WoW, then /reload",
          body: "At the Auction House run Auctionator scan, open CraftPlan Exporter from the minimap, press Scan all + variants, then type /reload.",
        };
      }
      if (!status.hasReport) {
        return {
          step: "report",
          badge: "Step 4",
          title: "Generate your craft report",
          body: "CraftingBuddy has your scan. Generate the report to see what to craft, how many, and which reagent qualities to buy.",
        };
      }
      return {
        step: "done",
        badge: "Ready",
        title: "Report ready",
        body: "Open the report, add mats from the best crafts, paste the shopping list into CPE, and craft from the top down. Regenerate after every new WoW scan.",
      };
    }

    function setStepState(selector, done, active) {
      const element = $(selector);
      element.classList.toggle("done", Boolean(done));
      element.classList.toggle("active", Boolean(active && !done));
    }

    function infoLabel(info) {
      const meta = info?.meta || {};
      const realm = meta.realmName || meta.normalizedRealmName || "realm found";
      const records = info?.recordsByItemID == null ? "0" : String(info.recordsByItemID);
      return realm + ", " + records + " profit items saved.";
    }

    function metric(label, value) {
      return '<div class="metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
    }

    function setLog(text, kind = "") {
      $("#log").className = "log " + kind;
      $("#log").textContent = text;
    }

    function setBusy(active) {
      for (const button of document.querySelectorAll("button")) button.disabled = active;
    }

    $("#choose-wow").addEventListener("click", async () => {
      setBusy(true);
      try { await api("/api/choose-wow-folder", {}); await refresh(); setLog("WoW folder selected.", "good"); }
      catch (error) { setLog(error.message, "bad"); }
      finally { setBusy(false); }
    });

    $("#save-wow").addEventListener("click", async () => {
      setBusy(true);
      try { await api("/api/set-wow-folder", { wowRoot: $("#wow-path").value }); await refresh(); setLog("WoW folder saved.", "good"); }
      catch (error) { setLog(error.message, "bad"); }
      finally { setBusy(false); }
    });

    $("#save-undermine-key").addEventListener("click", async () => {
      setBusy(true);
      try {
        await api("/api/set-undermine-key", { apiKey: $("#undermine-key").value });
        $("#undermine-key").value = "";
        await refresh();
        setLog(state.config?.hasUndermineApiKey ? "Undermine API key saved." : "Undermine API key cleared.", "good");
      } catch (error) {
        setLog(error.message, "bad");
      } finally {
        setBusy(false);
      }
    });

    $("#install-addon").addEventListener("click", async () => {
      setBusy(true);
      try { await api("/api/install-addon", {}); await refresh(); setLog("Addon installed. Restart or /reload WoW if it was already running.", "good"); }
      catch (error) { setLog(error.message, "bad"); }
      finally { setBusy(false); }
    });

    $("#refresh-status").addEventListener("click", refresh);
    $("#refresh-status-2").addEventListener("click", refresh);

    $("#generate-report").addEventListener("click", async () => {
      setBusy(true);
      setLog("Generating report...");
      try {
        const result = await api("/api/generate", {});
        await refresh();
        setLog("Report generated for " + result.realm.label + " via " + (result.marketSource || "market data") + ".", "good");
        window.open("/report", "_blank");
      } catch (error) {
        setLog(error.message, "bad");
      } finally {
        setBusy(false);
      }
    });

    $("#open-report").addEventListener("click", async () => {
      try { await api("/api/open-report", {}); }
      catch (error) { setLog(error.message, "bad"); }
    });

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }

    refresh().catch(error => setLog(error.message, "bad"));
  </script>
</body>
</html>`;
}
