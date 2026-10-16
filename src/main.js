// Electron main process. Owns all filesystem/game access; the renderer talks to
// it only through the IPC surface in preload.js. Core logic is in core/kovaaks.js.
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  dialog,
  globalShortcut,
  ipcMain,
  safeStorage,
  shell,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { execFile } = require('node:child_process')
const k = require('./core/kovaaks')
const companion = require('./core/companion')
const progress = require('./core/progress')
const history = require('./core/history')
const clipper = require('./core/clipper')
const store = require('./core/presets')
const logger = require('./core/log')
const log = logger.log

const STEAM_APP_ID = '824270' // KovaaK's

// Pinned to the pre-rename folder. Electron derives userData from productName,
// so the KovaPresets -> kova companion rename would otherwise point every
// installed copy at an empty folder: presets, settings and the restore baseline
// gone. Must run before anything reads the path, the single-instance lock
// included (it keys on userData, which also keeps an old and new build from
// running side by side).
app.setPath('userData', path.join(app.getPath('appData'), 'KovaPresets'))

// One instance only: a second `npm start` focuses the existing window instead
// of silently stacking another copy in the tray (the X hides to tray, so
// "close then start again" would otherwise pile up instances).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
}

let win = null
let tray = null
let quitting = false

// ---- hot-path caches ------------------------------------------------------------
// The renderer polls `state` every 5s; without these that meant a synchronous
// tasklist spawn (blocks the main process), a Steam-library re-scan, and a
// re-read of ~55 theme JSONs per tick.
let installCache = null // a found install doesn't move while the app runs
function findInstall(rescan) {
  if (rescan) installCache = null
  if (!installCache) installCache = k.findInstall()
  return installCache
}

// game-running is polled ASYNC on a timer; readers get the cached answer
// synchronously, so apply/flush logic stays sync and nothing blocks on spawns.
// Worst case the answer is ~3s stale, which every consumer tolerates (a late
// flush waits one 4s tick; an apply mid-transition queues and gets flushed).
let gameRunningCache = !!k.isGameRunning()
const gameRunning = () => gameRunningCache
// Authoritative answer, for the two paths where a stale "not running" silently
// eats the write rather than merely delaying it: apply and flush. The poll can
// report false for up to one tick after the game starts, and an apply landing in
// that window writes PrimaryUserSettings.json directly and clears pending - so
// the game's rewrite from launch-time memory drops the sens/DPI/theme with
// nothing left queued to re-assert it. Launch the game, alt-tab, click a preset
// is the normal usage pattern, which made it look intermittent. ~50ms tasklist
// call on a user action only; every other reader still gets the cached value.
function gameRunningNow() {
  const running = k.isGameRunning()
  if (running !== null) noteGameRunning(running) // null: tasklist failed, keep what we knew
  return gameRunningCache
}
// When the game was first seen running, for the session recap. Both readers of
// the process list go through noteGameRunning, so the close edge is seen once
// whichever of them notices first. Restart-game sets the cache directly on
// purpose: closing to relaunch is the same session, not a recap.
let gameStartedAt = null
function noteGameRunning(running, clean = true) {
  const was = gameRunningCache
  gameRunningCache = running
  // also covers "already running when the app started": no rising edge then
  if (running && gameStartedAt == null) gameStartedAt = Date.now()
  if (running && !was) kovaLiveStart()
  updateTrayIcon()
  // a failed tasklist reads as "not running", and a restart-game closes it on
  // purpose: neither ends the session
  const closed = was && !running && clean && !restartInFlight
  if (closed) kovaLiveStop()
  if (closed) {
    onGameClosed(gameStartedAt).catch((e) => log('recap failed', e?.message))
    gameStartedAt = null
  }
}
let lastWatchTry = 0
function pollGameRunning() {
  execFile('tasklist', k.TASKLIST_ARGS, { windowsHide: true }, (err, out) => {
    noteGameRunning(!err && k.tasklistSaysRunning(out), !err)
    // A running game means the install exists, so a sync that couldn't start at
    // launch (Steam not up yet, install not found) starts now - without paying
    // for a Steam re-scan on every tick while nothing is found.
    // Each try can mean a Steam re-scan, so at most once a minute while it fails.
    if (gameRunningCache && Date.now() - lastWatchTry > 60_000 && ((kovaToken && !kovaWatcher) || !statsWatcher)) {
      lastWatchTry = Date.now()
      if (kovaToken && !kovaWatcher) startKovaSync()
      // runs only land while the game runs, so that's when the stats watch must be up
      if (!statsWatcher) startStatsWatch()
    }
  })
}

let optionsCache = null // { install, at, value }
const OPTIONS_TTL_MS = 30_000
function listOptionsCached(install, rescan) {
  if (rescan || !optionsCache || optionsCache.install !== install || Date.now() - optionsCache.at > OPTIONS_TTL_MS)
    optionsCache = { install, at: Date.now(), value: k.listOptions(install) }
  return optionsCache.value
}

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#111114',
    title: 'kova companion',
    icon: path.join(__dirname, 'assets', 'app.ico'),
    // started as a login item: boot straight into the tray, no window flash
    show: !process.argv.includes('--hidden'),
    // Riot-client-style chrome: fully frameless, the app's own topbar is the
    // drag region and renders its own caption buttons (the Windows overlay
    // buttons drew oversized/missing hover states at this bar height).
    // minimize + close only - no maximize, incl. via titlebar double-click.
    frame: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.removeMenu()
  // Renderer errors land in the log too - a blank preset list in a user report
  // otherwise leaves nothing to go on.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 3) log('renderer error', message, `${String(sourceId).split(/[\\/]/).pop()}:${line}`)
  })
  // The preload bridge is attached to the WINDOW, not the page, so anything
  // that loads here inherits it. The app has no in-app links or popups, so
  // pinning the window to index.html costs nothing and means one escaping slip
  // in a game-supplied string (crosshair/theme/scenario names) can't reach it.
  // External links go through shell.openExternal, which these don't affect.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Block anything that tries to leave index.html - nothing here legitimately
  // navigates. Compared against a STABLE precomputed URL, not the live
  // getURL(): reload goes through win:reload (webContents.reload(), which never
  // fires this), so the only navigations that reach here are the page trying to
  // leave - and matching getURL() was fragile (empty during a transient load,
  // or a different file:// casing on Windows) and could wrongly block a reload.
  const indexFile = path.join(__dirname, 'renderer', 'index.html')
  const indexUrl = pathToFileURL(indexFile).toString()
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== indexUrl) e.preventDefault()
  })
  win.loadFile(indexFile)
  // Close hides to the tray so global hotkeys keep working; quit via the tray menu.
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
    const s = loadSettings()
    if (!s.trayTipShown && tray) {
      tray.displayBalloon({
        title: 'kova companion is still running',
        content: 'Hotkeys stay active. Right-click the tray icon to apply presets or quit.',
      })
      saveSettings({ ...s, trayTipShown: true })
    }
  })
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow()
  else {
    win.show()
    win.focus()
  }
}

function requireInstall() {
  const install = findInstall()
  if (!install) throw new Error("KovaaK's install not found. Is it installed via Steam?")
  return install
}

const userData = () => app.getPath('userData')
const pendingFile = () => path.join(userData(), 'pending.json')

// ---- app settings (small flags, not presets) -----------------------------------
// applyMode ('manual' | 'reenter' | 'restart') is deliberately NOT defaulted here:
// it has to stay undefined for an existing config so applyMode() can migrate the
// old autoRestart boolean onto the 'reenter' rung. Defaulting it would merge a
// 'manual' over every existing user and silently turn their auto re-enter off.
const SETTINGS_DEFAULTS = { autoRestart: false, trayTipShown: false, onboarded: false, snipeAlerts: true, pbPopups: true }
const settingsFile = () => path.join(userData(), 'settings.json')
function loadSettings() {
  try {
    return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }
  } catch {
    return { ...SETTINGS_DEFAULTS }
  }
}
function saveSettings(s) {
  // atomic like every other store: a torn write here reads back as invalid JSON,
  // which loadSettings turns into defaults - re-running the first-run wizard and
  // silently resetting the apply mode
  k.writeFileAtomic(settingsFile(), JSON.stringify(s, null, 2))
}

// ---- scenario re-enter ----------------------------------------------------------
// Relaunches the current scenario via the same steam:// jump-to-scenario deep
// link the kova website's snipe button uses. Only a full scenario load re-reads
// weaponsettings.ini - the in-game ResetSession bind just resets the timer
// (verified: pressing it leaves the old crosshair), so keypressing is useless.
// "Current scenario" = newest stats CSV, written every time a run ends.
//
// Jumping to the scenario the player is ALREADY IN doesn't reload it (verified
// in-game), and that's the main case - so we park in the previous scenario
// first, then jump back. The second jump is a real scenario change = full load.
const REENTER_HOP_MS = 2500
const scenarioLink = (name, challenge) =>
  `steam://run/${STEAM_APP_ID}/?action=jump-to-scenario;name=${encodeURIComponent(name)}${challenge ? ';mode=challenge' : ''}`

// What to re-enter, and a different scenario to park on first (the jump to the
// same scenario reloads nothing). The target is the scenario loaded right now
// (session.sav); the stats history only knows finished runs, so it's the
// fallback - alone it sent anyone who'd loaded a new scenario and applied a
// preset before finishing a run back to the previous one.
function reenterTargets(install) {
  if (!install) return []
  const recent = k.recentScenariosFromStats(install)
  const scenario = k.currentScenario(install) || recent[0]
  return [scenario, recent.find((s) => s !== scenario)]
}

async function doRestartScenario() {
  if (!gameRunning()) return { ok: false, error: "KovaaK's isn't running." }
  const [scenario, parking] = reenterTargets(findInstall())
  if (!scenario)
    return { ok: false, error: 'No scenario loaded yet - re-enter the scenario by hand.' }
  // mode=challenge on the final jump so the next run counts on the leaderboard.
  // It also starts the run instantly - the URI API has no "challenge but idle"
  // option, so the player presses their own reset bind when ready (a reset or
  // abandoned run costs nothing, boards keep the best score).
  if (parking) {
    shell.openExternal(scenarioLink(parking, false))
    setTimeout(() => shell.openExternal(scenarioLink(scenario, true)), REENTER_HOP_MS)
  } else {
    // only one scenario in the whole history: a direct jump reloads nothing if
    // the player is already in it, but it's all we have
    shell.openExternal(scenarioLink(scenario, true))
  }
  return { ok: true, scenario, hopped: !!parking }
}

// Full game restart - the only thing that makes sens and DPI take effect, since
// the game reads PrimaryUserSettings.json at launch and nothing else re-reads it
// (verified: it rewrites that file from memory on settings interactions but never
// reads it back, and the weaponsettings sens fields are ignored on the
// scenario-entry reload). Close -> flush the queued fields while closed -> one
// deep link, which Steam uses to BOTH launch the game and jump to the scenario.
const CLOSE_POLL_MS = 500
const CLOSE_TIMEOUT_MS = 20000

