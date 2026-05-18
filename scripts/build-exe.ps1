$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$version = "$($package.version).0"
$dist = Join-Path $root "dist"
$rawExe = Join-Path $dist "CraftPlanApp.raw.exe"
$finalExe = Join-Path $dist "CraftPlanApp.exe"
$icon = Join-Path $root "assets\icons\craftingbuddy-icon.ico"

New-Item -ItemType Directory -Force -Path $dist | Out-Null

if (Test-Path -LiteralPath $rawExe) {
  Remove-Item -LiteralPath $rawExe -Force
}

npx --yes @yao-pkg/pkg . --targets node20-win-x64 --output $rawExe --no-bytecode --public --fallback-to-source

npx --yes resedit-cli $rawExe $finalExe `
  --icon $icon `
  --product-name "CraftingBuddy" `
  --file-description "CraftingBuddy local WoW crafting helper" `
  --internal-name "CraftPlanApp" `
  --original-filename "CraftPlanApp.exe" `
  --product-version $version `
  --file-version $version

Remove-Item -LiteralPath $rawExe -Force
Write-Host "Built $finalExe"
