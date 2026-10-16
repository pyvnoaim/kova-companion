# TODO

## Now: test everything built on 2026-10-14 (nothing has run for real yet)

**1. Locally, app against a local kova** (Docker on): in `~/dev/kova`
`npm run db:up && npm run db:migrate && npm run dev`, then here
`KOVA_URL=http://localhost:3000 npm start`.

- [ ] Sign in end to end: code shown, approve on `localhost:3000/login/companion`, the card
      shows your name and rank. Sign out removes the session on kova's account page.
- [ ] Rank progress loads your real KovaaK's bests (needs KovaaK's linked on the profile).
- [ ] The overlay's "KovaaK's setup" slide renders (card and bar layouts) once a setup has
      been posted.

**2. On Windows, with KovaaK's:**

- [ ] The redesign: presets apply, HUD editor opens / saves / leaving with unsaved edits asks,
      the window drags by its title bar.
- [ ] **Live setup on stream:** change sens / crosshair / FOV in game; the overlay follows
      within seconds. The FOV row appears (scanned by key name - if it never shows, KovaaK's
      keeps FOV elsewhere). Find the real **sound cooldown** key and pin it in
      `core/companion.js` (it matches anything named *cooldown* today).
      The slide only shows while KovaaK's runs: it should appear within seconds of starting the
      game, stay through a restart-game, and go about 90s after closing it.
- [ ] **Rank progress** (built 2026-10-14). Signed in, with KovaaK's linked on kova: your real
      bests show; after 5+ runs on a scenario its odds appear; a run that crosses a rank line
      pops Kovi (tray: a Windows notification). Play session: does each scenario launch, and
      does it move on after 3 finished runs?
- [ ] **Sessions** (built 2026-10-14). First open on a real stats folder: how long does it take?
      Close KovaaK's after a few runs: the "Open recap" toast (tray: notification, click opens
      the recap). Restart-game must NOT trigger a recap.
- [ ] **Re-enter targets the loaded scenario** (session.sav, built 2026-10-14). Load a scenario,
      DON'T finish a run, apply a preset with "Re-enter scenario": it must reload that one, not
      the previous. If it still jumps to the old one, check where session.sav actually lives
      (install `Saved/SaveGames` or `%LOCALAPPDATA%`) and that `ScenarioName` is in it.

