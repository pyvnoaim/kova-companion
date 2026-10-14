// Read-only smoke test for the core against the real install. Writes nothing.
// Run: npm run core:test
const assert = require('node:assert')
const k = require('./kovaaks')

// UI.json validation (hud:save boundary) - pure, runs anywhere (no install needed)
assert.ok(k.validUi('{"windows":[]}'))
assert.ok(!k.validUi('not json'))
assert.ok(!k.validUi('null'), 'null parses but carries nothing')
assert.ok(!k.validUi('{'.repeat(600 * 1024)))
console.log('UI.json validation: ok')

// sens picks - pure, no install needed. Sens rides the global XSens/YSens (the
// launch path), NOT the weaponsettings override, which the game ignores on its
// scenario-entry reload - verified in-game, see setSensPick.
{
  const w = {}
  const pr = {}
  k.setSensPick(w, pr, 52, 'cm/360')
  assert.equal(pr.floatSettings.XSens, 52, 'global sens is the only route that works')
  assert.equal(pr.floatSettings.YSens, 52)
  assert.equal(pr.stringSettings.SensScaleString, 'cm/360')
  assert.equal(w.HorizontalSens, '52')
  assert.equal(w.VerticalSens, '52')
  assert.equal(w.OverrideSensScaleString, 'cm/360', 'scale must be pinned, not left stale')
  // the override wins at launch, so leaving it on would shadow the XSens above
  // and make the pick appear to do nothing
  assert.equal(w.OverrideSens, 'false', 'override must be cleared or it shadows global sens')
  // SensScale mirrors the legacy enum and routinely disagrees with the real
  // scale - writing it would reinterpret the number, so it must stay untouched
  assert.ok(!('SensScale' in w), 'legacy SensScale must be left alone')

  // an already-on override must be turned off, not preserved
  const w3 = { OverrideSens: 'true' }
  k.setSensPick(w3, {}, 40, 'cm/360')
  assert.equal(w3.OverrideSens, 'false', 'a pre-existing override must be cleared too')

  // no scale known: still set the value rather than pinning a wrong scale
  const w2 = {}
  const pr2 = {}
  k.setSensPick(w2, pr2, 30, '')
  assert.equal(w2.HorizontalSens, '30')
  assert.equal(pr2.floatSettings.XSens, 30)
  assert.ok(!('OverrideSensScaleString' in w2), 'no scale to pin means leave it as-is')

  // scale resolution: the preset's own wins, else the live one
  assert.equal(k.sensScaleOf({ stringSettings: { SensScaleString: 'in/360' } }, null), 'in/360')
  assert.equal(
    k.sensScaleOf({}, { primary: { stringSettings: { SensScaleString: 'Valorant' } } }),
    'Valorant',
    'an old preset with no scale falls back to the live one'
  )
  assert.equal(k.sensScaleOf(null, null), '')
  console.log('sens picks: ok')
}

