// kova account: the sidebar card and the Settings rows.
// A classic <script> sharing one global scope with renderer.js and hud.js
// (see index.html for the load order); helpers like $, esc, toast and fmt
// come from renderer.js.
/* exported renderKova */

// ---- kova account ---------------------------------------------------------------
// Three states, one card: signed out (Sign in), waiting for the browser approval
// (shows the code to compare), signed in (you, links to your profile). Settings
// gets the matching rows. Every name shown came from kova, so it's escaped.
// Kovi's "Waiting" mood from the mascot canvas: eyes to the side, three dots
const KOVI_WAITING = `<svg viewBox="0 0 120 200" width="30" height="50" aria-hidden="true" style="flex: none; overflow: visible"><ellipse cx="60" cy="190" rx="30" ry="5" fill="#000" opacity="0.5"/><rect x="30" y="16" width="60" height="152" rx="30" fill="#0d0d0f" stroke="#ff9a9a" stroke-width="5"/><ellipse cx="69" cy="38" rx="13" ry="6" fill="#2c2c33" transform="rotate(-24 69 38)"/><rect x="53" y="62" width="8" height="14" rx="4" fill="#ff9a9a"/><rect x="73" y="62" width="8" height="14" rx="4" fill="#ff9a9a"/><circle cx="94" cy="20" r="4" fill="#fff"/><circle cx="104" cy="20" r="4" fill="#fff" opacity="0.7"/><circle cx="114" cy="20" r="4" fill="#fff" opacity="0.4"/></svg>`

async function renderKova() {
  const s = await window.kova.kovaGet()
  const card = $('#kova-card')
  const rows = $('#kova-rows')
  if (s.signingIn) {
    card.innerHTML = `
      <span class="kc-wait">${KOVI_WAITING}<span class="kc-title">Approve in your browser</span></span>
      <span class="kc-desc">kova.page opened. Check it shows this code:</span>
      <span class="kc-code">${esc(s.signingIn.replace(/^(.{4})(.{4})$/, '$1-$2'))}</span>
      <button class="kova-cancel">Cancel</button>`
  } else if (s.signedIn) {
    const u = s.user
    card.innerHTML = `
      <button class="kova-me" data-tip="Open your kova profile">
        <span class="kc-av">${
          u?.avatar?.startsWith('data:image/')
            ? `<img src="${esc(u.avatar)}" alt="">`
            : esc((u?.name || '?').trim().charAt(0).toUpperCase())
        }</span>
        <span class="kc-text">
          <span class="kc-title">${esc(u?.name || 'Signed in')}</span>
          ${
            u?.rank
              ? `<span class="kc-rank">${rankMark(u.rank, 16)}<span class="kc-rank-name" style="color:${esc(u.rank.color || 'inherit')}">${esc(u.rank.name)}</span></span>`
              : '<span class="kc-desc">No benchmark rank yet</span>'
          }
        </span>
      </button>`
  } else {
    card.innerHTML = `
      <span><span class="kc-title">Connect kova</span><br>
      <span class="kc-desc">Your ranks, tournaments and team challenge, and your live setup on stream.</span></span>
      <button class="solid kova-signin">Sign in</button>`
  }

  rows.innerHTML = s.signedIn
    ? `<div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">Account</span>
          <span class="setting-desc">Signed in as ${esc(s.user?.name || 'you')}.</span>
        </div>
        <button class="kova-signout">Sign out</button>
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">Live setup on stream</span>
          <span class="setting-desc">While you play, your stream overlay shows your sens, FOV, crosshair and sounds.</span>
        </div>
        <button class="switch kova-sync" role="switch" aria-checked="${s.sync}" aria-label="Live setup on stream"></button>
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">Stream overlay</span>
          <span class="setting-desc">Set it up on kova. Its KovaaK's slide shows what syncs from here.</span>
        </div>
        <button class="kova-overlay">Open on kova</button>
      </div>`
    : `<div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">Account</span>
          <span class="setting-desc">Signs in on kova.page in your browser.</span>
        </div>
        <button class="solid kova-signin">Sign in</button>
      </div>`
  $('#alert-rows').innerHTML =
    `<div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">PB pop-ups</span>
          <span class="setting-desc">Kovi cheers when a run beats your best.</span>
        </div>
        <button class="switch kova-pbs" role="switch" aria-checked="${s.pbPopups}" aria-label="PB pop-ups"></button>
      </div>` +
    (s.signedIn
      ? `<div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">Snipe alerts</span>
          <span class="setting-desc">Someone you follow beats your best on a scenario.</span>
        </div>
        <button class="switch kova-snipes" role="switch" aria-checked="${s.snipes}" aria-label="Snipe alerts"></button>
      </div>`
      : '')
}
// one delegated listener for every slot, since renderKova replaces their markup
for (const slot of ['#kova-card', '#kova-rows', '#alert-rows'])
  $(slot).addEventListener('click', async (e) => {
    const btn = e.target.closest('button')
    if (!btn) return
    if (btn.classList.contains('kova-signin')) {
      btn.disabled = true
      const res = await window.kova.kovaSignIn()
      if (!res.ok) toast(esc(res.error), 'err')
    } else if (btn.classList.contains('kova-cancel')) await window.kova.kovaCancelSignIn()
    else if (btn.classList.contains('kova-signout')) {
      await window.kova.kovaSignOut()
      toast('Signed out of kova.')
    } else if (btn.classList.contains('kova-sync'))
      await window.kova.kovaSetSync(btn.getAttribute('aria-checked') !== 'true')
    else if (btn.classList.contains('kova-pbs')) await window.kova.kovaSetPbPopups(btn.getAttribute('aria-checked') !== 'true')
    else if (btn.classList.contains('kova-snipes'))
      await window.kova.kovaSetSnipes(btn.getAttribute('aria-checked') !== 'true')
    else if (btn.classList.contains('kova-me')) {
      // the browser takes focus; coming back must not paint the keyboard ring
      btn.blur()
      return window.kova.kovaOpen('profile')
    }
    else if (btn.classList.contains('kova-overlay')) return window.kova.kovaOpen('overlay')
    renderKova()
  })