- [ ] **Autoclipper** (built 2026-10-14). OBS open with its WebSocket server on: Connected, and
      the replay buffer switches on. Set a PB: a clip lands in the clips folder (trimmed if
      ffmpeg is installed, else OBS's whole buffer), the Kovi notice shows, Play opens it.
      Check the cut starts just before the run (keyframes can shift it a second or two).
- [ ] **Update from an installed 2.0.1** to the renamed build: presets and settings survive
      (userData is pinned to the old folder), auto-update works, no stray old shortcut.

- [ ] **Tournaments** (built 2026-10-14). Registered for a real kova tournament: it shows under
      Upcoming; when check-in opens, one reminder (tray: notification) and Check in works; the
      app never checks in by itself. When your match goes live: one reminder, the green dot,
      Play launches the picked scenario; the window never jumps forward.
- [ ] **Weekly challenge** (built 2026-10-14). In a team with a Discord challenge channel: the page
      shows its scenario, standings and past weeks; Play launches it. Two teams: tabs. Needs the
      challenge_week migration applied.
- [ ] **Snipe alerts** (built 2026-10-14). Follow someone on kova who plays your scenarios; when
      kova logs a PB of theirs above your local best: one toast (tray: notification), Play
      launches it. The first poll after sign-in only sets the cursor, no alerts.
- [ ] **Bundled ffmpeg, once before the first release with it:** push, run the **ffmpeg**
      workflow (Actions tab, builds the cut-only LGPL ffmpeg.exe and publishes it as a
      pre-release), copy the sha256 from its summary into `scripts/ffmpeg-pin.json`, commit.
      `npm run release` refuses to build until that's done.
- [ ] Trim a **real OBS clip** (H.264 / HEVC / AV1): local tests only had MPEG-4 video, since
      there's no H.264 encoder without GPL code. mp4, fragmented mp4, mkv and mpegts all cut
      to the second with the 2.3 MB build.

- [ ] **Kovi everywhere** (built 2026-10-14): empty / error states, the "KovaaK's is closed" note on
      Presets, a PB pop-up for every PB (Settings > Alerts), the tray icon awake / asleep. On kova:
      the overlay's opt-in "Kovi on new PBs" pop flag - check it on the card and moments layouts
      in the local run (not rendered yet, kova's overlay needs the database).

**3. Ship:** commit kova first (the app needs its endpoints), then release notes, version
bump and `npm run release` here, then the GitHub repo rename.

## Next: KovaPresets -> kova companion

It's already a multi-tool app - `core/kovaaks.js` is a shared file layer, and
presets / HUD / overlay are three tools on top of it with namespaced IPC
(`presets:` / `hud:` / `overlay:`). What's missing is chrome that admits it.

**Do not rebuild from scratch.** The asset in this repo is the verified file
semantics in `kovaaks.js`, not the code: that `OverrideSens` does nothing on the
scenario reload, that a `[weapon]` section shadows the global block, that the game
rewrites `PrimaryUserSettings.json` from launch-time memory, that the proxy theme
is the only live-swap route. Each of those is a day spent proving it in game. A
rebuild rediscovers them the hard way.

- [x] **Mascot: Kovi**, the KovaaK's bot capsule with glowing eyes ("kova companion
      mascot" canvas, https://claude.ai/artifact/CjLLCHnLGU7K9rUHeDyzT4). Becomes the
      tray icon (built 2026-10-14: `tray-awake` / `tray-asleep` PNGs, follows the game) and the app
      icon (`app.ico`: Kovi on a dark tile, chunkier glyph at 32/16 px - check it in the taskbar,
      title bar, installer and Start menu on Windows). Kovi
      shows up in empty states, PB pop-ups and reminders. Shell draft:
      https://claude.ai/artifact/7aakEHeWhUex49u4UBpRRF
- [x] `productName` becomes kova companion, and **keep `appId: app.kova.presets`**. It's the
      NSIS upgrade key, so keeping it is what makes installed copies update into the
      new name instead of stranding on a dead feed. The install folder and shortcut
      still move, so old copies can linger - this is a deliberate release with a
      note, not a quiet edit.
- [ ] Repo rename. GitHub redirects, but electron-builder's `publish.repo` has to be
      updated and the auto-updater's download URLs then rely on that redirect.
      **Test an update from an old install before shipping it**, don't assume.
- [ ] `install.ps1` at pyvno.xyz points at the new release asset name.
- [x] Left nav in `index.html`. Views already toggle on `.hidden`, so this is a
      two-view toggle becoming an N-view one.
- [x] Split the renderer (2026-10-14): `renderer.js` keeps presets, the builder, settings and
      the shared helpers; each page added since has its own script (`kova.js`, `progress.js`,
      `sessions.js`, `clips.js`, plus the older `hud.js`), loaded in order by `index.html` and
      sharing one global scope. A new page gets a new file; its cross-file names go in the
      `globals` list in `eslint.config.js`.

Ship the rename + nav with the three tools that exist, as one release. Adding new
tools first is how the rename stalls.

## Then: sign in with kova

The app makes no calls to kova today. Everything account-based below waits on this,
so it comes before any connected tool. Two-repo change.

- [x] **Login with your kova account.** (Built 2026-10-14 on both sides: Better Auth device-code grant + bearer, /login/companion approval page. Not yet run against a real kova.) Sign-in happens in the browser on kova.page
      (kova is Discord-only, so the app never sees Discord credentials) and hands the
      app a token. Needs the approve page and token endpoints on kova's side, plus
      sign out and "signed in as" in the app.
- [ ] One rule for everything after this: local data may drive pop-ups and displays
      but **never writes PBs or ranks into kova**, it can't be verified. Profile
      settings (sens, DPI, FOV, crosshair) are fine to sync, they are self-reported
      already.

## Then: new tools

Needs sign-in:

- [x] **Tournaments** (built 2026-10-14: app page + reminders, kova GET /api/companion/tournaments and POST .../checkin). Decided: check-in is
      ALWAYS a reminder, never automatic; a live match only notifies, never pulls the window
      forward. Needs on kova: "my tournaments + matches" and a check-in endpoint over the
      existing `playerCheckIn` action. Your upcoming matches, check-in reminders, one-click launch
      of the match scenario, live match state.
- [x] **Live setup on stream** (was "profile auto-sync"; decided 2026-10-14: overlay only, the profile and feed are never touched). Built: POST /api/companion/setup, KovaaksSetup row, overlay "KovaaK's setup" slide. Not yet run against a real kova. Original note: Sens, DPI, FOV and crosshair on your kova profile
      update themselves when you change them in game.
- [ ] **Shareable presets.** "Use this aimer's crosshair and theme" from a profile
      opens it in the app. Needs the asset URLs on kova's side.
- [ ] **Playlist launcher** - parked 2026-10-14: a list of your own kova playlists isn't useful
      enough yet. Revisit as **benchmark quick play**: launch a benchmark's scenarios straight
      from the app. Mechanics are known: `steam://run/824270/?action=jump-to-playlist;sharecode=<code>`
      for a playlist, the `jump-to-scenario` link the app already uses for a single scenario.
- [x] **Snipe alerts** (built 2026-10-14: kova GET /api/companion/snipes, app polls every 5 min,
      compares with your local best, toast / notification with Play; toggle in Settings).
      Someone you follow beat your score, with one click to launch that scenario.

- [ ] **Default preset per scenario** - parked 2026-10-14. Pin a preset to a scenario (or a
      tag); re-enter / restart into it applies that preset first. Idea from kovaaks-plus.
      Builds on the session.sav reader (`currentScenario`).

- [x] **Team challenge of the week** (built 2026-10-14: Weekly challenge page, team tabs, past 8 weeks;
      kova GET /api/companion/challenge + ChallengeWeek table written by the sweep). Your aimgroup's
      scenario of the week, days left, standings, Play. kova already computes it for the feed
      (`getTeamChallenge` in features/feed/personal.ts); needs a /api/companion/challenge wrapper.
- [ ] **Cloud presets** - maybe later. Back presets up to your kova account for a second PC.

Works from local files:

- [x] **Rank progress** (built 2026-10-14, with odds, rank-up session, Kovi pop-up). How many points you need per scenario for the next rank,
      live while you play. Thresholds come from kova.
- [x] **Session recap** (built 2026-10-14 as Sessions: yearly calendar, every day, recap on close). Runs, PBs and time played when you close KovaaK's.
- ~~**Discord rich presence.**~~ Dropped 2026-10-14: KovaaK's has it built in now.
- [x] **Autoclipper** (built 2026-10-14; trims with a bundled 2.3 MB cut-only ffmpeg, scripts/build-ffmpeg.sh). Clip on PB via obs-websocket, with a threshold (percentile,
      playlist, rank achieved, or just every PB). Cheapest new tool here: watching
      the stats folder for a PB is the same `fs.watch` the overlay already runs, so
      obs-websocket is the only genuinely new piece.
- [ ] **Chat commands** - parked 2026-10-14. Drafted on the shell canvas ("Chat commands" section):
      a Stream page, Twitch connected via device code (twitch.tv/activate, a Public client id, no
      server), posts as the streamer's account, per-command switches, 10/30/60s cooldown.
      (`!sens`, `!theme`, `!crosshair`, `!sounds`). Answers come
      straight off the snapshot the overlay already serves, so this is a Twitch
      connection rather than a feature. `!theme` handing out a download needs the
      asset URLs on kova's side, so it's a two-repo change.

## Ideas (2026-10-14)

- [x] **Score graph per scenario** (built 2026-10-14). Click a scenario in Rank progress: runs over
      30 / 90 days / all, your best, rank bands, hover for a run's score and date.
- [ ] Streaks on the Sessions calendar - undecided.
- Not doing: smart warm-up, fatigue hints, sens converter (kova's site has one), OBS scene switching.

## Loose ends

- [ ] List kova companion on kova's `/projects` directory.
- [ ] Two mid-session applies, the second with the same theme: its queue replaces the first's and
      drops `proxyName`, so the overlay and (after quit) the in-game menu fall back to the launch-time
      theme name. Colours are right. Fix: carry `proxyName` forward when an apply doesn't change the theme.
