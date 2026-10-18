// Rank progress: your local runs, layered on a benchmark playlist from kova
// (thresholds + your verified bests), turned into what the page shows - rank,
// points to the next one, rank-up odds, a rank-up session, and rank-up detection.
// Pure Node like the rest of core/; the network half lives in main.js.
//
// Local runs are display only. They make the page current the moment a run ends
// (kova's verified bests lag behind KovaaK's own API), but nothing read here is
// ever written into kova: local files can't be verified.
const fs = require('node:fs')
const path = require('node:path')
const k = require('./kovaaks')

// ---- local runs ---------------------------------------------------------------
// A stats CSV is written once when a run ends and never changes, so a parsed
// file is cached by name for the life of the app - the folder holds thousands.
const runCache = new Map() // filename -> { scenario, ts, score } | null
const RECENT = 20 // runs the odds and "typical" are computed over

// One `Key:,value` summary row of a stats CSV, as a number (null if absent).
function csvNum(text, key) {
  const m = text.match(new RegExp(`^${key}:,\\s*([-\\d.]+)`, 'm'))
  return m && Number.isFinite(Number(m[1])) ? Number(m[1]) : null
}

// How long a run took, in ms. `Challenge Start:` is a clock time (HH:MM:SS.mmm),
// not a duration: the start is the file's end time with its clock replaced, a
// day earlier if that lands after the end (a run across midnight). Null when the
// row is missing or the result is implausible.
function runDurationMs(text, endTs) {
  const m = text.match(/^Challenge Start:,\s*(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/m)
  if (!m) return null
  const start = new Date(endTs)
  start.setHours(+m[1], +m[2], 0, 0)
  let startTs = start.getTime() + Number(m[3]) * 1000
  if (startTs > endTs) {
    // a calendar day back, not 24h: across a DST switch the day is 23 or 25h
    start.setDate(start.getDate() - 1)
    startTs = start.getTime() + Number(m[3]) * 1000
  }
  const ms = endTs - startTs
  return ms > 0 && ms <= 2 * 3600 * 1000 ? ms : null
}

// A stats file's run, or null. `undefined` from runFromText means "not finished
// writing yet" and is never cached, so the next read tries again.
function runFromText(meta, text) {
  const score = csvNum(text, 'Score')
  if (score == null) return undefined // the summary rows land last
  return {
    scenario: meta.scenario,
    ts: meta.ts, // when the run ended
    score,
    hits: csvNum(text, 'Hit Count'),
    misses: csvNum(text, 'Miss Count'),
    durationMs: activeMs(runDurationMs(text, meta.ts), csvNum(text, 'Pause Duration')),
  }
}

// Wall time minus pauses (seconds in the CSV): a run paused for 7 minutes is
// still a one-minute run.
function activeMs(ms, pauseS) {
  if (ms == null || !(pauseS > 0)) return ms
  return Math.max(0, ms - pauseS * 1000)
}

// KovaaK's writes a stats file as UTF-16LE (with a BOM) when the scenario name
// has characters outside ASCII (✦, CJK, ...); everything else is UTF-8.
function decodeStats(buf) {
  return buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le', 2) : buf.toString('utf8')
}

function parseRun(dir, file) {
  if (runCache.has(file)) return runCache.get(file)
  const meta = k.statsFileScenario(file)
  if (!meta) {
    runCache.set(file, null)
    return null
  }
  let text
  try {
    text = decodeStats(fs.readFileSync(path.join(dir, file)))
  } catch {
    return null // locked mid-write: not cached, so the next read retries it
  }
  const run = runFromText(meta, text)
  if (run === undefined) return null
  runCache.set(file, run)
  return run
}

// Every run in the stats folder, oldest first. The folder can hold years of
// play; each file is parsed once per app run (runCache), so repeat calls only
// pay for new files.
// Async: the first call on a big stats folder reads thousands of files, and
// doing that synchronously would freeze the window.
async function allRuns(install) {
  const dir = path.join(install, 'stats')
  let files
  try {
    files = await fs.promises.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    let run = runCache.get(f)
    if (!runCache.has(f)) {
      const meta = k.statsFileScenario(f)
      if (!meta) runCache.set(f, (run = null))
      else {
        const text = await fs.promises.readFile(path.join(dir, f)).then(decodeStats, () => null)
        run = text == null ? null : runFromText(meta, text)
        if (text != null && run !== undefined) runCache.set(f, run)
      }
    }
    if (run) out.push(run)
  }
  return out.sort((a, b) => a.ts - b.ts)
}

// scenario name (lowercased) -> runs, oldest first. Only files whose NAME is one
// of `names` are opened, so a benchmark's worth of reads, not the whole folder.
function localRuns(install, names) {
  const want = new Set([...names].map((n) => n.toLowerCase()))
  const out = new Map()
  const dir = path.join(install, 'stats')
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return out
  }
  for (const f of files) {
    const meta = k.statsFileScenario(f)
    if (!meta || !want.has(meta.scenario.toLowerCase())) continue
    const run = parseRun(dir, f)
    if (!run) continue
    const key = run.scenario.toLowerCase()
    if (!out.has(key)) out.set(key, [])
    out.get(key).push(run)
  }
  for (const runs of out.values()) runs.sort((a, b) => a.ts - b.ts)
  return out
}

// ---- odds -----------------------------------------------------------------------
// Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7).
function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp((-z * z) / 2)
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2
}

