$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$iconDir = Join-Path $root "assets\icons"
$addonMediaDir = Join-Path $root "CraftPlanExporter\Media"
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
New-Item -ItemType Directory -Force -Path $addonMediaDir | Out-Null

$candidates = @(
  @{ Id = "01-gem-spark"; Name = "Gem Spark"; Accent = "#51d6a8"; Secondary = "#e4b65e" },
  @{ Id = "02-auction-orbit"; Name = "Auction Orbit"; Accent = "#62d6ff"; Secondary = "#e4b65e" },
  @{ Id = "03-cauldron-margin"; Name = "Cauldron Margin"; Accent = "#9ce871"; Secondary = "#e4b65e" },
  @{ Id = "04-craft-ledger"; Name = "Craft Ledger"; Accent = "#51d6a8"; Secondary = "#f2d087" }
)

function Convert-HexColor([string]$hex) {
  $clean = $hex.TrimStart("#")
  return [System.Drawing.Color]::FromArgb(
    255,
    [Convert]::ToInt32($clean.Substring(0, 2), 16),
    [Convert]::ToInt32($clean.Substring(2, 2), 16),
    [Convert]::ToInt32($clean.Substring(4, 2), 16)
  )
}

function New-RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-PolygonPath([System.Drawing.PointF[]]$points) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddPolygon($points)
  return $path
}

