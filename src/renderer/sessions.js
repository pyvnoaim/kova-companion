// Sessions: the yearly calendar, the day list and the day recap.
// A classic <script> sharing one global scope with renderer.js and hud.js
// (see index.html for the load order); helpers like $, esc, toast and fmt
// come from renderer.js.
/* exported renderSessions */

// ---- sessions --------------------------------------------------------------------
// The whole stats history as a calendar (one year per view), a day list (recent,
// or one month), and a day's recap. Built in main from local files; nothing here
// is fetched from kova.
const sess = { year: null, month: null, day: null }
let historyData = null
const RECENT_DAYS = 8

const short2 = (n) => shortScenario(n)

// Kovi's mood for a recap: the New PB hop when the day had one, idle otherwise.
const KOVI_HAPPY = `<svg viewBox="0 0 120 200" width="40" height="66" aria-hidden="true"><ellipse cx="60" cy="190" rx="30" ry="5" fill="#000" opacity="0.5"/><rect x="30" y="16" width="60" height="152" rx="30" fill="#0d0d0f" stroke="#ff9a9a" stroke-width="3"/><ellipse cx="69" cy="38" rx="13" ry="6" fill="#2c2c33" transform="rotate(-24 69 38)"/><path d="M44 74q5-9 10 0M66 74q5-9 10 0" fill="none" stroke="#ff9a9a" stroke-width="4" stroke-linecap="round"/><path d="M104 24v12M98 30h12M16 46v8M12 50h8" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>`
const KOVI_IDLE = `<svg viewBox="0 0 120 200" width="40" height="66" aria-hidden="true"><ellipse cx="60" cy="190" rx="30" ry="5" fill="#000" opacity="0.5"/><rect x="30" y="16" width="60" height="152" rx="30" fill="#0d0d0f" stroke="#ff9a9a" stroke-width="3"/><ellipse cx="69" cy="38" rx="13" ry="6" fill="#2c2c33" transform="rotate(-24 69 38)"/><rect x="45" y="62" width="8" height="14" rx="4" fill="#ff9a9a"/><rect x="67" y="62" width="8" height="14" rx="4" fill="#ff9a9a"/></svg>`

function dayRowsHtml(days) {
  return days
    .map((d) => {
      const what = [
        `${d.sessions} session${d.sessions === 1 ? '' : 's'}`,
        d.played.length <= 3 ? d.played.map((p) => short2(p.scenario)).join(', ') : `${d.played.length} scenarios`,
        ...d.rankUps.slice(0, 1).map((r) => `${r.rank} on ${short2(r.scenario)}`),
      ].join(' · ')
      return `<button class="ss-day" data-day="${esc(d.key)}">
        <span class="pg-name"><span class="pg-title">${esc(dayLabel(d.key))}</span><span class="pg-odds">${esc(what)}</span></span>
        <span class="ss-n"><span class="num">${d.runs}</span> runs</span>
        <span class="ss-n"><span class="num${d.pbCount ? ' ok-text' : ''}">${d.pbCount}</span> PB${d.pbCount === 1 ? '' : 's'}</span>
        <span class="num ss-time">${esc(fmtDur(d.playMs))}</span>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>
      </button>`
    })
    .join('')
}