// weaponsettings parsing against synthetic files - pure, and the real install
// can't exercise the cases that matter (per-weapon sections, a managed key on
// line 1 behind the BOM). Writes only to a temp dir.
{
  const fs2 = require('node:fs')
  const os2 = require('node:os')
  const path2 = require('node:path')
  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'kova-selftest-'))
  const sg = path2.join(root, 'Saved', 'SaveGames')
  fs2.mkdirSync(sg, { recursive: true })
  const file = path2.join(sg, 'weaponsettings.ini')
  const write = (s) => fs2.writeFileSync(file, s)

  // A BOM sits before the first key, so /^Key=/m can't match line 1 unless the
  // BOM is split off first. The real file starts with an unmanaged key, which is
  // the only reason this never showed up as a silent read-of-"" / failed write.
  write('﻿CrosshairFile=global.png\nHorizontalSens=52.0\nOverrideSens=false\n')
  assert.equal(k.readWeapon(root).CrosshairFile, 'global.png', 'must read a managed key on line 1 past the BOM')

  // Per-weapon sections repeat every key, so reads/writes must stay in the
  // global block, and a section must survive a write byte-for-byte.
  write(
    '﻿CrosshairFile=global.png\nHorizontalSens=52.0\nOverrideSens=false\n\n' +
      '[pistol]\nUseDefaults=false\nCrosshairFile=section.png\nHorizontalSens=999.0\n'
  )
  assert.equal(k.readWeapon(root).CrosshairFile, 'global.png', 'must not read a section value')
  assert.equal(k.readWeapon(root).HorizontalSens, '52.0')
  const secBefore = fs2.readFileSync(file, 'utf8').slice(fs2.readFileSync(file, 'utf8').indexOf('[pistol]'))
  assert.equal(k.applyWeapon(root, { CrosshairFile: 'new.png' }), true)
  const after = fs2.readFileSync(file, 'utf8')
  assert.ok(after.startsWith('﻿'), 'BOM must be preserved on write')
  assert.equal(after.slice(after.indexOf('[pistol]')), secBefore, 'per-weapon section must be untouched')
  assert.equal(k.readWeapon(root).CrosshairFile, 'new.png')
  assert.equal(k.applyWeapon(root, { CrosshairFile: 'new.png' }), false, 'a no-op apply must report false')

  // a value containing "[" must not be mistaken for a section header
  write('﻿CrosshairFile=odd[1].png\n\n[pistol]\nCrosshairFile=b.png\n')
  assert.equal(k.readWeapon(root).CrosshairFile, 'odd[1].png', 'a bracket in a value is not a header')

  fs2.rmSync(root, { recursive: true, force: true })
  console.log('weaponsettings sections + BOM: ok')
}

// primaryDiffers while the game is on the proxy theme - synthetic install, so it
// can stage the exact mid-session state: the settings file stale on the LAUNCH
// theme (the game rewrites it from launch-time memory) while the proxy file
// holds what a live apply put on screen. Re-applying the launch preset must
// read as a change, or the proxy is never rewritten and the player keeps the
// previous preset's theme (the "going back to the preset I launched with does
// nothing" bug).
{
  const fs2 = require('node:fs')
  const os2 = require('node:os')
  const path2 = require('node:path')
  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'kova-selftest-'))
  const sg = path2.join(root, 'Saved', 'SaveGames')
  fs2.mkdirSync(path2.join(sg, 'Themes'), { recursive: true })
  fs2.writeFileSync(path2.join(sg, 'weaponsettings.ini'), '﻿CrosshairFile=dot.png\n')

  const themeX = { WallColor: [0.1, 0.1, 0.1] }
  const themeA = { WallColor: [0.9, 0, 0] }
  const primaryOf = (theme, name) => ({
    stringSettings: { CurrentThemeName: name },
    floatSettings: { XSens: 0.5 },
    integerSettings: { DPI: 3200 },
    vectorSettings: theme,
  })
  // the on-disk settings file nests managed fields under `<PREFIX>::<name>`
  const PREFIX = {
    stringSettings: 'EStringSettingId',
    floatSettings: 'EFloatSettingId',
    integerSettings: 'EIntegerSettingId',
    vectorSettings: 'EVectorSettingId',
  }
  const writeSettings = (primary) => {
    const out = {}
    for (const [section, fields] of Object.entries(primary)) {
      out[section] = {}
      for (const [name, val] of Object.entries(fields)) out[section][`${PREFIX[section]}::${name}`] = val
    }
    fs2.writeFileSync(path2.join(sg, 'PrimaryUserSettings.json'), JSON.stringify(out, null, '\t'))
  }

  const presetX = primaryOf(themeX, 'X')
  const presetA = primaryOf(themeA, 'A')
  writeSettings(primaryOf(themeX, '!KovaPreset - X')) // stale: still the launch theme
  k.writeProxyTheme(root, presetA, '!KovaPreset - X') // live: the last mid-session apply
  assert.ok(k.proxyThemeSelected(root))
  assert.equal(k.primaryDiffers(root, presetX), true, 'returning to the launch preset must count as a change')
  assert.equal(k.primaryDiffers(root, presetA), false, 're-applying what the proxy renders must be a no-op')
  // non-theme fields have no live route - they still compare against the settings file
  const sensBump = JSON.parse(JSON.stringify(presetA))
  sensBump.floatSettings.XSens = 0.9
  assert.equal(k.primaryDiffers(root, sensBump), true, 'sens still compares against the settings file')
  // off the proxy (or with no proxy file), the settings file decides as before
  writeSettings(primaryOf(themeX, 'SomeRealTheme'))
  assert.equal(k.primaryDiffers(root, presetX), false, 'off-proxy: settings file decides')
  assert.equal(k.primaryDiffers(root, presetA), true)
  fs2.rmSync(path2.join(sg, 'Themes', '!KovaPreset.json'))
  writeSettings(primaryOf(themeX, '!KovaPreset - X'))
  assert.equal(k.primaryDiffers(root, presetX), false, 'proxy selected but file missing: no crash, settings decide')

  fs2.rmSync(root, { recursive: true, force: true })
  console.log('primaryDiffers vs proxy theme: ok')
}

