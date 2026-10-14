// Autoclipper: OBS, when to clip, the clips folder, recent clips.
// A classic <script> sharing one global scope with renderer.js and hud.js
// (see index.html for the load order); helpers like $, esc, toast and fmt
// come from renderer.js.
/* exported renderClips */

// ---- autoclipper -------------------------------------------------------------------
// OBS saves a clip when a run is worth keeping (main.js does the work). Paths and
// scenario names shown here are escaped; Play only opens files main recorded.
const CLIP_MODE_HELP = {
  pb: 'A run that beats your best on its scenario.',
  rankup: 'A run that reaches a new rank in the benchmark on Rank progress.',
  every: 'Every finished run.',
}
// Kovi's "Clip saved" mood, exactly as on the mascot canvas
const KOVI_CLIP = `<svg viewBox="0 0 120 200" width="30" height="50" aria-hidden="true"><ellipse cx="60" cy="190" rx="30" ry="5" fill="#000" opacity="0.5"/><path d="M16 24V10h14M104 24V10H90M16 152v14h14M104 152v14H90" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="97" cy="34" r="7" fill="#f87171"/><rect x="30" y="16" width="60" height="152" rx="30" fill="#0d0d0f" stroke="#ff9a9a" stroke-width="5"/><ellipse cx="69" cy="38" rx="13" ry="6" fill="#2c2c33" transform="rotate(-24 69 38)"/><path d="M44 70q5 6 10 0" fill="none" stroke="#ff9a9a" stroke-width="6" stroke-linecap="round"/><rect x="67" y="62" width="8" height="14" rx="4" fill="#ff9a9a"/></svg>`

function clipWhen(at) {
  const key = keyOf(new Date(at))
  const day = key === keyOf(new Date()) ? 'Today' : dayLabel(key)
  return `${day}, ${clock(at)}`
}

// ---- the one OBS setup, in Settings ------------------------------------------------
const obsStatus = (c) =>
  ({
    connected: '<span class="status status-on">Connected</span>',
    connecting: '<span class="status status-off">Connecting…</span>',
    error: '<span class="status status-err">Not connected</span>',
  })[c.obs.status] || '<span class="status status-off">Off</span>'

async function renderObsSettings() {
  const c = await window.kova.clipGet()
  const desc = !c.on
    ? `${esc(c.host)}:${c.port} · connects while the autoclipper is on`
    : c.obs.status === 'error'
      ? esc(c.obs.error || "Couldn't reach OBS")
      : `${esc(c.host)}:${c.port} · for the autoclipper`
  $('#obs-rows').innerHTML = `<div class="setting-row">
      <div class="setting-text"><span class="setting-label">OBS</span><span class="setting-desc">${desc}</span></div>
      ${c.on ? obsStatus(c) : ''}
      <button class="obs-change">Change</button>
    </div>`
}

// Connect OBS: the two steps in OBS, then address, port and password.
async function openObsDialog() {
  const c = await window.kova.clipGet()
  const w = openModal(`<div class="modal obs-modal" role="dialog" aria-labelledby="obs-title">
      <div><h2 id="obs-title">Connect OBS</h2><p class="setting-desc">Built into OBS 28 and newer, no plugin needed.</p></div>
      <ol class="obs-steps">
        <li><span class="obs-n">1</span><span>In OBS: <b>Tools</b> → <b>WebSocket Server Settings</b>, tick <b>Enable WebSocket server</b>.</span></li>
        <li><span class="obs-n">2</span><span>Click <b>Show Connect Info</b> and copy the port and password here.</span></li>
      </ol>
      <div class="obs-fields">
        <label class="field"><span class="field-label">Address</span><input id="obs-host" type="text" value="${esc(c.host)}" spellcheck="false" /></label>
        <label class="field"><span class="field-label">Port</span><input id="obs-port" type="text" inputmode="numeric" value="${c.port}" /></label>
        <label class="field obs-pass"><span class="field-label">Password</span><input id="obs-pw" type="password" placeholder="${c.hasPassword ? 'unchanged' : 'none'}" /></label>
      </div>
      <div class="modal-actions"><button class="m-cancel">Cancel</button><button class="primary m-ok">Connect</button></div>
    </div>`, async (ok) => {
    if (!ok) return
    const port = Number(w.querySelector('#obs-port').value.trim())
    await window.kova.clipSet({ host: w.querySelector('#obs-host').value.trim(), port: Number.isInteger(port) ? port : undefined })
    // empty means "keep the saved one", so a blank field never wipes it
    const pw = w.querySelector('#obs-pw').value
    if (pw) await window.kova.clipSetPassword(pw)
    toast(c.on ? 'Connecting to OBS…' : 'Saved. OBS connects when the autoclipper is on.', 'ok')
    renderObsSettings()
  })
  w.querySelector('#obs-host').focus()
}
$('#obs-rows').addEventListener('click', (e) => {
  if (e.target.closest('.obs-change')) openObsDialog()
})
renderObsSettings()