function closeGame() {
  // WM_CLOSE, not /F: a graceful close lets the game write its own state, and the
  // pending flush lands after it exits so our values win. A force kill risks
  // losing the player's unsaved stats for no benefit.
  return new Promise((resolve) => {
    execFile('taskkill', ['/IM', k.GAME_EXE], { windowsHide: true }, () => resolve())
  })
}

function waitForExit() {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      execFile('tasklist', k.TASKLIST_ARGS, { windowsHide: true }, (err, out) => {
        if (err || !k.tasklistSaysRunning(out)) return resolve(true)
        if (Date.now() - started > CLOSE_TIMEOUT_MS) return resolve(false)
        setTimeout(tick, CLOSE_POLL_MS)
      })
    }
    tick()
  })
}

// A restart takes tens of seconds and the hotkeys stay live throughout, so a
// second press must not start an overlapping close/relaunch pair - that could
// kill the copy Steam just started, or double-launch.
let restartInFlight = false

async function doRestartGame() {
  if (restartInFlight) return { ok: false, error: 'A restart is already in progress.' }
  if (!gameRunning()) return { ok: false, error: "KovaaK's isn't running." }
  restartInFlight = true
  try {
    return await restartGameInner()
  } finally {
    restartInFlight = false
  }
}

async function restartGameInner() {
  // Read the scenario BEFORE closing: session.sav is the running game's, and
  // what's on disk after it quits is whatever it last wrote.
  const [scenario] = reenterTargets(findInstall())
  await closeGame()
  if (!(await waitForExit())) {
    log('restart: game did not close within timeout')
    return { ok: false, error: "KovaaK's didn't close - it may be showing a prompt. Close it and the queued settings apply automatically." }
  }
  gameRunningCache = false
  // now that the game is gone, the queued sens/DPI/theme can actually land
  flushPendingIfPossible()
  log('restart: relaunching', scenario || '(no scenario)')
  if (!scenario) {
    shell.openExternal(`steam://run/${STEAM_APP_ID}`)
    return { ok: true, scenario: null }
  }
  // no parking hop needed: a fresh launch loads the scenario for the first time
  shell.openExternal(scenarioLink(scenario, true))
  return { ok: true, scenario }
}

// What an apply should do to make itself take effect. Replaces the old
// autoRestart boolean; 'reenter' is its equivalent.
const APPLY_MODES = new Set(['manual', 'reenter', 'restart'])
function applyMode() {
  const s = loadSettings()
  if (APPLY_MODES.has(s.applyMode)) return s.applyMode
  return s.autoRestart ? 'reenter' : 'manual'
}

// Run the configured follow-up after an apply. `result` is doApplyPreset's.
// Only escalates when there's something for that step to make live: re-entry is
// pointless without a weaponsettings change, and a restart is only worth its
// ~40s when a game-owned field is actually queued.
async function runApplyFollowUp(result) {
  if (!result.running) return { mode: 'manual' }
  const mode = applyMode()
  // Restart ONLY for fields that genuinely need a launch (result.queued). A
  // crosshair/sound-only change is fully covered by a scenario re-entry, so
  // escalating to a ~40s relaunch for it would be pure cost - hence `queued`
  // here and not `queued || weaponChanged`.
  if (mode === 'restart' && result.queued) {
    const r = await doRestartGame()
    return { mode: 'restart', ok: r.ok, error: r.error, scenario: r.scenario }
  }
  if ((mode === 'reenter' || mode === 'restart') && result.weaponChanged) {
    const r = await doRestartScenario()
    return { mode: 'reenter', ok: r.ok, error: r.error, scenario: r.scenario }
  }
  return { mode: 'manual' }
}

// ---- pending (game-owned files queued while the game runs) --------------------
function setPending(pending) {
  // atomic: pending.json holds the whole queued intent - a torn write would
  // drop it, or worse flush half of it into the game's files on quit
  k.writeFileAtomic(pendingFile(), JSON.stringify(pending))
}
function readPending() {
  try {
    return JSON.parse(fs.readFileSync(pendingFile(), 'utf8'))
  } catch {
    return null
  }
}
function clearPending() {
  try {
    fs.unlinkSync(pendingFile())
  } catch {}
}

// Runs on a bare 4s interval, so it must never throw: applyWeapon/applyPrimary
// read the settings files unguarded, and a Steam "verify files" or a moved
// library makes them vanish mid-session. Swallow and retry next tick - pending
// stays on disk, so nothing is lost.
let lastFlushError = ''
function flushPendingIfPossible() {
  try {
    const r = flushPending()
    lastFlushError = ''
    return r
  } catch (e) {
    // log each DISTINCT failure once, not once per 4s tick for hours
    const msg = String(e?.message || e)
    if (msg !== lastFlushError) {
      lastFlushError = msg
      log('flush failed (will retry)', e)
    }
    return false
  }
}

function flushPending() {
  // No queue at all is the overwhelmingly common tick - skip on a bare stat.
  if (!fs.existsSync(pendingFile())) return false
  const pending = readPending()
  if (!pending) return false
  // Cached first, authoritative second, and the order matters for cost: this runs
  // on a 4s timer for as long as a queue exists (hours, if the game is up), and
  // the authoritative check is a BLOCKING tasklist spawn on the main process.
  // Only the cache saying "closed" is dangerous - that's the one direction where
  // being wrong writes into a live game - so only that path pays, and it happens
  // once, because the flush it guards clears the queue.
  if (gameRunning()) return false
  if (gameRunningNow()) return false
  const install = findInstall()
  if (!install) return false
  const p = k.paths(install)
  if (pending.primaryRaw != null)
    // undo restore: put the exact captured file back
    k.writeFileAtomic(p.primary, pending.primaryRaw)
  else if (pending.primary) {
    // Re-label the proxy BEFORE pointing CurrentThemeName at the new name: the
    // two are matched against each other, and a crash between them is only
    // recoverable in this order. A file whose name nothing selects is inert; a
    // selection naming no file empties the game's theme dropdown.
    // (applyPrimary walks PRIMARY_MANAGED only, so proxyName rides along inert.)
    //
    // The re-label FAILING is the case that strands us: the Themes folder lives
    // inside the game install, so a Steam "verify integrity" can delete the
    // proxy between the apply and this flush. Rebuild it from the queued intent
    // rather than letting CurrentThemeName name a theme that doesn't exist.
    if (pending.primary.proxyName) {
      if (!k.setProxyThemeName(install, pending.primary.proxyName))
        k.writeProxyTheme(install, pending.primary, pending.primary.proxyName)
    }
    k.applyPrimary(install, pending.primary)
  }
  if (pending.ui != null) k.applyUi(install, pending.ui)
  // re-assert the weapon intent the game's exit-write may have reverted
  if (pending.weaponRaw != null) k.writeFileAtomic(p.weapon, pending.weaponRaw)
  else if (pending.weapon) k.applyWeapon(install, pending.weapon)
  log('pending flushed', Object.keys(pending))
  clearPending()
  if (win && !win.isDestroyed()) win.webContents.send('changed')
  return true
}

// ---- baseline: the user's own setup, captured before the first apply -----------
// One snapshot, taken only when none exists, so "Restore original setup" always
// returns to the state before kova companion touched anything - not one step back
// like the old per-apply undo. Cleared on restore; the next apply recaptures.
const baselineDir = () => path.join(userData(), 'baseline')
const hasBaseline = () => fs.existsSync(path.join(baselineDir(), 'weapon.bak'))

function captureBaselineIfMissing(install) {
  if (hasBaseline()) return
  const p = k.paths(install)
  const files = { weapon: p.weapon, primary: p.primary, proxy: p.proxy, ui: p.ui }
  const dir = baselineDir()
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, file] of Object.entries(files))
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, `${name}.bak`))
}

function deactivatePresets() {
  if (!hasBaseline()) return { ok: false, error: 'Nothing to restore.' }
  const dir = baselineDir()
  const install = requireInstall()
  const p = k.paths(install)
  const running = gameRunning()
  const read = (n) => {
    const f = path.join(dir, n)
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
  }
  // weapon + proxy theme are safe to write any time
  const weapon = read('weapon.bak')
  if (weapon != null) k.writeFileAtomic(p.weapon, weapon)
  const proxy = read('proxy.bak')
  if (proxy != null) k.writeFileAtomic(p.proxy, proxy)
  // game-owned files follow the closed-game rule
  const primaryRaw = read('primary.bak')
  const ui = read('ui.bak')
  let queued = false
  if (running) {
    // A restore supersedes EVERYTHING queued - start from an empty pending, or
    // a leftover intent with no baseline counterpart (e.g. a queued HUD layout
    // when no UI.json existed at capture) would re-apply part of it after the
    // restore, on game quit.
    const pending = {}
    if (weapon != null) pending.weaponRaw = weapon
    if (primaryRaw != null) pending.primaryRaw = primaryRaw
    if (ui != null) pending.ui = ui
    setPending(pending)
    queued = primaryRaw != null || ui != null
  } else {
    clearPending() // same reasoning - drop any not-yet-flushed preset intents
    if (primaryRaw != null) k.writeFileAtomic(p.primary, primaryRaw)
    if (ui != null) k.applyUi(install, ui)
  }
  fs.rmSync(dir, { recursive: true, force: true }) // restored - next apply recaptures
  log('restored original setup', { running, queued })
  return { ok: true, queued }
}