// Theme round trip: primary -> proxy theme file -> primary. The two directions
// share one field table (THEME_FIELDS), and this is what catches a row that maps
// one way only - which would silently drop that field from every applied preset.
{
  const fs2 = require('node:fs')
  const os2 = require('node:os')
  const path2 = require('node:path')
  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'kova-roundtrip-'))
  fs2.mkdirSync(path2.join(root, 'Saved', 'SaveGames', 'Themes'), { recursive: true })

  // one field per section, plus a surface and an enemy field from each family
  const primary = {
    stringSettings: { WallMaterial: 'Concrete', CeilingMaterial: 'Metal' },
    floatSettings: { FloorRoughness: 0.42, EnemyGlowUpHeadOnLookAt: 1.5, EnemyMetalic: 0.25 },
    integerSettings: { SkyPreset: 3, CloudCover: 1 },
    booleanSettings: { SolidSkyColor: true, OverrideEnemyBodyColor: false },
    vectorSettings: { RampColor: [0.2, 0.4, 0.6], EnemyBodyColorOnHit: [1, 0, 0] },
    colorSettings: { SkyColor: { R: 0.1, G: 0.2, B: 0.3, A: 1 } },
  }
  k.writeProxyTheme(root, primary, '!KovaPreset - RoundTrip')
  const back = k.readProxyPrimary(root)
  for (const [section, fields] of Object.entries(primary))
    for (const [name, val] of Object.entries(fields))
      assert.deepEqual(back[section]?.[name], val, `${section}.${name} survives the round trip`)
  assert.equal(back.stringSettings.CurrentThemeName, '!KovaPreset - RoundTrip')

  fs2.rmSync(root, { recursive: true, force: true })
  console.log('theme round trip: ok')
}

// stats-CSV filename parsing - pure. Feeds recentScenariosFromStats, which the
// scenario re-enter / restart follow-ups resolve their jump target from.
{
  const p1 = k.statsFileScenario('VT Pasu Advanced S5 - Challenge - 2026.07.29-19.05.28 Stats.csv')
  assert.equal(p1.scenario, 'VT Pasu Advanced S5')
  assert.equal(p1.ts, new Date(2026, 6, 29, 19, 5, 28).getTime(), 'timestamp parses as local time')
  // scenario names can contain " - " themselves; the greedy head must keep it
  const p2 = k.statsFileScenario('A - B - Challenge - 2026.01.02-03.04.05 Stats.csv')
  assert.equal(p2.scenario, 'A - B')
  // the older builds' name: no " Stats" suffix, "Challenge Start" as the mode
  const p3 = k.statsFileScenario('1wall6targets TE - Challenge Start - 2024.03.01-12.30.45.csv')
  assert.equal(p3.scenario, '1wall6targets TE')
  assert.equal(p3.ts, new Date(2024, 2, 1, 12, 30, 45).getTime())
  assert.equal(k.statsFileScenario('not a stats file.csv'), null)
  assert.equal(k.statsFileScenario('A - Challenge - 2024.03.01-12.30.45 Stats.txt'), null)
  console.log('stats-CSV parsing: ok')
}