function New-IconBitmap([int]$size, [string]$variant) {
  $scale = $size / 256.0
  $bmp = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.ScaleTransform($scale, $scale)

  $bg = New-RoundedRect 10 10 236 236 46
  $bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.RectangleF]::new(0, 0, 256, 256),
    (Convert-HexColor "#07100c"),
    (Convert-HexColor "#182219"),
    45
  )
  $g.FillPath($bgBrush, $bg)
  $g.DrawPath([System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(90, 228, 182, 94), 4), $bg)

  $shadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(75, 0, 0, 0))
  $mint = Convert-HexColor "#51d6a8"
  $gold = Convert-HexColor "#e4b65e"
  $cream = Convert-HexColor "#f7efd6"
  $ink = Convert-HexColor "#07100c"

  if ($variant -eq "01-gem-spark") {
    $g.FillEllipse($shadowBrush, 49, 172, 158, 24)
    $ringPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(210, $gold), 11)
    $g.DrawEllipse($ringPen, 52, 55, 152, 152)
    $gem = New-PolygonPath @(
      [System.Drawing.PointF]::new(128, 42),
      [System.Drawing.PointF]::new(190, 108),
      [System.Drawing.PointF]::new(128, 206),
      [System.Drawing.PointF]::new(66, 108)
    )
    $g.FillPath([System.Drawing.SolidBrush]::new($mint), $gem)
    $g.FillPolygon([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(120, 255, 255, 255)), @(
      [System.Drawing.PointF]::new(128, 42),
      [System.Drawing.PointF]::new(190, 108),
      [System.Drawing.PointF]::new(128, 118)
    ))
    $g.FillPolygon([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(170, $gold)), @(
      [System.Drawing.PointF]::new(66, 108),
      [System.Drawing.PointF]::new(128, 206),
      [System.Drawing.PointF]::new(128, 118)
    ))
    $g.DrawPath([System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(220, $cream), 4), $gem)
    $g.FillPolygon([System.Drawing.SolidBrush]::new($cream), @(
      [System.Drawing.PointF]::new(193, 42),
      [System.Drawing.PointF]::new(204, 70),
      [System.Drawing.PointF]::new(232, 81),
      [System.Drawing.PointF]::new(204, 92),
      [System.Drawing.PointF]::new(193, 120),
      [System.Drawing.PointF]::new(182, 92),
      [System.Drawing.PointF]::new(154, 81),
      [System.Drawing.PointF]::new(182, 70)
    ))
  } elseif ($variant -eq "02-auction-orbit") {
    $g.FillEllipse($shadowBrush, 50, 177, 160, 22)
    $g.DrawArc([System.Drawing.Pen]::new($gold, 13), 48, 48, 160, 160, 210, 300)
    $g.DrawLine([System.Drawing.Pen]::new($gold, 13), 190, 66, 219, 63)
    $g.DrawLine([System.Drawing.Pen]::new($gold, 13), 204, 52, 219, 63)
    $g.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(35, 255, 255, 255)), 74, 74, 108, 108)
    $g.DrawLines([System.Drawing.Pen]::new((Convert-HexColor "#62d6ff"), 18), @(
      [System.Drawing.PointF]::new(76, 158),
      [System.Drawing.PointF]::new(112, 122),
      [System.Drawing.PointF]::new(136, 144),
      [System.Drawing.PointF]::new(184, 88)
    ))
    $g.FillPolygon([System.Drawing.SolidBrush]::new((Convert-HexColor "#62d6ff")), @(
      [System.Drawing.PointF]::new(184, 88),
      [System.Drawing.PointF]::new(184, 124),
      [System.Drawing.PointF]::new(216, 88)
    ))
  } elseif ($variant -eq "03-cauldron-margin") {
    $g.FillEllipse($shadowBrush, 49, 185, 158, 22)
    $g.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 13, 22, 17)), 54, 76, 148, 124)
    $g.DrawEllipse([System.Drawing.Pen]::new($gold, 9), 54, 76, 148, 124)
    $g.FillEllipse([System.Drawing.SolidBrush]::new((Convert-HexColor "#9ce871")), 77, 83, 102, 48)
    $g.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(140, $mint)), 91, 93, 28, 18)
    $g.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(155, $cream)), 132, 88, 22, 14)
    $g.DrawLine([System.Drawing.Pen]::new($gold, 9), 80, 184, 60, 216)
    $g.DrawLine([System.Drawing.Pen]::new($gold, 9), 176, 184, 196, 216)
    $g.FillEllipse([System.Drawing.SolidBrush]::new($gold), 163, 144, 46, 46)
    $g.DrawString("g", [System.Drawing.Font]::new("Georgia", 26, [System.Drawing.FontStyle]::Bold), [System.Drawing.SolidBrush]::new($ink), 176, 145)
  } else {
    $g.FillEllipse($shadowBrush, 49, 181, 158, 22)
    $paper = New-RoundedRect 57 51 142 160 20
    $g.FillPath([System.Drawing.SolidBrush]::new($cream), $paper)
    $g.DrawPath([System.Drawing.Pen]::new($gold, 7), $paper)
    $g.DrawLine([System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(150, 48, 53, 42), 7), 83, 91, 172, 91)
    $g.DrawLine([System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(150, 48, 53, 42), 7), 83, 120, 158, 120)
    $g.DrawLine([System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(150, 48, 53, 42), 7), 83, 149, 172, 149)
    $gem = New-PolygonPath @(
      [System.Drawing.PointF]::new(165, 123),
      [System.Drawing.PointF]::new(213, 159),
      [System.Drawing.PointF]::new(173, 218),
      [System.Drawing.PointF]::new(125, 162)
    )
    $g.FillPath([System.Drawing.SolidBrush]::new($mint), $gem)
    $g.DrawPath([System.Drawing.Pen]::new($ink, 6), $gem)
  }

  $g.Dispose()
  return $bmp
}