// ---- preset apply (shared by IPC and hotkeys) ---------------------------------
function doApplyPreset(preset) {
  const install = requireInstall()
  const running = gameRunningNow()
  captureBaselineIfMissing(install)
  const weaponChanged = k.applyWeapon(install, preset.weapon)

  const activePrimary = k.readPrimary(install)
  // Sens and DPI have no live route at all - the game reads them only at launch
  // (see setSensPick). Unlike the theme, no in-game gesture picks them up, so a
  // changed value would otherwise sit there silently doing nothing. Report which
  // ones changed so the UI can say so instead of the player discovering it.
  // Carries the VALUE, not just the field name: the other way to apply these is
  // to type them into the game's own settings screen (which does take effect
  // immediately), so the UI can only offer that if it can tell you what to type.
  // Number.isFinite guards both ends: an imported/corrupt preset carrying a
  // non-numeric sens would otherwise surface as a literal "sens NaN" in the UI,
  // since NaN !== anything makes the difference check always true.
  const launchOnly = []
  const changedNum = (want, cur) =>
    Number.isFinite(Number(want)) && Number(want) !== Number(cur)
  const wantSens = preset.primary?.floatSettings?.XSens
  if (wantSens !== undefined && changedNum(wantSens, activePrimary.floatSettings?.XSens))
    launchOnly.push({ field: 'sens', value: Number(wantSens) })
  const wantDpi = preset.primary?.integerSettings?.DPI
  if (wantDpi !== undefined && changedNum(wantDpi, activePrimary.integerSettings?.DPI))
    launchOnly.push({ field: 'DPI', value: Number(wantDpi) })

  // primaryDiffers compares against PrimaryUserSettings.json ON DISK - except for
  // theme fields while the proxy is selected, which it compares against the proxy
  // file, because that's what the game is actually rendering (see the note there).
  // The settings file is only the truth while the game is CLOSED - a running game
  // owns those fields in memory and rewrites the file from them. So this answers
  // "is there a change to report", NOT "is there anything to write": a preset
  // whose sens already matches disk still has to be re-asserted after the game
  // quits, or the game's own rewrite puts the launch-time value back and the pick
  // silently does nothing. That was the other half of the intermittent sens - the
  // half a fresh running-check can't fix.
  const primaryChanged = k.primaryDiffers(install, preset.primary)
  let primaryIntent = null
  if (preset.primary) {
    primaryIntent = structuredClone(preset.primary)
    if (!primaryIntent.stringSettings) primaryIntent.stringSettings = {}
    if (primaryChanged) {
      // The proxy's name mirrors the preset's theme so overlays and the in-game
      // menu read something meaningful - but the name is the game's selection
      // key, bound in memory at launch, so it can only move while the game is
      // CLOSED (see the PROXY_THEME notes in kovaaks.js). Running: rewrite the
      // contents under the EXISTING name, and queue the new one for the quit
      // flush. Closed: both move together, right now.
      const wantName = k.proxyThemeName(preset.primary.stringSettings?.CurrentThemeName)
      k.writeProxyTheme(install, preset.primary, running ? k.readProxyName(install) : wantName)
      primaryIntent.stringSettings.CurrentThemeName = wantName
      // The flush re-labels the file to match; without this the queued
      // CurrentThemeName would land on a proxy still carrying the old name and
      // the game would boot with an empty theme selection.
      primaryIntent.proxyName = wantName
    } else {
      // Nothing visibly differs, so don't touch theme SELECTION. On the proxy
      // that's because it already renders this preset's theme (the check reads
      // the proxy file, not the stale settings one); off it, the proxy still
      // holds whatever the last apply wrote and pinning the game to it here
      // would hand the player a different preset's theme. Either way this intent
      // exists purely to survive the game's exit rewrite.
      delete primaryIntent.stringSettings.CurrentThemeName
    }
  }
  const wantPrimary = primaryChanged ? primaryIntent : null

  let theme = 'nochange'
  if (running) {
    // The game rewrites weaponsettings.ini from memory on exit, so an apply it
    // never re-read (no scenario re-entry) gets reverted at quit. Queue the
    // intent; the quit flush re-asserts it.
    //
    // REPLACE the queue, don't merge into it: a preset is a total intent, and a
    // field this preset leaves alone (nothing to write, the disk already
    // matches) would otherwise keep the PREVIOUS preset's queued value and land
    // that on game quit - e.g. apply a dark preset, then a light one whose theme
    // equals the on-disk one, and the dark theme still applies at quit.
    //
    // The exception is a field presets carry NOTHING for: a HUD layout saved
    // from the editor mid-session (pending.ui) is its own intent and stands.
    const prev = readPending() || {}
    const next = { weapon: preset.weapon, primary: primaryIntent }
    if (prev.ui != null) next.ui = prev.ui
    setPending(next)
    if (wantPrimary) theme = k.proxyThemeSelected(install) ? 'live' : 'arming'
  } else if (wantPrimary) {
    k.applyPrimary(install, wantPrimary)
    clearPending()
    theme = 'applied'
  }
  // `queued` = game-owned fields (theme/sens/DPI) waiting on the game to close.
  // Only a full restart makes those live, so it gates that escalation.
  const queued = running && !!wantPrimary
  const result = { weaponChanged, theme, running, queued, launchOnly }
  log('apply', preset.name || '(unnamed)', result)
  return result
}

// ---- global hotkeys -----------------------------------------------------------
// Apply + configured follow-up + renderer toast, shared by the two background
// surfaces (global hotkey, tray click). Both happen while the game has focus,
// so the follow-up is what makes the apply hands-off, and errors have nowhere
// to surface - the window may be hidden.
async function applyAndNotify(preset) {
  try {
    const result = doApplyPreset(preset)
    const followUp = await runApplyFollowUp(result)
    if (win && !win.isDestroyed())
      win.webContents.send('hotkey-applied', { name: preset.name, ...result, followUp })
  } catch {
    // install missing mid-session - nothing sane to do in the background
  }
}

function registerHotkeys() {
  globalShortcut.unregisterAll()
  const presets = store.load(userData())
  for (const preset of presets) {
    if (!preset.hotkey) continue
    try {
      globalShortcut.register(preset.hotkey, () => {
        // Re-read by id instead of closing over the loaded object: only
        // delete/setHotkey re-register, so editing a preset (build/update/
        // updateWeapon/rename) would otherwise leave the hotkey applying the
        // preset as it looked when hotkeys were last registered.
        const fresh = store.load(userData()).find((x) => x.id === preset.id)
        if (fresh) applyAndNotify(fresh)
      })
    } catch {
      // invalid accelerator string - ignore, the UI validates on record
    }
  }
}

// Overlay one primary-shaped object's fields onto another, section by section.
function overlayPrimary(base, overlay) {
  for (const [section, fields] of Object.entries(overlay)) {
    if (!base[section]) base[section] = {}
    Object.assign(base[section], fields)
  }
}

// ---- presets migration (v1 flat shape -> nested) ------------------------------
function loadPresetsMigrated(install) {
  const presets = store.load(userData())
  let changed = false
  for (const p of presets) {
    if (!p.primary || p.primary.stringSettings) continue
    const flat = p.primary
    const base = structuredClone(k.readPrimary(install))
    const fromTheme = flat.CurrentThemeName ? k.primaryFromTheme(install, flat.CurrentThemeName) : null
    if (fromTheme) overlayPrimary(base, fromTheme)
    for (const key of [
      'CurrentThemeName',
      'KillConfirmedSound',
      'SpawnSound',
      'MBSGoodSound',
      'MBSOkaySound',
      'MBSBadSound',
      'MBSChangeNowSound',
    ])
      if (flat[key] !== undefined) base.stringSettings[key] = flat[key]
    p.primary = base
    changed = true
  }
  // Presets built while sens was thought to apply live carry only the
  // weaponsettings override (OverrideSens=true), which the game ignores - so
  // their sens silently did nothing. Move the value they already hold onto the
  // route that works (XSens/YSens) and clear the override, which would otherwise
  // shadow it at launch. The scale falls back to the live one, which is how that
  // unpinned number was already being read, so no speeds change.
  let active = null
  for (const p of presets) {
    const h = p.weapon?.HorizontalSens
    if (String(p.weapon?.OverrideSens).toLowerCase() !== 'true' || h == null || h === '') continue
    const sens = Number(h)
    if (!Number.isFinite(sens) || sens <= 0) continue
    if (!active) active = { primary: k.readPrimary(install) }
    p.primary = p.primary || {}
    k.setSensPick(p.weapon, p.primary, sens, k.sensScaleOf(p.primary, active))
    changed = true
  }
  if (changed) store.save(userData(), presets)
  return presets
}

// ---- tray -----------------------------------------------------------------------
// The menu is built fresh on every right-click (there's no "before show" hook on
// Windows), so it always reflects the current preset list.
function trayMenu() {
  const presets = store.load(userData())
  const items = presets.slice(0, 12).map((p) => ({
    label: p.hotkey ? `${p.name}  (${p.hotkey})` : p.name,
    click: () => applyAndNotify(p),
  }))
  return Menu.buildFromTemplate([
    ...(items.length ? items : [{ label: 'No presets yet', enabled: false }]),
    { type: 'separator' },
    // The window can go unopened for days, so the staged update needs a route
    // that doesn't depend on anyone looking at it.
    ...(updateReady
      ? [{ label: `Restart to update to ${updateReady}`, click: () => installUpdate() }]
      : []),
    { label: 'Open kova companion', click: showWindow },
    // support surface: "sens didn't apply" reports come with a file to look at
    ...(logger.logPath()
      ? [{ label: 'Open log file', click: () => shell.showItemInFolder(logger.logPath()) }]
      : []),
    { label: 'Quit', click: () => app.quit() },
  ])
}

// Kovi in the tray: awake while KovaaK's runs, asleep (grey) otherwise, like the
// title bar. PNGs with @1.25x / @1.5x / @2x siblings - Electron picks the one for
// the display scale. The 16px one is a chunkier drawing, so it reads at tray size.
const trayIcon = (running) => path.join(__dirname, 'assets', running ? 'tray-awake.png' : 'tray-asleep.png')
let trayAwake = null
function updateTrayIcon() {
  if (!tray || trayAwake === !!gameRunningCache) return
  trayAwake = !!gameRunningCache
  tray.setImage(trayIcon(trayAwake))
}

function createTray() {
  try {
    trayAwake = !!gameRunningCache
    tray = new Tray(trayIcon(trayAwake))
  } catch (e) {
    // The old .ico didn't decode off Windows, and this used to throw straight out of
    // whenReady - taking auto-update, the pending flush and hotkey registration
    // with it, leaving a macOS/Linux dev run half-booted with no visible reason.
    // The app is shipped for Windows; elsewhere it just runs without a tray.
    log('tray unavailable (expected off Windows)', e)
    return
  }
  tray.setToolTip('kova companion')
  tray.on('click', showWindow)
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()))
}

// ---- IPC ----------------------------------------------------------------------
// Applies made while the game runs sit in pending.json until the game quits,
// so the files still hold the old values. Merge the queued intent into the
// reported state or the UI forgets what was applied (worst after an app
// restart, when nothing else hints at it). Capture/build read through this
// too, so they snapshot what the user SEES as active, not stale disk state.
function readActiveMerged(install) {
  const active = k.readActive(install)
  const pending = readPending()
  if (pending) {
    if (pending.primary && active.primary)
      for (const [section, fields] of Object.entries(pending.primary))
        active.primary[section] = { ...(active.primary[section] || {}), ...fields }
    if (pending.ui != null) active.ui = pending.ui
    if (pending.weapon) active.weapon = { ...active.weapon, ...pending.weapon }
  }
  return { active, pending: !!pending }
}

ipcMain.handle('state', (_e, opts) => {
  const install = findInstall(opts?.rescan)
  if (!install) return { install: null, appVersion: app.getVersion() }
  const { active, pending } = readActiveMerged(install)
  return {
    install,
    appVersion: app.getVersion(),
    gameRunning: gameRunning(),
    active,
    // What the proxy theme file actually holds - the renderer matches theme
    // identity against this while the game is on the proxy, because the game
    // rewrites PrimaryUserSettings.json from launch-time memory and its theme
    // fields go stale the moment a preset is applied live.
    proxyPrimary: k.readProxyPrimary(install),
    updateReady,
    options: listOptionsCached(install, opts?.rescan),
    presets: loadPresetsMigrated(install),
    pending: !!pending,
    resolution: k.readResolution(),
    canRestore: hasBaseline(),
  }
})

