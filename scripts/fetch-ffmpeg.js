#!/usr/bin/env node
// Puts the autoclipper's ffmpeg into vendor/ffmpeg/ before electron-builder runs,
// which bundles that folder (package.json build.win.extraResources).
//
// The Windows binary is built by the "ffmpeg" workflow (scripts/build-ffmpeg.sh)
// and published as a pre-release, so the app's auto-updater - which follows the
// latest regular release - never mistakes it for an app version. It's fetched
// with gh and must match the sha256 pinned in scripts/ffmpeg-pin.json: what
// ships is exactly what was built from FFmpeg's signed source, never whatever
// happens to be in the release.
//
//   node scripts/fetch-ffmpeg.js          fetch + verify (no-op if already right)
//   node scripts/fetch-ffmpeg.js --check  verify only, exit 1 if missing or wrong
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const out = path.join(root, 'vendor', 'ffmpeg')
const pin = JSON.parse(fs.readFileSync(path.join(__dirname, 'ffmpeg-pin.json'), 'utf8'))
const exe = path.join(out, 'ffmpeg.exe')
const FILES = ['ffmpeg.exe', 'LICENSE.md', 'SOURCE.md']

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const ok = () => FILES.every((f) => fs.existsSync(path.join(out, f))) && sha(exe) === pin.sha256

function fetchFfmpeg({ check = false } = {}) {
  if (!/^[0-9a-f]{64}$/.test(pin.sha256 || ''))
    throw new Error(
      `no ffmpeg pinned yet: run the "ffmpeg" workflow (Actions tab), then put the sha256 it prints into scripts/ffmpeg-pin.json`
    )
  if (ok()) return 'already in place'
  if (check) throw new Error(`vendor/ffmpeg is missing or doesn't match the pinned sha256`)
  fs.mkdirSync(out, { recursive: true })
  const args = ['release', 'download', pin.release, '--dir', out, '--clobber']
  for (const f of FILES) args.push('--pattern', f)
  execFileSync('gh', args, { cwd: root, stdio: 'inherit' })
  if (!ok()) {
    fs.rmSync(exe, { force: true })
    throw new Error(`downloaded ffmpeg.exe doesn't match the pinned sha256 - not using it`)
  }
  return `fetched ${pin.release}`
}

module.exports = { fetchFfmpeg }

if (require.main === module) {
  try {
    console.log(`ffmpeg: ${fetchFfmpeg({ check: process.argv.includes('--check') })}`)
  } catch (e) {
    console.error(`ffmpeg: ${e.message}`)
    process.exit(1)
  }
}