function calendarHtml(year, perDay) {
  // Monday-first weeks; column 0 holds the Monday on or before 1 January.
  const jan1 = new Date(year, 0, 1)
  const start = new Date(jan1)
  start.setDate(1 - ((jan1.getDay() + 6) % 7))
  const todayKey = keyOf(new Date())
  const max = Math.max(1, ...Object.values(perDay))
  const cells = []
  const monthCol = []
  for (let i = 0; i < 54 * 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const col = Math.floor(i / 7)
    if (d.getFullYear() > year && i % 7 === 0) break
    if (d.getFullYear() === year && d.getDate() === 1) monthCol[d.getMonth()] = col
    if (d.getFullYear() !== year) {
      cells.push('<span class="ss-cell ss-out"></span>')
      continue
    }
    const key = keyOf(d)
    const runs = perDay[key] || 0
    const lvl = runs ? Math.min(3, Math.ceil((runs / max) * 3)) : 0
    const dim = sess.month != null && d.getMonth() !== sess.month ? ' ss-dim' : ''
    const label = `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}: ${runs ? `${runs} runs` : 'no runs'}`
    cells.push(
      key > todayKey
        ? '<span class="ss-cell ss-future"></span>'
        : `<button class="ss-cell ss-l${lvl}${key === todayKey ? ' ss-today' : ''}${dim}"${runs ? ` data-day="${key}"` : ' disabled'} aria-label="${esc(label)}" title="${esc(label)}"></button>`
    )
  }
  const cols = Math.ceil(cells.length / 7)
  const months = MONTHS.map(
    (m, i) =>
      `<button class="ss-month${sess.month === i ? ' on' : ''}" data-month="${i}" style="grid-column:${(monthCol[i] ?? 0) + 1} / span 4"${sess.month === i ? ' aria-pressed="true"' : ''}>${m}</button>`
  ).join('')
  return `<div class="ss-months" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${months}</div>
    <div class="ss-grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${cells.join('')}</div>
    <div class="ss-legend">Less <span class="ss-cell ss-l0"></span><span class="ss-cell ss-l1"></span><span class="ss-cell ss-l2"></span><span class="ss-cell ss-l3"></span> More</div>`
}

function recapHtml(d) {
  const statsRow = [
    [d.runs, 'runs', ''],
    [d.pbCount, `new PB${d.pbCount === 1 ? '' : 's'}`, d.pbCount ? 'ok-text' : ''],
    [d.rankUps.length, `rank-up${d.rankUps.length === 1 ? '' : 's'}`, ''],
    [fmtDur(d.playMs), 'in runs', ''],
  ]
    .map(([v, l, c]) => `<span class="ss-stat"><span class="num ${c}">${esc(v)}</span><span class="setting-desc">${esc(l)}</span></span>`)
    .join('')
  const pbs = d.pbs.length
    ? `<section class="block"><div class="section-head"><h2>New PBs</h2></div><div class="pg-list">${d.pbs
        .map(
          (p) => `<div class="pg-row ss-pb-row">
            <span class="pg-title">${esc(p.scenario)}</span>
            <span class="num pg-best">${fmt(p.score)}</span>
            <span class="num ok-text pg-best">+${fmt(p.gain)}</span>
            <span class="pg-rank">${p.rankUp ? `<span class="pg-dot" style="background:${esc(p.rankUp.color || '#ff9a9a')}"></span>${esc(p.rankUp.rank)}, new` : ''}</span>
          </div>`
        )
        .join('')}</div></section>`
    : ''
  const played = `<section class="block"><div class="section-head"><h2>Played</h2></div><div class="pg-list">${d.played
    .map(
      (p) => `<div class="pg-row ss-played-row">
        <span class="pg-title">${esc(p.scenario)}</span>
        <span class="ss-n"><span class="num">${p.runs}</span> runs</span>
        <span class="ss-n">best <span class="num">${fmt(p.best)}</span></span>
        <span class="ss-n">${p.acc != null ? `<span class="num">${Math.round(p.acc * 100)}%</span> acc` : ''}</span>
      </div>`
    )
    .join('')}</div></section>`
  return `
    <div class="page-head">
      <div class="page-title"><h1>${esc(dayLabel(d.key))}</h1>
        <p class="lead">${d.sessions} session${d.sessions === 1 ? '' : 's'}, ${esc(clock(d.first))} to ${esc(clock(d.last))}</p></div>
      <div class="page-actions"><button class="ss-back">Back to sessions</button></div>
    </div>
    <section class="ss-strip">${d.pbCount ? KOVI_HAPPY : KOVI_IDLE}<div class="ss-stats">${statsRow}</div></section>
    ${pbs}${played}`
}

