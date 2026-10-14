// Weekly challenge: each of your teams' scenario of the week, its standings and
// past weeks, all from kova (GET /api/companion/challenge). Same shared global
// scope as the other page scripts; ordinal() comes from tournaments.js.
/* exported renderChallenge */

let challengeTeamSlug = null // the team tab you picked, kept across re-renders

function placeLine(t) {
  if (t.place == null) return "You haven't played it yet"
  const where = `You're <span class="ch-strong">${ordinal(t.place)}</span> of ${t.of}`
  return t.behind == null ? where : `${where} · <span class="num">${esc(fmt(t.behind))}</span> behind ${ordinal(t.place - 1)}`
}

async function renderChallenge() {
  const el = $('#challenge-view')
  const res = await window.kova.challengeGet()
  const head = `<div class="page-head"><div class="page-title"><h1>Weekly challenge</h1>
    <p class="lead">Your team's scenario this week.</p></div></div>`
  if (!res.ok) {
    el.innerHTML =
      res.reason === 'signed-out'
        ? head + emptyState('idle', 'Sign in with kova', "To see your team's weekly challenge.", '<button class="solid ch-signin">Sign in</button>')
        : head + emptyState('uhoh', "Couldn't reach kova", 'Check your connection, then try again.', '<button class="ch-retry">Try again</button>')
    return
  }
  if (!res.teams.length) {
    el.innerHTML = head + emptyState('idle', 'No weekly challenge yet', "A team admin turns it on in the team's Discord settings on kova.")
    return
  }
  const t = res.teams.find((x) => x.team.slug === challengeTeamSlug) || res.teams[0]
  challengeTeamSlug = t.team.slug
  const tabs =
    res.teams.length > 1
      ? `<div class="seg ch-tabs" role="tablist" aria-label="Team">${res.teams
          .map((x) => `<button role="tab" class="ch-tab${x === t ? ' on' : ''}" aria-selected="${x === t}" data-s="${esc(x.team.slug)}">${esc(x.team.name)}</button>`)
          .join('')}</div>`
      : ''
  const rows = t.standings
    .map(
      (r) => `<div class="ch-row${r.isYou ? ' ch-you' : ''}"><span class="num ch-place">${r.place}</span>
        <span class="ch-name">${esc(r.name)}</span><span class="num">${esc(fmt(r.score))}</span></div>`
    )
    .join('')
  const past = t.past
    .map((p) => {
      const place = p.place == null ? "Didn't play" : `${ordinal(p.place)} of ${p.of}`
      return `<div class="tn-row"><span class="pg-name"><span class="pg-title">${esc(p.scenario)}</span>
          <span class="pg-odds">${esc(p.week)} · won by ${esc(p.winner)}</span></span>
        <span class="tn-state tn-place${p.place === 1 ? ' ch-won' : p.place == null ? ' setting-desc' : ''}">${p.place === 1 ? koviChampion(18, 30) : ''}${place}</span>
        <span class="num ch-score">${p.score == null ? '-' : esc(fmt(p.score))}</span></div>`
    })
    .join('')
  el.innerHTML = `${head}${tabs}
    <section class="ch-card">
      <div class="ch-head">
        ${t.place === 1 ? koviChampion(30, 50) : ''}
        <span class="pg-name">
          <span class="pg-odds">${res.teams.length > 1 ? '' : `${esc(t.team.name)} · `}This week · ${t.daysLeft} day${t.daysLeft === 1 ? '' : 's'} left</span>
          <span class="ch-scen">${esc(t.scenario)}</span>
          <span class="pg-odds">${placeLine(t)}</span>
        </span>
        <button class="primary ch-play">Play</button>
        <button class="ch-open">Open on kova</button>
      </div>
      ${rows || '<p class="pg-note ch-none">Nobody has played it yet. Be first.</p>'}
    </section>
    <p class="pg-note ch-foot">kova updates the board every hour.</p>
    ${past ? `<section class="block"><div class="section-head"><h2>Past weeks</h2></div><div class="pg-list">${past}</div></section>` : ''}`
}

$('#challenge-view').addEventListener('click', async (e) => {
  const b = e.target.closest('button')
  if (!b) return
  if (b.classList.contains('ch-tab')) {
    challengeTeamSlug = b.dataset.s
    return renderChallenge()
  }
  if (b.classList.contains('ch-play')) return window.kova.challengePlay(challengeTeamSlug)
  if (b.classList.contains('ch-open')) return window.kova.challengeOpen(challengeTeamSlug)
  if (b.classList.contains('ch-signin')) {
    const res = await window.kova.kovaSignIn()
    if (!res.ok) toast(esc(res.error), 'err')
    return renderKova()
  }
  if (b.classList.contains('ch-retry')) renderChallenge()
})
