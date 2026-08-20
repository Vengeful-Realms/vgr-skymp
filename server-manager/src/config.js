'use strict'

// Server Manager configuration, rewired for the Vengeful Realms VPS.
// The manager lives inside the full skymp-vgr monorepo (server-manager/src ->
// repo root), which holds the backend plus the launcher/client/server/gamemode
// sources. The deployed game server is separate, at C:\skymp\server (found via
// SERVER_SETTINGS_PATH in the backend .env). Everything can be overridden with
// a VGR_* environment variable.

const path = require('path')
const fs   = require('fs')

const repoRoot = path.resolve(__dirname, '..', '..')

function nssmPath() {
  const bundled = 'C:\\tools\\nssm\\nssm.exe'
  return fs.existsSync(bundled) ? bundled : 'nssm'
}

// Read a single KEY=value from the backend .env (ports, secrets, paths).
function readEnv(key) {
  try {
    const txt = fs.readFileSync(path.join(repoRoot, 'skymp5-backend', '.env'), 'utf8')
    const m = txt.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.*)\\s*$', 'm'))
    return m ? m[1].trim() : ''
  } catch { return '' }
}

// The deployed game server's settings file. The backend already knows where it
// lives (SERVER_SETTINGS_PATH), so reuse that instead of keeping a second copy.
const serverSettings = process.env.VGR_SERVER_SETTINGS
  || readEnv('SERVER_SETTINGS_PATH')
  || 'C:\\skymp\\server\\server-settings.json'

// Voice media server (nssm). Listed on the Console tab and also started
// best-effort alongside the game service.
const liveKitService = 'VgrLiveKit'

// Build output tree (esbuild/electron-builder targets ../build via the package
// scripts; CMake also pins its binary dir here).
const buildDir = process.env.VGR_BUILD_DIR || path.join(repoRoot, 'build')

module.exports = {
  repoRoot,
  logDir:   process.env.VGR_LOG_DIR || 'C:\\logs',
  nssm:     nssmPath(),
  buildDir,

  // nssm services. `key` is the short label shown in the UI; `name` is the
  // actual Windows service. Order is the start order (stop order is reversed).
  // Keep this list in sync with SERVICES in src/renderer/renderer.js (the
  // renderer has its own copy of key/label and would show a stale set if they drift).
  // The game server has no service on this box yet - run
  // tools/install-game-service.bat once to create VgrGameServer (and VgrLiveKit).
  services: [
    { key: 'nginx',   name: 'vengefulrealmsNginx', legacyNames: ['SkyrpNginx', 'SkyMPNginx'],       label: 'Nginx'   },
    { key: 'backend', name: 'SkyrpBackend',        legacyNames: ['VgrBackend'],                     label: 'Backend' },
    { key: 'livekit', name: liveKitService,                                                         label: 'LiveKit' },
    { key: 'game',    name: 'VgrGameServer',       legacyNames: ['SkyrpGameServer', 'VGRGameServer'], label: 'Game'  },
  ],

  liveKitService,

  // Reference MO2 install used to compile the manifest (the Modlist tab).
  // Defaults match the production VPS (C:\MO2, launcher-managed layout with
  // the game copy at C:\MO2\skyrim, profile VengefulRealms); point the
  // VGR_MO2_* env vars elsewhere on a dev machine. Note: machine-level env
  // vars only reach this app after Explorer restarts - the in-code defaults
  // are what actually apply on a freshly configured box.
  mo2Root:  process.env.VGR_MO2_ROOT  || 'C:\\MO2',
  gameRoot: process.env.VGR_GAME_ROOT || 'C:\\MO2\\skyrim',
  // Default must match compile-manifest.js / BuildManifest.bat so every
  // invocation path builds against the same profile.
  profile:  process.env.VGR_MO2_PROFILE || 'VengefulRealms',

  paths: {
    backend:      path.join(repoRoot, 'skymp5-backend'),
    versionRoute: path.join(repoRoot, 'skymp5-backend', 'routes', 'version.js'),
    backendEnv:   path.join(repoRoot, 'skymp5-backend', '.env'),
    backendEnvExample: path.join(repoRoot, 'skymp5-backend', '.env.example'),
    dataDir:      path.join(repoRoot, 'skymp5-backend', 'data'),
    // Launcher news: the entries file and the folder of images it can use.
    newsFile:      path.join(repoRoot, 'skymp5-backend', 'data', 'news.json'),
    newsImagesDir: process.env.VGR_NEWS_IMAGES_DIR
      || path.join(repoRoot, 'skymp5-backend', 'public', 'images'),
    filesVersion: path.join(repoRoot, 'skymp5-backend', 'data', 'files-version.json'),

    // Monorepo sources the Build tab drives.
    launcher:     path.join(repoRoot, 'skymp5-launcher'),
    launcherPkg:  path.join(repoRoot, 'skymp5-launcher', 'package.json'),
    launcherOut:  path.join(buildDir, 'launcher'),
    client:       path.join(repoRoot, 'skymp5-client'),
    server:       path.join(repoRoot, 'skymp5-server'),
    // The gamemode now lives directly in the live server checkout (the private
    // vgr-server repo at build/dist/server), so the sync source IS the live dir
    // and the Gamemode Sync button reports "already matches" - edit and commit
    // gamemode files in the live checkout instead.
    gamemodeSrcDir: process.env.VGR_GAMEMODE_SRC || path.dirname(serverSettings),
    serverDistDir:  path.join(buildDir, 'dist', 'server'),
    clientDistDir:  path.join(buildDir, 'dist', 'client'),

    // The deployed game server's settings (holds secrets; not in the repo).
    serverSettings,
    // The game server's working directory: gamemode.js, gamemode_extensions/
    // and dist_back/ live here. Defaults to the settings file's folder.
    serverDir:    process.env.VGR_SERVER_DIR || path.dirname(serverSettings),
  },

  // Read a backend .env value on demand (also used by the Builder for warnings).
  readBackendEnv: readEnv,

  // WS relay link for the Console command box (read live from the backend .env).
  relay: {
    get port()   { return parseInt(readEnv('WS_PORT') || '7778', 10) },
    // No fallback secret: when RELAY_SECRET is unset the relay must fail auth
    // rather than silently authenticate with a well-known default.
    get secret() { return readEnv('RELAY_SECRET') },
  },
}
