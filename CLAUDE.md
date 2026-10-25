# DarkShed: notes for working on this repo

Browser-based RAW + JPEG editor (plain JavaScript, WebGL2, LibRaw via WebAssembly). See README.md for what it does.

## Commands
- `npm run dev`: dev server on :5173, reachable from a phone on the same Wi-Fi (edits show instantly).
- `npm run build`: production build into `dist/`; `npm start` serves it plus the preset/LUT sync API (`server/index.mjs`).

## Where things are
- `src/gl.js` renderer (shaders, strip-based full-res export), `src/export.js` export, `src/jpeg.js` own JPEG encoder (no canvas size limit on iOS).
- `src/mobile.js` + the `body.m` rules in `src/style.css` are the phone layout (fixed photo, bottom dock, fixed-height sheet).
- `src/ui/about.js` About text and credits. Colors are CSS variables at the top of `src/style.css` (60/30/10 palette, safelight red accent). The logo is the "D" in `public/favicon.svg` and `src/ui/logo.js`.

## Decisions to keep
- Photos never leave the device; the server only stores presets and LUTs.
- iOS home-screen app: keep `apple-mobile-web-app-status-bar-style` = `black` (with `black-translucent` iOS 26 left a gap under the dock).
- Page zoom is disabled on touch screens on purpose, including double-tap zoom: `touch-action: manipulation` on everything (coarse pointers), and the photo's double-click zoom only reacts to a mouse. Curves detect double click / double tap themselves (inner point removed, end point back to its corner).
- No live demo on GitHub Pages (decided: not worth risking the offline cache).

## UI patterns worth keeping consistent
- Item menus (presets, grid thumbnails, filmstrip, category chips): a small "⋯" button (hover on desktop, always visible on touch), press and hold (550 ms) on touch, and right-click on desktop. Destructive actions (delete preset or LUT, remove photo) always ask first.
- Presets replace each other: `revertPrevious()` in `src/ui/presets-panel.js` undoes what the last preset changed before the next one applies, so a color preset never inherits B&W leftovers.
- The presets panel is one list: search, Save and a "⋯" menu (imports, exports) on top, then collapsible categories on desktop (your own presets first, then Looks (the built-in Fujifilm-style ones, which keep exposure and white balance), then LUTs); on phones the categories are chips (wrapping) and the tiles a wrapping grid, so the sheet only scrolls up and down. It lists the looks and synced presets even with no photo open (previews need a photo). Profiles (Standard, Camera Matching, ...) live in their own Profiles tab (between Presets and Info, in the rail and on the phone dock), RAW files only, with a preview of each on the photo; looks and LUTs live only in the presets panel. The thumbnail renderer needs the RAW flag, camera and camera fit in the state it is given, or RAW previews come out without the base curve.
- RAW white balance is in Kelvin (`wbK` param, 0 = as shot, `src/wb.js`): the Temp slider runs 2000-50000 K in 50 K steps with about 7000 K mid-track, and the presets, auto and the picker set a Kelvin. The shader applies per-channel gains from the camera's colour data (`uWbG`); `temp` (-100..100) is only for JPEGs and old edits. Anything that renders a RAW (thumbnails, export) needs `wbGain` in its state.
- Desktop: choosing the tool that is already open (rail button or its key) folds the side panel away, choosing it again or another tool brings it back (`pickTool()` in `src/main.js`, `body.panel-closed`). Tool keys: E edit, C crop, Q healing, M masks, L presets, R profiles, I info; S shows or hides the filmstrip. The Keyboard shortcuts window (grouped, with search) is built from `shortcutList()` in `src/main.js`: update it whenever a key changes. Keep global keys unique: P / X / U are flags (X also swaps orientation inside the crop tool), O, H, B belong to the mask and healing tools, so new global keys must avoid all of these.
- The photo can be zoomed out to 10% of fit (`MIN_ZOOM` in `src/gl.js`) so a big mask fits in the window. Opening a photo shows a spinner with the current step (`.loadbox` in `src/main.js`, fed by the `loading` event; it waits 200 ms so quick switches do not flash it). "Delete all stored copies" in Settings also empties the open library; there is no "Clean up now" button because cleanup is automatic.
- On iOS the file pickers for presets and LUTs must not set `accept` (iOS greys out .xmp, .lrtemplate, .cube).
- Grid view: no filmstrip over it on desktop (the grid is the library); double-click or a quick double tap on a photo opens it in the editor. This is detected by hand in `src/ui/grid.js` (not `dblclick`): the cells are rebuilt on the first press, so the browser never sees two clicks on one element, and iOS sends no dblclick for touches anyway. The grid is `touch-action: pan-y` so a double tap does not zoom the page.
- The floating histogram belongs to the edit screen only (hidden over the grid and with no photo open).

