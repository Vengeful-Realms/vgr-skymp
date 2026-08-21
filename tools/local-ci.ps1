# Local CI: clean-room native build with pinned flags, tests, and versioned artifacts.
# Mirrors .github/actions/pr_base as closely as this box allows, so every build is
# reproducible and comparable instead of inheriting whatever the build/ tree last held.
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File tools\local-ci.ps1                # CI-parity build
#   powershell -ExecutionPolicy Bypass -File tools\local-ci.ps1 -VoiceChat    # production client build
#   powershell -ExecutionPolicy Bypass -File tools\local-ci.ps1 -SkipClean    # incremental rebuild
#   powershell -ExecutionPolicy Bypass -File tools\local-ci.ps1 -SkipTests
#
# Artifacts land in build-artifacts\<UTCstamp>-<sha>-<flags>\ with a build-report.json.
# This script never touches build\dist\server\ (the live game server),
# build\client-files\, or any live file.

param(
  [switch]$VoiceChat,
  [switch]$SkipClean,
  [switch]$SkipTests,
  [string[]]$Targets = @()
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$buildDir = Join-Path $repo 'build'
$vcpkgDir = Join-Path $repo 'vcpkg'
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$sha = (& git -C $repo rev-parse --short HEAD).Trim()
$dirty = (& git -C $repo status --porcelain | Measure-Object).Count -gt 0
$flagsTag = if ($VoiceChat) { 'voice' } else { 'ci-parity' }
$artifactDir = Join-Path $repo ("build-artifacts\{0}-{1}{2}-{3}" -f $stamp, $sha, $(if ($dirty) { '-dirty' } else { '' }), $flagsTag)
$report = [ordered]@{
  stamp = $stamp; commit = $sha; dirty = $dirty; flags = $flagsTag
  steps = [ordered]@{}
}

function Step($name, [scriptblock]$body) {
  Write-Host "==== $name ===="
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & $body
  $sw.Stop()
  $script:report.steps[$name] = [math]::Round($sw.Elapsed.TotalSeconds, 1)
}

# Toolchain discovery, same rules as the server manager's native build
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$vsDir = (& $vswhere -products * -version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -latest -format value -property installationPath | Select-Object -First 1)
if (-not $vsDir) { throw 'Visual Studio 2022 with the C++ workload is required' }
$cmake = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (-not $cmake) { $cmake = Join-Path $vsDir 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' }
$report.visualStudio = $vsDir
$report.cmake = (& $cmake --version | Select-Object -First 1)

if (-not (Test-Path (Join-Path $vcpkgDir 'vcpkg.exe'))) {
  Step 'bootstrap-vcpkg' { & (Join-Path $vcpkgDir 'bootstrap-vcpkg.bat') | Out-Host }
}

if (-not $SkipClean) {
  Step 'clean' {
    # Spare exactly two things: build\client-files (the LIVE zip the backend
    # serves) and build\dist\server (the RUNNING game server, a vgr-server
    # checkout with production secrets). Everything else goes, including
    # build\dist\client - leaving that in place accumulates DLLs and payload
    # files from many build eras into one incoherent pack, which is the
    # mixed-era client failure mode.
    $spare = @{ $buildDir = @('client-files', 'dist'); (Join-Path $buildDir 'dist') = @('server') }
    $nuke = {
      param($item)
      # No stderr redirection on the native fallbacks: under Stop preference
      # PS 5.1 turns redirected native stderr into a terminating error.
      try { Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop } catch {}
      if (Test-Path -LiteralPath $item.FullName) {
        if ($item.PSIsContainer) { cmd /c "rmdir /s /q `"$($item.FullName)`"" | Out-Null }
        else { cmd /c "del /f /q `"$($item.FullName)`"" | Out-Null }
      }
      if (Test-Path -LiteralPath $item.FullName) { throw "clean: could not remove $($item.FullName)" }
    }
    foreach ($dir in @($buildDir, (Join-Path $buildDir 'dist'))) {
      if (-not (Test-Path $dir)) { continue }
      $keep = $spare[$dir]
      Get-ChildItem $dir | Where-Object { $keep -notcontains $_.Name } | ForEach-Object { & $nuke $_ }
    }
    New-Item -ItemType Directory -Force $buildDir | Out-Null
  }
}

# The client TS bundle feeds native packaging; CI builds it before configuring.
Step 'client-bundle' {
  Push-Location (Join-Path $repo 'skymp5-client')
  try {
    if (-not (Test-Path 'node_modules')) { yarn install | Out-Host }
    yarn build | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'client bundle build failed' }
  } finally { Pop-Location }
}

Step 'configure' {
  $flags = @(
    '-B', $buildDir,
    '-G', 'Visual Studio 17 2022',
    '-A', 'x64',
    "-DVCPKG_ROOT=$($vcpkgDir -replace '\\','/')",
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_NODEJS=OFF',
    '-DBUILD_FRONT=OFF',
    '-DBUILD_UNIT_TESTS=ON',
    '-DPREPARE_NEXUS_ARCHIVES=OFF',
    '-DCPPCOV_PATH=OFF'
  )
  if (Test-Path 'C:\MO2\skyrim\SkyrimSE.exe') { $flags += '-DSKYRIM_DIR=C:/MO2/skyrim' }
  if ($VoiceChat) { $flags += @('-DSKYMP_VOICE_CHAT=ON', '-DVCPKG_MANIFEST_FEATURES=voice-chat') }
  $report.configureFlags = $flags -join ' '
  $env:VCPKG_FEATURE_FLAGS = 'manifests'
  & $cmake @flags $repo | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'configure failed' }
}

Step 'build' {
  # skymp5-server/CMakeLists.txt copies server-settings.json, launch_server.bat,
  # package.json and yarn.lock into dist/server with UPSTREAM defaults - and
  # since the 2026-08-20 move that path is the live server holding production
  # secrets. Snapshot them and put them back after the build.
  $guardDir = Join-Path $buildDir 'dist\server'
  $guarded = @()
  foreach ($name in @('server-settings.json', 'launch_server.bat', 'package.json', 'yarn.lock')) {
    $p = Join-Path $guardDir $name
    if (Test-Path $p) { $guarded += @{ Path = $p; Bytes = [System.IO.File]::ReadAllBytes($p) } }
  }

  $args = @('--build', $buildDir, '--config', 'Release')
  foreach ($t in $Targets) { $args += @('--target', $t) }
  & $cmake @args | Out-Host
  $buildExit = $LASTEXITCODE

  foreach ($g in $guarded) {
    $now = if (Test-Path $g.Path) { [System.IO.File]::ReadAllBytes($g.Path) } else { $null }
    $same = $now -and $now.Length -eq $g.Bytes.Length -and -not (Compare-Object $now $g.Bytes)
    if (-not $same) {
      [System.IO.File]::WriteAllBytes($g.Path, $g.Bytes)
      Write-Host "[guard] restored $(Split-Path $g.Path -Leaf) (the build regenerates it with upstream defaults)"
    }
  }
  if ($buildExit -ne 0) { throw 'build failed' }
}

if (-not $SkipTests) {
  Step 'ctest' {
    Push-Location $buildDir
    try {
      & ctest -C Release --output-on-failure | Out-Host
      $report.testsPassed = ($LASTEXITCODE -eq 0)
      if ($LASTEXITCODE -ne 0) { Write-Warning 'ctest reported failures (artifacts still staged)' }
    } finally { Pop-Location }
  }
}

Step 'stage-artifacts' {
  # dist\server is the LIVE game server (the vgr-server checkout) since the
  # 2026-08-20 restructure: never copy it into artifacts (it holds secrets,
  # node_modules and a locked native). Stage the client payload only; a
  # server-native build is a deliberate stopped-server operation whose output
  # IS the live file.
  New-Item -ItemType Directory -Force (Join-Path $artifactDir 'dist') | Out-Null
  Copy-Item (Join-Path $buildDir 'dist\client') (Join-Path $artifactDir 'dist\client') -Recurse
  foreach ($rel in @('dist\client\Data\SKSE\Plugins\SkyrimPlatform.dll', 'dist\client\Data\SKSE\Plugins\MpClientPlugin.dll', 'dist\client\Data\Platform\Distribution\RuntimeDependencies\SkyrimPlatformImpl.dll')) {
    $f = Join-Path $artifactDir $rel
    if (Test-Path $f) {
      $h = (Get-FileHash $f -Algorithm SHA256).Hash
      $report[(Split-Path $rel -Leaf)] = [ordered]@{ size = (Get-Item $f).Length; sha256 = $h }
    } else {
      $report[(Split-Path $rel -Leaf)] = 'MISSING'
    }
  }
  $report | ConvertTo-Json -Depth 8 | Out-File (Join-Path $artifactDir 'build-report.json') -Encoding utf8
}

Write-Host "==== done ===="
Write-Host "artifacts: $artifactDir"
Get-Content (Join-Path $artifactDir 'build-report.json')
