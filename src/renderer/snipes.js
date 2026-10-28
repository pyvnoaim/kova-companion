// Snipes: every snipe alert so far (a followed player beat your best), newest
// first, so one you missed in a toast isn't gone. The log lives in main
// (snipes.json); Play jumps into the scenario like the toast's button. A snipe
// your local best has since beaten reads "Sniped back" and its Play goes quiet.
/* exported renderSnipes */

async function renderSnipes() {
  const el = $('#snipes-view')
  const res = await window.kova.snipesList()
  const head = `<div class="page-head"><div class="page-title"><h1>Snipes</h1>
    <p class="lead">Every time someone you follow beat your best.</p></div></div>`
  if (!res.signedIn) {
    el.innerHTML = head + emptyState('idle', 'Sign in with kova', 'Snipes come from the players you follow on kova.', '<button class="solid sn-signin">Sign in</button>')
    return
  }
  const off = res.alertsOn ? '' : '<p class="pg-note">Snipe alerts are off in Settings, so new ones aren\'t logged.</p>'
  if (!res.snipes.length) {
    el.innerHTML =
      head +
      (res.alertsOn
        ? emptyState('idle', 'No snipes yet', 'When someone you follow beats your best, it shows up here.')
        : emptyState('asleep', 'Snipe alerts are off', 'Turn them on to log every time someone you follow beats your best.', '<button class="sn-settings">Open Settings</button>'))
    return
  }
  const rows = res.snipes
    .map((p) => {
      const at = p.setAt ? new Date(p.setAt) : null
      const when = at && !Number.isNaN(at.getTime()) ? ` · ${dayLabel(keyOf(at))} ${clock(at)}` : ''
      return `<div class="tn-row"><span class="pg-name"><span class="pg-title">${esc(p.scenario)}</span>
          <span class="pg-odds">${esc(p.name)}${when}</span></span>
        ${
          p.back != null
            ? `<span class="tn-state sn-back">Sniped back · <span class="num">${esc(fmt(p.back))}</span></span>`
            : `<span class="tn-state"><span class="num sn-them">${esc(fmt(p.score))}</span> vs your <span class="num">${esc(fmt(p.mine))}</span></span>`
        }
        <button class="${p.back != null ? '' : 'primary '}sn-play" data-id="${esc(p.id)}">Play</button></div>`
    })
    .join('')
  el.innerHTML = `${head}${off}<div class="pg-list">${rows}</div>`
}

$('#snipes-view').addEventListener('click', async (e) => {
  const b = e.target.closest('button')
  if (!b) return
  if (b.classList.contains('sn-play')) return window.kova.snipesPlay(b.dataset.id)
  if (b.classList.contains('sn-settings')) return showView('settings')
  if (b.classList.contains('sn-signin')) {
    const res = await window.kova.kovaSignIn()
    if (!res.ok) toast(esc(res.error), 'err')
    renderKova()
    return renderSnipes()
  }
})
