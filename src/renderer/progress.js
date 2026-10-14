// Rank progress: the page, rank-up odds, the rank-up session, the Kovi pop-up.
// A classic <script> sharing one global scope with renderer.js and hud.js
// (see index.html for the load order); helpers like $, esc, toast and fmt
// come from renderer.js.
/* exported renderProgress */

// ---- rank progress ----------------------------------------------------------------
// kova's benchmark playlist with your local runs on top (main.js loadProgress).
// Everything shown that came from kova or from a scenario name is escaped.
let progressOpts = {} // { source, difficulty } the user picked; empty = profile default
let progressDetail = null // { name, days } while a scenario's score graph is open
const RUNS_EACH = 3 // keep in step with main.js: runs per scenario in a session

function oddsText(r) {
  if (!r.next) return { text: 'Top rank', good: false }
  // no estimate yet (under 5 runs): the list says so once, not on every row
  if (r.odds == null) return { text: '', good: false }
  if (r.odds >= 0.5) return { text: `Likely to reach ${r.next.name}`, good: true }
  const inN = Math.round(1 / r.odds)
  if (inN > 50) return { text: `${r.next.name} needs more practice`, good: false }
  return { text: `1 in ${inN} runs reach ${r.next.name}`, good: inN <= 12 }
}

// ---- score graph: one scenario's runs, your best, the rank lines -------------------
const GRAPH_W = 760
const GRAPH_H = 260
const RANGES = [
  [30, '30 days'],
  [90, '90 days'],
  [null, 'All'],
]

// A round step for ~4 gridlines over `span` (1, 2, 2.5 or 5 times a power of ten).
function niceStep(span) {
  const raw = span / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)
}
// A smooth path through points that never overshoots them (monotone cubic,
// Fritsch-Carlson): your best only goes up, so the curve can't dip or bulge past
// a PB the way a plain spline would.
function smoothPath(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : ''
  const n = pts.length
  const d = []
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0]
    d.push(dx ? (pts[i + 1][1] - pts[i][1]) / dx : 0)
  }
  const m = pts.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2))
  for (let i = 0; i < n - 1; i++) {
    if (!d[i]) {
      m[i] = m[i + 1] = 0
      continue
    }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const h = Math.hypot(a, b)
    if (h > 3) {
      m[i] = (3 * a * d[i]) / h
      m[i + 1] = (3 * b * d[i]) / h
    }
  }
  let path = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < n - 1; i++) {
    const dx = (pts[i + 1][0] - pts[i][0]) / 3
    path += ` C${pts[i][0] + dx},${pts[i][1] + m[i] * dx} ${pts[i + 1][0] - dx},${pts[i + 1][1] - m[i + 1] * dx} ${pts[i + 1][0]},${pts[i + 1][1]}`
  }
  return path
}
const shortDate = (ts) => `${new Date(ts).getDate()} ${MONTHS[new Date(ts).getMonth()]}`

