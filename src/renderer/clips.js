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

// ---- the in-app player -----------------------------------------------------------
// Play opens the clip right here. The Windows player apps choke on OBS's
// 1080p120 mkv (a clip that's smooth frame for frame played at ~1 fps), while
// the app's own Chromium plays H.264/AAC in mkv and mp4 fine. Anything it can't
// decode falls back to the system player.
let clipsShown = [] // the list as last rendered, so a row's Play finds its clip
// Once OBS is connected the setup is done: fold it into one summary row. Opened
// by hand, it stays open (per viewer; storage can be unavailable, so guarded).
let clipSetupOpen = (() => {
  try {
    return localStorage.getItem('clipSetupOpen') === '1'
  } catch {
    return false
  }
})()
function setClipSetupOpen(open) {
  clipSetupOpen = open
  try {
    localStorage.setItem('clipSetupOpen', open ? '1' : '0')
  } catch {}
}
const CHEVRON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'
const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>'

const PLAY_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>'
const CLIP_THUMB_S = 8 // a trimmed clip opens ~3s before the run: this lands mid-action

// Thumbnails: each card's <video> gets its source right away (preload=metadata
// reads the header and one frame; the list is capped at 50). Lazy-loading via
// IntersectionObserver took 8s+ to fire whenever the window was behind another
// one. The page re-renders on every OBS status change, save and toggle, so a
// loaded thumbnail is kept and moved into the new card rather than decoded
// again. A muted preview plays while a card is hovered.
const clipThumbCache = new Map() // data-src -> its loaded <video>
function clipThumbs(root) {
  const seen = new Set()
  for (const v of root.querySelectorAll('.cl-thumb video[data-src]')) {
    const key = v.dataset.src
    seen.add(key)
    const kept = clipThumbCache.get(key)
    if (kept) {
      v.replaceWith(kept)
      if (kept.dataset.err) kept.closest('.cl-thumb')?.classList.add('cl-thumb-err')
      continue
    }
    v.addEventListener(
      'error',
      () => {
        v.dataset.err = '1'
        v.closest('.cl-thumb')?.classList.add('cl-thumb-err')
      },
      { once: true }
    )
    // metadata alone draws nothing: an explicit seek makes Chromium decode
    // and show that frame
    v.addEventListener('loadedmetadata', () => (v.currentTime = Math.min(CLIP_THUMB_S, (v.duration || 1) / 2)), { once: true })
    v.src = key
    clipThumbCache.set(key, v)
  }
  // deleted clips: let their video go
  for (const key of clipThumbCache.keys()) if (!seen.has(key)) clipThumbCache.delete(key)
}
$('#clips-view').addEventListener('pointerover', (e) => {
  const card = e.target.closest('.cl-card')
  const v = card?.querySelector('video')
  if (v?.src && v.paused && !card.contains(e.relatedTarget)) v.play().catch(() => {})
})
$('#clips-view').addEventListener('pointerout', (e) => {
  const card = e.target.closest('.cl-card')
  const v = card?.querySelector('video')
  if (v && !card.contains(e.relatedTarget)) {
    v.pause()
    v.currentTime = CLIP_THUMB_S
  }
})

// Resolves true once the clip is gone (to the Recycle Bin - main never
// deletes outright, so the toast can say where to get it back).
async function deleteClip(clip) {
  if (!(await appConfirm(`Delete this clip of ${clip.scenario}? It goes to the Recycle Bin.`, { okLabel: 'Delete', danger: true })))
    return false
  const r = await window.kova.clipDelete(clip.file)
  if (!r?.ok) {
    toast(esc(r?.error || "Couldn't delete that clip."), 'err')
    return false
  }
  toast('Clip moved to the Recycle Bin.')
  if (view === 'clips') renderClips()
  return true
}