ipcMain.handle('presets:capture', (_e, name) => {
  const install = requireInstall()
  const presets = store.load(userData())
  const { active } = readActiveMerged(install)
  presets.push({ id: store.newId(), name: name || 'New preset', weapon: active.weapon, primary: active.primary })
  store.save(userData(), presets)
  return presets
})

// Theme files carry material STRINGS but not the WallMat/FloorMat INDEX
// fields, so overlaying a theme pick would leave the previous theme's indices
// riding along and fighting the new materials on the launch path. Drop them -
// the game re-derives and rewrites them itself when it loads the theme.
function dropStaleMaterialIndices(primary) {
  if (!primary.integerSettings) return
  delete primary.integerSettings.WallMat
  delete primary.integerSettings.FloorMat
}

// Sens/DPI both need a positive number; an empty field means "keep current".
const validPick = (v) => v != null && Number.isFinite(Number(v)) && Number(v) > 0

// Overlay the builder's picks onto a weapon+primary pair, mutating both - the
// shared half of preset create (onto a snapshot of the active setup) and preset
// edit (onto the preset's own data). Empty pick = keep. `activeForScale` gives
// a sens pick its scale when `primary` carries none of its own.
function applyPicks(install, weapon, primary, picks, activeForScale) {
  if (picks.crosshair) weapon.CrosshairFile = picks.crosshair
  if (picks.crosshairScale > 0) weapon.CrosshairScale = String(picks.crosshairScale)
  if (picks.crosshairColor) weapon.CrosshairColor = picks.crosshairColor
  if (picks.bodyHit != null) weapon.BodyHitSound = picks.bodyHit
  if (picks.theme) {
    const fromTheme = k.primaryFromTheme(install, picks.theme)
    if (fromTheme) {
      overlayPrimary(primary, fromTheme)
      dropStaleMaterialIndices(primary)
    }
  }
  if (picks.killSound != null) {
    if (!primary.stringSettings) primary.stringSettings = {}
    primary.stringSettings.KillConfirmedSound = picks.killSound
  }
  if (validPick(picks.dpi)) {
    if (!primary.integerSettings) primary.integerSettings = {}
    primary.integerSettings.DPI = Math.round(Number(picks.dpi))
  }
  // after the theme overlay, so a theme pick can't drop the sens fields
  if (validPick(picks.sens))
    k.setSensPick(weapon, primary, Number(picks.sens), k.sensScaleOf(primary, activeForScale))
}

ipcMain.handle('presets:build', (_e, picks) => {
  const install = requireInstall()
  const { active } = readActiveMerged(install)
  const weapon = { ...active.weapon }
  const primary = structuredClone(active.primary)
  applyPicks(install, weapon, primary, picks, active)
  const presets = store.load(userData())
  presets.push({ id: store.newId(), name: picks.name || 'New preset', weapon, primary })
  store.save(userData(), presets)
  return presets
})

// Edit an existing preset: same picks shape as presets:build, but applied on
// top of the preset's own data.
ipcMain.handle('presets:update', (_e, id, picks) => {
  const install = requireInstall()
  const presets = store.load(userData())
  const p = presets.find((x) => x.id === id)
  if (!p) return presets
  if (picks.name) p.name = String(picks.name).slice(0, 80)
  p.weapon = p.weapon || {}
  p.primary = p.primary || {}
  applyPicks(install, p.weapon, p.primary, picks, readActiveMerged(install).active)
  store.save(userData(), presets)
  return presets
})

ipcMain.handle('presets:delete', (_e, id) => {
  const presets = store.load(userData()).filter((p) => p.id !== id)
  store.save(userData(), presets)
  registerHotkeys()
  return presets
})

ipcMain.handle('presets:rename', (_e, id, name) => {
  const presets = store.load(userData())
  const p = presets.find((x) => x.id === id)
  if (p) p.name = name
  store.save(userData(), presets)
  return presets
})

ipcMain.handle('presets:updateWeapon', (_e, id, patch) => {
  const presets = store.load(userData())
  const p = presets.find((x) => x.id === id)
  if (p) p.weapon = { ...p.weapon, ...patch }
  store.save(userData(), presets)
  return presets
})

ipcMain.handle('presets:duplicate', (_e, id) => {
  const presets = store.load(userData())
  const i = presets.findIndex((x) => x.id === id)
  if (i >= 0) {
    const copy = structuredClone(presets[i])
    copy.id = store.newId()
    copy.name = `${copy.name} copy`
    delete copy.hotkey // hotkeys stay unique to the original
    presets.splice(i + 1, 0, copy)
    store.save(userData(), presets)
  }
  return presets
})

ipcMain.handle('presets:reorder', (_e, orderedIds) => {
  const presets = store.load(userData())
  presets.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id))
  store.save(userData(), presets)
  return presets
})

ipcMain.handle('presets:setHotkey', (_e, id, hotkey) => {
  const presets = store.load(userData())
  for (const p of presets) {
    if (p.id === id) p.hotkey = hotkey || undefined
    else if (hotkey && p.hotkey === hotkey) p.hotkey = undefined // steal = move
  }
  store.save(userData(), presets)
  registerHotkeys()
  return presets
})

// By id, not by object: what gets written to the game's files is whatever the
// store holds, so the renderer can't define it. Same lookup the hotkey path
// does, so both apply exactly the same thing.
ipcMain.handle('preset:apply', async (_e, id) => {
  const preset = store.load(userData()).find((p) => p.id === id)
  if (!preset) throw new Error('That preset no longer exists.')
  const result = doApplyPreset(preset)
  return { ...result, followUp: await runApplyFollowUp(result) }
})

ipcMain.handle('presets:deactivate', () => deactivatePresets())

ipcMain.handle('game:restart', () => doRestartScenario())
ipcMain.handle('game:restartFull', () => doRestartGame())

// Diagnostics for the health panel + first-run wizard. Uses the cached install
// (findInstall) and write-probes the settings folders, so it's a user-driven
// call, never on the state poll path.
ipcMain.handle('health:check', () => k.checkHealth(findInstall()))

// Create the !KovaPreset proxy theme file up front (first-run "arm live themes"
// step), so it shows in KovaaK's theme list before any preset has been applied.
// Seeded from the current setup, so selecting it changes nothing until a preset
// with a theme is applied. No-op if it already exists.
ipcMain.handle('proxy:ensure', () => {
  const install = findInstall()
  if (!install) return { ok: false, error: "KovaaK's install not found." }
  try {
    const p = k.paths(install)
    fs.mkdirSync(p.themes, { recursive: true })
    if (fs.existsSync(p.proxy)) return { ok: true, existed: true }
    k.writeProxyTheme(install, k.readPrimary(install))
    return { ok: true, existed: false }
  } catch {
    return { ok: false, error: 'Could not create the proxy theme file.' }
  }
})

ipcMain.handle('win:minimize', () => win?.minimize())
ipcMain.handle('win:devtools', () => win?.webContents.toggleDevTools())
ipcMain.handle('win:close', () => win?.close()) // routes through close-to-tray
// Programmatic reload: it never fires will-navigate, so the guard below can't
// block it - unlike a renderer location.reload(), whose URL-string match is
// fragile (Windows file:// casing, transient getURL()).
ipcMain.handle('win:reload', () => win?.webContents.reload())

// applyMode goes out RESOLVED (the stored value may be absent pre-migration, see
// applyMode()) so the renderer never re-implements the autoRestart fallback.
ipcMain.handle('settings:get', () => ({ ...loadSettings(), applyMode: applyMode() }))

ipcMain.handle('settings:set', (_e, patch) => {
  const s = { ...loadSettings(), ...patch }
  saveSettings(s)
  return s
})

// ---- kova account + setup sync -------------------------------------------------
// Sign-in is kova's device-code grant: the app gets a short code, the user
// approves it on kova.page/login/companion while signed in with Discord (the app never
// sees Discord credentials), and the poll comes back with a kova session token.
// That token is stored encrypted with the OS keystore (DPAPI on Windows) and
// sent as a Bearer. The sync then posts the live in-game setup (core/companion.js)
// whenever the game's settings files change - never scores or ranks.
const KOVA_URL = process.env.KOVA_URL || 'https://kova.page' // KOVA_URL=http://localhost:3000 for dev
const KOVA_CLIENT_ID = 'kova-companion'
const kovaAuthFile = () => path.join(userData(), 'kova-auth.bin')
let kovaToken = null
let kovaUser = null // { username, name, avatarUrl, rank } once /me answered
let kovaSignIn = null // { userCode, url, cancel } while a sign-in is pending

function loadKovaToken() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(fs.readFileSync(kovaAuthFile()))
  } catch {
    return null
  }
}
function saveKovaToken(token) {
  kovaToken = token
  // atomic: a crash mid-write must not leave a half token that signs you out
  if (token) k.writeFileAtomic(kovaAuthFile(), safeStorage.encryptString(token))
  else fs.rmSync(kovaAuthFile(), { force: true })
}

