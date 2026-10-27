// Draws the app and tray icons: Kovi's face, a pink squircle whose only mark is
// his two eyes. Every size is drawn on its own (eyes snapped to whole pixels up
// to 32 px) instead of one big image scaled down, which is what blurs an icon.
//
//   npx electron scripts/draw-icons.js
//
// Writes src/assets/app.ico (every size Windows asks for: taskbar 24/30/36 at
// 100/125/150%, title bar 16/20, Start 32/40/48, Explorer up to 256) and the tray
// PNGs Electron picks per display scale (tray-awake.png, @1.25x ... @2x, and the
// same for tray-asleep: grey, eyes shut, while KovaaK's is closed).
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ASSETS = path.join(__dirname, '..', 'src', 'assets')
const ICO_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 64, 96, 128, 256]
const TRAY_SCALES = { '': 16, '@1.25x': 20, '@1.5x': 24, '@1.75x': 28, '@2x': 32 }

// Runs in the page: canvas drawing, returns a PNG data URL.
const DRAW = `
// superellipse (n = 5): the squircle app icons use, fuller than a rounded rect
function squircle(g, x, y, s) {
  const n = 5, r = s / 2, cx = x + r, cy = y + r
  g.beginPath()
  for (let i = 0; i <= 360; i++) {
    const t = (i * Math.PI) / 180, c = Math.cos(t), sn = Math.sin(t)
    const px = cx + r * Math.sign(c) * Math.abs(c) ** (2 / n)
    const py = cy + r * Math.sign(sn) * Math.abs(sn) ** (2 / n)
    i ? g.lineTo(px, py) : g.moveTo(px, py)
  }
  g.closePath()
}

function kovi(N, asleep) {
  const c = document.createElement('canvas')
  c.width = c.height = N
  const g = c.getContext('2d')
  const small = N <= 32
  // tray and title bar sizes fill the square; larger ones keep a hair of margin
  const m = N <= 20 ? 0 : N * 0.03, s = N - 2 * m

  squircle(g, m, m, s)
  const bg = g.createLinearGradient(0, m, 0, m + s)
  bg.addColorStop(0, asleep ? '#b9b9c2' : '#ffb8b4')
  bg.addColorStop(1, asleep ? '#8e8e98' : '#ff858c')
  g.fillStyle = bg
  g.fill()

  if (N >= 48) {
    // soft top light and a hairline edge: depth without decoration
    g.save()
    squircle(g, m, m, s)
    g.clip()
    const hi = g.createRadialGradient(N / 2, m, 0, N / 2, m, s * 0.9)
    hi.addColorStop(0, 'rgba(255,255,255,0.28)')
    hi.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = hi
    g.fillRect(0, 0, N, N)
    g.restore()
    squircle(g, m + 0.5, m + 0.5, s - 1)
    g.strokeStyle = 'rgba(255,255,255,0.25)'
    g.lineWidth = Math.max(1, N / 160)
    g.stroke()
  }

  // eyes: tall pills a little above centre, close together
  let ew = s * 0.15, eh = s * 0.3, gap = s * 0.14, ey = m + s * 0.27
  if (small) {
    ew = Math.max(2, Math.round(ew))
    eh = Math.max(3, Math.round(eh))
    gap = Math.max(2, Math.round(gap))
    ey = Math.round(ey)
  }
  const x1 = small ? Math.round((N - ew * 2 - gap) / 2) : (N - ew * 2 - gap) / 2
  const x2 = x1 + ew + gap
  g.fillStyle = '#17171b'
  if (asleep) {
    const t = small ? Math.max(1, Math.round(N / 14)) : s * 0.06
    const y = small ? Math.round(ey + eh * 0.55) : ey + eh * 0.55
    for (const x of [x1, x2]) {
      g.beginPath()
      g.roundRect(small ? x : x - ew * 0.15, y, small ? ew : ew * 1.3, t, small ? 0 : t / 2)
      g.fill()
    }
  } else {
    for (const x of [x1, x2]) {
      g.beginPath()
      g.roundRect(x, ey, ew, eh, small ? (N >= 24 ? 1 : 0) : ew / 2)
      g.fill()
    }
    if (!small) {
      g.fillStyle = 'rgba(255,255,255,0.85)'
      for (const x of [x1, x2]) {
        g.beginPath()
        g.ellipse(x + ew * 0.62, ey + eh * 0.2, ew * 0.18, ew * 0.24, 0, 0, 7)
        g.fill()
      }
    }
  }
  return c.toDataURL('image/png')
}`

// ICO with PNG frames (Vista and later read PNG at every size)
function ico(frames) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(frames.length, 4)
  let off = 6 + 16 * frames.length
  const dir = frames.map(([n, png]) => {
    const e = Buffer.alloc(16)
    e.writeUInt8(n >= 256 ? 0 : n, 0)
    e.writeUInt8(n >= 256 ? 0 : n, 1)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(off, 12)
    off += png.length
    return e
  })
  return Buffer.concat([head, ...dir, ...frames.map((f) => f[1])])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,<body></body>')
  await win.webContents.executeJavaScript(`${DRAW};0`)
  const png = async (n, asleep) =>
    Buffer.from((await win.webContents.executeJavaScript(`kovi(${n}, ${asleep})`)).split(',')[1], 'base64')

  const frames = []
  for (const n of ICO_SIZES) frames.push([n, await png(n, false)])
  fs.writeFileSync(path.join(ASSETS, 'app.ico'), ico(frames))
  for (const [suffix, n] of Object.entries(TRAY_SCALES)) {
    fs.writeFileSync(path.join(ASSETS, `tray-awake${suffix}.png`), await png(n, false))
    fs.writeFileSync(path.join(ASSETS, `tray-asleep${suffix}.png`), await png(n, true))
  }
  console.log(`app.ico (${ICO_SIZES.join(', ')}) and tray PNGs written to src/assets`)
  app.quit()
})
