# Builds the Chrome Web Store package: dist/kinship-<version>.zip
# Usage (from this folder):  powershell -ExecutionPolicy Bypass -File .\build.ps1
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$root = $PSScriptRoot
$runtime = @("manifest.json", "background.js", "app.html", "app.css", "app.js", "popup.html", "popup.css", "popup.js", "lib\*.js", "icons\*.png")

# ---- manifest checks ----
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$problems = @()
if ($manifest.manifest_version -ne 3) { $problems += "manifest_version must be 3" }
if ($manifest.version -notmatch '^\d+(\.\d+){0,3}$') { $problems += "version '$($manifest.version)' is not a valid Chrome version" }
if ($manifest.name.Length -gt 75) { $problems += "name longer than 75 chars" }
if ($manifest.description.Length -gt 132) { $problems += "description is $($manifest.description.Length) chars (max 132)" }
# Mozilla marks: never as/at the start of the name; only descriptively after the brand
# ("Kinship - works with Firefox Sync", "... for Firefox"). "Mozilla" never.
$nm = $manifest.name
if ($nm -match '^\s*(Firefox|Mozilla)') { $problems += "name starts with a Mozilla trademark" }
if ($nm -match 'Mozilla') { $problems += "name contains 'Mozilla'" }
$stripped = $nm -replace '(works with|for|compatible with) Firefox( Sync)?', ''
if ($stripped -match 'Firefox') { $problems += "name uses 'Firefox' other than as 'works with / for Firefox (Sync)'" }
if ($manifest.short_name -match 'Firefox|Mozilla') { $problems += "short_name contains a Mozilla trademark" }
# Sign-in mode (lib/config.js) and the "identity" permission must agree.
$configJs = Get-Content (Join-Path $root "lib\config.js") -Raw -Encoding UTF8
$identityMode = $configJs -match 'OAUTH_REDIRECT_MODE\s*=\s*"chromiumapp"'
$hasIdentity = @($manifest.permissions) -contains "identity"
if ($identityMode -and -not $hasIdentity) { $problems += 'config uses the chromiumapp redirect: add "identity" to manifest permissions' }
if (-not $identityMode -and $hasIdentity) { $problems += '"identity" permission is unused in firefox-android mode: remove it' }
foreach ($size in "16", "32", "48", "128") {
  if (-not $manifest.icons.$size) { $problems += "missing $size px icon" }
}

# ---- collect files ----
$files = foreach ($pattern in $runtime) { Get-ChildItem (Join-Path $root $pattern) -File }
$rel = { param($f) $f.FullName.Substring($root.Length + 1).Replace("\", "/") }
$included = @{}
foreach ($f in $files) { $included[(& $rel $f)] = $f }

# Every file the manifest points at must be included.
$refs = @($manifest.background.service_worker) + @($manifest.icons.PSObject.Properties.Value) +
        @($manifest.action.default_icon.PSObject.Properties.Value) + @($manifest.action.default_popup | Where-Object { $_ })
foreach ($r in $refs) { if (-not $included.ContainsKey($r)) { $problems += "manifest references '$r', which isn't in the package" } }

# Every module import / html src/href must resolve inside the package (catches stray test imports).
foreach ($key in @($included.Keys)) {
  if ($key -notmatch '\.(js|html)$') { continue }
  $text = Get-Content $included[$key].FullName -Raw -Encoding UTF8
  $dir = [System.IO.Path]::GetDirectoryName($key).Replace("\", "/")
  $targets = [regex]::Matches($text, '(?:from\s+|import\s*\(\s*|import\s+)"(\.{1,2}/[^"]+)"|(?:src|href)="([^"#:]+)"') |
    ForEach-Object { if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value } }
  foreach ($t in $targets) {
    $path = if ($dir) { "$dir/$t" } else { $t }
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($p in $path.Split("/")) {
      if ($p -eq "." -or $p -eq "") { continue }
      if ($p -eq "..") { if ($parts.Count) { $parts.RemoveAt($parts.Count - 1) } } else { $parts.Add($p) }
    }
    $resolved = $parts -join "/"
    if (-not $included.ContainsKey($resolved)) { $problems += "$key imports '$t' -> '$resolved', which isn't in the package" }
  }
  if ($text -match 'eval\(|new Function\(') { $problems += "$key uses eval/new Function (not allowed)" }
}

if ($problems.Count) {
  Write-Host "Build failed:" -ForegroundColor Red
  $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}

# ---- zip (forward-slash entry names) ----
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force $dist | Out-Null
$zipPath = Join-Path $dist "kinship-$($manifest.version).zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($key in ($included.Keys | Sort-Object)) {
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $included[$key].FullName, $key, [System.IO.Compression.CompressionLevel]::Optimal)
  }
} finally { $zip.Dispose() }

$size = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host "Built $zipPath ($($included.Count) files, $size KB)" -ForegroundColor Green
$included.Keys | Sort-Object | ForEach-Object { Write-Host "  $_" }
