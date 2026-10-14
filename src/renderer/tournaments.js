// Tournaments: the live match, upcoming tournaments with check-in, past placements.
// A classic <script> sharing one global scope with renderer.js and hud.js
// (see index.html for the load order); helpers like $, esc, toast and fmt
// come from renderer.js.
// Decided: check-in is only ever the player's click, and a live match only
// notifies - nothing here checks in or brings the window forward by itself.
/* exported renderTournaments */

// Kovi's "Locked in" mood from the mascot canvas: your match is live
const KOVI_LOCKED = `<svg overflow="visible" viewBox="0 0 120 200" width="44" height="74" aria-hidden="true"><ellipse cx="60" cy="190" rx="30" ry="5" fill="#000" opacity="0.5"/><rect x="30" y="16" width="60" height="152" rx="30" fill="#0d0d0f" stroke="#ff9a9a" stroke-width="4"/><ellipse cx="69" cy="38" rx="13" ry="6" fill="#2c2c33" transform="rotate(-24 69 38)"/><rect x="43" y="68" width="12" height="7" rx="3.5" fill="#ff9a9a"/><rect x="65" y="68" width="12" height="7" rx="3.5" fill="#ff9a9a"/><path d="M30 48h60" stroke="#ff9a9a" stroke-width="9"/><path d="M90 48l14-8M90 48l12 6" stroke="#ff9a9a" stroke-width="5" stroke-linecap="round"/></svg>`

// Kovi's "Champion" mood from the mascot canvas: won the weekly challenge, top 3
// in a tournament. The crown pokes above the frame, so it overflows rather than shrinking Kovi.
const koviChampion = (w, h) =>
  `<svg viewBox="0 0 120 200" overflow="visible" width="${w}" height="${h}" aria-hidden="true" class="kovi-champ"><ellipse cx="60" cy="190" rx="30" ry="5" fill="#000" opacity="0.5"/><rect x="30" y="16" width="60" height="152" rx="30" fill="#0d0d0f" stroke="#ff9a9a" stroke-width="5"/><ellipse cx="69" cy="38" rx="13" ry="6" fill="#2c2c33" transform="rotate(-24 69 38)"/><path d="M44 74q5-9 10 0M66 74q5-9 10 0" fill="none" stroke="#ff9a9a" stroke-width="6" stroke-linecap="round"/><path d="M40 12L44 -4l10 9 6-12 6 12 10-9 4 16Z" fill="#fbbf24" stroke="#fbbf24" stroke-width="2" stroke-linejoin="round"/></svg>`

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}
function whenLabel(iso) {
  if (!iso) return 'Start time not set'
  const d = new Date(iso)
  return `${dayLabel(keyOf(d))}, ${clock(d.getTime())}`
}