async function kovaFetch(pathname, { method = 'GET', body, token = kovaToken } = {}) {
  try {
    return await fetch(`${KOVA_URL}${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(10000),
    })
  } catch (e) {
    log('kova request failed', pathname, e?.message)
    return null // offline / kova down - every caller treats it as "try later"
  }
}

const kovaNotify = () => win?.webContents.send('kova-changed')
const kovaSyncOn = () => loadSettings().kovaSync !== false

// Signed out from kova's side (expired, revoked, banned): forget the token so the
// app stops posting and shows Sign in again.
function kovaForget() {
  saveKovaToken(null)
  kovaUser = null
  stopKovaSync()
  // Everything that belonged to that account: a later sign-in (maybe someone
  // else) starts clean - snipes baseline again instead of replaying old PBs.
  clearInterval(kovaLiveTimer)
  kovaLiveTimer = null
  clearTimeout(kovaLiveOffTimer)
  clearTimeout(tourneyTimer)
  clearTimeout(snipeTimer)
  tourneyData = null
  challengeData = null
  progressBench = null
  rankSession = null
  snipesSeen.clear()
  const s = loadSettings()
  delete s.snipeCursor
  saveSettings(s)
  kovaNotify()
}

async function refreshKovaUser() {
  const res = await kovaFetch('/api/companion/me')
  if (res?.status === 401) return kovaForget()
  if (!res?.ok) return // offline: keep the cached user, retry on the next start
  const me = await res.json().catch(() => null) // an error page, not JSON
  if (!me?.username) return
  kovaUser = {
    username: me.username,
    name: me.name,
    // relative upload paths come back as-is, so anchor them to kova
    avatarUrl: me.avatarUrl ? new URL(me.avatarUrl, KOVA_URL).href : null,
    rank: me.rank?.name ? { name: me.rank.name, benchmark: me.rank.benchmark, color: me.rank.color } : null,
  }
  kovaNotify()
}

// ---- sync: watch the game's settings, post the setup when it changed ----
let kovaWatcher = null
let kovaTimer = null
let kovaLastSent = ''
let kovaPosting = Promise.resolve()
const KOVA_RETRY_MS = 60_000
// The files setupPayload reads. SaveGames also holds files the game rewrites
// constantly while running (session.sav), and reacting to those would keep
// resetting the debounce below, so the post could never fire mid-session.
const KOVA_WATCHED = /^(weaponsettings\.ini|PrimaryUserSettings\.json|Themes[\\/].*)$/i
// ---- live on stream: is KovaaK's running right now? -------------------------------
// The overlay shows the KovaaK's slide only while the game runs. The app says so
// when it starts, every 5 minutes while it runs (kova lets the slide go 10 minutes
// after the last ping, so a crash or a PC switched off can't leave it up), and
// when it closes - 90s late, so a restart (applying a preset) doesn't make the
// slide blink off and on.
const KOVA_LIVE_MS = 5 * 60 * 1000
const KOVA_LIVE_OFF_DELAY_MS = 90 * 1000
let kovaLiveTimer = null
let kovaLiveOffTimer = null
function postKovaLive(running) {
  if (!kovaToken) return Promise.resolve()
  return kovaFetch('/api/companion/live', { method: 'POST', body: JSON.stringify({ running }) })
    .then((r) => r?.status === 401 && kovaForget())
    .catch(() => {})
}
function kovaLiveStart() {
  clearTimeout(kovaLiveOffTimer)
  if (kovaLiveTimer || !kovaToken || !kovaSyncOn()) return
  postKovaLive(true)
  kovaLiveTimer = setInterval(() => postKovaLive(true), KOVA_LIVE_MS)
}
function kovaLiveStop({ now = false } = {}) {
  const wasLive = !!kovaLiveTimer
  clearInterval(kovaLiveTimer)
  kovaLiveTimer = null
  clearTimeout(kovaLiveOffTimer)
  if (!wasLive) return Promise.resolve()
  if (now) return postKovaLive(false)
  kovaLiveOffTimer = setTimeout(() => postKovaLive(false), KOVA_LIVE_OFF_DELAY_MS)
  return Promise.resolve()
}

function stopKovaSync() {
  clearTimeout(kovaTimer)
  kovaWatcher?.close()
  kovaWatcher = null
  kovaLastSent = ''
}
const scheduleKovaPush = (ms) => {
  clearTimeout(kovaTimer)
  kovaTimer = setTimeout(pushKovaSetup, ms)
}
// One post at a time, so an older payload can never land after a newer one.
function pushKovaSetup() {
  kovaPosting = kovaPosting.then(postKovaSetup, postKovaSetup)
  return kovaPosting
}
async function postKovaSetup() {
  const install = findInstall()
  if (!install || !kovaToken || !kovaSyncOn()) return
  let body
  try {
    body = JSON.stringify(companion.setupPayload(install, readPending()?.primary?.proxyName))
  } catch {
    return // a half-written settings file - the next watch event brings the good one
  }
  // The game rewrites its files with identical content on every menu visit; only
  // a real change is worth a request (and an overlay reload on stream).
  if (body === kovaLastSent) return
  const res = await kovaFetch('/api/companion/setup', { method: 'POST', body })
  if (res?.status === 401) return kovaForget()
  if (res?.ok) kovaLastSent = body
  // Offline, kova down, rate-limited: try again in a minute, so an app started
  // before the network was up still gets the overlay current. A settings change
  // in between reschedules it sooner.
  else if (kovaWatcher) scheduleKovaPush(KOVA_RETRY_MS)
}
// ponytail: bound to the install found at start; a moved install (re-scan) is
// picked up on the next app start. Rebind on rescan if that ever matters.
function startKovaSync() {
  stopKovaSync()
  const install = findInstall()
  if (!install || !kovaToken || !kovaSyncOn()) return
  try {
    // The directory, not the files: both are written atomically (temp + rename),
    // which strands a per-file watch on a dead inode after the first write.
    kovaWatcher = fs.watch(k.paths(install).saveGames, { recursive: true }, (_type, name) => {
      // no name (some platforms, overflow): can't tell, so treat it as relevant
      if (name && !KOVA_WATCHED.test(String(name))) return
      scheduleKovaPush(1500) // one post per burst of writes
    })
    kovaWatcher.on('error', () => {}) // folder gone mid-session (Steam verify) - sync just pauses
  } catch {
    kovaWatcher = null
  }
  pushKovaSetup()
}

// ---- sign-in (device code) ----
async function startKovaSignIn() {
  kovaSignIn?.cancel()
  const res = await kovaFetch('/api/auth/device/code', {
    method: 'POST',
    token: null,
    body: JSON.stringify({ client_id: KOVA_CLIENT_ID }),
  })
  const grant = res?.ok ? await res.json().catch(() => null) : null
  if (!grant?.user_code) return { ok: false, error: "Couldn't reach kova. Check your connection and try again." }
  let interval = (grant.interval || 5) * 1000
  const expires = Date.now() + (grant.expires_in || 600) * 1000
  let timer = null
  const pending = {
    userCode: grant.user_code,
    // the approval page, and only ever on kova itself: this is a server answer
    // that ends up in the browser
    url: [grant.verification_uri_complete, grant.verification_uri].find((u) => {
      try {
        return new URL(u).origin === new URL(KOVA_URL).origin
      } catch {
        return false
      }
    }) || `${KOVA_URL}/login/companion`,
    cancel: () => {
      clearTimeout(timer)
      if (kovaSignIn === pending) kovaSignIn = null
    },
  }
  kovaSignIn = pending
  const poll = async () => {
    if (kovaSignIn !== pending) return
    if (Date.now() > expires) {
      pending.cancel()
      return kovaNotify()
    }
    const r = await kovaFetch('/api/auth/device/token', {
      method: 'POST',
      token: null,
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: KOVA_CLIENT_ID,
      }),
    })
    if (kovaSignIn !== pending) return
    const data = r ? await r.json().catch(() => ({})) : {}
    if (r?.ok && data.access_token) {
      pending.cancel()
      saveKovaToken(data.access_token)
      await refreshKovaUser()
      startKovaSync()
      loadTournaments().catch(() => {}).finally(scheduleTournaments)
      if (gameRunningCache) kovaLiveStart()
      scheduleSnipes(10 * 1000) // after the "Connected" toast, not over it
      return kovaNotify()
    }
    // RFC 8628: keep polling while pending, back off on slow_down, stop on anything final
    if (data.error === 'slow_down') interval += 5000
    else if (r && data.error !== 'authorization_pending') {
      pending.cancel()
      return kovaNotify()
    }
    timer = setTimeout(poll, interval)
  }
  timer = setTimeout(poll, interval)
  shell.openExternal(pending.url)
  return { ok: true, userCode: pending.userCode }
}

const kovaState = () => ({
  signedIn: !!kovaToken,
  user: kovaUser,
  sync: kovaSyncOn(),
  snipes: loadSettings().snipeAlerts,
  pbPopups: loadSettings().pbPopups,
  signingIn: kovaSignIn ? kovaSignIn.userCode : null,
})

ipcMain.handle('kova:get', () => kovaState())
ipcMain.handle('kova:signIn', async () => {
  if (!safeStorage.isEncryptionAvailable())
    return { ok: false, error: "This PC can't store the sign-in securely, so kova sign-in is off." }
  return startKovaSignIn()
})
ipcMain.handle('kova:cancelSignIn', () => {
  kovaSignIn?.cancel()
  return kovaState()
})
ipcMain.handle('kova:signOut', async () => {
  // Best effort on kova's side too, so the session leaves the account page; and
  // the overlay's KovaaK's slide goes now, not 10 minutes later.
  await kovaLiveStop({ now: true })
  if (kovaToken) await kovaFetch('/api/auth/sign-out', { method: 'POST', body: '{}' })
  kovaForget()
  return kovaState()
})
ipcMain.handle('kova:setPbPopups', (_e, on) => {
  saveSettings({ ...loadSettings(), pbPopups: !!on })
  return kovaState()
})
ipcMain.handle('kova:setSnipes', (_e, on) => {
  saveSettings({ ...loadSettings(), snipeAlerts: !!on })
  return kovaState()
})
ipcMain.handle('kova:setSync', (_e, on) => {
  saveSettings({ ...loadSettings(), kovaSync: !!on })
  if (on) {
    startKovaSync()
    if (gameRunningCache) kovaLiveStart()
  } else {
    stopKovaSync()
    kovaLiveStop({ now: true })
  }
  return kovaState()
})
// The only kova pages the renderer may open: your profile, and the overlay setup.
ipcMain.handle('kova:open', (_e, where) => {
  const target =
    where === 'overlay' ? '/dashboard/overlay' : where === 'profile' && kovaUser ? `/${kovaUser.username}` : null
  if (target) shell.openExternal(`${KOVA_URL}${target}`)
})

// ---- rank progress ---------------------------------------------------------------
// The page model: kova's benchmark playlist (thresholds + verified bests) with the
// local runs layered on (core/progress.js). Runs land in <install>/stats the
// moment one ends, which is what drives the live parts: the page refresh, the
// rank-up pop-up, and advancing a rank-up session.
let progressBench = null // kova's last payload, for rank-up detection between page loads
let statsWatcher = null
const seenStats = new Set() // files already handled, so a rewrite never double-counts

async function loadProgress({ source, difficulty } = {}) {
  if (!kovaToken) return { ok: false, reason: 'signed-out' }
  const qs = new URLSearchParams()
  if (source) qs.set('source', source)
  if (difficulty) qs.set('difficulty', difficulty)
  const res = await kovaFetch(`/api/companion/benchmark?${qs}`)
  if (res?.status === 401) {
    kovaForget()
    return { ok: false, reason: 'signed-out' }
  }
  const bench = res?.ok ? await res.json().catch(() => null) : null
  if (!bench?.scenarios) return { ok: false, reason: 'offline' }
  // KovaaK's didn't answer: keep the verified bests we had for this benchmark
  // rather than showing a player who's played nothing
  if (bench.scoresUnavailable && progressBench?.source === bench.source && progressBench.difficulty === bench.difficulty) {
    const had = new Map(progressBench.scenarios.map((s) => [s.name, s.best]))
    for (const s of bench.scenarios) s.best ??= had.get(s.name) ?? null
  }
  progressBench = bench
  // The card shows the featured rank; opening the page is a natural moment to
  // pick up a rank-up kova has confirmed since start.
  refreshKovaUser().catch(() => {})
  const install = findInstall()
  const rows = progress.buildProgress(
    bench.scenarios,
    install ? progress.localRuns(install, bench.scenarios.map((s) => s.name)) : new Map()
  )
  startStatsWatch()
  return {
    ok: true,
    bench: { source: bench.source, label: bench.label, difficulty: bench.difficulty, difficulties: bench.difficulties, sources: bench.sources, connected: bench.connected },
    rows,
    session: progress.pickSession(rows),
    loaded: install ? k.currentScenario(install) : null,
    playing: rankSession ? { names: rankSession.names, idx: rankSession.idx } : null,
  }
}

// ---- rank-up session: launch each scenario, move on after RUNS_EACH runs ----
// Not a KovaaK's playlist: the playlist link needs an uploaded playlist's share
// code, which a list built here doesn't have. The app drives it instead, with the
// same jump-to-scenario link re-enter uses, counting finished runs from /stats.
const RUNS_EACH = 3
let rankSession = null // { names, idx, left }
function sessionStep() {
  if (!rankSession) return
  const name = rankSession.names[rankSession.idx]
  if (!name) {
    rankSession = null
    win?.webContents.send('progress-changed', { sessionDone: true })
    return
  }
  rankSession.left = RUNS_EACH
  shell.openExternal(scenarioLink(name, true))
  win?.webContents.send('progress-changed', {})
}

function onRunFinished(file, attempt = 0) {
  const install = findInstall()
  if (!install) return
  const run = progress.parseRun(path.join(install, 'stats'), file)
  // still being written (no score row yet): try again shortly, a couple of times
  if (!run) {
    if (attempt < 3) setTimeout(() => onRunFinished(file, attempt + 1), 1500)
    return
  }
  const s = progressBench?.scenarios.find((x) => x.name.toLowerCase() === run.scenario.toLowerCase())
  // The best BEFORE this run: any earlier local run, and kova's verified best
  // when the scenario is in the loaded benchmark (it can know runs this PC doesn't).
  const earlier = (progress.localRuns(install, [run.scenario]).get(run.scenario.toLowerCase()) || [])
    .filter((r) => r.ts < run.ts)
    .map((r) => r.score)
  const bests = [s?.best, ...earlier].filter((v) => v != null)
  const prevBest = bests.length ? Math.max(...bests) : null
  const crossed = s ? progress.rankUpFrom(s.thresholds, prevBest, run.score) : null
  if (crossed) {
    const info = { scenario: s.name, rank: crossed.rank, color: crossed.color || null, score: run.score, over: Math.round((run.score - crossed.score) * 10) / 10 }
    log('rank-up', info.scenario, info.rank, info.score)
    // The window usually sits in the tray mid-session: the OS toast is what's seen.
    if (!win?.isVisible() && Notification.isSupported())
      new Notification({ title: `${info.rank} on ${info.scenario}`, body: `${info.score}, ${info.over} over the line` }).show()
    win?.webContents.send('rank-up', info)
  } else if (prevBest != null && run.score > prevBest && loadSettings().pbPopups) {
    // A plain PB, same pop-up with the New PB mood. In-app only: unlike a rank-up
    // it happens often enough that an OS notification for each would be noise.
    win?.webContents.send('pb', { scenario: run.scenario, score: run.score, gain: Math.round((run.score - prevBest) * 10) / 10 })
  }
  clipRun(run, prevBest, crossed?.rank || null)
  if (rankSession && rankSession.names[rankSession.idx]?.toLowerCase() === run.scenario.toLowerCase()) {
    rankSession.left -= 1
    if (rankSession.left <= 0) {
      rankSession.idx += 1
      sessionStep()
      return
    }
  }
  win?.webContents.send('progress-changed', {})
}

function startStatsWatch() {
  if (statsWatcher) return
  const install = findInstall()
  if (!install) return
  const dir = path.join(install, 'stats')
  try {
    // Everything already there is history, not a fresh run.
    for (const f of fs.readdirSync(dir)) seenStats.add(f)
    statsWatcher = fs.watch(dir, (_type, name) => {
      if (!name || seenStats.has(name) || !k.statsFileScenario(name)) return
      seenStats.add(name)
      // the game is still writing it for a moment after the file appears
      setTimeout(() => onRunFinished(name), 500)
    })
    statsWatcher.on('error', () => {})
  } catch {
    statsWatcher = null
  }
}

ipcMain.handle('progress:get', (_e, opts) => loadProgress(opts))
// The score graph for one scenario of the loaded benchmark: its row (best, odds)
// plus the chart over `days` (30 / 90 / null = all).
ipcMain.handle('progress:scenario', (_e, name, days) => {
  const s = progressBench?.scenarios.find((x) => x.name === name)
  const install = findInstall()
  if (!s) return { ok: false }
  const runs = install ? progress.localRuns(install, [s.name]) : new Map()
  const mine = runs.get(s.name.toLowerCase()) || []
  return {
    ok: true,
    row: progress.buildProgress([s], runs)[0],
    chart: progress.scenarioChart(mine, s.thresholds, days),
  }
})
ipcMain.handle('progress:play', (_e, name) => {
  if (typeof name !== 'string' || !progressBench?.scenarios.some((s) => s.name === name)) return
  shell.openExternal(scenarioLink(name, true))
})
ipcMain.handle('progress:startSession', (_e, names) => {
  const valid = (Array.isArray(names) ? names : []).filter(
    (n) => typeof n === 'string' && progressBench?.scenarios.some((s) => s.name === n)
  )
  if (!valid.length) return null
  rankSession = { names: valid, idx: 0, left: RUNS_EACH }
  sessionStep()
  return { names: valid, idx: 0 }
})
ipcMain.handle('progress:stopSession', () => {
  rankSession = null
})

// ---- sessions (history + recap) ---------------------------------------------------
// Every run in /stats grouped into days and sessions (core/history.js). Rank-ups
// are marked for the benchmark Rank progress last loaded, when there is one.
function historyThresholds() {
  return new Map((progressBench?.scenarios || []).map((s) => [s.name.toLowerCase(), s.thresholds]))
}
async function loadHistory() {
  const install = findInstall()
  if (!install) return { ok: false, reason: 'no-install' }
  const days = history.buildHistory(await progress.allRuns(install), historyThresholds())
  return { ok: true, days, years: history.yearsOf(days) }
}
ipcMain.handle('history:get', () => loadHistory())

// The recap moment: KovaaK's just closed. Called from the game poll on the
// running -> closed edge with when the game was first seen running.
async function onGameClosed(startedAt) {
  const install = findInstall()
  if (!install || !startedAt) return
  const all = await progress.allRuns(install)
  const runs = all.filter((r) => r.ts >= startedAt)
  if (!runs.length) return // opened and closed without finishing a run
  // PBs and rank-ups of THIS session, against the bests from before it
  const best = new Map()
  for (const r of all) if (r.ts < startedAt) best.set(r.scenario.toLowerCase(), Math.max(best.get(r.scenario.toLowerCase()) ?? -Infinity, r.score))
  const thresholds = historyThresholds()
  const pbScenarios = new Set()
  const rankUps = []
  for (const r of runs) {
    const key = r.scenario.toLowerCase()
    const prev = best.has(key) ? best.get(key) : null
    if (prev != null && r.score > prev) pbScenarios.add(key)
    const up = thresholds.has(key) ? progress.rankUpFrom(thresholds.get(key), prev, r.score) : null
    if (up) rankUps.push({ scenario: r.scenario, rank: up.rank, color: up.color || null })
    if (prev == null || r.score > prev) best.set(key, r.score)
  }
  const info = { day: history.dayKey(runs[runs.length - 1].ts), runs: runs.length, pbs: pbScenarios.size, rankUps }
  log('session ended', info.runs, 'runs', info.pbs, 'PBs')
  if (!win?.isVisible() && Notification.isSupported()) {
    const n = new Notification({
      title: `Session done: ${info.runs} runs${info.pbs ? `, ${info.pbs} new PB${info.pbs === 1 ? '' : 's'}` : ''}`,
      body: `${info.rankUps.length ? `${info.rankUps[0].rank} on ${info.rankUps[0].scenario}. ` : ''}Click for the recap.`,
    })
    n.on('click', () => {
      showWindow()
      win?.webContents.send('open-recap', info)
    })
    n.show()
  }
  win?.webContents.send('session-ended', info)
}

// ---- autoclipper ---------------------------------------------------------------------
// A finished run that qualifies (core/clipper.js clipReason) -> wait PAD_END_S ->
// ask OBS to save its replay buffer -> OBS answers with ReplayBufferSaved and the
// file -> cut it to the run with ffmpeg if it's installed (else keep it whole) ->
// file it under the clips folder. The OBS password is kept encrypted like the
// kova token.
const CLIP_DEFAULTS = { on: false, host: '127.0.0.1', port: 4455, mode: 'pb', trim: true, folder: null }
const clipCfg = () => ({ ...CLIP_DEFAULTS, ...(loadSettings().clip || {}) })
const clipFolder = () => clipCfg().folder || path.join(app.getPath('videos'), 'kova companion')
const obsPassFile = () => path.join(userData(), 'obs-pass.bin')
const clipsFile = () => path.join(userData(), 'clips.json')
const CLIPS_KEPT = 50 // the Recent clips list; the files themselves are never deleted by us
const OBS_RETRY_MS = 15000

function loadObsPass() {
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(fs.readFileSync(obsPassFile())) : ''
  } catch {
    return ''
  }
}
function loadClips() {
  try {
    const list = JSON.parse(fs.readFileSync(clipsFile(), 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

let obs = null
let obsRetry = null
let obsState = { status: 'off', error: null }
let pendingClips = [] // runs we asked OBS to save, oldest first
const CLIP_JOB_TTL_MS = 30_000 // OBS answers in a second or two; older means it never will
// Bumped by every stop/start: a connection from an older start ignores its own
// results, so a save that restarts OBS twice can't leave two sockets open.
let obsGen = 0
const clipNotify = () => win?.webContents.send('clip-changed')

function obsStop() {
  obsGen += 1
  clearTimeout(obsRetry)
  pendingClips = [] // their saves won't come from a closed socket
  const c = obs
  obs = null
  c?.close()
  obsState = { status: 'off', error: null }
}
async function obsStart() {
  obsStop()
  const cfg = clipCfg()
  if (!cfg.on) return clipNotify()
  const gen = obsGen
  obsState = { status: 'connecting', error: null }
  clipNotify()
  // Declared before the connect call: OBS can close the socket (a wrong password)
  // before obsConnect has resolved, and onClose must not touch an unset binding.
  let conn = null
  try {
    conn = await clipper.obsConnect(
      { host: cfg.host, port: cfg.port, password: loadObsPass() },
      {
        onEvent: (type, data) => {
          if (type === 'ReplayBufferSaved' && gen === obsGen) {
            while (pendingClips[0] && Date.now() - pendingClips[0].savedAt > CLIP_JOB_TTL_MS) pendingClips.shift()
            const job = pendingClips.shift()
            // a save we didn't ask for (the streamer's own hotkey): not ours to move
            if (job) finishClip(job, data.savedReplayPath).catch((e) => log('clip failed', e?.message))
          }
        },
        onClose: () => {
          // not up yet (the catch below handles that and retries), or closed on
          // purpose by obsStop
          if (!conn || obs !== conn || gen !== obsGen) return
          obs = null
          pendingClips = []
          obsState = { status: 'error', error: 'OBS closed' }
          clipNotify()
          obsRetry = setTimeout(obsStart, OBS_RETRY_MS)
        },
      }
    )
    // a newer start or a stop happened while this one connected: not ours any more
    if (gen !== obsGen) return conn.close()
    obs = conn
    // The whole feature rides on the replay buffer, so switch it on if it's off.
    const st = await conn.request('GetReplayBufferStatus').catch(() => null)
    if (st && !st.outputActive)
      await conn.request('StartReplayBuffer').catch(() => {
        throw new Error('Turn on the replay buffer in OBS: Settings, Output, Replay Buffer')
      })
    obsState = { status: 'connected', error: null }
  } catch (e) {
    conn?.close() // only this attempt's socket - a newer one may be the live one
    if (gen !== obsGen) return
    if (obs === conn) obs = null
    obsState = { status: 'error', error: e?.message || "Couldn't reach OBS" }
    // OBS not running yet is the normal case at app start: keep trying quietly
    obsRetry = setTimeout(obsStart, OBS_RETRY_MS)
  }
  clipNotify()
}

function clipRun(run, prevBest, rank) {
  const cfg = clipCfg()
  if (!cfg.on || !obs) return
  const reason = clipper.clipReason(cfg.mode, run, prevBest, rank)
  if (!reason) return
  // A few seconds of the moment after the run, then save.
  setTimeout(async () => {
    if (!obs) return
    const job = { run, reason, savedAt: Date.now() }
    pendingClips.push(job)
    try {
      await obs.request('SaveReplayBuffer')
    } catch (e) {
      pendingClips = pendingClips.filter((j) => j !== job)
      log('clip: save failed', e?.message)
    }
  }, clipper.PAD_END_S * 1000)
}

// The bundled cut-only ffmpeg (scripts/build-ffmpeg.sh, shipped in resources/
// by electron-builder; vendor/ in a dev checkout), else one on PATH.
function ffmpegBin() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', exe)
    : path.join(__dirname, '..', 'vendor', 'ffmpeg', exe)
  return fs.existsSync(bundled) ? bundled : 'ffmpeg'
}
let ffmpegOk = null // cached: can we run one?
function hasFfmpeg() {
  if (ffmpegOk !== null) return Promise.resolve(ffmpegOk)
  return new Promise((resolve) =>
    execFile(ffmpegBin(), ['-version'], { windowsHide: true }, (err) => resolve((ffmpegOk = !err)))
  )
}

async function finishClip(job, src) {
  if (!src || !fs.existsSync(src)) return
  const cfg = clipCfg()
  const dest = clipper.clipPath(clipFolder(), job.run, path.extname(src))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  let trimmed = false
  const fromEnd = clipper.trimFromEndS(job.run, job.savedAt)
  if (cfg.trim && fromEnd && (await hasFfmpeg())) {
    trimmed = await new Promise((resolve) =>
      execFile(ffmpegBin(), clipper.ffmpegArgs(src, dest, fromEnd), { windowsHide: true }, (err) => resolve(!err))
    )
    // OBS's copy was only ever made for this clip
    if (trimmed) fs.rmSync(src, { force: true })
  }
  if (!trimmed) {
    try {
      fs.renameSync(src, dest)
    } catch {
      // another drive: rename can't cross volumes. Async - a replay buffer can be
      // hundreds of MB, and a sync copy would freeze the window.
      await fs.promises.copyFile(src, dest)
      fs.rmSync(src, { force: true })
    }
  }
  const { reason, run } = job
  const why = reason.why === 'rankup' ? `${reason.rank}, new` : reason.why === 'pb' ? `PB +${Math.round(reason.gain * 10) / 10}` : 'Run'
  const clip = { file: dest, scenario: run.scenario, score: run.score, why, at: Date.now(), trimmed }
  k.writeFileAtomic(clipsFile(), JSON.stringify([clip, ...loadClips()].slice(0, CLIPS_KEPT), null, 2))
  log('clip saved', dest)
  if (!win?.isVisible() && Notification.isSupported())
    new Notification({ title: `Clip saved: ${run.scenario}`, body: `${run.score}, ${why}` }).show()
  win?.webContents.send('clip-saved', clip)
  clipNotify()
}

ipcMain.handle('clip:get', async () => {
  const cfg = clipCfg()
  return {
    on: cfg.on,
    mode: cfg.mode,
    trim: cfg.trim,
    host: cfg.host,
    port: cfg.port,
    hasPassword: !!loadObsPass(),
    folder: clipFolder(),
    obs: obsState,
    ffmpeg: await hasFfmpeg(),
    clips: loadClips().filter((c) => fs.existsSync(c.file)),
  }
})
const CLIP_MODES = ['pb', 'rankup', 'every']
ipcMain.handle('clip:set', (_e, patch) => {
  const cur = clipCfg()
  const next = { ...cur }
  if (typeof patch?.on === 'boolean') next.on = patch.on
  if (CLIP_MODES.includes(patch?.mode)) next.mode = patch.mode
  if (typeof patch?.trim === 'boolean') next.trim = patch.trim
  if (typeof patch?.host === 'string' && /^[\w.-]{1,253}$/.test(patch.host)) next.host = patch.host
  if (Number.isInteger(patch?.port) && patch.port > 0 && patch.port < 65536) next.port = patch.port
  saveSettings({ ...loadSettings(), clip: next })
  if (next.on !== cur.on || next.host !== cur.host || next.port !== cur.port) obsStart()
})
ipcMain.handle('clip:setPassword', (_e, pw) => {
  if (typeof pw !== 'string') return
  if (!pw) fs.rmSync(obsPassFile(), { force: true })
  else if (safeStorage.isEncryptionAvailable()) k.writeFileAtomic(obsPassFile(), safeStorage.encryptString(pw))
  if (clipCfg().on) obsStart()
})
ipcMain.handle('clip:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Clips folder',
    defaultPath: clipFolder(),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (res.canceled || !res.filePaths[0]) return null
  saveSettings({ ...loadSettings(), clip: { ...clipCfg(), folder: res.filePaths[0] } })
  return res.filePaths[0]
})
ipcMain.handle('clip:openFolder', () => {
  fs.mkdirSync(clipFolder(), { recursive: true })
  shell.openPath(clipFolder())
})
// Only a file this app recorded as a clip can be opened from here.
ipcMain.handle('clip:play', (_e, file) => {
  if (loadClips().some((c) => c.file === file)) shell.openPath(file)
})

// ---- tournaments -------------------------------------------------------------------
// Your kova tournaments (GET /api/companion/tournaments): the page, plus two
// reminders, each once - check-in opening, and your match going live. Decided:
// the app NEVER checks anyone in by itself (that's always the player's click),
// and a live match only notifies; it never pulls the window forward.
const TOURNEY_FAST_MS = 60 * 1000 // something registered, upcoming or live
const TOURNEY_SLOW_MS = 15 * 60 * 1000 // nothing on: just notice new entries
let tourneyData = null
let tourneyTimer = null
const tourneyReminded = new Set() // `checkin:<id>` / `live:<matchId>`, once per app run

// `announce`: tell the page it changed. Only the background poll does - the page
// asking for the data itself must not, or its own re-render asks again, forever.
async function loadTournaments({ announce = true } = {}) {
  if (!kovaToken) return { ok: false, reason: 'signed-out' }
  const res = await kovaFetch('/api/companion/tournaments')
  if (res?.status === 401) {
    kovaForget()
    return { ok: false, reason: 'signed-out' }
  }
  const data = res?.ok ? await res.json().catch(() => null) : null
  if (!data?.current) return { ok: false, reason: 'offline' }
  tourneyData = data
  remindTournaments(data)
  if (announce) win?.webContents.send('tournaments-changed', { live: data.current.some((t) => t.match?.status === 'LIVE') })
  return { ok: true, ...data }
}

function remindTournaments(data) {
  // Check-ins first, live matches last: the app shows one toast at a time and the
  // last one stays up, so the more urgent reminder is the one that lands.
  for (const t of data.current) {
    if (t.checkIn.open && !t.checkIn.checkedIn && !tourneyReminded.has(`checkin:${t.id}`)) {
      tourneyReminded.add(`checkin:${t.id}`)
      const starts = t.startsAt ? new Date(t.startsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null
      tourneyNotify('checkin', t, { title: 'Check-in is open', body: `${t.name}${starts ? ` starts at ${starts}` : ''}` })
    }
  }
  for (const t of data.current) {
    const m = t.match
    if (m?.status === 'LIVE' && !tourneyReminded.has(`live:${m.id}`)) {
      tourneyReminded.add(`live:${m.id}`)
      const game = m.game ? ` · Game ${m.game.number}: ${m.game.scenario}` : ''
      tourneyNotify('live', t, { title: 'Your match is live', body: `vs ${m.opponent || 'TBD'}${game}` })
    }
  }
}

// In-app when the window is up (with its button), else a Windows notification
// whose click only opens the page - it doesn't check in or launch anything.
function tourneyNotify(kind, t, { title, body }) {
  log('tournament', kind, t.name)
  if (!win?.isVisible() && Notification.isSupported()) {
    const n = new Notification({ title, body })
    n.on('click', () => {
      showWindow()
      win?.webContents.send('open-view', 'tournaments')
    })
    n.show()
  }
  win?.webContents.send('tournament-reminder', { kind, id: t.id, matchId: t.match?.id || null, title, body })
}

function scheduleTournaments() {
  clearTimeout(tourneyTimer)
  if (!kovaToken) return
  const busy = tourneyData?.current?.some((t) => t.status !== 'COMPLETED')
  tourneyTimer = setTimeout(async () => {
    await loadTournaments().catch(() => {})
    scheduleTournaments()
  }, busy ? TOURNEY_FAST_MS : TOURNEY_SLOW_MS)
}

ipcMain.handle('tournaments:get', () => loadTournaments({ announce: false }))
ipcMain.handle('tournaments:checkIn', async (_e, id) => {
  if (!tourneyData?.current?.some((t) => t.id === id)) return { ok: false, error: 'Unknown tournament.' }
  const res = await kovaFetch('/api/companion/tournaments/checkin', { method: 'POST', body: JSON.stringify({ tournamentId: id }) })
  if (res?.status === 401) {
    kovaForget()
    return { ok: false, error: 'Signed out of kova.' }
  }
  const data = res ? await res.json().catch(() => ({})) : {}
  // the caller re-renders from its own reload; announcing here would loop too
  await loadTournaments({ announce: false }).catch(() => {})
  return res?.ok ? { ok: true } : { ok: false, error: data.error || "Couldn't reach kova." }
})
// Launch the current game's scenario. Only a KovaaK's steam link from kova's own
// payload - never an arbitrary URL from the renderer.
ipcMain.handle('tournaments:play', (_e, matchId) => {
  const m = tourneyData?.current?.map((t) => t.match).find((x) => x?.id === matchId)
  const url = m?.game?.playUrl
  if (typeof url === 'string' && url.startsWith(`steam://run/${STEAM_APP_ID}/`)) shell.openExternal(url)
})
ipcMain.handle('tournaments:open', (_e, slug) => {
  const known = [...(tourneyData?.current || []), ...(tourneyData?.past || [])].some((t) => t.slug === slug)
  if (known && /^[\w-]+$/.test(slug)) shell.openExternal(`${KOVA_URL}/tournaments/${slug}`)
})

// ---- weekly challenge ------------------------------------------------------------
// Your teams' scenario of the week (GET /api/companion/challenge): this week's
// standings and past weeks, computed by kova like its Discord board and feed rail.
// Loaded when the page opens; nothing polls it.
let challengeData = null

async function loadChallenge() {
  if (!kovaToken) return { ok: false, reason: 'signed-out' }
  const res = await kovaFetch('/api/companion/challenge')
  if (res?.status === 401) {
    kovaForget()
    return { ok: false, reason: 'signed-out' }
  }
  const data = res?.ok ? await res.json().catch(() => null) : null
  if (!Array.isArray(data?.teams)) return { ok: false, reason: 'offline' }
  challengeData = data
  return { ok: true, ...data }
}
const challengeTeam = (slug) => challengeData?.teams.find((t) => t.team.slug === slug)

ipcMain.handle('challenge:get', () => loadChallenge())
// Only a scenario and a team from kova's own answer, never one the renderer names.
ipcMain.handle('challenge:play', (_e, slug) => {
  const t = challengeTeam(slug)
  if (t) shell.openExternal(scenarioLink(t.scenario))
})
ipcMain.handle('challenge:open', (_e, slug) => {
  if (challengeTeam(slug) && /^[\w-]+$/.test(slug)) shell.openExternal(`${KOVA_URL}/aimgroup/${slug}`)
})

// ---- snipe alerts --------------------------------------------------------------------
// PBs set by people you follow (GET /api/companion/snipes), checked against your
// local best on the same scenario. kova never sees your scores: the comparison
// happens here, and only a PB that beats yours alerts. The cursor (the last
// row's loggedAt) lives in settings, so a restart doesn't replay old ones; the
// very first poll only sets it, so signing in doesn't dump a week of alerts.
const SNIPE_POLL_MS = 5 * 60 * 1000
let snipeTimer = null
const snipesSeen = new Map() // snipe id -> its PB, for the Play button

async function pollSnipes() {
  if (!kovaToken) return
  const s = loadSettings()
  const baseline = !s.snipeCursor
  let cursor = s.snipeCursor || ''
  const fresh = []
  // ponytail: 10 pages of 100 caps a catch-up; past that the rest is old news anyway
  for (let page = 0; page < 10; page++) {
    const res = await kovaFetch(`/api/companion/snipes${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`)
    if (res?.status === 401) return kovaForget()
    const data = res?.ok ? await res.json().catch(() => null) : null
    if (!Array.isArray(data?.pbs)) return // offline or rate-limited: same cursor next time
    fresh.push(...data.pbs)
    if (data.cursor) cursor = data.cursor
    if (data.pbs.length < 100) break
  }
  saveSettings({ ...loadSettings(), snipeCursor: cursor || new Date().toISOString() })
  const install = findInstall()
  if (baseline || !s.snipeAlerts || !install || !fresh.length) return

  const snipes = companion.pickSnipes(fresh, progress.localRuns(install, new Set(fresh.map((p) => p.scenario))))
  if (!snipes.length) return
  for (const p of snipes) snipesSeen.set(p.id, p)
  // one alert per poll: the newest, with the rest counted
  const p = snipes[snipes.length - 1]
  const more = snipes.length - 1
  const title = `${p.name} beat your best`
  const body = `${p.scenario}: ${Math.round(p.score)} vs your ${Math.round(p.mine)}${more ? ` (+${more} more)` : ''}`
  log('snipe', p.username, p.scenario)
  if (!win?.isVisible() && Notification.isSupported()) {
    const n = new Notification({ title, body })
    n.on('click', () => shell.openExternal(scenarioLink(p.scenario))) // the one click: straight into it
    n.show()
  }
  win?.webContents.send('snipe', { id: p.id, name: p.name, scenario: p.scenario, score: p.score, mine: p.mine, more })
}

function scheduleSnipes(ms = SNIPE_POLL_MS) {
  clearTimeout(snipeTimer)
  if (!kovaToken) return
  snipeTimer = setTimeout(async () => {
    await pollSnipes().catch((e) => log('snipes failed', e.message))
    scheduleSnipes()
  }, ms)
}

ipcMain.handle('snipes:play', (_e, id) => {
  const p = snipesSeen.get(id)
  if (p) shell.openExternal(scenarioLink(p.scenario))
})

// ---- preset import/export (share a preset as a JSON file) ----------------------
ipcMain.handle('presets:export', async (_e, id) => {
  const presets = store.load(userData())
  const chosen = id ? presets.filter((p) => p.id === id) : presets
  if (!chosen.length) return { ok: false, error: 'Nothing to export.' }
  const base = id ? (chosen[0].name || 'preset').replace(/[<>:"/\\|?*]+/g, '').trim() : 'kova-presets'
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `${base || 'preset'}.kovapreset.json`,
    filters: [{ name: 'kova companion preset', extensions: ['json'] }],
  })
  if (canceled || !filePath) return { ok: false, canceled: true }
  // ids are local and hotkeys are personal - neither belongs in a shared file
  // (imports ignore them too). Dead fields from older stores never get here:
  // store.load strips them.
  const out = chosen.map(({ id: _id, hotkey: _hk, ...rest }) => rest)
  fs.writeFileSync(filePath, JSON.stringify({ kovapreset: 1, presets: out }, null, 2))
  return { ok: true, count: out.length }
})

ipcMain.handle('presets:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: 'kova companion preset', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths.length) return { ok: false, canceled: true }
  let data
  try {
    data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'))
  } catch {
    return { ok: false, error: "That file isn't valid JSON." }
  }
  const incoming = Array.isArray(data?.presets) ? data.presets : Array.isArray(data) ? data : null
  if (!incoming) return { ok: false, error: "That file doesn't look like a kova companion preset export." }
  const presets = store.load(userData())
  let count = 0
  for (const p of incoming) {
    if (!p || typeof p !== 'object' || (!p.weapon && !p.primary)) continue
    presets.push({
      id: store.newId(),
      name: String(p.name || 'Imported preset').slice(0, 80),
      weapon: p.weapon && typeof p.weapon === 'object' ? p.weapon : {},
      primary: p.primary && typeof p.primary === 'object' ? p.primary : {},
    })
    count++
  }
  if (!count) return { ok: false, error: 'No presets found in that file.' }
  store.save(userData(), presets)
  return { ok: true, count, presets }
})