// session.sav: the scenario loaded right now, which re-enter / restart target.
// Hand-built GVAS bytes in the shape the reader expects; every malformed case
// must come back null so the caller falls back to the stats history.
{
  const fs2 = require('node:fs')
  const os2 = require('node:os')
  const path2 = require('node:path')
  const i32 = (n) => {
    const b = Buffer.alloc(4)
    b.writeInt32LE(n)
    return b
  }
  const fstr = (s) => Buffer.concat([i32(s.length + 1), Buffer.from(s + '\0', 'latin1')])
  const fstr16 = (s) => Buffer.concat([i32(-(s.length + 1)), Buffer.from(s + '\0', 'utf16le')])
  const sav = (value, type = 'StrProperty') =>
    Buffer.concat([
      Buffer.from('GVAS\x02\x00junk', 'latin1'),
      fstr('ScenarioName'),
      fstr(type),
      Buffer.alloc(8), // int64 size
      Buffer.from([0]), // hasGuid
      value,
      fstr('NextProperty'),
    ])

  assert.equal(k.sessionScenarioFromBuffer(sav(fstr('VT Pasu Novice S5'))), 'VT Pasu Novice S5')
  assert.equal(k.sessionScenarioFromBuffer(sav(fstr16('Gauntlet Ä'))), 'Gauntlet Ä', 'UTF-16 names')
  assert.equal(k.sessionScenarioFromBuffer(sav(fstr('x'), 'IntProperty')), null, 'wrong type')
  assert.equal(k.sessionScenarioFromBuffer(Buffer.from('nothing to see here')), null, 'no property')
  assert.equal(k.sessionScenarioFromBuffer(sav(fstr('VT Pasu Novice S5')).subarray(0, 70)), null, 'cut off mid-write')
  assert.equal(k.sessionScenarioFromBuffer(sav(i32(5000))), null, 'absurd length')

  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'kova-session-'))
  const sg = path2.join(root, 'Saved', 'SaveGames')
  fs2.mkdirSync(sg, { recursive: true })
  assert.equal(k.currentScenario(root), null, 'no session.sav: null, no throw')
  fs2.writeFileSync(path2.join(sg, 'session.sav'), sav(fstr('1wall6targets TE')))
  assert.equal(k.currentScenario(root), '1wall6targets TE')
  fs2.rmSync(root, { recursive: true, force: true })
  console.log('session.sav scenario: ok')
}

// Rank progress: odds, the page model, the session pick, rank-up detection, and
// reading local runs from a fake stats folder.
{
  const fs2 = require('node:fs')
  const os2 = require('node:os')
  const path2 = require('node:path')
  const p = require('./progress')
  assert.ok(Math.abs(p.normCdf(0) - 0.5) < 1e-6)
  assert.ok(Math.abs(p.normCdf(1.96) - 0.975) < 1e-3)
  assert.equal(p.rankUpOdds([900, 910, 920], 930), null, 'under 5 runs: no estimate')
  const runs = [860, 870, 880, 875, 865, 890, 872, 868]
  const odds = p.rankUpOdds(runs, 930)
  assert.ok(odds > 0 && odds < 0.05, 'a line far above every run is unlikely, but not impossible')
  assert.ok(p.rankUpOdds(runs, 860) > 0.8, 'a line below most runs is likely')

  const th = [
    { rank: 'Platinum', score: 770, color: '#2FCFC2' },
    { rank: 'Diamond', score: 850, color: '#B9F2FF' },
    { rank: 'Jade', score: 930, color: '#85FA85' },
    { rank: 'Master', score: 980, color: '#EC44CA' },
  ]
  const local = new Map([['vt pasu intermediate s5', runs.map((score, i) => ({ score, ts: i }))]])
  const [row] = p.buildProgress([{ name: 'VT Pasu Intermediate S5', thresholds: th, best: 896 }], local)
  assert.equal(row.best, 896, "kova's verified best wins when it's higher than any local run")
  assert.equal(row.rank.name, 'Diamond')
  assert.equal(row.next.name, 'Jade')
  assert.equal(row.toNext, 34)
  assert.ok(Math.abs(row.pct - (896 - 850) / 80) < 1e-9)
  const [fresh] = p.buildProgress([{ name: 'VT Pasu Intermediate S5', thresholds: th, best: 850 }], local)
  assert.equal(fresh.best, 890, 'a newer local run beats a lagging kova best')
  const [none] = p.buildProgress([{ name: 'Unplayed', thresholds: th, best: null }], new Map())
  assert.equal(none.rank, null)
  assert.equal(none.next.name, 'Platinum')
  assert.equal(none.odds, null)

  assert.deepEqual(
    p.pickSession([
      { name: 'a', next: {}, odds: 0.05 },
      { name: 'b', next: {}, odds: 0.3 },
      { name: 'c', next: null, odds: null }, // maxed: nothing to rank up
      { name: 'd', next: {}, odds: 0.001 }, // hopeless: left out
    ]),
    ['b', 'a']
  )
  assert.equal(p.rankUpFrom(th, 896, 934).rank, 'Jade')
  assert.equal(p.rankUpFrom(th, 896, 920), null, 'a PB inside the same tier is not a rank-up')
  assert.equal(p.rankUpFrom(th, null, 800).rank, 'Platinum', 'first run ever can rank up')

  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'kova-progress-'))
  const stats = path2.join(root, 'stats')
  fs2.mkdirSync(stats)
  fs2.writeFileSync(path2.join(stats, 'VT Pasu Intermediate S5 - Challenge - 2026.10.14-20.00.00 Stats.csv'), 'Kill #,Timestamp\n\nScore:,912.5\nHit Count:,80\n')
  fs2.writeFileSync(path2.join(stats, 'Other Scenario - Challenge - 2026.10.14-20.05.00 Stats.csv'), 'Score:,1\n')
  const got = p.localRuns(root, ['VT Pasu Intermediate S5'])
  assert.deepEqual([...got.keys()], ['vt pasu intermediate s5'], 'only the asked-for scenarios are read')
  assert.equal(got.get('vt pasu intermediate s5')[0].score, 912.5)
  fs2.rmSync(root, { recursive: true, force: true })
  console.log('rank progress: ok')
}

