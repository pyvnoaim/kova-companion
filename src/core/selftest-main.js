// Regression tests for the apply / quit-flush / restore logic in src/main.js.
// Run: npm run core:test (after selftest.js)
//
// Loads the REAL main.js with a stubbed `electron` module, against a synthetic
// KovaaK's install and userData in os.tmpdir(). No real game, no Electron
// binary, no network, and nothing outside the temp dir is read or written:
// findInstall/isGameRunning are stubbed on the shared kovaaks module before
// main.js loads, app.getPath points at the temp dir, and APPDATA/LOCALAPPDATA
// are redirected too (currentScenario and readResolution read LOCALAPPDATA).
// app.whenReady() never resolves, so none of main's intervals ever start.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const k = require('./kovaaks')

const MAIN = path.join(__dirname, '..', 'main.js')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kova-main-'))
process.env.APPDATA = path.join(TMP, 'appdata')
process.env.LOCALAPPDATA = path.join(TMP, 'localappdata')

// The one game-facing seam: every booted main.js shares this kovaaks module
// (same require-cache entry), and main calls these through `k.`, so swapping
// them here is enough - no Steam scan, no tasklist spawn.
let env = null // the currently booted instance
k.findInstall = () => env.install
k.isGameRunning = () => env.running

// ---- the synthetic install --------------------------------------------------
const BOM = '﻿'
const WEAPON_INI =
  BOM +
  'TracerVisible=true\nCrosshairFile=dot.png\nCrosshairColor=FFFFFFFF\nCrosshairScale=1.0\n' +
  'BodyHitSound=hit\nHeadHitSound=crit\nShootSound=shot\nEnableMissSound=false\nMissSound=miss\n' +
  'MissPitchShiftPerDeg=0.0\nOverrideSens=false\nHorizontalSens=40.0\nVerticalSens=40.0\n' +
  'SensScale=cm/360\nOverrideSensScaleString=cm/360\nZoomSensMultiplier=1.0\n\n' +
  '[pistol]\nUseDefaults=false\nCrosshairFile=section.png\nHorizontalSens=999.0\n'

const PRIMARY_JSON = JSON.stringify(
  {
    stringSettings: {
      'EStringSettingId::CurrentThemeName': 'Default',
      'EStringSettingId::WallMaterial': 'GRID',
      'EStringSettingId::FloorMaterial': 'GRID',
      'EStringSettingId::KillConfirmedSound': 'Pop1',
      'EStringSettingId::SensScaleString': 'cm/360',
      'EStringSettingId::PlayerName': 'tester', // unmanaged: must survive every write
    },
    floatSettings: {
      'EFloatSettingId::XSens': 40,
      'EFloatSettingId::YSens': 40,
      'EFloatSettingId::WallRoughness': 0.5,
      'EFloatSettingId::FOV': 103,
    },
    integerSettings: {
      'EIntegerSettingId::DPI': 800,
      'EIntegerSettingId::SkyPreset': 0,
      'EIntegerSettingId::WallMat': 3,
      'EIntegerSettingId::FloorMat': 3,
    },
    booleanSettings: { 'EBooleanSettingId::SolidSkyColor': false },
    vectorSettings: { 'EVectorSettingId::WallColor': { x: 0.5, y: 0.5, z: 0.5 } },
    colorSettings: { 'EColorSettingId::SkyColor': { r: 127, g: 127, b: 127, a: 255 } },
    keyBindings: { Fire: 'LeftMouseButton' },
  },
  null,
  '\t'
)

const theme = (themeName, wall, rough, tint, sky, solid) =>
  JSON.stringify(
    {
      themeName,
      wallMaterial: wall,
      wallRoughness: rough,
      wallTint: { x: tint, y: tint, z: tint },
      floorMaterial: wall,
      skyPresetId: sky,
      solidSkyColor: solid,
      skyColor: { b: 20 + sky, g: 10 + sky, r: 10 + sky, a: 255 },
      teamGlowUpHead: 1, // a theme key presets don't manage
    },
    null,
    '\t'
  )
const THEMES = {
  'Default.json': theme('Default', 'GRID', 0.5, 0.5, 0, false),
  'Midnight.json': theme('Midnight', 'BLACK', 1, 0.04, 1, true),
  'Daylight.json': theme('Daylight', 'WHITE WOOD BOARD', 0.2, 0.9, 2, false),
  '!KovaPreset.json': theme('!KovaPreset - Old', 'GRID', 0.5, 0.5, 0, false),
}
const UI_JSON =
  '{"windowPositionSettings":[{"windowName":"FPS","position":{"x":10,"y":20}}],"windowScaleSettings":[{"windowName":"FPS","scale":1}]}'
