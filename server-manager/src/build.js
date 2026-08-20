'use strict'

const fs   = require('fs')
const path = require('path')
const cp   = require('child_process')
const vm   = require('vm')
const config = require('./config')

const isWin = process.platform === 'win32'

// Rewired for the full monorepo checkout: the repo now holds the real sources
// (skymp5-server TS, skymp5-launcher, skymp5-client, vgr-gamemode, vgr-frontend),
// while the game server runs from the separate deploy at C:\skymp\server.
//
// Gamemode model on this fork: <serverDir>\gamemode.js is a hand-written LOADER
// that require()s each gamemode_extensions/*.js with (mp) via absolute paths.
// It is NOT a concatenation - never generate it. The manager instead syncs the
// repo's vgr-gamemode/ files onto the server (merge, never delete) and tells the
// operator to restart the Game service (extensions sit in node's require cache;
// only gamemode.js itself is hot-reloaded by the server's file watcher).
class Builder {
  constructor(log) {
    this.log = log || (() => {})
  }

  line(text) { this.log(text.endsWith('\n') ? text : text + '\n') }
  banner(text) { this.log(`\n==================== ${text} ====================\n`) }

  // Run a command, streaming combined stdout/stderr to the build console.
  // With shell:true a spaced program path must be quoted or cmd.exe splits it; args with spaces need shell:false.
  run(cmd, args, cwd, label, env, shell = isWin) {
    if (shell && isWin && /\s/.test(cmd) && !cmd.startsWith('"')) cmd = `"${cmd}"`
    return new Promise(resolve => {
      this.log(`\n$ ${label || [cmd, ...args].join(' ')}\n`)
      let child
      try {
        child = cp.spawn(cmd, args, {
          cwd, shell, windowsHide: true,
          env: { ...process.env, ...(env || {}) },
        })
      } catch (err) {
        this.line(`[spawn failed] ${err.message}`)
        return resolve({ ok: false, code: -1 })
      }
      child.stdout.on('data', d => this.log(d.toString()))
      child.stderr.on('data', d => this.log(d.toString()))
      child.on('error', err => { this.line(`[error] ${err.message}`); resolve({ ok: false, code: -1 }) })
      child.on('close', code => { this.line(`[exit ${code}]`); resolve({ ok: code === 0, code }) })
    })
  }

  // Install a project's dependencies when node_modules is missing
  async ensureDeps(dir, label, pm = 'npm') {
    if (!fs.existsSync(dir)) return { ok: false, error: `${label}: directory not found (${dir})` }
    if (fs.existsSync(path.join(dir, 'node_modules'))) return { ok: true }
    this.line(`[${label}] installing dependencies (node_modules missing)…`)
    const r = await this.run(pm, ['install', '--legacy-peer-deps'], dir, `${label}: ${pm} install`)
    return r.ok ? { ok: true } : { ok: false, error: `${label}: dependency install failed` }
  }

  hasCmd(cmd) {
    try { cp.execSync(`${isWin ? 'where' : 'which'} ${cmd}`, { stdio: 'ignore' }); return true }
    catch { return false }
  }

  // Re-read PATH from the registry so tools installed mid-session are found.
  refreshPath() {
    if (!isWin) return
    try {
      const ps = "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"
      const out = cp.execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' }).trim()
      if (out) process.env.PATH = out
    } catch {}
  }

  // ── Native (C++) build: the .dlls and scam_native.node via CMake/MSVC ─────────