async function renderClips() {
  const el = $('#clips-view')
  const c = await window.kova.clipGet()
  const obsDesc =
    c.obs.status === 'error'
      ? esc(c.obs.error || "Couldn't reach OBS")
      : c.obs.status === 'connected'
        ? 'Replay buffer on · set up in Settings'
        : 'Set up in Settings'
  const seg = ['pb', 'rankup', 'every']
    .map((m) => `<button role="radio" class="cl-mode${c.mode === m ? ' on' : ''}" aria-checked="${c.mode === m}" data-m="${m}">${{ pb: 'Every PB', rankup: 'Rank-ups', every: 'Every run' }[m]}</button>`)
    .join('')
  const clips = c.clips.length
    ? `<div class="pg-list">${c.clips
        .map(
          (x) => `<div class="pg-row cl-row">
            <span class="pg-name"><span class="pg-title">${esc(x.scenario)}</span><span class="pg-odds">${esc(clipWhen(x.at))}${x.trimmed ? '' : ' · full buffer'}</span></span>
            <span class="num pg-best">${fmt(x.score)}</span>
            <span class="cl-why ok-text">${esc(x.why)}</span>
            <button class="cl-play" data-f="${esc(x.file)}">Play</button>
          </div>`
        )
        .join('')}</div>`
    : emptyState('idle', 'No clips yet', 'With OBS connected, the next run worth keeping lands here.')

  el.innerHTML = `
    <div class="page-head">
      <div class="page-title"><h1>Autoclipper</h1><p class="lead">OBS saves a clip when a run is worth keeping.</p></div>
      <div class="page-actions"><button class="switch cl-on" role="switch" aria-checked="${c.on}" aria-label="Autoclipper on"></button></div>
    </div>
    <div class="rows">
      <div class="setting-row">
        <div class="setting-text"><span class="setting-label">OBS</span><span class="setting-desc">${obsDesc}</span></div>
        ${c.on ? obsStatus(c) : ''}
        <button class="cl-settings">Settings</button>
      </div>
      <div class="setting-row">
        <div class="setting-text"><span class="setting-label">Clip</span><span class="setting-desc">${esc(CLIP_MODE_HELP[c.mode])}</span></div>
        <div class="seg" role="radiogroup" aria-label="Clip">${seg}</div>
      </div>
      <div class="setting-row">
        <div class="setting-text"><span class="setting-label">Trim to the run</span>
          <span class="setting-desc">${c.ffmpeg ? 'Cuts the clip to the run plus 3 seconds each side. Off keeps OBS\'s whole buffer.' : 'Needs ffmpeg, which isn\'t installed. Clips keep OBS\'s whole buffer until it is.'}</span></div>
        <button class="switch cl-trim" role="switch" aria-checked="${c.trim && c.ffmpeg}" aria-label="Trim to the run"${c.ffmpeg ? '' : ' disabled'}></button>
      </div>
      <div class="setting-row">
        <div class="setting-text"><span class="setting-label">Clips folder</span><span class="setting-desc cl-path">${esc(c.folder)} · one folder per scenario</span></div>
        <button class="cl-folder">Change</button>
        <button class="cl-open">Open</button>
      </div>
    </div>
    <section class="block cl-recent">
      <div class="section-head"><h2>Recent clips</h2></div>
      ${clips}
    </section>`
}

$('#clips-view').addEventListener('click', async (e) => {
  const b = e.target.closest('button')
  if (!b || b.disabled) return
  if (b.classList.contains('cl-on')) await window.kova.clipSet({ on: b.getAttribute('aria-checked') !== 'true' })
  else if (b.classList.contains('cl-trim')) await window.kova.clipSet({ trim: b.getAttribute('aria-checked') !== 'true' })
  else if (b.classList.contains('cl-mode')) await window.kova.clipSet({ mode: b.dataset.m })
  else if (b.classList.contains('cl-settings')) return showView('settings')
  else if (b.classList.contains('cl-folder')) await window.kova.clipPickFolder()
  else if (b.classList.contains('cl-open')) return window.kova.clipOpenFolder()
  else if (b.classList.contains('cl-play')) return window.kova.clipPlay(b.dataset.f)
  else return
  renderClips()
})
window.kova.onClipChanged(() => {
  if (view === 'clips') renderClips()
  renderObsSettings()
})
window.kova.onClipSaved((clip) => {
  const t = $('#toast')
  toast(
    `<span class="cl-toast">${KOVI_CLIP}<span>Clip saved: <span class="cl-b">${esc(shortScenario(clip.scenario))}</span>, <span class="num">${esc(fmt(clip.score))}</span>, ${esc(clip.why)}</span></span>`,
    'ok',
    8000,
    { label: 'Play', run: () => window.kova.clipPlay(clip.file) }
  )
  t.classList.add('toast-clip')
  setTimeout(() => t.classList.remove('toast-clip'), 8000)
})