async function renderTournaments() {
  const el = $('#tournaments-view')
  const res = await window.kova.tournamentsGet()
  const head = `<div class="page-head"><div class="page-title"><h1>Tournaments</h1>
    <p class="lead">Your kova tournaments, with the next thing to do.</p></div></div>`
  if (!res.ok) {
    el.innerHTML =
      res.reason === 'signed-out'
        ? head + emptyState('idle', 'Sign in with kova', 'To see your tournaments and check in.', '<button class="solid tn-signin">Sign in</button>')
        : head + emptyState('uhoh', "Couldn't reach kova", 'Check your connection, then try again.', '<button class="tn-retry">Try again</button>')
    return
  }
  const live = res.current.find((t) => t.match && (t.match.status === 'LIVE' || t.match.status === 'READY'))
  const liveCard = live
    ? (() => {
        const m = live.match
        const isLive = m.status === 'LIVE'
        return `<section class="tn-live">
          ${KOVI_LOCKED}
          <div class="tn-live-text">
            <span class="tn-live-top">${isLive ? '<span class="status status-on">Live now</span>' : '<span class="status status-off">Up next</span>'}<span class="setting-desc">${esc(live.name)}${m.bestOf ? ` · Bo${m.bestOf}` : ''}</span></span>
            <span class="tn-vs"><span class="tn-vs-name">You vs ${esc(m.opponent || 'TBD')}</span><span class="num tn-score">${m.myScore}–${m.oppScore}</span></span>
            <span class="setting-desc">${m.game ? `Game ${m.game.number}: <span class="tn-scen">${esc(m.game.scenario)}</span>` : 'Waiting for pick and ban'}</span>
          </div>
          <div class="tn-live-actions">
            ${m.game?.playUrl ? `<button class="primary tn-play" data-m="${esc(m.id)}">Play game ${m.game.number}</button>` : ''}
            <button class="tn-open" data-s="${esc(live.slug)}">Open match</button>
          </div>
        </section>`
      })()
    : ''
  const upcoming = res.current.filter((t) => t !== live)
  const upRows = upcoming
    .map((t) => {
      const ci = t.checkIn
      const sub = [
        t.status === 'LIVE' ? 'In progress' : whenLabel(t.startsAt),
        ci.open && !ci.checkedIn && ci.closesAt ? `check-in open until ${clock(new Date(ci.closesAt).getTime())}` : '',
        !ci.open && ci.opensAt && new Date(ci.opensAt) > new Date() ? `check-in opens ${clock(new Date(ci.opensAt).getTime())}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      const right = ci.checkedIn
        ? '<span class="ok-text tn-state">Checked in</span>'
        : ci.open
          ? `<button class="tn-checkin" data-t="${esc(t.id)}">Check in</button>`
          : '<span class="setting-desc tn-state">Registered</span>'
      return `<div class="tn-row"><span class="pg-name"><button class="tn-name tn-open" data-s="${esc(t.slug)}">${esc(t.name)}</button><span class="pg-odds">${esc(sub)}</span></span>${right}</div>`
    })
    .join('')
  const pastRows = res.past
    .map(
      (t) => `<div class="tn-row"><span class="pg-name"><button class="tn-name tn-open" data-s="${esc(t.slug)}">${esc(t.name)}</button><span class="pg-odds">${esc(t.startsAt ? dayLabel(keyOf(new Date(t.startsAt))) : '')}</span></span>
        <span class="num tn-state tn-place">${t.place && t.place <= 3 ? koviChampion(18, 30) : ''}${t.place ? `${t.tied ? 'T-' : ''}${ordinal(t.place)} of ${t.of}` : '-'}</span></div>`
    )
    .join('')
  el.innerHTML = `${head}
    ${liveCard}
    <section class="block"><div class="section-head"><h2>Upcoming</h2></div>
      ${upRows ? `<div class="pg-list">${upRows}</div>` : '<p class="pg-note pg-note-list">Nothing coming up. Register on kova and it shows here.</p>'}</section>
    ${pastRows ? `<section class="block"><div class="section-head"><h2>Past</h2></div><div class="pg-list">${pastRows}</div></section>` : ''}`
}

$('#tournaments-view').addEventListener('click', async (e) => {
  const b = e.target.closest('button')
  if (!b || b.disabled) return
  if (b.classList.contains('tn-play')) return window.kova.tournamentsPlay(b.dataset.m)
  if (b.classList.contains('tn-open')) return window.kova.tournamentsOpen(b.dataset.s)
  if (b.classList.contains('tn-checkin')) {
    b.disabled = true
    const res = await window.kova.tournamentsCheckIn(b.dataset.t)
    toast(res.ok ? 'Checked in.' : esc(res.error || "Couldn't check in."), res.ok ? 'ok' : 'err')
  } else if (b.classList.contains('tn-signin')) {
    const res = await window.kova.kovaSignIn()
    if (!res.ok) toast(esc(res.error), 'err')
    renderKova()
    return
  } else if (!b.classList.contains('tn-retry')) return
  renderTournaments()
})

window.kova.onTournamentsChanged((info) => {
  $('.nav-item[data-view="tournaments"] .nav-live').classList.toggle('hidden', !info.live)
  if (view === 'tournaments') renderTournaments()
})
// The reminders: a toast with the one button that matters. Check in stays a click.
window.kova.onTournamentReminder((r) => {
  const action =
    r.kind === 'checkin'
      ? {
          label: 'Check in',
          run: async () => {
            const res = await window.kova.tournamentsCheckIn(r.id)
            toast(res.ok ? 'Checked in.' : esc(res.error || "Couldn't check in."), res.ok ? 'ok' : 'err')
          },
        }
      : { label: 'Open', run: () => showView('tournaments') }
  toast(`<b class="tn-toast-title">${esc(r.title)}</b> ${esc(r.body)}`, 'ok', 20000, action)
})
window.kova.onOpenView((v) => {
  if (v === 'tournaments') showView('tournaments')
})
