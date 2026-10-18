// Autoclipper: which runs get clipped, where the clip goes, how it's cut - plus
// a minimal OBS WebSocket (protocol v5) client to ask OBS for the clip. Pure Node
// like the rest of core/; main.js wires it to the stats watcher and the settings.
//
// The shape: OBS keeps a rolling recording (its replay buffer). When a run that
// qualifies ends, we ask OBS to save the buffer, then cut the saved file down to
// the run - we know when it started from the stats CSV - and file it.
const crypto = require('node:crypto')
const path = require('node:path')

// Seconds kept either side of the run, so the clip doesn't start mid-flick.
const PAD_START_S = 3
const PAD_END_S = 3

// ---- which runs ----------------------------------------------------------------
// mode: 'pb' (beat every earlier run of the scenario), 'rankup' (crossed a rank
// line), 'every'. `prevBest` is the best BEFORE this run, null = first ever run,
// which isn't a PB - there was nothing to beat (same rule as the session history).
function clipReason(mode, run, prevBest, rankUp) {
  if (mode === 'every') return { why: 'run' }
  if (mode === 'rankup') return rankUp ? { why: 'rankup', rank: rankUp } : null
  if (prevBest != null && run.score > prevBest) return { why: 'pb', gain: run.score - prevBest }
  return null
}

// ---- where it goes ---------------------------------------------------------------
// Windows filename rules: no <>:"/\|?* or control chars, no trailing dot/space,
// and not a reserved device name. Scenario names are free text, so all of it.
function safeName(s) {
  let out = String(s || 'clip')
    // eslint-disable-next-line no-control-regex -- control chars are illegal in Windows names
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/[. ]+$/, '')
    .trim()
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = `_${out}`
  return out.slice(0, 120) || 'clip'
}

const pad = (n) => String(n).padStart(2, '0')
// <folder>/<scenario>/<scenario> - <score> - YYYY-MM-DD HH.MM.SS<ext>
function clipPath(folder, run, ext) {
  const d = new Date(run.ts)
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
  const name = safeName(run.scenario)
  const score = String(Math.round(run.score * 10) / 10)
  return path.join(folder, name, `${name} - ${score} - ${stamp}${ext || '.mp4'}`)
}

// ---- how it's cut ------------------------------------------------------------------
// The saved buffer ENDS at `savedAt`, but its length depends on OBS's setting,
// which we don't know - so the cut is measured from the end of the file
// (ffmpeg -sseof), not the start. Null when the run's start is unknown: then the
// whole buffer is kept rather than guessing.
function trimFromEndS(run, savedAt) {
  if (run.durationMs == null) return null
  const runStart = run.ts - run.durationMs
  return Math.max(1, Math.ceil((savedAt - runStart) / 1000 + PAD_START_S))
}

// ffmpeg arguments for a stream-copy cut: no re-encode, so it takes a moment and
// costs no quality. Cuts land on the nearest keyframe, which is why PAD_START_S
// exists at all.
function ffmpegArgs(input, output, fromEndS) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-sseof', `-${fromEndS}`, '-i', input, '-c', 'copy', '-movflags', '+faststart', output]
}

// ---- OBS WebSocket v5 --------------------------------------------------------------
// The auth string from OBS's Hello: base64(sha256(base64(sha256(password + salt)) + challenge)).
function obsAuth(password, salt, challenge) {
  const sha = (s) => crypto.createHash('sha256').update(s).digest('base64')
  return sha(sha(password + salt) + challenge)
}

const OP = { HELLO: 0, IDENTIFY: 1, IDENTIFIED: 2, EVENT: 5, REQUEST: 6, RESPONSE: 7 }
const EVENTS_OUTPUTS = 1 << 6 // ReplayBufferSaved and the other output events

// One connection. `onEvent(type, data)` for events, `onClose(reason)` once.
// ponytail: no reconnect logic in here - main.js reconnects on a timer, which is
// all a local app talking to localhost needs.
function obsConnect({ host, port, password }, { onEvent = () => {}, onClose = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let ws
    try {
      // The subprotocol obs-websocket documents, and OBS 30 echoes it (verified
      // 2026-10-18). Without it, a non-OBS server on the port that sends one
      // unasked trips an uncaught throw in Node's WebSocket.
      ws = new WebSocket(`ws://${host}:${port}`, 'obswebsocket.json')
    } catch (e) {
      return reject(e)
    }
    const pending = new Map()
    let ready = false
    let nextId = 1
    // something on the port that never says Hello would leave this pending forever
    const helloTimer = setTimeout(() => fail("OBS didn't answer"), 10_000)
    const fail = (msg) => {
      clearTimeout(helloTimer)
      if (!ready) reject(new Error(msg))
      try {
        ws.close()
      } catch {}
    }
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      const d = msg.d || {}
      if (msg.op === OP.HELLO) {
        const id = { rpcVersion: 1, eventSubscriptions: EVENTS_OUTPUTS }
        if (d.authentication) {
          if (!password) return fail('OBS wants a password')
          id.authentication = obsAuth(password, d.authentication.salt, d.authentication.challenge)
        }
        ws.send(JSON.stringify({ op: OP.IDENTIFY, d: id }))
      } else if (msg.op === OP.IDENTIFIED) {
        ready = true
        clearTimeout(helloTimer)
        resolve({
          request(type, data) {
            const requestId = String(nextId++)
            ws.send(JSON.stringify({ op: OP.REQUEST, d: { requestType: type, requestId, requestData: data } }))
            return new Promise((res, rej) => {
              pending.set(requestId, { res, rej })
              setTimeout(() => pending.delete(requestId) && rej(new Error(`${type} timed out`)), 10000)
            })
          },
          close: () => ws.close(),
        })
      } else if (msg.op === OP.RESPONSE) {
        const p = pending.get(d.requestId)
        if (!p) return
        pending.delete(d.requestId)
        if (d.requestStatus?.result) p.res(d.responseData || {})
        else p.rej(new Error(d.requestStatus?.comment || `${d.requestType} failed`))
      } else if (msg.op === OP.EVENT) onEvent(d.eventType, d.eventData || {})
    })
    ws.addEventListener('close', (ev) => {
      clearTimeout(helloTimer)
      for (const p of pending.values()) p.rej(new Error('OBS disconnected'))
      pending.clear()
      // 4009 = authentication failed (OBS's WebSocketCloseCode)
      if (!ready) reject(new Error(ev.code === 4009 ? 'Wrong OBS password' : "Couldn't reach OBS"))
      onClose(ev.code)
    })
    ws.addEventListener('error', () => {}) // close always follows; that's where it's handled
  })
}

module.exports = { clipReason, clipPath, safeName, trimFromEndS, ffmpegArgs, obsAuth, obsConnect, PAD_START_S, PAD_END_S }