function Save-Png([string]$variant, [string]$path, [int]$size) {
  $bmp = New-IconBitmap $size $variant
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

function Save-Ico([string]$variant, [string]$path) {
  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $images = @()
  foreach ($size in $sizes) {
    $bmp = New-IconBitmap $size $variant
    $stream = [System.IO.MemoryStream]::new()
    $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $images += [pscustomobject]@{ Size = $size; Bytes = $stream.ToArray() }
    $stream.Dispose()
    $bmp.Dispose()
  }

  $fs = [System.IO.File]::Create($path)
  $bw = [System.IO.BinaryWriter]::new($fs)
  $bw.Write([UInt16]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]$images.Count)
  $offset = 6 + ($images.Count * 16)
  foreach ($image in $images) {
    $sizeByte = if ($image.Size -eq 256) { 0 } else { $image.Size }
    $bw.Write([byte]$sizeByte)
    $bw.Write([byte]$sizeByte)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$image.Bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $image.Bytes.Length
  }
  foreach ($image in $images) {
    $bw.Write($image.Bytes)
  }
  $bw.Dispose()
  $fs.Dispose()
}

function Save-Tga([string]$variant, [string]$path, [int]$size) {
  $bmp = New-IconBitmap $size $variant
  $fs = [System.IO.File]::Create($path)
  $bw = [System.IO.BinaryWriter]::new($fs)

  $bw.Write([byte]0)      # ID length
  $bw.Write([byte]0)      # no color map
  $bw.Write([byte]2)      # uncompressed true-color image
  $bw.Write([byte[]]@(0, 0, 0, 0, 0))
  $bw.Write([UInt16]0)    # x origin
  $bw.Write([UInt16]0)    # y origin
  $bw.Write([UInt16]$size)
  $bw.Write([UInt16]$size)
  $bw.Write([byte]32)     # BGRA
  $bw.Write([byte]40)     # 8 alpha bits, top-left origin

  for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
      $pixel = $bmp.GetPixel($x, $y)
      $bw.Write([byte]$pixel.B)
      $bw.Write([byte]$pixel.G)
      $bw.Write([byte]$pixel.R)
      $bw.Write([byte]$pixel.A)
    }
  }

  $bw.Dispose()
  $fs.Dispose()
  $bmp.Dispose()
}

function Write-Svg([string]$id, [string]$path) {
  $svg = switch ($id) {
    "01-gem-spark" {
@'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect x="10" y="10" width="236" height="236" rx="46" fill="#07100c"/>
  <path d="M10 56a46 46 0 0 1 46-46h144a46 46 0 0 1 46 46v144a46 46 0 0 1-46 46H56a46 46 0 0 1-46-46z" fill="url(#bg)"/>
  <circle cx="128" cy="131" r="76" fill="none" stroke="#e4b65e" stroke-width="11"/>
  <path d="M128 42 190 108 128 206 66 108Z" fill="#51d6a8" stroke="#f7efd6" stroke-width="4"/>
  <path d="M128 42 190 108 128 118Z" fill="#fff" opacity=".42"/>
  <path d="M66 108 128 206 128 118Z" fill="#e4b65e" opacity=".74"/>
  <path d="m193 42 11 28 28 11-28 11-11 28-11-28-28-11 28-11z" fill="#f7efd6"/>
  <defs><linearGradient id="bg" x1="28" x2="226" y1="24" y2="232"><stop stop-color="#07100c"/><stop offset="1" stop-color="#182219"/></linearGradient></defs>
</svg>
'@
    }
    "02-auction-orbit" {
@'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect x="10" y="10" width="236" height="236" rx="46" fill="#07100c"/>
  <path d="M64 176a80 80 0 1 1 126-96" fill="none" stroke="#e4b65e" stroke-width="13" stroke-linecap="round"/>
  <path d="m190 66 29-3-15-11" fill="none" stroke="#e4b65e" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="128" cy="128" r="55" fill="#fff" opacity=".09"/>
  <path d="m76 158 36-36 24 22 48-56" fill="none" stroke="#62d6ff" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M184 88v36l32-36z" fill="#62d6ff"/>
</svg>
'@
    }
    "03-cauldron-margin" {
@'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect x="10" y="10" width="236" height="236" rx="46" fill="#07100c"/>
  <ellipse cx="128" cy="138" rx="74" ry="62" fill="#0d1611" stroke="#e4b65e" stroke-width="9"/>
  <ellipse cx="128" cy="107" rx="51" ry="24" fill="#9ce871"/>
  <circle cx="104" cy="102" r="12" fill="#51d6a8" opacity=".75"/>
  <circle cx="144" cy="98" r="10" fill="#f7efd6" opacity=".8"/>
  <path d="m80 184-20 32m116-32 20 32" stroke="#e4b65e" stroke-width="9" stroke-linecap="round"/>
  <circle cx="186" cy="167" r="23" fill="#e4b65e"/>
  <text x="176" y="178" font-size="34" font-family="Georgia,serif" font-weight="700" fill="#07100c">g</text>
</svg>
'@
    }
    default {
@'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect x="10" y="10" width="236" height="236" rx="46" fill="#07100c"/>
  <rect x="57" y="51" width="142" height="160" rx="20" fill="#f7efd6" stroke="#e4b65e" stroke-width="7"/>
  <path d="M83 91h89M83 120h75M83 149h89" stroke="#30352a" stroke-width="7" stroke-linecap="round" opacity=".65"/>
  <path d="m165 123 48 36-40 59-48-56z" fill="#51d6a8" stroke="#07100c" stroke-width="6"/>
</svg>
'@
    }
  }
  Set-Content -Path $path -Value $svg -Encoding UTF8
}