ipcMain.handle('hud:save', (_e, uiRaw) => {
  const install = requireInstall()
  // hudSerialize() always produces valid JSON, so this only ever fires on a
  // renderer bug - but a corrupt UI.json breaks the player's in-game HUD, and
  // that's not worth trusting a caller for.
  if (!k.validUi(uiRaw)) return { status: 'invalid' }
  // The HUD editor writes UI.json directly, so "Restore original setup" must
  // have the pre-kova-companion layout on file before the first save lands.
  captureBaselineIfMissing(install)
  if (gameRunning()) {
    const pending = readPending() || {}
    setPending({ ...pending, ui: uiRaw })
    return { status: 'queued' }
  }
  k.applyUi(install, uiRaw)
  return { status: 'applied' }
})

// ---- auto-update ---------------------------------------------------------------
// Releases live on this repo's GitHub Releases; electron-updater reads the
// published latest.yml, downloads in the background and verifies the installer
// against its sha512 before offering it. Only a packaged build carries the
// update metadata, so a dev run skips all of it.
const UPDATE_POLL_MS = 6 * 60 * 60 * 1000 // the app can sit in the tray for days
let updateReady = null // version string once an update is downloaded and staged

function initAutoUpdate() {
  if (!app.isPackaged) return
  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = true
  // if the user never clicks "restart now", the staged update still installs
  // the next time they quit from the tray
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version
    log('update downloaded', info.version)
    // The tray is the only surface guaranteed to be visible - the window is
    // usually hidden when this fires, which is exactly how a staged update used
    // to go unmentioned indefinitely.
    if (tray && !tray.isDestroyed()) tray.setToolTip(`kova companion - update ${info.version} ready`)
  })
  // offline, rate-limited, or no release yet - just try again on the next tick
  autoUpdater.on('error', () => {})
  const check = () => autoUpdater.checkForUpdates().catch(() => {})
  check()
  setInterval(check, UPDATE_POLL_MS)
}