// Session history: days, sessions split by breaks, PBs and rank-ups as they
// were at the time, and the duration read from "Challenge Start".
{
  const p = require('./progress')
  const h = require('./history')
  const at = (y, mo, d, hh, mm) => new Date(y, mo - 1, d, hh, mm).getTime()
  const run = (scenario, ts, score, durMin = 1) => ({ scenario, ts, score, hits: 9, misses: 1, durationMs: durMin * 60000 })
  const runs = [
    run('Pasu', at(2026, 7, 28, 19, 0), 880), // first ever: not a PB
    run('Pasu', at(2026, 7, 28, 19, 2), 900), // PB +20
    run('Pasu', at(2026, 7, 28, 19, 4), 890),
    run('Popcorn', at(2026, 7, 28, 21, 0), 700), // 2h break: a second session
    run('Pasu', at(2026, 7, 30, 18, 0), 934), // next day: PB, crosses Jade
  ]
  const th = new Map([['pasu', [{ rank: 'Diamond', score: 850 }, { rank: 'Jade', score: 930 }]]])
  const days = h.buildHistory(runs, th)
  assert.deepEqual(days.map((d) => d.key), ['2026-07-30', '2026-07-28'], 'newest day first')
  const d28 = days[1]
  assert.equal(d28.runs, 4)
  assert.equal(d28.sessions, 2, 'a 2h break splits the day')
  assert.equal(d28.pbCount, 1, "the first-ever run isn't a PB")
  assert.deepEqual(d28.pbs, [{ scenario: 'Pasu', score: 900, gain: 20, rankUp: null }])
  assert.equal(d28.playMs, 4 * 60000)
  assert.equal(d28.played[0].scenario, 'Pasu')
  assert.ok(Math.abs(d28.played[0].acc - 0.9) < 1e-9)
  assert.deepEqual(days[0].rankUps, [{ scenario: 'Pasu', rank: 'Jade', color: null }])
  assert.equal(days[0].pbs[0].gain, 34, 'gain is over the best from before that day')
  const years = h.yearsOf(days)
  assert.deepEqual(years.map((y) => [y.year, y.runs, y.days, y.pbs]), [[2026, 5, 2, 2]])
  // "Challenge Start" is a clock time: a run ending 00:00:30 that started 23:59:00
  const end = at(2026, 7, 29, 0, 0) + 30000
  assert.equal(p.runDurationMs('Challenge Start:,23:59:00.000\n', end), 90000, 'across midnight')
  assert.equal(p.runDurationMs('no such row', end), null)
  console.log('session history: ok')
}