- Sync data is validated: `validPreset()` in `src/merge.js` drops anything that is not a real preset, on the server and on devices. Never write test data to a real server's `/api/presets` (a bad test once broke the presets panel on every synced device).
- iOS sends no `dblclick` for touches and zooms the page on double taps: controls that reset on double tap (sliders, the colour wheel) detect the second tap themselves, and touch-only controls cancel `touchstart`.

- Full screen (menu item and the F key) uses the Fullscreen API; it is hidden on iPhone Safari and in the installed app, where it cannot or need not work. Headless browsers refuse it, so it needs a real click to verify.

## Testing
- No real browser automation here; headless Firefox works. Use a fresh `--profile` dir every run. `src/devtest.js` (dev only) loads `?test=/img.png&script=...` and posts screenshots/logs to the Vite middleware `/__shot` (needs the `SHOT_DIR` env var). Sample images live in `dev/`.
- Do not use anyone's personal photos in tests, screenshots or commits.
- To test sync end to end, run a throwaway server (`DARKSHED_PORT=8097 DARKSHED_DATA=<temp dir> node server/index.mjs`), add a temporary `/api` proxy to it in `vite.config.js` (do not commit it), and open the app in two fresh browser profiles. Restart `vite` after editing files, or a test script can load a second copy of a module.

## Releasing
Push to `main`. GitHub Actions builds the Docker image `ghcr.io/hertn/darkshed:latest`; hosts running the compose file update from it (Watchtower).

## Downloads without Docker (launcher/)
- `launcher/` builds self-contained downloads (official Node.js bundled in `runtime/`, built app, `server/`, `src/merge.js`, a `data/` folder next to it). `launcher/start.mjs` starts the server, picks a free port, prints the phone address (first private IPv4) and opens the browser at it, so the computer and the phone share one address (and presets). Settings in `data/launcher.json` (`port`, `token`).
- `launcher/service.mjs install|remove|status` is the optional run-in-background mode: macOS LaunchAgent, Windows scheduled task (runs `hidden.vbs`), Linux systemd user unit. `remove` works from names, not paths, so it still works after the folder moved. `DARKSHED_SERVICE_LABEL` lets tests use a different name.
- `node launcher/build-release.mjs <mac-arm64|mac-x64|win-x64|linux-x64|linux-arm64> [version]` after `npm run build` writes `release/`. `.github/workflows/release.yml` builds all five on a version tag (`v*`) or by hand, smoke-tests the Apple-silicon Mac, Windows and Linux Intel/AMD packages on real runners (the files are named mac-apple-silicon, mac-intel, windows, linux-intel-amd, linux-arm: users do not know "arm64") and publishes to GitHub Releases. The user-facing instructions are `launcher/READ-ME-FIRST.template.txt` (filled per system by the build script): keep it in step with the scripts.
- A port only counts as free if nothing answers on 127.0.0.1, ::1 or the LAN address and it can be bound on 0.0.0.0 and :: (an app on just IPv4 8080 once made the browser show the other app); after starting, `start.mjs` pings itself and warns if `/api/ping` does not say `app: "darkshed"`. The port in use is written to `data/darkshed.port`.
- Tested locally (Intel Mac): start, ping, token, background install, restart after kill, remove. Not tested by hand: Windows, Linux, Apple-silicon Macs (only CI smoke tests), linux-arm64 (not tested at all). Files are unsigned: Gatekeeper and SmartScreen warnings are documented in the READ ME.
