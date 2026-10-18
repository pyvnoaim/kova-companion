// What the kova sync sends: the player's live KovaaK's setup, read straight from
// the game's files, in the shape POST kova.page/api/companion/setup takes. It
// feeds the stream overlay only - kova never copies it onto the profile. Pure
// Node like the rest of core/; the network half lives in main.js.
//
// Reads the FILES rather than mirroring what the app last applied, because the
// point is a change made in game reaching the stream overlay too.
// KovaaK's writes weaponsettings.ini on a crosshair/sound change and rewrites
// PrimaryUserSettings.json on settings-screen interactions, so both kinds of
// change land here through the same watch.
//
// Only self-reported settings. Never scores or ranks: local files can't be
// verified, so the app never writes those into kova.
const fs = require('node:fs')
const k = require('./kovaaks')

const noExt = (s) => String(s || '').replace(/\.[^.]+$/, '')
const blank = (v) => v == null || v === ''

// Live theme swapping pins CurrentThemeName to the proxy, so the raw value reads
// "!KovaPreset - Foo". kova wants "Foo".
function themeLabel(name) {
  const s = String(name || '').trim()
  const sep = `${k.PROXY_THEME} - `
  return s.startsWith(sep) ? s.slice(sep.length) : s
}

// FOV is deliberately NOT in PRIMARY_MANAGED - presets don't capture or write it,
// and adding it there to read it would change what every preset applies. So it's
// found by the key's short name in the raw settings object (file keys carry an
// enum prefix, "EFloatSettingId::FOV"). If KovaaK's has no such field, it's null.
function scanKey(section, re) {
  for (const [key, value] of Object.entries(section || {})) {
    if (re.test(key.split('::').pop())) return value
  }
  return null
}

// Same idea for weaponsettings.ini: the first `Key=value` line whose key matches.
// The global block comes first in the file, so the first hit is the global value,
// not a [weapon] section's override.
function scanWeaponIni(install, re) {
  try {
    const text = fs.readFileSync(k.paths(install).weapon, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([^=[\s]+)=(.*)$/)
      if (m && re.test(m[1])) return m[2].trim() || null
    }
  } catch {}
  return null
}

const num = (v) => (blank(v) || !Number.isFinite(Number(v)) ? null : Number(v))

// `queuedProxyName`: the proxy name a mid-session apply queued for the quit flush.
// The file keeps its launch-time name until then (it's the game's selection key),
// so without this the overlay shows the theme from before the apply.
function setupPayload(install, queuedProxyName) {
  const weapon = k.readWeapon(install)
  const primary = k.readPrimary(install)
  const raw = k.readPrimaryObject(install) || {}
  const s = primary.stringSettings || {}
  // While the proxy theme is selected the game renders the PROXY FILE, and
  // PrimaryUserSettings' theme name goes stale the moment a preset applies live.
  const theme = themeLabel(
    k.proxyThemeSelected(install) ? queuedProxyName || k.readProxyName(install) : s.CurrentThemeName
  )
  return {
    dpi: num(primary.integerSettings?.DPI),
    sens: num(primary.floatSettings?.XSens),
    sensScale: s.SensScaleString || null,
    fov: num(scanKey(raw.floatSettings, /^FOV$/i)),
    // pinned (seen in a real install 2026-10-18): /FOV/ alone matched
    // FILMSCustomFOV ("hML") before FOVScaleString
    fovScale: scanKey(raw.stringSettings, /^FOVScaleString$/i) || null,
    theme: theme || null,
    crosshair: weapon.CrosshairFile ? noExt(weapon.CrosshairFile) : null,
    crosshairScale: num(weapon.CrosshairScale),
    hitSound: blank(weapon.BodyHitSound) ? null : noExt(weapon.BodyHitSound),
    // weaponsettings.ini has ShootSoundCooldown and HitSoundCooldown (seen in a
    // real install 2026-10-18); this row sits next to the hit sound
    soundCooldown: num(scanWeaponIni(install, /^HitSoundCooldown$/i)),
  }
}

// Snipe alerts: the PBs (from kova's /api/companion/snipes) that beat your
// local best on the same scenario, each with that best as `mine`. A scenario
// you've never played isn't a snipe - there's nothing of yours to beat.
// `localRuns`: lowercased scenario name -> runs, as progress.localRuns returns.
function pickSnipes(pbs, localRuns) {
  return pbs.flatMap((p) => {
    const runs = localRuns.get(p.scenario.toLowerCase())
    if (!runs?.length) return []
    const mine = Math.max(...runs.map((r) => r.score))
    return p.score > mine ? [{ ...p, mine }] : []
  })
}

module.exports = { setupPayload, themeLabel, scanKey, scanWeaponIni, pickSnipes }