function graphSvg(c) {
  const L = 44 // left gutter for the score labels
  const R = GRAPH_W - 4
  const T = 8
  const B = GRAPH_H - 26 // bottom gutter for the dates
  const X = (x) => (L + x * (R - L)).toFixed(1)
  const Y = (y) => (B - y * (B - T)).toFixed(1)
  const yOf = (v) => (v - c.lo) / (c.hi - c.lo)
  const color = (l) => esc(l.color || '#71717a')

  // score gridlines
  const step = niceStep(c.hi - c.lo)
  let grid = ''
  for (let v = Math.ceil(c.lo / step) * step; v <= c.hi; v += step)
    grid += `<line x1="${L}" x2="${R}" y1="${Y(yOf(v))}" y2="${Y(yOf(v))}" class="pg-grid"/>
      <text x="${L - 8}" y="${Number(Y(yOf(v))) + 4}" class="pg-axis" text-anchor="end">${esc(fmt(v))}</text>`
  // dates along the bottom
  let dates = ''
  for (let i = 0; i <= 3; i++) {
    const ts = c.from + ((c.to - c.from) * i) / 3
    dates += `<text x="${X(i / 3)}" y="${GRAPH_H - 6}" class="pg-axis" text-anchor="${['start', 'middle', 'middle', 'end'][i]}">${i === 3 ? 'Today' : esc(shortDate(ts))}</text>`
  }
  // each rank tints the band up to the next one
  const bands = c.lines
    .map((l, i) => {
      const top = Math.min(1, c.lines[i + 1]?.y ?? 1)
      const bottom = Math.max(0, l.y)
      return `<rect x="${L}" width="${R - L}" y="${Y(top)}" height="${(Number(Y(bottom)) - Number(Y(top))).toFixed(1)}" fill="${color(l)}" opacity="0.06"/>
        <line x1="${L}" x2="${R}" y1="${Y(l.y)}" y2="${Y(l.y)}" stroke="${color(l)}" stroke-dasharray="4 4" opacity="0.8"/>`
    })
    .join('')
  const labels = c.lines
    .map((l) => `<text class="pg-line-label" x="${R - 4}" y="${Number(Y(l.y)) - 6}" fill="${color(l)}" text-anchor="end">${esc(l.name)} ${esc(fmt(l.score))}</text>`)
    .join('')
  // your best: a smooth curve through each PB, with a soft fill under it
  const curve = smoothPath(c.best.map(([x, y]) => [Number(X(x)), Number(Y(y))]))
  const area = `<path d="${curve} L${X(c.best.at(-1)[0])},${B} L${X(c.best[0][0])},${B} Z" fill="url(#pg-fill)"/>`
  const best = `<path d="${curve}" fill="none" class="pg-best-line"/>`
  const last = c.points.at(-1)
  const dots = c.points
    .map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${p.pb ? 4 : 3}" class="${p.pb ? 'pg-dot-pb' : 'pg-dot-run'}"/>`)
    .join('')
  const ring = `<circle cx="${X(last.x)}" cy="${Y(last.y)}" r="7" class="pg-dot-last"/>`
  // bigger invisible targets for the hover tooltip
  const hits = c.points
    .map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="9" class="pg-hit" data-score="${esc(fmt(p.score))}" data-ts="${p.ts}" data-pb="${p.pb ? 1 : ''}"/>`)
    .join('')
  return `<svg class="pg-graph" viewBox="0 0 ${GRAPH_W} ${GRAPH_H}" role="img" aria-label="Score per run, with your best and the rank lines">
    <defs><linearGradient id="pg-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="pg-fill-top"/><stop offset="1" class="pg-fill-bottom"/></linearGradient></defs>
    ${grid}${bands}${area}${dots}${best}${ring}${labels}${dates}${hits}</svg>`
}

async function renderScenarioGraph(el) {
  const { name, days } = progressDetail
  const res = await window.kova.progressScenario(name, days)
  if (!res.ok) {
    progressDetail = null
    return renderProgress()
  }
  const { row, chart } = res
  const stat = (v, label) => `<span class="pg-stat"><span class="num">${v}</span><span class="setting-desc">${label}</span></span>`
  const odds = row.next && row.odds != null ? (row.odds > 0 && row.odds < 0.005 ? '<1%' : `${Math.round(row.odds * 100)}%`) : '-'
  const seg = `<div class="seg" role="radiogroup" aria-label="Range">${RANGES.map(
    ([d, label]) => `<button role="radio" class="pg-range${d === days ? ' on' : ''}" aria-checked="${d === days}" data-d="${d ?? ''}">${label}</button>`
  ).join('')}</div>`
  el.innerHTML = `
    <div class="page-head">
      <button class="pg-back" aria-label="Back to Rank progress"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
      <div class="page-title"><h1>${esc(name)}</h1><p class="lead">Every run, with your best and the rank lines.</p></div>
      <div class="page-actions"><button class="primary pg-play" data-n="${esc(name)}">Play</button></div>
    </div>
    <div class="pg-stats">
      ${stat(esc(fmt(row.best)), 'best')}
      ${stat(row.typical == null ? '-' : esc(fmt(row.typical)), 'typical, last 20')}
      ${stat(row.runs, 'runs on this PC')}
      ${stat(odds, row.next ? `odds of ${esc(row.next.name)}` : 'top rank')}
    </div>
    <section class="pg-graph-card">
      <div class="pg-graph-top">
        <div class="pg-graph-key"><span><span class="pg-key-dot"></span>A run</span><span><span class="pg-key-dot pg-key-pb"></span>New best</span><span><span class="pg-key-line"></span>Your best</span></div>
        ${seg}
      </div>
      ${
        chart.points.length
          ? `${graphSvg(chart)}
             <div class="pg-tip hidden"></div>`
          : `<p class="pg-note pg-graph-empty">No runs ${days ? `in the last ${days} days` : 'yet'} on this PC.</p>`
      }
    </section>`
}

async function renderProgress() {
  const el = $('#progress-view')
  if (progressDetail) return renderScenarioGraph(el)
  const res = await window.kova.progressGet(progressOpts)
  const head = (lead, actions = '') => `
    <div class="page-head">
      <div class="page-title"><h1>Rank progress</h1><p class="lead">${lead}</p></div>
      <div class="page-actions">${actions}</div>
    </div>`
  if (!res.ok) {
    el.innerHTML =
      res.reason === 'signed-out'
        ? `${head('Your benchmark ranks, with the points to each next one.')}
           ${emptyState('idle', 'Sign in with kova', 'To see your benchmark ranks.', '<button class="solid pg-signin">Sign in</button>')}`
        : `${head('Your benchmark ranks, with the points to each next one.')}
           ${emptyState('uhoh', "Couldn't reach kova", 'Check your connection, then try again.', '<button class="pg-retry">Try again</button>')}`
    return
  }
  const { bench, rows, session, loaded, playing } = res
  const short = (n) => shortScenario(n, bench.difficulty)
  const diffSeg = bench.difficulties.length > 1
    ? `<div class="seg" role="radiogroup" aria-label="Difficulty">${bench.difficulties
        .map((d) => `<button role="radio" class="pg-diff${d === bench.difficulty ? ' on' : ''}" aria-checked="${d === bench.difficulty}" data-d="${esc(d)}">${esc(d)}</button>`)
        .join('')}</div>`
    : ''
  const sourceMenu = `
    <div class="pg-menu-wrap">
      <button class="pg-source" aria-haspopup="listbox">${esc(bench.label)}</button>
      <div class="pg-menu hidden" role="listbox">${bench.sources
        .map((s) => `<button role="option" class="pg-source-opt" data-s="${esc(s.id)}">${esc(s.label)}</button>`)
        .join('')}</div>
    </div>`

  const sessionStrip = playing
    ? `<section class="pg-strip">
        <span class="pg-strip-text"><span class="setting-label">Rank-up session</span>
        <span class="setting-desc">Playing ${playing.idx + 1} of ${playing.names.length}: ${esc(short(playing.names[playing.idx] || ''))}. Moves on after ${RUNS_EACH} runs.</span></span>
        <button class="pg-stop">Stop</button></section>`
    : session.length
      ? `<section class="pg-strip">
          <span class="pg-strip-text"><span class="setting-label">Rank-up session</span>
          <span class="setting-desc">${esc(session.map(short).join(', '))} · your best odds · about ${session.length * RUNS_EACH} min</span></span>
          <button class="primary pg-session">Play session</button></section>`
      : ''

  const now = loaded && rows.find((r) => r.name.toLowerCase() === loaded.toLowerCase())
  const nowCard = now
    ? (() => {
        const o = oddsText(now)
        return `<section class="pg-now">
          <div class="pg-now-top">
            <span class="pg-now-name"><span class="setting-desc">Loaded now</span><button class="pg-now-title pg-open" data-n="${esc(now.name)}">${esc(now.name)}</button></span>
            <span class="pg-now-odds">${o.text ? `<span class="${o.good ? 'ok-text' : ''}">${esc(o.text)}</span>` : ''}
              <span class="setting-desc">${now.typical != null ? `typical <span class="num">${fmt(now.typical)}</span>, ` : ''}best <span class="num">${fmt(now.best)}</span>${now.next ? `, ${esc(now.next.name)} at <span class="num">${fmt(now.next.score)}</span>` : ''}</span></span>
          </div>
          <div class="pg-bar pg-bar-lg"><span style="width:${Math.round(now.pct * 100)}%"></span></div>
        </section>`
      })()
    : ''

  const list = rows
    .map((r) => {
      const o = oddsText(r)
      return `<div class="pg-row">
        <span class="pg-name"><button class="pg-title pg-open" data-n="${esc(r.name)}">${esc(short(r.name))}</button>${o.text ? `<span class="pg-odds${o.good ? ' ok-text' : ''}">${esc(o.text)}</span>` : ''}</span>
        <span class="pg-rank"><span class="pg-dot" style="background:${esc(r.rank?.color || '#71717a')}"></span>${esc(r.rank?.name || 'Unranked')}</span>
        <span class="num pg-best">${fmt(r.best)}</span>
        <span class="pg-bar"><span style="width:${Math.max(4, Math.round(r.pct * 100))}%"></span></span>
        <span class="pg-left">${r.next ? `<span class="num">${fmt(r.toNext)}</span> to ${esc(r.next.name)}` : 'Maxed'}</span>
        <button class="pg-play" data-n="${esc(r.name)}" aria-label="Play ${esc(r.name)}">Play</button>
      </div>`
    })
    .join('')

  el.innerHTML = `
    ${head('Updates after every run.', `${diffSeg}${sourceMenu}`)}
    ${bench.connected ? '' : '<p class="pg-note">Connect KovaaK\'s on your kova profile for verified bests. Until then this shows your runs on this PC.</p>'}
    ${sessionStrip}${nowCard}
    ${rows.some((r) => r.odds != null) ? '' : '<p class="pg-note pg-note-list">Rank-up odds and the rank-up session appear after 5 runs of a scenario on this PC.</p>'}
    <div class="pg-list">${list}</div>`
}

// one delegated listener: renderProgress replaces the markup on every run
$('#progress-view').addEventListener('click', async (e) => {
  const b = e.target.closest('button')
  if (!b) return
  if (b.classList.contains('pg-play')) return window.kova.progressPlay(b.dataset.n)
  if (b.classList.contains('pg-open')) progressDetail = { name: b.dataset.n, days: 90 }
  else if (b.classList.contains('pg-back')) progressDetail = null
  else if (b.classList.contains('pg-range')) progressDetail.days = b.dataset.d ? Number(b.dataset.d) : null
  else if (b.classList.contains('pg-source')) return b.nextElementSibling.classList.toggle('hidden')
  else if (b.classList.contains('pg-source-opt')) progressOpts = { source: b.dataset.s }
  else if (b.classList.contains('pg-diff')) progressOpts = { ...progressOpts, difficulty: b.dataset.d }
  else if (b.classList.contains('pg-session')) {
    const res = await window.kova.progressGet(progressOpts)
    if (res.ok) await window.kova.progressStartSession(res.session)
  } else if (b.classList.contains('pg-stop')) await window.kova.progressStopSession()
  else if (b.classList.contains('pg-signin')) {
    const res = await window.kova.kovaSignIn()
    if (!res.ok) toast(esc(res.error), 'err')
    renderKova()
    return
  }
  renderProgress()
})
window.kova.onProgressChanged((info) => {
  if (info?.sessionDone) toast('Rank-up session done.', 'ok')
  if (view === 'progress') renderProgress()
})
let rankupTimer = null
// The rank-up pop-up, also used for a plain PB (no rank dot, no "official" note).
function showPopup({ title, line, color = null, meta = false }) {
  const box = $('#rankup')
  box.querySelector('.rankup-dot').classList.toggle('hidden', !color)
  if (color) box.querySelector('.rankup-dot').style.background = color
  box.querySelector('.rankup-name').textContent = title
  box.querySelector('.rankup-line').textContent = line
  box.querySelector('.rankup-meta').classList.toggle('hidden', !meta)
  box.classList.remove('hidden')
  clearTimeout(rankupTimer)
  rankupTimer = setTimeout(() => box.classList.add('hidden'), 9000)
}
window.kova.onRankUp((info) =>
  showPopup({
    title: `${info.rank} on ${shortScenario(info.scenario)}`,
    line: `${fmt(info.score)}, ${fmt(info.over)} over the line`,
    color: info.color || '#ff9a9a',
    meta: true,
  })
)
window.kova.onPb((info) =>
  showPopup({ title: `New PB on ${shortScenario(info.scenario)}`, line: `${fmt(info.score)}, +${fmt(info.gain)} over your best` })
)

// the graph's hover: a run's score and date
$('#progress-view').addEventListener('mouseover', (e) => {
  const hit = e.target.closest?.('.pg-hit')
  const tip = $('#progress-view .pg-tip')
  if (!tip) return
  if (!hit) return tip.classList.add('hidden')
  const card = tip.parentElement.getBoundingClientRect()
  const r = hit.getBoundingClientRect()
  tip.innerHTML = `<span><span class="num">${hit.dataset.score}</span>${hit.dataset.pb ? ' <span class="pg-tip-pb">new best</span>' : ''}</span><span class="setting-desc">${esc(dayLabel(keyOf(new Date(Number(hit.dataset.ts)))))}, ${esc(clock(Number(hit.dataset.ts)))}</span>`
  tip.style.left = `${r.left + r.width / 2 - card.left}px`
  tip.style.top = `${r.top - card.top}px`
  tip.classList.remove('hidden')
})