  // Locate a VS 2022 install with the C++ toolset.
  findVsWithCpp() {
    const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'
    if (!fs.existsSync(vswhere)) return null
    try {
      const out = cp.execSync(
        `"${vswhere}" -products * -version "[17.0,18.0)" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -latest -format value -property installationPath`,
        { encoding: 'utf8' }
      ).trim()
      const dir = out.split(/\r?\n/)[0]
      if (dir && fs.existsSync(path.join(dir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'))) return dir
    } catch {}
    return null
  }

  // cmake: PATH first, then the copy VS ships with the C++ workload.
  findCmake(vsDir) {
    if (this.hasCmd('cmake')) return 'cmake'
    if (vsDir) {
      const bundled = path.join(vsDir, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe')
      if (fs.existsSync(bundled)) return bundled
    }
    return null
  }

  // Reports everything the native build needs in one go.
  checkNativeToolchain() {
    const problems = []
    const vsDir = this.findVsWithCpp()
    if (!vsDir) {
      problems.push(
        'Visual Studio 2022 with the "Desktop development with C++" workload.\n' +
        '      Add it to an existing VS 2022 install (elevated):\n' +
        '      "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vs_installer.exe" modify ^\n' +
        '        --productId Microsoft.VisualStudio.Product.Community ^\n' +
        '        --channelId VisualStudio.17.Release ^\n' +
        '        --add Microsoft.VisualStudio.Workload.NativeDesktop --includeRecommended --passive --norestart'
      )
    }
    const cmake = this.findCmake(vsDir)
    if (!cmake) problems.push('CMake (comes with the C++ workload above, or install it separately and put it on PATH)')
    if (!this.hasCmd('git')) problems.push('Git (needed for the vcpkg submodule)')
    if (!this.hasCmd('python') && !this.hasCmd('python3')) problems.push('Python 3 (some vcpkg ports need it)')
    const vcpkgDir = path.join(config.repoRoot, 'vcpkg')
    if (!fs.existsSync(path.join(vcpkgDir, '.git')) && !fs.existsSync(path.join(vcpkgDir, 'bootstrap-vcpkg.bat'))) {
      problems.push('the vcpkg submodule (run: git submodule update --init --recursive)')
    }
    return { vsDir, cmake, vcpkgDir, problems }
  }

  // Configure + build the C++ with CMake/MSVC. Voice chat is always on, matching
  // the production client (CI flatrim builds it OFF, so a local build is the way
  // to get voice-enabled dlls). opts.targets limits the build, omit for everything.
  async buildNative(opts = {}) {
    this.banner('Native (C++) build')
    if (!isWin) return { ok: false, error: 'native build is Windows-only' }

    const tc = this.checkNativeToolchain()
    if (tc.problems.length) {
      this.line('[native] cannot build - missing:')
      for (const p of tc.problems) this.line(`  - ${p}`)
      this.line('\n[native] Alternative: download the CI "PR Windows Flatrim" dist artifact instead.')
      return { ok: false, error: `missing build tools: ${tc.problems.length} item(s), see log` }
    }
    this.line(`[native] Visual Studio: ${tc.vsDir}`)
    this.line(`[native] cmake: ${tc.cmake}`)

    // CMakeLists refuses any other binary dir, so this cannot be relocated.
    const buildDir = config.buildDir
    fs.mkdirSync(buildDir, { recursive: true })

    // Clean-room configure, exactly like tools/local-ci.ps1: an incremental
    // build over a stale CMake tree produced client DLLs that froze the game
    // on load (2026-08-20). Spared: client-files (live zip the backend
    // serves) and dist (live game server + era-paired client payload).
    this.line('[native] cleaning the CMake tree (sparing client-files and dist)…')
    let cleaned = 0
    for (const entry of fs.readdirSync(buildDir)) {
      if (entry === 'client-files' || entry === 'dist') continue
      try {
        fs.rmSync(path.join(buildDir, entry), { recursive: true, force: true })
        cleaned++
      } catch (e) {
        this.line(`[native] could not remove ${entry}: ${e.message}`)
      }
    }
    this.line(`[native] removed ${cleaned} build-tree entrie(s); configure will run from scratch`)

    // cmake/yarn.cmake shells out to yarn during configure; npm is not accepted there.
    if (!this.hasCmd('yarn')) {
      this.line('[native] yarn missing - installing with npm…')
      const y = await this.run('npm', ['install', '-g', 'yarn'], config.repoRoot, 'install yarn')
      this.refreshPath()
      if (!y.ok || !this.hasCmd('yarn')) {
        return { ok: false, error: 'yarn is required by the CMake configure - install it manually: npm install -g yarn' }
      }
    }

    if (!fs.existsSync(path.join(tc.vcpkgDir, 'vcpkg.exe'))) {
      this.line('[native] bootstrapping vcpkg (first run, this takes a few minutes)…')
      const boot = await this.run(path.join(tc.vcpkgDir, 'bootstrap-vcpkg.bat'), [], tc.vcpkgDir, 'bootstrap vcpkg')
      if (!boot.ok) return { ok: false, error: 'vcpkg bootstrap failed - see log' }
    }

    const serverOnly = Array.isArray(opts.targets) && opts.targets.every(t => t === 'skymp5-server')
    const buildsServer = !Array.isArray(opts.targets) || opts.targets.includes('skymp5-server')

    const args = [
      '-B', buildDir,
      '-G', 'Visual Studio 17 2022',
      '-A', 'x64',
      `-DVCPKG_ROOT=${tc.vcpkgDir.replace(/\\/g, '/')}`,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_NODEJS=OFF',
      '-DBUILD_FRONT=OFF',
      '-DBUILD_UNIT_TESTS=OFF',
      '-DPREPARE_NEXUS_ARCHIVES=OFF',
      '-DCPPCOV_PATH=OFF',
      '-DSKYMP_VOICE_CHAT=ON',
      '-DVCPKG_MANIFEST_FEATURES=voice-chat',
    ]
    if (config.gameRoot && fs.existsSync(config.gameRoot)) {
      args.push(`-DSKYRIM_DIR=${config.gameRoot.replace(/\\/g, '/')}`)
    }

    // CI builds the client TS bundle before configuring (pr_base "Early build skymp5-client").
    if (!serverOnly) {
      const clientDeps = await this.ensureDeps(config.paths.client, 'client')
      if (!clientDeps.ok) return clientDeps
      const early = await this.run('npm', ['run', 'build'], config.paths.client, 'client: build bundle')
      if (!early.ok) return { ok: false, error: 'client bundle build failed - see log' }
    }

    // shell:false: cmake.exe and several args contain spaces a shell command line would split.
    this.line('\n[native] configuring (first run compiles all vcpkg dependencies - expect 1-3 hours)…')
    const cfg = await this.run(tc.cmake, args, config.repoRoot, 'cmake configure', { VCPKG_FEATURE_FLAGS: 'manifests' }, false)
    if (!cfg.ok) return { ok: false, error: 'cmake configure failed - see log' }

    // The server post-build step regenerates these with upstream defaults, so
    // snapshot the build-tree copies and put them back afterwards.
    const guarded = ['server-settings.json', 'launch_server.bat'].map(name => {
      const file = path.join(buildDir, 'dist', 'server', name)
      let before = null
      try { before = fs.readFileSync(file) } catch {}
      return { file, before }
    })

    this.line('\n[native] compiling…')
    const buildArgs = ['--build', buildDir, '--config', 'Release']
    for (const t of (opts.targets || [])) buildArgs.push('--target', t)
    const build = await this.run(tc.cmake, buildArgs, config.repoRoot, 'cmake build', null, false)

    for (const g of guarded) {
      if (!g.before) continue
      let after = null
      try { after = fs.readFileSync(g.file) } catch {}
      if (!after || !after.equals(g.before)) {
        fs.writeFileSync(g.file, g.before)
        this.line(`[native] restored ${path.basename(g.file)} (the build regenerates it with upstream defaults)`)
      }
    }
    if (!build.ok) return { ok: false, error: 'cmake build failed - see log' }

    const outDir = path.join(buildDir, 'dist')
    this.line('')
    const expected = []
    if (buildsServer) expected.push('server/scam_native.node')
    if (!serverOnly) {
      expected.push('client/Data/SKSE/Plugins/SkyrimPlatform.dll')
      expected.push('client/Data/SKSE/Plugins/MpClientPlugin.dll')
    }
    for (const rel of expected) {
      const p = path.join(outDir, rel)
      this.line(fs.existsSync(p) ? `✓ ${rel}` : `MISSING ${rel}`)
    }
    this.line(`\n✓ Native build complete; artifacts are in ${outDir}`)
    return { ok: true, out: outDir }
  }

  // ── Gamemode: repo vgr-gamemode/ vs deployed <serverDir> ──────────────────────

  // The synced set: the loader itself plus everything under gamemode_extensions.
  // Paths are relative to the sync roots ('gamemode.js' or 'gamemode_extensions/x').
  listGamemodeFiles(root, extDirName = 'gamemode_extensions') {
    const files = []
    if (fs.existsSync(path.join(root, 'gamemode.js'))) files.push('gamemode.js')
    const extDir = path.join(root, extDirName)
    let entries = []
    try { entries = fs.readdirSync(extDir) } catch {}
    for (const name of entries) {
      if (!/\.(js|json)$/.test(name)) continue
      try { if (fs.statSync(path.join(extDir, name)).isFile()) files.push('gamemode_extensions/' + name) } catch {}
    }
    return files
  }

  // Line endings differ between git (LF) and the deployed copies (CRLF);
  // compare content, not bytes.
  normalized(file) {
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  }

  gamemodeStatus() {
    const repoRoot = config.paths.gamemodeSrcDir
    const srvRoot = config.paths.serverDir
    if (!fs.existsSync(repoRoot)) return { ok: false, error: `repo gamemode source not found (${repoRoot})` }
    const repoFiles = new Set(this.listGamemodeFiles(repoRoot))
    const srvFiles = new Set(this.listGamemodeFiles(srvRoot))
    const repoOnly = [], serverOnly = [], differs = [], same = []
    for (const f of repoFiles) {
      if (!srvFiles.has(f)) { repoOnly.push(f); continue }
      try {
        if (this.normalized(path.join(repoRoot, f)) === this.normalized(path.join(srvRoot, f))) same.push(f)
        else differs.push(f)
      } catch (err) { differs.push(f) }
    }
    for (const f of srvFiles) if (!repoFiles.has(f)) serverOnly.push(f)
    return { ok: true, repoRoot, srvRoot, repoOnly, serverOnly, differs, same }
  }

  // Merge-copy repo gamemode files onto the server: overwrite differing files,
  // add repo-only ones, NEVER delete server-only files (some live extensions
  // have no repo source). Overwritten server versions are backed up first.
  async syncGamemode() {
    this.banner('Gamemode sync (repo → server)')
    const st = this.gamemodeStatus()
    if (!st.ok) return st
    const toCopy = [...st.repoOnly, ...st.differs].sort()
    if (!toCopy.length) {
      this.line('[gamemode] server already matches the repo - nothing to copy.')
      if (st.serverOnly.length) this.line(`[gamemode] ${st.serverOnly.length} server-only file(s) kept: ${st.serverOnly.join(', ')}`)
      return { ok: true, copied: [], kept: st.serverOnly }
    }

    // Validate everything BEFORE touching the live server: a file with a syntax
    // error must never land in the running gamemode's folder.
    for (const f of toCopy) {
      const src = path.join(st.repoRoot, f)
      try {
        if (f.endsWith('.json')) JSON.parse(fs.readFileSync(src, 'utf8'))
        else new vm.Script(fs.readFileSync(src, 'utf8'), { filename: f })
      } catch (err) {
        return { ok: false, error: `${f}: ${err.message} - fix it in the repo first, nothing was copied` }
      }
    }

    // Back up the server versions this sync overwrites.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const backupRoot = path.join(st.srvRoot, 'manager-backups', stamp, 'gamemode')
    for (const f of st.differs) {
      const dest = path.join(backupRoot, f)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(path.join(st.srvRoot, f), dest)
    }
    if (st.differs.length) this.line(`[gamemode] backed up ${st.differs.length} file(s) to ${backupRoot}`)

    // Copy extensions first and the loader last: the server hot-reloads only on
    // gamemode.js changes, so when it fires the extensions are already in place.
    const ordered = toCopy.filter(f => f !== 'gamemode.js').concat(toCopy.includes('gamemode.js') ? ['gamemode.js'] : [])
    for (const f of ordered) {
      const dest = path.join(st.srvRoot, f)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const tmp = dest + '.tmp'
      fs.copyFileSync(path.join(st.repoRoot, f), tmp)
      fs.renameSync(tmp, dest)
      this.line(`[gamemode] ${st.differs.includes(f) ? 'updated' : 'added'} ${f}`)
    }
    if (st.serverOnly.length) this.line(`[gamemode] kept ${st.serverOnly.length} server-only file(s): ${st.serverOnly.join(', ')}`)
    this.line('\n✓ Sync complete. RESTART the Game service to apply - extensions load once at startup (node require cache), the file watcher only covers gamemode.js.')
    return { ok: true, copied: ordered, kept: st.serverOnly, backupRoot: st.differs.length ? backupRoot : null }
  }

  // ── Game server: bundle the TypeScript and deploy it to the live server ───────

  async buildServer(opts = {}) {
    // The fresh scam_native.node is deployed below, so fail before the long
    // native build if the live copy is locked by a running game server.
    const liveNode = path.join(config.paths.serverDir, 'scam_native.node')
    if (opts.native && opts.deploy && fs.existsSync(liveNode)) {
      try { fs.closeSync(fs.openSync(liveNode, 'r+')) }
      catch { return { ok: false, error: 'scam_native.node is locked - stop the Game service before a native server build' } }
    }
    if (opts.native) {
      const n = await this.buildNative({ targets: ['skymp5-server'] })
      if (!n.ok) return n
    }

    this.banner('Game server (TS bundle)')
    const dir = config.paths.server
    const dep = await this.ensureDeps(dir, 'game server')
    if (!dep.ok) return dep

    // The live server can run straight from the build output dir; esbuild then
    // overwrites the running bundle in place, so back it up BEFORE building.
    const sameDir = path.resolve(config.paths.serverDistDir) === path.resolve(config.paths.serverDir)
    let inPlaceBackupDir = null
    if (opts.deploy && sameDir) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      inPlaceBackupDir = path.join(config.paths.serverDir, 'manager-backups', stamp, 'dist_back')
      for (const name of ['skymp5-server.js', 'skymp5-server.js.map']) {
        const live = path.join(config.paths.serverDir, 'dist_back', name)
        if (!fs.existsSync(live)) continue
        fs.mkdirSync(inPlaceBackupDir, { recursive: true })
        fs.copyFileSync(live, path.join(inPlaceBackupDir, name))
      }
    }

    // esbuild writes to <repo>/build/dist/server/dist_back (path fixed in the
    // package script); scam_native.node is loaded at runtime from the server
    // cwd, so the native module is not needed to bundle.
    const r = await this.run('npm', ['run', 'build-ts'], dir, 'game server: npm run build-ts')
    if (!r.ok) return { ok: false, error: 'build-ts failed - TypeScript errors stop the build (see log)' }
    const bundle = path.join(config.paths.serverDistDir, 'dist_back', 'skymp5-server.js')
    if (!fs.existsSync(bundle)) return { ok: false, error: `expected bundle missing: ${bundle}` }

    if (!opts.deploy) {
      this.line(`\n✓ Bundle built: ${bundle} (not deployed)`)
      return { ok: true, bundle }
    }

    if (sameDir) {
      if (inPlaceBackupDir) this.line(`[deploy] previous bundle backed up to ${inPlaceBackupDir}`)
      this.line('\n✓ Bundle built in the live server dir. Restart the Game service to run it.')
      return { ok: true, bundle, deployed: true }
    }

    // Deploy: back up the live bundle, then copy the new one (+ sourcemap) in.
    // Safe while the server runs - dist_back is read once at startup.
    const liveDir = path.join(config.paths.serverDir, 'dist_back')
    fs.mkdirSync(liveDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const backupDir = path.join(config.paths.serverDir, 'manager-backups', stamp, 'dist_back')
    for (const name of ['skymp5-server.js', 'skymp5-server.js.map']) {
      const live = path.join(liveDir, name)
      if (!fs.existsSync(live)) continue
      fs.mkdirSync(backupDir, { recursive: true })
      fs.copyFileSync(live, path.join(backupDir, name))
    }
    for (const name of ['skymp5-server.js', 'skymp5-server.js.map']) {
      const src = path.join(config.paths.serverDistDir, 'dist_back', name)
      if (!fs.existsSync(src)) continue
      const dest = path.join(liveDir, name)
      const tmp = dest + '.tmp'
      fs.copyFileSync(src, tmp)
      fs.renameSync(tmp, dest)
      this.line(`[deploy] ${name} → ${liveDir}`)
    }
    if (opts.native) {
      const freshNode = path.join(config.paths.serverDistDir, 'scam_native.node')
      if (!fs.existsSync(freshNode)) return { ok: false, error: `native build did not produce ${freshNode}` }
      if (fs.existsSync(liveNode)) {
        const nodeBackupDir = path.dirname(backupDir)
        fs.mkdirSync(nodeBackupDir, { recursive: true })
        fs.copyFileSync(liveNode, path.join(nodeBackupDir, 'scam_native.node'))
      }
      const tmp = liveNode + '.tmp'
      fs.copyFileSync(freshNode, tmp)
      fs.renameSync(tmp, liveNode)
      this.line(`[deploy] scam_native.node → ${config.paths.serverDir}`)
    }
    this.line(`[deploy] previous bundle backed up to ${backupDir}`)
    this.line('\n✓ Bundle deployed. Restart the Game service to run it.')
    return { ok: true, bundle, deployed: true }
  }

  // ── Launcher: the Electron installer ──────────────────────────────────────────

  async buildLauncher() {
    this.banner('Launcher')
    const dir = config.paths.launcher
    try { fs.rmSync(config.paths.launcherOut, { recursive: true, force: true }) } catch {}
    const dep = await this.ensureDeps(dir, 'launcher')
    if (!dep.ok) return dep

    // CSC_IDENTITY_AUTO_DISCOVERY=false stops an expired code-signing cert in
    // the Windows store from aborting the build.
    const r = await this.run('npm', ['run', 'build:win'], dir, 'launcher: npm run build:win',
      { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
    if (!r.ok) return { ok: false, error: 'electron-builder failed - see log' }

    let exe = null
    try { exe = fs.readdirSync(config.paths.launcherOut).find(f => f.toLowerCase().endsWith('.exe')) } catch {}
    if (!exe) return { ok: false, error: `no installer .exe found in ${config.paths.launcherOut}` }
    this.line(`\n✓ Launcher built → ${path.join(config.paths.launcherOut, exe)}`)
    this.line('Upload it to the download host (LAUNCHER_DOWNLOAD_URL) and bump the version field so launchers see the update.')
    return { ok: true, out: path.join(config.paths.launcherOut, exe) }
  }

  // ── Client files: rebuild skymp5-client.js and repackage the launcher bundle ──

  async buildClient(opts = {}) {
    if (opts.native) {
      const n = await this.buildNative({ targets: ['skymp5-client', 'skyrim-platform'] })
      if (!n.ok) return n
    }

    this.banner('Client files')
    const clientData = path.join(config.paths.clientDistDir, 'Data')
    if (!fs.existsSync(clientData)) {
      return { ok: false, error: `client payload not found at ${clientData} - tick the CMake box to build the DLLs locally, or download the CI "dist" artifact (PR Windows Flatrim workflow) and extract it into build/dist/client first.` }
    }

    // Fresh client logic bundle into the payload (webpack targets
    // build/dist/client/Data/Platform/Plugins/skymp5-client.js).
    const dep = await this.ensureDeps(config.paths.client, 'client logic')
    if (!dep.ok) return dep
    const r = await this.run('npm', ['run', 'build'], config.paths.client, 'client logic: webpack build')
    if (!r.ok) return { ok: false, error: 'client logic build failed (see log)' }

    // populate-files.js + merge-files.js: payload + vgr-frontend UI overlay →
    // build/client-files/root → skymp-client.zip + data/files-version.json.
    const dep2 = await this.ensureDeps(config.paths.backend, 'backend')
    if (!dep2.ok) return dep2
    const p = await this.run('npm', ['run', 'build-client'], config.paths.backend, 'package client: npm run build-client')
    if (!p.ok) return { ok: false, error: 'build-client failed - see log (is build/dist/client complete?)' }

    this.line('\n✓ Client files packaged (skymp-client.zip + data/files-version.json).')
    const zipUrl = config.readBackendEnv('CLIENT_ZIP_URL')
    if (zipUrl) {
      this.line('\n!! WARNING: CLIENT_ZIP_URL is set - /api/files/zip serves the REMOTE zip:')
      this.line(`   ${zipUrl}`)
      this.line('   files-version.json just changed, so launchers will now update and download')
      this.line('   the OLD remote zip. Upload the new build/client-files/skymp-client.zip there')
      this.line('   NOW, or clear CLIENT_ZIP_URL (Settings tab) to serve the local zip instead.')
    }
    return { ok: true, zipUrl: zipUrl || null }
  }
}

module.exports = { Builder }