const UI_A = '{"windowPositionSettings":[{"windowName":"FPS","position":{"x":111,"y":20}}]}'
const UI_B = '{"windowPositionSettings":[{"windowName":"FPS","position":{"x":222,"y":20}}]}'

// Exposes a few of main's internals that no IPC handler reaches (the quit flush
// runs on an interval; the game-running cache is set by the 3s poll). Appended
// to the source at compile time, so main.js itself carries no test code.
const SEAM =
  '\n;module.exports.__test = { flushPending, doApplyPreset, readActiveMerged, deactivatePresets,' +
  ' setGameRunning: (v) => { gameRunningCache = v } }\n'

function boot(tag) {
  const root = fs.mkdtempSync(path.join(TMP, `${tag}-`))
  const install = path.join(root, 'FPSAimTrainer')
  const sg = path.join(install, 'Saved', 'SaveGames')
  fs.mkdirSync(path.join(sg, 'Themes'), { recursive: true })
  fs.writeFileSync(path.join(sg, 'weaponsettings.ini'), WEAPON_INI)
  fs.writeFileSync(path.join(sg, 'PrimaryUserSettings.json'), PRIMARY_JSON)
  fs.writeFileSync(path.join(sg, 'UI.json'), UI_JSON)
  for (const [f, s] of Object.entries(THEMES)) fs.writeFileSync(path.join(sg, 'Themes', f), s)
  const userData = path.join(root, 'userData')
  fs.mkdirSync(userData)

  const handlers = {}
  const noop = () => {}
  const electron = {
    app: {
      getPath: (name) => (name === 'userData' ? userData : path.join(root, `electron-${name}`)),
      setPath: noop,
      requestSingleInstanceLock: () => true,
      exit: noop,
      quit: noop,
      on: noop,
      whenReady: () => new Promise(noop), // never: no window, tray, intervals or sync
      getVersion: () => '0.0.0-test',
      isPackaged: false,
    },
    ipcMain: { handle: (ch, fn) => (handlers[ch] = fn), on: noop },
    globalShortcut: { register: () => true, unregisterAll: noop, isRegistered: () => true },
    shell: { openExternal: noop, showItemInFolder: noop },
    dialog: {
      showOpenDialog: async () => env.openDialog || { canceled: true, filePaths: [] },
      showSaveDialog: async () => ({ canceled: true }),
    },
    safeStorage: { isEncryptionAvailable: () => false },
    BrowserWindow: function () {},
    Tray: function () {},
    Notification: Object.assign(function () {}, { isSupported: () => false }),
    Menu: { buildFromTemplate: (t) => t },
  }

  env = { root, install, userData, running: false, openDialog: null }
  const m = new Module(MAIN, module)
  m.filename = MAIN
  m.paths = Module._nodeModulePaths(path.dirname(MAIN))
  const origLoad = Module._load
  Module._load = function (req, ...rest) {
    return req === 'electron' ? electron : origLoad.call(this, req, ...rest)
  }
  try {
    m._compile(fs.readFileSync(MAIN, 'utf8') + SEAM, MAIN)
  } finally {
    Module._load = origLoad
  }
  const t = m.exports.__test

  const file = (name) => path.join(sg, name)
  const read = (name) => fs.readFileSync(file(name), 'utf8')
  const json = (s) => JSON.parse(s.replace(/^﻿/, ''))
  return {
    ...env,
    t,
    invoke: (ch, ...args) => handlers[ch]({}, ...args),
    setRunning(v) {
      env.running = v
      t.setGameRunning(v)
    },
    read,
    weapon: () => k.readWeapon(install),
    primary: () => k.readPrimary(install),
    primaryRaw: () => json(read('PrimaryUserSettings.json')),
    selected: () => k.readPrimary(install).stringSettings.CurrentThemeName,
    proxy: () => json(read('Themes/!KovaPreset.json')),
    pending() {
      try {
        return JSON.parse(fs.readFileSync(path.join(userData, 'pending.json'), 'utf8'))
      } catch {
        return null
      }
    },
    baseline: (n) => fs.readFileSync(path.join(userData, 'baseline', `${n}.bak`), 'utf8'),
    hasBaseline: () => fs.existsSync(path.join(userData, 'baseline', 'weapon.bak')),
    build(picks) {
      const presets = this.invoke('presets:build', picks)
      return presets.find((p) => p.name === picks.name)
    },
  }
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ---- 1 ------------------------------------------------------------------------
test('apply closed: weapon, primary and proxy written, name == selection', () => {
  const h = boot('t1')
  const A = h.build({ name: 'A', theme: 'Daylight', crosshair: 'cross2.png', sens: 35 })
  const r = h.t.doApplyPreset(A)
  assert.equal(r.running, false)
  assert.equal(r.theme, 'applied')
  assert.equal(r.weaponChanged, true)
  assert.deepEqual(r.launchOnly, [{ field: 'sens', value: 35 }])

  const ini = h.read('weaponsettings.ini')
  assert.ok(ini.startsWith(BOM), 'weaponsettings BOM kept')
  assert.match(ini, /^CrosshairFile=cross2\.png$/m)
  assert.ok(ini.endsWith('[pistol]\nUseDefaults=false\nCrosshairFile=section.png\nHorizontalSens=999.0\n'), 'section untouched')

  const want = '!KovaPreset - Daylight'
  assert.equal(h.selected(), want, 'CurrentThemeName points at the proxy')
  assert.equal(h.proxy().themeName, want, 'proxy carries the same name')
  assert.equal(h.proxy().wallMaterial, 'WHITE WOOD BOARD')
  assert.deepEqual(h.proxy().wallTint, { x: 0.9, y: 0.9, z: 0.9 })
  const p = h.primary()
  assert.equal(p.stringSettings.WallMaterial, 'WHITE WOOD BOARD')
  assert.equal(p.floatSettings.XSens, 35)
  assert.deepEqual(p.colorSettings.SkyColor, { b: 22, g: 12, r: 12, a: 255 })
  const raw = h.primaryRaw()
  assert.equal(raw.stringSettings['EStringSettingId::PlayerName'], 'tester', 'unmanaged key kept')
  assert.deepEqual(raw.keyBindings, { Fire: 'LeftMouseButton' }, 'unmanaged section kept')
  assert.equal(h.pending(), null, 'nothing queued when closed')
  assert.equal(h.baseline('primary'), PRIMARY_JSON, 'baseline is the pre-apply file')
})

// ---- 2 ------------------------------------------------------------------------
test('apply running: settings file untouched, queued with proxyName, flushed consistent', () => {
  const h = boot('t2')
  const A = h.build({ name: 'A', theme: 'Midnight' })
  const B = h.build({ name: 'B', theme: 'Daylight', crosshair: 'cross2.png' })
  h.t.doApplyPreset(A) // closed: the proxy is the selection at "launch"
  const launchName = '!KovaPreset - Midnight'
  assert.equal(h.proxy().themeName, launchName)

  h.setRunning(true)
  const primaryBefore = h.read('PrimaryUserSettings.json')
  const r = h.t.doApplyPreset(B)
  assert.equal(r.running, true)
  assert.equal(r.theme, 'live')
  assert.equal(r.queued, true)
  assert.equal(h.read('PrimaryUserSettings.json'), primaryBefore, 'game-owned file untouched while running')
  assert.equal(h.weapon().CrosshairFile, 'cross2.png', 'weapon is live, written now')
  assert.equal(h.proxy().themeName, launchName, 'proxy keeps the name the game selected at launch')
  assert.equal(h.proxy().wallMaterial, 'WHITE WOOD BOARD', 'proxy contents swapped live')
  const q = h.pending()
  assert.equal(q.primary.proxyName, '!KovaPreset - Daylight')
  assert.equal(q.primary.stringSettings.CurrentThemeName, '!KovaPreset - Daylight')
  assert.equal(q.weapon.CrosshairFile, 'cross2.png')

  // the game quits and rewrites weaponsettings from memory
  h.setRunning(false)
  fs.writeFileSync(path.join(h.install, 'Saved', 'SaveGames', 'weaponsettings.ini'), WEAPON_INI)
  assert.equal(h.t.flushPending(), true)
  assert.equal(h.selected(), '!KovaPreset - Daylight')
  assert.equal(h.proxy().themeName, h.selected(), 'name and selection agree after the flush')
  assert.equal(h.primary().stringSettings.WallMaterial, 'WHITE WOOD BOARD')
  assert.equal(h.weapon().CrosshairFile, 'cross2.png', 'flush re-asserts the weapon intent')
  assert.equal(h.pending(), null)

  // off the proxy at launch: the apply arms it, the flush selects it
  const h2 = boot('t2b')
  const B2 = h2.build({ name: 'B', theme: 'Daylight' })
  h2.setRunning(true)
  assert.equal(h2.t.doApplyPreset(B2).theme, 'arming')
  assert.equal(h2.selected(), 'Default')
  assert.equal(h2.proxy().themeName, '!KovaPreset - Old', 'not renamed while running')
  h2.setRunning(false)
  h2.t.flushPending()
  assert.equal(h2.selected(), '!KovaPreset - Daylight')
  assert.equal(h2.proxy().themeName, '!KovaPreset - Daylight')
})

// ---- 3 ------------------------------------------------------------------------
test('second mid-session apply with the same theme keeps the queued proxyName', () => {
  const h = boot('t3')
  const A = h.build({ name: 'A', theme: 'Midnight' })
  const B = h.build({ name: 'B', theme: 'Daylight' })
  const C = h.build({ name: 'C', theme: 'Daylight', crosshair: 'cross3.png' })
  h.t.doApplyPreset(A)
  h.setRunning(true)
  h.t.doApplyPreset(B)
  assert.equal(h.pending().primary.proxyName, '!KovaPreset - Daylight')
  const r = h.t.doApplyPreset(C) // proxy already shows Daylight: nothing differs
  assert.equal(r.theme, 'nochange')
  const q = h.pending()
  assert.equal(q.primary.proxyName, '!KovaPreset - Daylight', 'queued relabel survives')
  assert.equal(q.primary.stringSettings.CurrentThemeName, '!KovaPreset - Daylight')
  assert.equal(q.weapon.CrosshairFile, 'cross3.png', 'the queue is the latest preset')
  h.setRunning(false)
  h.t.flushPending()
  assert.equal(h.selected(), '!KovaPreset - Daylight')
  assert.equal(h.proxy().themeName, '!KovaPreset - Daylight')
})

// ---- 4 ------------------------------------------------------------------------
test('restore while running, then apply: baseline stays the original setup', () => {
  const h = boot('t4')
  const A = h.build({ name: 'A', theme: 'Daylight', crosshair: 'cross2.png', sens: 35 })
  const B = h.build({ name: 'B', theme: 'Midnight', sens: 7.7 })
  const proxyOrig = THEMES['!KovaPreset.json']
  h.t.doApplyPreset(A)
  assert.equal(h.proxy().themeName, '!KovaPreset - Daylight')

  h.setRunning(true)
  const r = h.t.deactivatePresets()
  assert.deepEqual(r, { ok: true, queued: true })
  assert.equal(h.read('weaponsettings.ini'), WEAPON_INI, 'weapon restored right away')
  assert.equal(h.proxy().themeName, '!KovaPreset - Daylight', 'proxy not renamed while running')
  assert.equal(h.selected(), '!KovaPreset - Daylight', 'settings file left to the game')
  assert.equal(h.pending().primaryRaw, PRIMARY_JSON, 'original queued for the quit')
  assert.equal(h.hasBaseline(), false)

  h.t.doApplyPreset(B) // before quitting
  assert.equal(h.baseline('primary'), PRIMARY_JSON, 'baseline is the ORIGINAL, not the modified disk')
  assert.equal(h.baseline('weapon'), WEAPON_INI)
  assert.equal(h.baseline('proxy'), proxyOrig)
  assert.equal(h.baseline('ui'), UI_JSON)
  assert.equal(h.proxy().themeName, '!KovaPreset - Daylight', 'still not renamed while running')
  assert.equal(h.proxy().wallMaterial, 'BLACK')

  h.setRunning(false)
  h.t.flushPending()
  assert.equal(h.selected(), '!KovaPreset - Midnight')
  assert.equal(h.proxy().themeName, '!KovaPreset - Midnight')
  assert.equal(h.primary().floatSettings.XSens, 7.7)

  assert.deepEqual(h.t.deactivatePresets(), { ok: true, queued: false })
  assert.equal(h.read('weaponsettings.ini'), WEAPON_INI)
  assert.equal(h.read('PrimaryUserSettings.json'), PRIMARY_JSON)
  assert.equal(h.read('Themes/!KovaPreset.json'), proxyOrig)
  assert.equal(h.read('UI.json'), UI_JSON)
  assert.equal(h.pending(), null)
})

// ---- 5 ------------------------------------------------------------------------
test('sens-only preset leaves the proxy and the theme selection alone', () => {
  const h = boot('t5')
  const A = h.build({ name: 'A', theme: 'Daylight' })
  h.t.doApplyPreset(A)
  const proxyBefore = h.read('Themes/!KovaPreset.json')
  const sensOnly = { id: 'x', name: 'sens only', weapon: {}, primary: { floatSettings: { XSens: 3.3, YSens: 3.3 } } }

  const r = h.t.doApplyPreset(structuredClone(sensOnly))
  assert.equal(r.theme, 'nochange')
  assert.equal(h.read('Themes/!KovaPreset.json'), proxyBefore, 'proxy not rebuilt from an empty theme')
  assert.equal(h.selected(), '!KovaPreset - Daylight')
  assert.equal(h.primary().floatSettings.XSens, 3.3)
  assert.equal(h.primary().stringSettings.WallMaterial, 'WHITE WOOD BOARD')

  // same while running, through the queue and the flush
  h.setRunning(true)
  h.t.doApplyPreset({ ...structuredClone(sensOnly), primary: { floatSettings: { XSens: 4.4, YSens: 4.4 } } })
  assert.equal(h.read('Themes/!KovaPreset.json'), proxyBefore)
  const q = h.pending()
  assert.equal(q.primary.proxyName, undefined)
  assert.equal(q.primary.stringSettings.CurrentThemeName, undefined)
  h.setRunning(false)
  h.t.flushPending()
  assert.equal(h.read('Themes/!KovaPreset.json'), proxyBefore)
  assert.equal(h.selected(), '!KovaPreset - Daylight')
  assert.equal(h.primary().floatSettings.XSens, 4.4)

  // a stray theme field with no theme name (an import carrying only SkyColor)
  // isn't a theme: no proxy rebuilt around it, selection untouched
  const skyOnly = { id: 'y', name: 'sky only', weapon: {}, primary: { colorSettings: { SkyColor: { r: 1, g: 2, b: 3, a: 255 } } } }
  h.t.doApplyPreset(skyOnly)
  assert.equal(h.read('Themes/!KovaPreset.json'), proxyBefore)
  assert.equal(h.selected(), '!KovaPreset - Daylight')
})

test('a sens-only apply mid-session keeps the theme switch the previous apply queued', () => {
  const h = boot('t5b')
  const A = h.build({ name: 'A', theme: 'Daylight' })
  h.setRunning(true)
  h.t.doApplyPreset(A)
  const armed = h.pending().primary
  assert.equal(typeof armed.proxyName, 'string')

  // a themeless preset replaces the queue - it must not cancel A's theme
  const r = h.t.doApplyPreset({ id: 'x', name: 'sens only', weapon: {}, primary: { floatSettings: { XSens: 5.5, YSens: 5.5 } } })
  assert.equal(r.theme, 'nochange', 'a sens-only apply says nothing about the theme')
  const q = h.pending()
  assert.equal(q.primary.proxyName, armed.proxyName)
  assert.equal(q.primary.stringSettings.CurrentThemeName, armed.stringSettings.CurrentThemeName)
  assert.equal(q.presetId, 'x', 'the queue names the preset it carries')

  h.setRunning(false)
  h.t.flushPending()
  assert.equal(h.selected(), armed.proxyName)
  assert.equal(h.primary().floatSettings.XSens, 5.5)
})

// ---- 6 ------------------------------------------------------------------------
test('capture while a queued primary carries proxyName saves no proxyName junk', () => {
  const h = boot('t6')
  const A = h.build({ name: 'A', theme: 'Midnight' })
  const B = h.build({ name: 'B', theme: 'Daylight' })
  h.t.doApplyPreset(A)
  h.setRunning(true)
  h.t.doApplyPreset(B)
  assert.equal(typeof h.pending().primary.proxyName, 'string')

  const { active, pending } = h.t.readActiveMerged(h.install)
  assert.equal(pending, true)
  assert.ok(!('proxyName' in active.primary), 'merged state has no proxyName')
  assert.equal(active.primary.stringSettings.CurrentThemeName, '!KovaPreset - Daylight', 'merged view shows the queued intent')
  assert.ok(!('proxyName' in h.invoke('state').active.primary))

  const D = h.invoke('presets:capture', 'D').find((p) => p.name === 'D')
  assert.ok(!('proxyName' in D.primary))
  for (const [section, v] of Object.entries(D.primary)) assert.equal(typeof v, 'object', `${section} is a section`)
  const stored = JSON.parse(fs.readFileSync(path.join(h.userData, 'presets.json'), 'utf8')).presets
  assert.ok(!('proxyName' in stored.find((p) => p.name === 'D').primary), 'nothing junk on disk either')
})

// ---- 7 ------------------------------------------------------------------------
test('hud:save closed drops a stale queued layout', () => {
  const h = boot('t7')
  const B = h.build({ name: 'B', theme: 'Daylight' })
  h.setRunning(true)
  h.t.doApplyPreset(B)
  assert.deepEqual(h.invoke('hud:save', UI_A), { status: 'queued' })
  assert.equal(h.read('UI.json'), UI_JSON, 'UI.json untouched while running')
  assert.equal(h.pending().ui, UI_A)
  assert.ok(h.pending().primary, 'the queued preset stays alongside')

  h.setRunning(false)
  assert.deepEqual(h.invoke('hud:save', UI_B), { status: 'applied' })
  assert.equal(h.read('UI.json'), UI_B)
  const q = h.pending()
  assert.ok(q && !('ui' in q), 'stale layout dropped from the queue')
  assert.ok(q.primary, 'the rest of the queue is kept')
  h.t.flushPending()
  assert.equal(h.read('UI.json'), UI_B, 'the flush does not bring the old layout back')

  // a queue holding only the layout goes away entirely
  h.setRunning(true)
  h.invoke('hud:save', UI_A)
  h.setRunning(false)
  h.invoke('hud:save', UI_B)
  assert.equal(h.pending(), null)
  assert.deepEqual(h.invoke('hud:save', '[]'), { status: 'invalid' })
})

// ---- 8 ------------------------------------------------------------------------
test('presets:import sanitizes hostile presets', async () => {
  const h = boot('t8')
  const file = path.join(h.root, 'hostile.kovapreset.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      kovapreset: 1,
      presets: [
        {
          id: 'stolen-id',
          name: 'evil',
          hotkey: 'Ctrl+A',
          weapon: { CrosshairFile: '..\\..\\evil.png', BodyHitSound: 'C:\\x', CrosshairScale: '1.5', Junk: 'x' },
          primary: {
            proxyName: '!KovaPreset - x',
            stringSettings: { CurrentThemeName: 'a/../b', KillConfirmedSound: 'Pop2', SpawnSound: 'a\nb' },
            floatSettings: { XSens: 'NaN', YSens: 12 },
            integerSettings: { DPI: -1 },
            vectorSettings: { WallColor: { x: 1e9, y: 0, z: 0 } },
            colorSettings: { SkyColor: { r: 300, g: 2, b: 3, a: 255 } },
            junkSettings: { a: 1 },
          },
        },
        { name: 'nothing usable', weapon: { Junk: 1 } },
      ],
    })
  )
  env.openDialog = { canceled: false, filePaths: [file] }
  const r = await h.invoke('presets:import')
  assert.equal(r.ok, true)
  assert.equal(r.count, 1, 'an entry with nothing usable is skipped')
  const p = r.presets.find((x) => x.name === 'evil')
  assert.notEqual(p.id, 'stolen-id')
  assert.equal(p.hotkey, undefined)
  assert.deepEqual(p.weapon, { CrosshairScale: '1.5' })
  assert.deepEqual(p.primary, {
    stringSettings: { KillConfirmedSound: 'Pop2' },
    floatSettings: { YSens: 12 },
  })

  // and applying it writes only what survived
  h.t.doApplyPreset(p)
  assert.ok(!h.read('weaponsettings.ini').includes('evil'))
  assert.equal(h.weapon().CrosshairScale, '1.5')
  assert.equal(h.selected(), 'Default', 'no theme fields, no selection change')
  assert.equal(h.read('Themes/!KovaPreset.json'), THEMES['!KovaPreset.json'])

  env.openDialog = null
  assert.deepEqual(await h.invoke('presets:import'), { ok: false, canceled: true })
})

// ---- runner ---------------------------------------------------------------------
;(async () => {
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log(`main: ${name}: ok`)
    } catch (e) {
      failed++
      console.error(`main: ${name}: FAILED\n${e.stack || e}`)
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true })
  // explicit: nothing main.js scheduled may keep the process (or CI) hanging
  process.exit(failed ? 1 : 0)
})()