async function renderSessions({ reload = false } = {}) {
  const el = $('#sessions-view')
  if (!historyData || reload) historyData = await window.kova.historyGet()
  const h = historyData
  if (!h.ok || !h.days.length) {
    el.innerHTML = `<div class="page-head"><div class="page-title"><h1>Sessions</h1>
      <p class="lead">Every day you played, from KovaaK's own stats files.</p></div></div>
      ${h.ok ? emptyState('idle', 'No runs yet', "Finish a run in KovaaK's and it shows up here.") : emptyState('uhoh', "KovaaK's not found", "So there's no stats folder to read.")}`
    return
  }
  if (sess.day) {
    const d = h.days.find((x) => x.key === sess.day)
    if (d) {
      el.innerHTML = recapHtml(d)
      return
    }
    sess.day = null
  }
  const years = h.years.map((y) => y.year)
  if (sess.year == null || !years.includes(sess.year)) sess.year = years[years.length - 1]
  const yi = years.indexOf(sess.year)
  const y = h.years[yi]
  const listDays =
    sess.month != null
      ? h.days.filter((d) => dateOf(d.key).getFullYear() === sess.year && dateOf(d.key).getMonth() === sess.month)
      : h.days.slice(0, RECENT_DAYS)
  const listHead =
    sess.month != null
      ? `<h2>${MONTHS[sess.month]} ${sess.year}</h2><span class="count">${listDays.length} day${listDays.length === 1 ? '' : 's'} played</span><span class="ss-spacer"></span><button class="ss-recent">Show recent</button>`
      : '<h2>Recent days</h2>'
  el.innerHTML = `
    <div class="page-head"><div class="page-title"><h1>Sessions</h1>
      <p class="lead">Every day you played on this PC. Totals are for the year shown.</p></div></div>
    <section class="ss-cal">
      <div class="ss-cal-top">
        <span><span class="num ss-big">${fmt(y.runs)}</span> <span class="setting-desc">runs</span></span>
        <span><span class="num ss-big">${y.days}</span> <span class="setting-desc">days played</span></span>
        <span><span class="num ss-big">${y.pbs}</span> <span class="setting-desc">PBs</span></span>
        <span class="ss-spacer"></span>
        <span class="ss-year">
          <button class="ss-prev icon-btn" aria-label="Previous year"${yi > 0 ? '' : ' disabled'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
          <span class="ss-year-n">${sess.year}</span>
          <button class="ss-next icon-btn" aria-label="Next year"${yi < years.length - 1 ? '' : ' disabled'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        </span>
      </div>
      ${calendarHtml(sess.year, y.perDay)}
    </section>
    <section class="block">
      <div class="section-head ss-list-head">${listHead}</div>
      ${listDays.length ? `<div class="pg-list">${dayRowsHtml(listDays)}</div>` : '<p class="pg-note pg-note-list">No runs that month.</p>'}
    </section>`
}

$('#sessions-view').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b || b.disabled) return
  if (b.dataset.day) sess.day = b.dataset.day
  else if (b.dataset.month != null && b.classList.contains('ss-month')) {
    const m = Number(b.dataset.month)
    sess.month = sess.month === m ? null : m
  } else if (b.classList.contains('ss-recent')) sess.month = null
  else if (b.classList.contains('ss-back')) sess.day = null
  else if (b.classList.contains('ss-prev')) {
    sess.year -= 1
    sess.month = null
  } else if (b.classList.contains('ss-next')) {
    sess.year += 1
    sess.month = null
  } else return
  renderSessions()
})
// KovaaK's closed: the history moved, and the recap is one click away (the page
// doesn't take over the window by itself).
window.kova.onSessionEnded((info) => {
  historyData = null
  if (view === 'sessions') renderSessions()
  toast(
    `Session done: ${info.runs} runs${info.pbs ? `, ${info.pbs} new PB${info.pbs === 1 ? '' : 's'}` : ''}.`,
    'ok',
    12000,
    { label: 'Open recap', run: () => openRecap(info.day) }
  )
})
function openRecap(day) {
  sess.day = day
  historyData = null
  showView('sessions').then(() => renderSessions({ reload: true }))
}
window.kova.onOpenRecap((info) => openRecap(info.day))
