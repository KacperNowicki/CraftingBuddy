$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$version = "$($package.version).0"
$target = "node20-win-x64"
$dist = Join-Path $root "dist"
$finalExe = Join-Path $dist "CraftPlanApp.exe"
$icon = Join-Path $root "assets\icons\craftingbuddy-icon.ico"
$brandedBaseDir = Join-Path $dist "pkg-base"

function Get-PkgCacheRoot {
  if ($env:PKG_CACHE_PATH) {
    return $env:PKG_CACHE_PATH
  }
  return Join-Path ([Environment]::GetFolderPath("UserProfile")) ".pkg-cache"
}

function Get-PkgBaseBinary {
  param(
    [Parameter(Mandatory = $true)][string] $CacheRoot,
    [Parameter(Mandatory = $true)][string] $Target
  )

  if (-not (Test-Path -LiteralPath $CacheRoot)) {
    return $null
  }

  $parts = $Target -split "-"
  $nodeMajor = $parts[0] -replace "^node", ""
  $platform = $parts[1]
  $arch = $parts[2]

  return Get-ChildItem -LiteralPath $CacheRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "^fetched-v$nodeMajor\." -and $_.Name -like "*$platform-$arch*" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}

function Ensure-PkgBaseBinary {
  $cacheRoot = Get-PkgCacheRoot
  $base = Get-PkgBaseBinary -CacheRoot $cacheRoot -Target $target
  if ($base) {
    return $base
  }

  Write-Host "Fetching pkg base binary..."
  $seedExe = Join-Path $dist "CraftPlanApp.seed.exe"
  Remove-Item -LiteralPath $seedExe -Force -ErrorAction SilentlyContinue
  npx --yes @yao-pkg/pkg . --targets $target --output $seedExe --no-bytecode --public --fallback-to-source
  Remove-Item -LiteralPath $seedExe -Force -ErrorAction SilentlyContinue

  $base = Get-PkgBaseBinary -CacheRoot $cacheRoot -Target $target
  if (-not $base) {
    throw "Could not find the pkg base binary in $cacheRoot after pkg fetch."
  }
  return $base
}

function Test-PackagedExeStarts {
  param([Parameter(Mandatory = $true)][string] $ExePath)

  $portInUse = $false
  try {
    $portInUse = [bool](Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 8791 -ErrorAction SilentlyContinue)
  } catch {
    $portInUse = $false
  }

  if ($portInUse) {
    Write-Warning "Skipping packaged exe smoke test because 127.0.0.1:8791 is already in use."
    return
  }

  $stdout = Join-Path $dist "CraftPlanApp.smoke.stdout.log"
  $stderr = Join-Path $dist "CraftPlanApp.smoke.stderr.log"
  Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue

  $process = $null
  $previousNoOpen = $env:CRAFTINGBUDDY_NO_OPEN
  try {
    $env:CRAFTINGBUDDY_NO_OPEN = "1"
    $process = Start-Process -FilePath $ExePath -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    Start-Sleep -Seconds 2
    if ($process.HasExited) {
      $out = if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout -Raw } else { "" }
      $err = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw } else { "" }
      throw "Packaged exe exited during smoke test with code $($process.ExitCode).`n$out`n$err"
    }
  } finally {
    if ($process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force
      Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
    }
    if ($null -eq $previousNoOpen) {
      Remove-Item Env:\CRAFTINGBUDDY_NO_OPEN -ErrorAction SilentlyContinue
    } else {
      $env:CRAFTINGBUDDY_NO_OPEN = $previousNoOpen
    }
  }

  Start-Sleep -Milliseconds 200
  Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
  Write-Host "Packaged exe smoke test passed."
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null
New-Item -ItemType Directory -Force -Path $brandedBaseDir | Out-Null

Remove-Item -LiteralPath $finalExe -Force -ErrorAction SilentlyContinue

$baseExe = Ensure-PkgBaseBinary
$brandedBase = Join-Path $brandedBaseDir "$(Split-Path $baseExe -Leaf).branded.exe"

npx --yes resedit-cli $baseExe $brandedBase `
  --icon $icon `
  --product-name "CraftingBuddy" `
  --file-description "CraftingBuddy local WoW crafting helper" `
  --internal-name "CraftPlanApp" `
  --original-filename "CraftPlanApp.exe" `
  --product-version $version `
  --file-version $version

$previousPkgNodePath = $env:PKG_NODE_PATH
try {
  $env:PKG_NODE_PATH = $brandedBase
  npx --yes @yao-pkg/pkg . --targets $target --output $finalExe --no-bytecode --public --fallback-to-source
} finally {
  if ($null -eq $previousPkgNodePath) {
    Remove-Item Env:\PKG_NODE_PATH -ErrorAction SilentlyContinue
  } else {
    $env:PKG_NODE_PATH = $previousPkgNodePath
  }
}

Test-PackagedExeStarts -ExePath $finalExe
Write-Host "Built $finalExe"