// The renderer polls state every few seconds, so the staged-update flag rides
// along there instead of a push event - it can't be missed by a window that
// was hidden (--hidden startup) or reloaded when the event fired.
function installUpdate() {
  if (!updateReady) return { ok: false }
  quitting = true // the window's close handler otherwise just hides to the tray
  require('electron-updater').autoUpdater.quitAndInstall()
  return { ok: true }
}
ipcMain.handle('update:install', () => installUpdate())

app.whenReady().then(() => {
  logger.init(userData())
  log('---- app start', app.getVersion(), app.isPackaged ? 'packaged' : 'dev', '----')
  createWindow()
  createTray()
  initAutoUpdate()
  flushPendingIfPossible()
  registerHotkeys()
  setInterval(flushPendingIfPossible, 4000)
  setInterval(pollGameRunning, 3000)
  // A stored kova sign-in resumes the setup sync, tray-only starts included -
  // keeping the stream overlay current is exactly the job the tray is for.
  kovaToken = loadKovaToken()
  if (kovaToken) {
    refreshKovaUser()
    startKovaSync()
    // Rank-up detection needs the thresholds, and the app mostly lives in the
    // tray - so load them now rather than waiting for the page to be opened.
    loadProgress().catch(() => {})
    loadTournaments().catch(() => {}).finally(scheduleTournaments)
    if (gameRunningCache) kovaLiveStart() // already running when the app started: no rising edge
    scheduleSnipes(0)
  }
  // finished runs drive clips, rank-ups and sessions, signed in or not
  startStatsWatch()
  if (clipCfg().on) obsStart()
  // legacy storage from the removed per-apply undo system
  fs.rmSync(path.join(userData(), 'backups'), { recursive: true, force: true })
  // The "Start with Windows" setting is gone, but anyone who had it on still has
  // a registered login item - and with the toggle removed there'd be no way to
  // turn it off. Clear it once, and drop the dead setting key.
  if (app.isPackaged && app.getLoginItemSettings().openAtLogin)
    app.setLoginItemSettings({ openAtLogin: false })
  const s = loadSettings()
  if ('launchOnStartup' in s) {
    delete s.launchOnStartup
    saveSettings(s)
  }
  app.on('activate', showWindow)
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => globalShortcut.unregisterAll())

// Closing the window hides to the tray (hotkeys + queued flushes stay alive);
// only the tray's Quit actually exits, so don't quit on window-all-closed.
app.on('window-all-closed', () => {})