// Autoclipper: which runs, file names, the cut, and OBS's auth handshake.
{
  const c = require('./clipper')
  const path2 = require('node:path')
  const run = { scenario: 'VT Pasu Intermediate S5', ts: new Date(2026, 6, 28, 20, 41, 5).getTime(), score: 934, durationMs: 60000 }
  assert.deepEqual(c.clipReason('pb', run, 896, null), { why: 'pb', gain: 38 })
  assert.equal(c.clipReason('pb', run, null, null), null, 'a first-ever run is not a PB')
  assert.equal(c.clipReason('pb', run, 940, null), null)
  assert.equal(c.clipReason('rankup', run, 896, null), null, 'a PB without a rank-up, in rank-up mode')
  assert.equal(c.clipReason('rankup', run, 896, 'Jade').rank, 'Jade')
  assert.equal(c.clipReason('every', run, 999, null).why, 'run')
  assert.equal(
    c.clipPath('D:\\Clips', run, '.mkv'),
    path2.join('D:\\Clips', 'VT Pasu Intermediate S5', 'VT Pasu Intermediate S5 - 934 - 2026-07-28 20.41.05.mkv')
  )
  assert.equal(c.safeName('a<b>:c?*. '), 'abc', 'Windows-illegal characters and a trailing dot go')
  assert.equal(c.safeName('CON'), '_CON', 'reserved device names get a prefix')
  // saved 3s after a 60s run ended: cut 3 + 60 + 3 seconds from the end
  assert.equal(c.trimFromEndS(run, run.ts + 3000), 66)
  assert.equal(c.trimFromEndS({ ...run, durationMs: null }, run.ts), null, 'unknown start: keep the whole buffer')
  // the worked example from OBS's own protocol docs (obs-websocket protocol.md)
  assert.equal(
    c.obsAuth('supersecretpassword', 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=', '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY='),
    '1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4='
  )
  console.log('autoclipper: ok')
}

// kova sync payload, against a fake install. This is what ends up on someone's
// profile and stream, and each field has a wrong-but-plausible failure.
{
  const fs2 = require('node:fs')
  const os2 = require('node:os')
  const path2 = require('node:path')
  const c = require('./companion')
  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'kova-sync-'))
  const sg = path2.join(root, 'Saved', 'SaveGames')
  fs2.mkdirSync(path2.join(sg, 'Themes'), { recursive: true })
  fs2.writeFileSync(
    path2.join(sg, 'weaponsettings.ini'),
    '﻿CrosshairFile=ZeeqPlus2.png\r\nCrosshairScale=1.0\r\nBodyHitSound=Porphyr2.ogg\r\nHitSoundCooldown=0.03\r\n[Rifle]\r\nHitSoundCooldown=9\r\n'
  )
  fs2.writeFileSync(
    path2.join(sg, 'PrimaryUserSettings.json'),
    JSON.stringify({
      stringSettings: { 'EStringSettingId::CurrentThemeName': '!KovaPreset - Old', 'EStringSettingId::SensScaleString': 'cm/360', 'EStringSettingId::FOVScale': 'Overwatch' },
      floatSettings: { 'EFloatSettingId::XSens': 37, 'EFloatSettingId::FOV': 103 },
      integerSettings: { 'EIntegerSettingId::DPI': 3200 },
    })
  )
  // mid-session live swap: the proxy file carries the theme actually on screen
  k.writeProxyTheme(root, { vectorSettings: { WallColor: [0.1, 0.1, 0.1] } }, '!KovaPreset - Misery')
  assert.deepEqual(c.setupPayload(root), {
    dpi: 3200,
    sens: 37,
    sensScale: 'cm/360',
    fov: 103,
    fovScale: 'Overwatch',
    theme: 'Misery', // the proxy's, unwrapped - not the stale launch name
    crosshair: 'ZeeqPlus2',
    crosshairScale: 1,
    hitSound: 'Porphyr2',
    soundCooldown: 0.03, // the global block, not the [Rifle] override
  })
  assert.equal(c.scanKey({ 'EFloatSettingId::FOVOther': 1 }, /^FOV$/i), null, 'anchored, not substring')
  assert.equal(c.scanWeaponIni(path2.join(root, 'missing'), /cooldown/i), null, 'no install, no throw')
  fs2.rmSync(root, { recursive: true, force: true })
  console.log('kova sync payload: ok')

  const local = new Map([['pasu', [{ score: 900 }, { score: 950 }]]])
  const snipes = c.pickSnipes(
    [
      { id: 'a', scenario: 'Pasu', score: 960 }, // beats 950, matched case-insensitively
      { id: 'b', scenario: 'Pasu', score: 950 }, // a tie isn't a snipe
      { id: 'c', scenario: 'Never Played', score: 1 },
    ],
    local
  )
  assert.deepEqual(snipes.map((s) => [s.id, s.mine]), [['a', 950]])
  console.log('snipe picks: ok')

  const pr = require('./progress')
  const DAY = 24 * 60 * 60 * 1000
  const now = 100 * DAY
  const th = [{ rank: 'Gold', score: 800 }, { rank: 'Jade', score: 900 }, { rank: 'Master', score: 1000 }]
  const runs = [{ ts: now - 50 * DAY, score: 870 }, { ts: now - 20 * DAY, score: 850 }, { ts: now - 10 * DAY, score: 880 }, { ts: now - 5 * DAY, score: 910 }]
  const ch = pr.scenarioChart(runs, th, 30, now)
  assert.equal(ch.points.length, 3, 'only runs inside the range')
  assert.deepEqual(ch.points.map((p) => p.pb), [false, true, true], '870 from before the range is the best to beat')
  assert.deepEqual(ch.lines.map((l) => l.name), ['Jade', 'Master'], 'the rank you are on and the next')
  assert.ok(ch.best[0][0] === 0 && ch.best.at(-1)[0] === 1, 'best line spans the chart')
  assert.ok(ch.points.every((p) => p.y > 0 && p.y < 1) && ch.lines.every((l) => l.y > 0 && l.y < 1), 'all inside')
  assert.equal(pr.scenarioChart([], th, 30, now).points.length, 0, 'no runs, empty chart')
  console.log('score graph: ok')
}

