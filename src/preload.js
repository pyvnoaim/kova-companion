// The only bridge between the sandboxed renderer and the main process. Each
// method is a thin wrapper over an ipcMain.handle channel in main.js.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('kova', {
  state: (opts) => ipcRenderer.invoke('state', opts),
  capture: (name) => ipcRenderer.invoke('presets:capture', name),
  build: (picks) => ipcRenderer.invoke('presets:build', picks),
  remove: (id) => ipcRenderer.invoke('presets:delete', id),
  rename: (id, name) => ipcRenderer.invoke('presets:rename', id, name),
  updateWeapon: (id, patch) => ipcRenderer.invoke('presets:updateWeapon', id, patch),
  duplicate: (id) => ipcRenderer.invoke('presets:duplicate', id),
  reorder: (orderedIds) => ipcRenderer.invoke('presets:reorder', orderedIds),
  setHotkey: (id, hotkey) => ipcRenderer.invoke('presets:setHotkey', id, hotkey),
  apply: (id) => ipcRenderer.invoke('preset:apply', id),
  deactivate: () => ipcRenderer.invoke('presets:deactivate'),
  updatePreset: (id, picks) => ipcRenderer.invoke('presets:update', id, picks),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  toggleDevtools: () => ipcRenderer.invoke('win:devtools'),
  reload: () => ipcRenderer.invoke('win:reload'),
  winClose: () => ipcRenderer.invoke('win:close'),
  restartScenario: () => ipcRenderer.invoke('game:restart'),
  restartGame: () => ipcRenderer.invoke('game:restartFull'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  health: () => ipcRenderer.invoke('health:check'),
  ensureProxy: () => ipcRenderer.invoke('proxy:ensure'),
  exportPresets: (id) => ipcRenderer.invoke('presets:export', id),
  importPresets: () => ipcRenderer.invoke('presets:import'),
  hudSave: (uiRaw) => ipcRenderer.invoke('hud:save', uiRaw),
  // kova account: device-code sign-in, and the setup sync toggle.
  kovaGet: () => ipcRenderer.invoke('kova:get'),
  kovaSignIn: () => ipcRenderer.invoke('kova:signIn'),
  kovaCancelSignIn: () => ipcRenderer.invoke('kova:cancelSignIn'),
  kovaSignOut: () => ipcRenderer.invoke('kova:signOut'),
  kovaSetSync: (on) => ipcRenderer.invoke('kova:setSync', on),
  kovaSetSnipes: (on) => ipcRenderer.invoke('kova:setSnipes', on),
  kovaSetPbPopups: (on) => ipcRenderer.invoke('kova:setPbPopups', on),
  snipesPlay: (id) => ipcRenderer.invoke('snipes:play', id),
  onSnipe: (cb) => ipcRenderer.on('snipe', (_e, info) => cb(info)),
  kovaOpen: (where) => ipcRenderer.invoke('kova:open', where),
  // Fired when sign-in finished, failed, or kova signed the app out.
  onKovaChanged: (cb) => ipcRenderer.on('kova-changed', () => cb()),
  // Rank progress: the page model, Play, and the rank-up session.
  progressGet: (opts) => ipcRenderer.invoke('progress:get', opts),
  progressPlay: (name) => ipcRenderer.invoke('progress:play', name),
  progressScenario: (name, days) => ipcRenderer.invoke('progress:scenario', name, days),
  progressStartSession: (names) => ipcRenderer.invoke('progress:startSession', names),
  progressStopSession: () => ipcRenderer.invoke('progress:stopSession'),
  // Fired when a run finished (refresh the page) and when one ranked up.
  onProgressChanged: (cb) => ipcRenderer.on('progress-changed', (_e, info) => cb(info)),
  onRankUp: (cb) => ipcRenderer.on('rank-up', (_e, info) => cb(info)),
  onPb: (cb) => ipcRenderer.on('pb', (_e, info) => cb(info)),
  // Sessions: the whole history, and the recap when KovaaK's closes.
  historyGet: () => ipcRenderer.invoke('history:get'),
  onSessionEnded: (cb) => ipcRenderer.on('session-ended', (_e, info) => cb(info)),
  onOpenRecap: (cb) => ipcRenderer.on('open-recap', (_e, info) => cb(info)),
  // Autoclipper: settings, OBS, the clips folder and the recent clips.
  clipGet: () => ipcRenderer.invoke('clip:get'),
  clipSet: (patch) => ipcRenderer.invoke('clip:set', patch),
  clipSetPassword: (pw) => ipcRenderer.invoke('clip:setPassword', pw),
  clipPickFolder: () => ipcRenderer.invoke('clip:pickFolder'),
  clipOpenFolder: () => ipcRenderer.invoke('clip:openFolder'),
  clipPlay: (file) => ipcRenderer.invoke('clip:play', file),
  onClipChanged: (cb) => ipcRenderer.on('clip-changed', () => cb()),
  onClipSaved: (cb) => ipcRenderer.on('clip-saved', (_e, clip) => cb(clip)),
  // Tournaments: the page, check-in (only on the player's click), Play, open on kova.
  challengeGet: () => ipcRenderer.invoke('challenge:get'),
  challengePlay: (slug) => ipcRenderer.invoke('challenge:play', slug),
  challengeOpen: (slug) => ipcRenderer.invoke('challenge:open', slug),
  tournamentsGet: () => ipcRenderer.invoke('tournaments:get'),
  tournamentsCheckIn: (id) => ipcRenderer.invoke('tournaments:checkIn', id),
  tournamentsPlay: (matchId) => ipcRenderer.invoke('tournaments:play', matchId),
  tournamentsOpen: (slug) => ipcRenderer.invoke('tournaments:open', slug),
  onTournamentsChanged: (cb) => ipcRenderer.on('tournaments-changed', (_e, info) => cb(info)),
  onTournamentReminder: (cb) => ipcRenderer.on('tournament-reminder', (_e, info) => cb(info)),
  // A notification click asking for a page.
  onOpenView: (cb) => ipcRenderer.on('open-view', (_e, v) => cb(v)),
  // Fired when a queued change is flushed after the game quits.
  onChanged: (cb) => ipcRenderer.on('changed', () => cb()),
  // Fired when a global hotkey applied a preset in the background.
  onHotkeyApplied: (cb) => ipcRenderer.on('hotkey-applied', (_e, info) => cb(info)),
})
