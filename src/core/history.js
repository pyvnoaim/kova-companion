// Session history: every run in the stats folder, grouped into days and the
// sessions inside them, with the PBs (and rank-ups) as they were AT THE TIME -
// a run is a PB if it beat every earlier run of its scenario, not today's best.
// Pure; main.js feeds it core/progress.js allRuns().
//
// Local only, like everything read from /stats: shown in the app, never sent.
const SESSION_GAP_MS = 30 * 60 * 1000 // a longer break between runs starts a new session

const pad = (n) => String(n).padStart(2, '0')
// The local calendar day a run belongs to (by when it ended), as YYYY-MM-DD.
const dayKey = (ts) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// `thresholds` (optional): scenario name, lowercased -> [{rank, score, color}],
// so a PB that crossed a rank line is also reported as a rank-up.
function buildHistory(runs, thresholds = new Map()) {
  const best = new Map() // scenario (lowercased) -> best so far
  const days = new Map() // dayKey -> day
  let lastEnd = null
  for (const run of [...runs].sort((a, b) => a.ts - b.ts)) {
    const key = run.scenario.toLowerCase()
    const prev = best.has(key) ? best.get(key) : null
    // a first-ever run isn't a PB worth listing - there was nothing to beat
    const pb = prev != null && run.score > prev
    let rankUp = null
    const th = thresholds.get(key)
    // same rule as PBs: a first-ever run has no rank to have gone up from
    if (th && prev != null && run.score > prev) {
      const tier = (s) => (s == null ? -1 : th.reduce((i, t, n) => (s >= t.score ? n : i), -1))
      const after = tier(run.score)
      if (after > tier(prev)) rankUp = th[after]
    }
    if (prev == null || run.score > prev) best.set(key, run.score)

    const k = dayKey(run.ts)
    if (!days.has(k)) days.set(k, { key: k, runs: [], sessions: 0 })
    const day = days.get(k)
    const start = run.ts - (run.durationMs ?? 0)
    // A new day always opens a new session; within a day, a break does.
    if (!day.runs.length || lastEnd == null || start - lastEnd > SESSION_GAP_MS) day.sessions += 1
    lastEnd = run.ts
    day.runs.push({ ...run, pb, gain: pb ? run.score - prev : null, rankUp })
  }
  return [...days.values()].map(summarizeDay).sort((a, b) => (a.key < b.key ? 1 : -1))
}

function summarizeDay(day) {
  const byScenario = new Map()
  for (const r of day.runs) {
    const key = r.scenario.toLowerCase()
    if (!byScenario.has(key)) byScenario.set(key, { scenario: r.scenario, runs: 0, best: -Infinity, hits: 0, shots: 0 })
    const s = byScenario.get(key)
    s.runs += 1
    s.best = Math.max(s.best, r.score)
    if (r.hits != null && r.misses != null) {
      s.hits += r.hits
      s.shots += r.hits + r.misses
    }
  }
  // the day's best PB per scenario (several PBs on one scenario read as one row)
  const pbs = new Map()
  for (const r of day.runs) {
    if (!r.pb) continue
    const key = r.scenario.toLowerCase()
    const first = day.runs.find((x) => x.scenario.toLowerCase() === key && x.pb)
    const top = pbs.get(key)
    if (!top || r.score > top.score)
      pbs.set(key, {
        scenario: r.scenario,
        score: r.score,
        // gain over the best from BEFORE this day, not over the day's previous PB
        gain: r.score - (first.score - first.gain),
        rankUp: r.rankUp || top?.rankUp || null,
      })
    else if (r.rankUp && !top.rankUp) top.rankUp = r.rankUp
  }
  const playMs = day.runs.reduce((a, r) => a + (r.durationMs ?? 0), 0)
  return {
    key: day.key,
    runs: day.runs.length,
    sessions: day.sessions,
    pbCount: day.runs.filter((r) => r.pb).length,
    rankUps: day.runs.filter((r) => r.rankUp).map((r) => ({ scenario: r.scenario, rank: r.rankUp.rank, color: r.rankUp.color || null })),
    playMs,
    first: day.runs[0].ts - (day.runs[0].durationMs ?? 0),
    last: day.runs[day.runs.length - 1].ts,
    pbs: [...pbs.values()].sort((a, b) => b.gain - a.gain),
    played: [...byScenario.values()]
      .sort((a, b) => b.runs - a.runs)
      .map((s) => ({ scenario: s.scenario, runs: s.runs, best: s.best, acc: s.shots ? s.hits / s.shots : null })),
  }
}

// Per-year totals and the calendar's per-day run counts.
function yearsOf(days) {
  const years = new Map()
  for (const d of days) {
    const y = Number(d.key.slice(0, 4))
    if (!years.has(y)) years.set(y, { year: y, runs: 0, days: 0, pbs: 0, perDay: {} })
    const t = years.get(y)
    t.runs += d.runs
    t.days += 1
    t.pbs += d.pbCount
    t.perDay[d.key] = d.runs
  }
  return [...years.values()].sort((a, b) => a.year - b.year)
}

module.exports = { buildHistory, yearsOf, dayKey, SESSION_GAP_MS }
