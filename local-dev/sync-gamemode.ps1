# Copies the VGR gamemode into the built server directory.
# Needed because the cmake build writes an EMPTY gamemode.js (BUILD_GAMEMODE=OFF
# fetches the upstream gamemode, not VGR's), and vgr-gamemode/gamemode.js
# resolves gamemode_extensions/ from the server's working directory.
# Re-run after every cmake build and after editing gamemode_extensions/*.js
# (extension edits also need a server restart - they are require()-cached).
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $repo 'build\dist\server'
if (-not (Test-Path (Join-Path $dist 'dist_back\skymp5-server.js'))) {
    Write-Error "No built server at $dist - run the cmake build first (see local-dev\README.md)."
}
$sourceGamemode = Join-Path $repo 'vgr-gamemode\gamemode.js'
$sourceExtensions = Join-Path $repo 'vgr-gamemode\gamemode_extensions'
$runtimeGamemode = Join-Path $dist 'gamemode.js'
$runtimeExtensions = Join-Path $dist 'gamemode_extensions'

if ((Test-Path $sourceGamemode) -and (Test-Path $sourceExtensions)) {
    Copy-Item $sourceGamemode $runtimeGamemode -Force
    Remove-Item $runtimeExtensions -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item $sourceExtensions $dist -Recurse -Force
    Write-Host "Gamemode synced from $sourceGamemode to $dist"
    exit 0
}

# The VGR gamemode is proprietary and may be omitted from a checkout. In that
# case, keep a previously prepared VGR runtime intact instead of deleting it
# or failing before the local server can start.
$runtimeLooksLikeVgr = $false
if ((Test-Path $runtimeGamemode) -and (Test-Path $runtimeExtensions)) {
    $runtimeLooksLikeVgr = Select-String -Path $runtimeGamemode -Pattern 'vgr_chat\.js' -Quiet
}

if ($runtimeLooksLikeVgr) {
    Write-Host "VGR gamemode source is unavailable at $sourceGamemode; keeping the existing VGR runtime in $dist."
    exit 0
}

Write-Error "VGR gamemode source is missing at $sourceGamemode and no usable prepared VGR runtime exists in $dist. Restore the proprietary vgr-gamemode directory or prepare the server runtime before launching."
