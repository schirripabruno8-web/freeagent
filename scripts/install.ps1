# FreeAgent installer (from source). Double-click Install.bat, or run:  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# It installs nothing outside this folder, except Node.js (only if you say yes) and, if you say yes, the optional Blender add-on.
#   -Yes          answer yes to every question (Node.js, Blender add-on, Desktop shortcut)
#   -NoLaunch     do not start the app at the end
param([switch]$Yes, [switch]$NoLaunch)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Ask([string]$question) {
  if ($Yes) { return $true }
  return ((Read-Host "$question [y/N]") -match '^(y|s)')
}
function Step([string]$text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Fail([string]$text) { Write-Host ""; Write-Host "ERROR: $text" -ForegroundColor Red; exit 1 }

function Node-Ok {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if (-not $n) { return $false }
  return ([version](& node -p "process.versions.node")) -ge [version]'22.12.0'
}

Step 'Checking Node.js (22.12 or newer)'
if (-not (Node-Ok)) {
  Write-Host 'Node.js 22.12+ was not found.'
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget -and (Ask 'Install Node.js LTS now with winget (about 30 MB, from the official OpenJS package)?')) {
    & winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    # the new PATH is not visible to this window yet
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if (-not (Node-Ok)) { Fail 'Install Node.js 22.12 or newer from https://nodejs.org, then run Install.bat again (open a new window so it sees Node.js).' }
}
Write-Host ("Node.js " + (& node -v))

Step 'Installing dependencies (npm ci)'
& npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed (see the messages above). Check your internet connection and run Install.bat again.' }

Step 'Downloading Electron (about 110 MB, once; Electron no longer fetches it during npm ci)'
& node (Join-Path $root 'node_modules\electron\install.js')
if ($LASTEXITCODE -ne 0) { Fail 'The Electron download failed (see the messages above). Check your internet connection and run Install.bat again.' }

Step 'Building the app'
& npm run build
if ($LASTEXITCODE -ne 0) { Fail 'The build failed (see the messages above).' }

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { Fail 'Electron was not installed (node_modules\electron\dist\electron.exe is missing).' }

Step 'Desktop shortcut'
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'FreeAgent.lnk'
if ((-not (Test-Path $lnk)) -and (Ask 'Create a FreeAgent shortcut on the Desktop?')) {
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = $electron
  $s.Arguments = '"' + $root + '"'
  $s.WorkingDirectory = $root
  $s.IconLocation = $electron
  $s.Save()
  Write-Host "Created $lnk"
} else {
  Write-Host 'Skipped (or it already exists). You can always start the app with FreeAgent.bat.'
}

# Optional: the Blender add-on used by the included "blender" MCP server (not needed for anything else).
$target = Join-Path $env:APPDATA 'freeagent\mcp\dcc-mcp-blender'
$blender = $null
foreach ($base in @('C:\Program Files\Blender Foundation', 'C:\Program Files (x86)\Blender Foundation')) {
  if (Test-Path $base) {
    $blender = Get-ChildItem $base -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'blender.exe') } | Sort-Object Name -Descending | Select-Object -First 1
    if ($blender) { break }
  }
}
if ($blender -and -not (Test-Path $target)) {
  Step ("Blender found: " + $blender.Name)
  if (Ask 'Install the Blender MCP add-on (dcc-mcp-blender 0.2.18, MIT, downloaded from PyPI with Blender''s own Python) so agents can drive Blender?') {
    $py = Get-ChildItem (Join-Path $blender.FullName '*\python\bin\python.exe') -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $py) {
      Write-Host 'Blender''s Python was not found: skipping the add-on.'
    } else {
      & $py.FullName -m pip install --target $target 'dcc-mcp-blender==0.2.18'
      if ($LASTEXITCODE -ne 0) { Write-Host 'The add-on could not be installed (the rest of FreeAgent works without it).' -ForegroundColor Yellow }
    }
  }
}

Write-Host ""
Write-Host 'FreeAgent is installed.' -ForegroundColor Green
Write-Host 'Start it with the Desktop shortcut or FreeAgent.bat. Log in to a provider on the right-hand page (email and password), pick a working folder, write a task.'
if (-not $NoLaunch) { Start-Process -FilePath $electron -ArgumentList ('"' + $root + '"') -WorkingDirectory $root }