let kovaWasSignedIn = null
// Serialized: sign-in fires kova-changed twice back to back, and two handlers
// reading `before` at once both saw "signed out" and toasted twice.
let kovaChangedQueue = Promise.resolve()
window.kova.onKovaChanged(() => {
  kovaChangedQueue = kovaChangedQueue.then(async () => {
    const before = kovaWasSignedIn
    await renderKova()
    const now = (await window.kova.kovaGet()).signedIn
    if (before === false && now) toast('Connected to kova.')
    kovaWasSignedIn = now
  }).catch(() => {})
})
renderKova().then(async () => (kovaWasSignedIn = (await window.kova.kovaGet()).signedIn))

// A followed player beat your best: Play jumps straight into that scenario.
// Kovi's "Sniped" mood (shook: dot eyes, a sweat drop), as on the mascot canvas
const KOVI_SNIPED = `<svg viewBox="0 0 120 200" width="30" height="50" aria-hidden="true"><ellipse cx="60" cy="190" rx="30" ry="5" fill="#000" opacity="0.5"/><rect x="30" y="16" width="60" height="152" rx="30" fill="#0d0d0f" stroke="#ff9a9a" stroke-width="5"/><ellipse cx="69" cy="38" rx="13" ry="6" fill="#2c2c33" transform="rotate(-24 69 38)"/><circle cx="49" cy="70" r="5" fill="#ff9a9a"/><circle cx="71" cy="70" r="5" fill="#ff9a9a"/><path d="M18 20c-10 14-10 24 0 24s10-10 0-24Z" fill="#fff"/></svg>`
window.kova.onSnipe((p) =>
  toast(
    `<span class="cl-toast">${KOVI_SNIPED}<span class="sn-text">
      <b class="tn-toast-title">${esc(p.name)} beat your best</b>
      <span class="sn-line">${esc(shortScenario(p.scenario))} · <span class="num sn-them">${esc(fmt(p.score))}</span> vs your <span class="num">${esc(fmt(p.mine))}</span></span>
      ${p.more ? `<span class="sn-line">+${p.more} more scenario${p.more === 1 ? '' : 's'}</span>` : ''}
    </span></span>`,
    'ok',
    20000,
    { label: 'Play', run: () => window.kova.snipesPlay(p.id) }
  )
)
