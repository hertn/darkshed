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
- Page zoom is disabled on touch screens on purpose.
- No live demo on GitHub Pages (decided: not worth risking the offline cache).

## UI patterns worth keeping consistent
- Item menus (presets, grid thumbnails, filmstrip, category chips): a small "⋯" button (hover on desktop, always visible on touch), press and hold (550 ms) on touch, and right-click on desktop. Destructive actions (delete preset or LUT, remove photo) always ask first.
- Presets replace each other: `revertPrevious()` in `src/ui/presets-panel.js` undoes what the last preset changed before the next one applies, so a color preset never inherits B&W leftovers.
- The presets panel is one list: search, Save and a "⋯" menu (imports, exports) on top, then collapsible categories on desktop (your own presets first, then Looks (the built-in Fujifilm-style ones, which keep exposure and white balance), then LUTs); on phones the categories are chips (wrapping) and the tiles a wrapping grid, so the sheet only scrolls up and down. It lists the looks and synced presets even with no photo open (previews need a photo). Profiles (Standard, Camera Matching, ...) live in their own Profiles tab (between Presets and Info, in the rail and on the phone dock), RAW files only, with a preview of each on the photo; looks and LUTs live only in the presets panel. The thumbnail renderer needs the RAW flag, camera and camera fit in the state it is given, or RAW previews come out without the base curve.
- On iOS the file pickers for presets and LUTs must not set `accept` (iOS greys out .xmp, .lrtemplate, .cube).
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