function playClip(clip) {
  const wrap = openModal(`<div class="modal modal-video" role="dialog" aria-modal="true" aria-label="Clip">
      <div class="mv-head">
        <span class="pg-name"><span class="pg-title">${esc(clip.scenario)}</span>
          <span class="pg-odds"><span class="num">${esc(fmt(clip.score))}</span> · ${esc(clip.why)} · ${esc(clipWhen(clip.at))}</span></span>
      </div>
      <video class="mv-video" src="${fileUrl(clip.file)}" controls autoplay></video>
      <div class="modal-actions">
        <button class="mv-del m-danger">Delete</button>
        <button class="mv-ext">Open in your player</button>
        <button class="m-cancel primary">Close</button>
      </div>
    </div>`)
  const video = wrap.querySelector('video')
  const external = () => {
    window.kova.clipPlay(clip.file)
    wrap.querySelector('.m-cancel').click()
  }
  wrap.querySelector('.mv-ext').addEventListener('click', external)
  wrap.querySelector('.mv-del').addEventListener('click', async () => {
    video.pause?.()
    if (await deleteClip(clip)) wrap.querySelector('.m-cancel').click()
  })
  video.addEventListener('error', () => {
    video.replaceWith(Object.assign(document.createElement('p'), { className: 'mv-err', textContent: "This clip won't play here. Open it in your player instead." }))
  })
  // openModal swallows keys for the page behind it; give the player its own
  const onKey = (e) => {
    if (!wrap.isConnected) return document.removeEventListener('keydown', onKey, true)
    if (e.key === ' ') video.paused ? video.play() : video.pause()
    else if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5)
    else if (e.key === 'ArrowRight') video.currentTime = Math.min(video.duration || 0, video.currentTime + 5)
    else return
    e.preventDefault()
  }
  document.addEventListener('keydown', onKey, true)
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
  // under the Settings page's own "OBS" heading, so the row names what it is
  $('#obs-rows').innerHTML = `<div class="setting-row">
      <div class="setting-text"><span class="setting-label">Connection</span><span class="setting-desc">${desc}</span></div>
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
  clipsShown = c.clips
  // A grid of cards. The thumbnail is the clip itself, paused a few seconds in
  // (a trimmed clip opens ~3s before the run) - no image files to make or keep,
  // and it works without ffmpeg. clipThumbs loads them, once per clip.
  const clips = c.clips.length
    ? `<div class="cl-grid">${c.clips
        .map(
          (x) => `<div class="cl-card" role="button" tabindex="0" data-f="${esc(x.file)}" aria-label="Play ${esc(x.scenario)}, ${esc(fmt(x.score))}">
            <div class="cl-thumb">
              <video muted preload="metadata" playsinline data-src="${esc(fileUrl(x.file))}#t=${CLIP_THUMB_S}"></video>
              <span class="cl-play-badge">${PLAY_ICON}</span>
              <span class="cl-why-badge${x.why === 'Run' ? '' : ' cl-why-hl'}">${esc(x.why)}</span>
              <button class="icon-btn cl-del" data-f="${esc(x.file)}" aria-label="Delete clip" title="Delete clip">${TRASH}</button>
            </div>
            <div class="cl-meta">
              <span class="cl-title">${esc(x.scenario)}</span>
              <span class="cl-sub"><span class="num">${esc(fmt(x.score))}</span> · ${esc(clipWhen(x.at))}${x.trimmed ? '' : ' · full buffer'}</span>
            </div>
          </div>`
        )
        .join('')}</div>`
    : emptyState('idle', 'No clips yet', 'With OBS connected, the next run worth keeping lands here.')

  const ready = c.on && c.obs.status === 'connected'
  const collapsed = ready && !clipSetupOpen
  const modeLabel = { pb: 'Every PB', rankup: 'Rank-ups', every: 'Every run' }[c.mode]
  const folderShort = String(c.folder).split(/[\\/]/).slice(-2).join('\\')
  // only once it works: a setup that needs attention is never folded away
  const summary = ready
    ? `<div class="setting-row cl-summary" role="button" tabindex="0" aria-expanded="${!collapsed}">
        <div class="setting-text"><span class="setting-label">Ready to clip</span>
          <span class="setting-desc">${esc(modeLabel)} · ${c.trim && c.ffmpeg ? 'trimmed to the run' : "OBS's whole buffer"} · ${esc(folderShort)}</span></div>
        ${obsStatus(c)}
        <span class="cl-chevron">${CHEVRON}</span>
      </div>`
    : ''

  el.innerHTML = `
    <div class="page-head">
      <div class="page-title"><h1>Autoclipper</h1><p class="lead">OBS saves a clip when a run is worth keeping.</p></div>
      <div class="page-actions"><button class="switch cl-on" role="switch" aria-checked="${c.on}" aria-label="Autoclipper on"></button></div>
    </div>
    <div class="rows${collapsed ? ' cl-collapsed' : ''}">
      ${summary}
      <div class="setting-row cl-detail">
        <div class="setting-text"><span class="setting-label">OBS</span><span class="setting-desc">${obsDesc}</span></div>
        ${c.on && !ready ? obsStatus(c) : ''}
        <button class="cl-settings">Settings</button>
      </div>
      <div class="setting-row cl-detail">
        <div class="setting-text"><span class="setting-label">Clip</span><span class="setting-desc">${esc(CLIP_MODE_HELP[c.mode])}</span></div>
        <div class="seg" role="radiogroup" aria-label="Clip">${seg}</div>
      </div>
      <div class="setting-row cl-detail">
        <div class="setting-text"><span class="setting-label">Trim to the run</span>
          <span class="setting-desc">${c.ffmpeg ? 'Cuts the clip to the run plus 3 seconds each side. Off keeps OBS\'s whole buffer.' : 'Needs ffmpeg, which isn\'t installed. Clips keep OBS\'s whole buffer until it is.'}</span></div>
        <button class="switch cl-trim" role="switch" aria-checked="${c.trim && c.ffmpeg}" aria-label="Trim to the run"${c.ffmpeg ? '' : ' disabled'}></button>
      </div>
      <div class="setting-row cl-detail">
        <div class="setting-text"><span class="setting-label">Clips folder</span><span class="setting-desc cl-path">${esc(c.folder)} · one folder per scenario</span></div>
        <button class="cl-folder">Change</button>
        <button class="cl-open">Open</button>
      </div>
    </div>
    <section class="block cl-recent">
      <div class="section-head"><h2>Recent clips</h2></div>
      ${clips}
    </section>`
  clipThumbs(el)
}

$('#clips-view').addEventListener('click', async (e) => {
  const sum = e.target.closest('.cl-summary')
  if (sum && !e.target.closest('button')) {
    setClipSetupOpen(sum.getAttribute('aria-expanded') !== 'true')
    return renderClips()
  }
  const b = e.target.closest('button')
  const card = e.target.closest('.cl-card')
  if (card && !b) {
    const clip = clipsShown.find((x) => x.file === card.dataset.f)
    return clip ? playClip(clip) : window.kova.clipPlay(card.dataset.f)
  }
  if (!b || b.disabled) return
  if (b.classList.contains('cl-on')) await window.kova.clipSet({ on: b.getAttribute('aria-checked') !== 'true' })
  else if (b.classList.contains('cl-trim')) await window.kova.clipSet({ trim: b.getAttribute('aria-checked') !== 'true' })
  else if (b.classList.contains('cl-mode')) await window.kova.clipSet({ mode: b.dataset.m })
  else if (b.classList.contains('cl-settings')) return showView('settings')
  else if (b.classList.contains('cl-folder')) await window.kova.clipPickFolder()
  else if (b.classList.contains('cl-open')) return window.kova.clipOpenFolder()
  else if (b.classList.contains('cl-del')) {
    const clip = clipsShown.find((x) => x.file === b.dataset.f)
    return clip && deleteClip(clip)
  }
  else return
  renderClips()
})
$('#clips-view').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && (e.target.classList.contains('cl-summary') || e.target.classList.contains('cl-card'))) {
    e.preventDefault()
    e.target.click()
  }
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
    { label: 'Play', run: () => playClip(clip) }
  )
  t.classList.add('toast-clip')
  setTimeout(() => t.classList.remove('toast-clip'), 8000)
})