const install = k.findInstall()
console.log('install:', install || 'NOT FOUND')
// Everything above is pure and passes anywhere, so no install is a clean stop,
// not a failure - that's what lets CI and non-Windows contributors run this.
if (!install) {
  console.log('\nno KovaaK\'s install here - pure checks passed, skipping the live ones')
  process.exit(0)
}

console.log('game running:', k.isGameRunning())

const active = k.readActive(install)
console.log('\nactive weapon (live: crosshair + combat sounds):')
console.log(JSON.stringify(active.weapon, null, 2))
console.log('\nactive theme name:', active.primary.stringSettings.CurrentThemeName)
console.log('theme fields captured:', Object.values(active.primary).reduce((n, s) => n + Object.keys(s).length, 0))

const opts = k.listOptions(install)
console.log('\noptions available:')
console.log(`  crosshairs: ${opts.crosshairs.length}`)
console.log(`  sounds:     ${opts.sounds.length}`)
console.log(`  themes:     ${opts.themes.length}`)

// change detection against a clone with one tweaked field (no writes)
const clone = JSON.parse(JSON.stringify(active))
clone.weapon.CrosshairFile = 'blank.png'
console.log('\nweaponDiffers vs tweaked clone:', k.weaponDiffers(install, clone.weapon))
console.log('primaryDiffers vs same snapshot:', k.primaryDiffers(install, active.primary))

// health check - probeWrites:false keeps it strictly read-only (accessSync, no
// temp file). Shape + a sane result against the real install.
const health = k.checkHealth(install, { probeWrites: false })
assert.ok(Array.isArray(health.checks) && health.checks.length, 'health returns checks')
assert.ok(['ok', 'warn', 'fail'].includes(health.status), 'health status is valid')
assert.equal(health.checks.find((c) => c.id === 'install').status, 'ok', 'install check ok when found')
const missing = k.checkHealth(null)
assert.equal(missing.status, 'fail', 'null install is a fail')
console.log('\nhealth:', health.status, '-', health.checks.map((c) => `${c.id}:${c.status}`).join(' '))