foreach ($candidate in $candidates) {
  Save-Png $candidate.Id (Join-Path $iconDir "$($candidate.Id).png") 256
  Write-Svg $candidate.Id (Join-Path $iconDir "$($candidate.Id).svg")
}

Copy-Item -LiteralPath (Join-Path $iconDir "01-gem-spark.svg") -Destination (Join-Path $iconDir "craftingbuddy-icon.svg") -Force
Save-Png "01-gem-spark" (Join-Path $iconDir "craftingbuddy-icon.png") 256
Save-Ico "01-gem-spark" (Join-Path $iconDir "craftingbuddy-icon.ico")
Save-Tga "01-gem-spark" (Join-Path $addonMediaDir "CraftingBuddyIcon.tga") 64

$preview = @"
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>CraftingBuddy Icon Candidates</title>
  <style>
    :root { color-scheme: dark; font-family: Bahnschrift, Aptos, "Segoe UI", sans-serif; background: #070907; color: #f5f0df; }
    body { margin: 0; padding: 32px; background: radial-gradient(circle at 20% 0%, rgba(81,214,168,.16), transparent 28rem), #070907; }
    h1 { margin: 0 0 10px; font-size: 34px; }
    p { margin: 0 0 28px; color: #b4b8aa; max-width: 740px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap: 18px; max-width: 980px; }
    .card { border: 1px solid rgba(255,255,255,.14); background: #111711; border-radius: 8px; padding: 18px; }
    .card.winner { border-color: #e4b65e; box-shadow: 0 0 0 1px rgba(228,182,94,.28); }
    img { width: 128px; height: 128px; image-rendering: auto; display: block; margin-bottom: 14px; }
    strong { display: block; font-size: 18px; }
    span { color: #b4b8aa; font-size: 13px; }
  </style>
</head>
<body>
  <h1>CraftingBuddy Icon Candidates</h1>
  <p>Winner: Gem Spark. It stays readable at small sizes, matches the existing mint/gold app identity, and avoids looking like a generic auction spreadsheet.</p>
  <div class="grid">
"@

foreach ($candidate in $candidates) {
  $winner = if ($candidate.Id -eq "01-gem-spark") { " winner" } else { "" }
  $preview += @"
    <div class="card$winner">
      <img src="$($candidate.Id).svg" alt="$($candidate.Name)">
      <strong>$($candidate.Name)</strong>
      <span>$($candidate.Id)</span>
    </div>
"@
}

$preview += @"
  </div>
</body>
</html>
"@

Set-Content -Path (Join-Path $iconDir "preview.html") -Value $preview -Encoding UTF8
Write-Host "Generated icon candidates in $iconDir"