// The chance one more run clears `threshold`, estimated from the spread of the
// recent runs. An estimate, not a count: the next rank is usually above your best,
// so no past run has cleared it. Null under 5 runs - too few to say anything.
// ponytail: a normal fit; scores skew a little (bad runs trail long). Good enough
// to rank scenarios against each other, which is all the page uses it for.
function rankUpOdds(scores, threshold) {
  const recent = scores.slice(-RECENT)
  if (recent.length < 5) return null
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length
  const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / (recent.length - 1))
  if (sd < 1e-9) return mean >= threshold ? 1 : 0
  return 1 - normCdf((threshold - mean) / sd)
}

function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// Index of the highest threshold `score` clears, -1 below all of them.
function tierIndex(thresholds, score) {
  let idx = -1
  if (score == null) return idx
  for (let i = 0; i < thresholds.length; i++) if (score >= thresholds[i].score) idx = i
  return idx
}

// ---- the page model -------------------------------------------------------------
// `scenarios` is kova's payload: [{ name, thresholds: [{rank, score, color}], best }]
function buildProgress(scenarios, runs) {
  return scenarios.map((s) => {
    const mine = (runs.get(s.name.toLowerCase()) || []).map((r) => r.score)
    const localBest = mine.length ? Math.max(...mine) : null
    // whichever is higher: kova's verified best lags; a local run can be newer
    const best = [s.best, localBest].filter((v) => v != null).reduce((a, b) => Math.max(a, b), -Infinity)
    const bestOrNull = Number.isFinite(best) ? best : null
    const idx = tierIndex(s.thresholds, bestOrNull)
    const rank = idx >= 0 ? s.thresholds[idx] : null
    const next = s.thresholds[idx + 1] || null
    const floor = rank ? rank.score : 0
    return {
      name: s.name,
      thresholds: s.thresholds,
      best: bestOrNull,
      runs: mine.length,
      typical: median(mine.slice(-RECENT)),
      rank: rank ? { name: rank.rank, color: rank.color || null } : null,
      next: next ? { name: next.rank, score: next.score, color: next.color || null } : null,
      toNext: next && bestOrNull != null ? Math.max(0, Math.round((next.score - bestOrNull) * 10) / 10) : next ? next.score : null,
      pct: next ? Math.min(1, Math.max(0, ((bestOrNull ?? 0) - floor) / (next.score - floor || 1))) : 1,
      odds: next ? rankUpOdds(mine, next.score) : null,
    }
  })
}

// The rank-up session: the scenarios where a rank-up is likeliest right now.
const SESSION_SIZE = 4
const MIN_ODDS = 1 / 50 // below this, a session spent there is mostly frustration
function pickSession(rows, size = SESSION_SIZE) {
  return rows
    .filter((r) => r.next && r.odds != null && r.odds >= MIN_ODDS)
    .sort((a, b) => b.odds - a.odds)
    .slice(0, size)
    .map((r) => r.name)
}

// A finished run that crossed into a new rank: the threshold it cleared, or null.
// `prevBest` is the best BEFORE this run (null = first run ever).
function rankUpFrom(thresholds, prevBest, score) {
  const before = tierIndex(thresholds, prevBest)
  const after = tierIndex(thresholds, score)
  return after > before ? thresholds[after] : null
}

// ---- score graph ---------------------------------------------------------------
// One scenario's runs over the last `days` (null = all of them), as 0-1
// coordinates for the page to draw: a dot per run, your best through each PB,
// and the rank lines around your scores (the one you're on and the next - every
// rank would squash the runs into a sliver). y = 0 is the bottom.
const DAY_MS = 24 * 60 * 60 * 1000
function scenarioChart(runs, thresholds, days, now = Date.now()) {
  const from = days ? now - days * DAY_MS : (runs[0]?.ts ?? now)
  let best = -Infinity // runs before the range still set the best you start from
  for (const r of runs) if (r.ts < from) best = Math.max(best, r.score)
  const inRange = runs.filter((r) => r.ts >= from && r.ts <= now)
  if (!inRange.length) return { points: [], best: [], lines: [], from, to: now }

  const scores = inRange.map((r) => r.score)
  const tier = tierIndex(thresholds, Math.max(...scores, best))
  const near = thresholds.slice(Math.max(0, tier), tier + 2)
  const bestIn = Number.isFinite(best) ? [best] : [] // an older best still draws its line
  let lo = Math.min(...scores, ...near.map((t) => t.score))
  let hi = Math.max(...scores, ...bestIn, ...near.map((t) => t.score))
  const pad = (hi - lo) * 0.08 || 1
  lo -= pad
  hi += pad
  const x = (ts) => (ts - from) / Math.max(1, now - from)
  const y = (s) => (s - lo) / (hi - lo)

  const points = []
  const line = Number.isFinite(best) && best >= lo ? [[0, y(best)]] : []
  for (const r of inRange) {
    const pb = r.score > best
    points.push({ x: x(r.ts), y: y(r.score), pb, score: r.score, ts: r.ts })
    if (!pb) continue
    best = r.score
    line.push([x(r.ts), y(best)]) // through each new best; the page draws it as a curve
  }
  line.push([1, y(best)])
  return {
    points,
    best: line,
    lines: near.map((t) => ({ name: t.rank, color: t.color || null, score: t.score, y: y(t.score) })),
    lo,
    hi,
    from,
    to: now,
  }
}

module.exports = { localRuns, allRuns, parseRun, runDurationMs, rankUpOdds, normCdf, buildProgress, pickSession, rankUpFrom, tierIndex, scenarioChart, RECENT }
