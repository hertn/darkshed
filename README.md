# DarkShed

<img src="public/icon-192.png" width="96" align="right" alt="DarkShed logo">

*A darkroom, but in a shed.* A free, Lightroom-style RAW + JPEG editor that runs in your browser, on your own machine, on Mac, iPad and iPhone.

**Why it exists:** Lightroom costs money, and the other vibe-coded "Lightroom killers" were desktop-only or tied to specific hardware. DarkShed is one web app that works on whatever you own.

A Lightroom-style RAW + JPEG editor that runs entirely in the browser. Decoding (LibRaw / WASM) and all editing (WebGL2) happen on your own device, so it uses your Mac's, iPad's or iPhone's GPU. The server only stores your **presets and LUTs**. It never sees a photo.

## Run it

```bash
npm install
npm run build
npm start                   # http://localhost:8080
```

Environment variables: `DARKSHED_PORT` (8080), `DARKSHED_DATA` (`./data`), `DARKSHED_TOKEN` (optional shared secret for the sync API).

Docker (easiest): download `docker-compose.yml` from this repo, then run
```bash
docker compose pull
docker compose up -d
```
The image comes from `ghcr.io/hertn/darkshed` and is rebuilt automatically on every change. Presets and LUTs live in `./data`. Updates are automatic: the bundled Watchtower container checks for a new image every hour and restarts DarkShed with it (delete the `watchtower` block in the compose file to turn this off, then update by hand with the same two commands).

Put it behind HTTPS (a reverse proxy, Tailscale serve, Cloudflare tunnel…): service workers, "Add to Home Screen" and the iOS share sheet need a secure context.

On iPhone / iPad: open the site in Safari → Share → **Add to Home Screen**. It then runs full-screen and works offline after the first load.

Development: `npm run dev`.

## What it does

- RAW (RAF, DNG, CR2/3, NEF, ARW…) and JPEG / PNG / HEIC editing, multiple photos with a filmstrip and a grid / cull view (ratings, pick / reject flags, filters, sorting).
- Edit panel: Light, Curves, Color (white balance with presets for RAW, HSL, color grading), Effects (texture, clarity, dehaze, vignette, grain), Detail (sharpening, noise reduction), Optics (color fringing, distortion, vignetting), B&W, LUTs, Profile dropdown.
- Crop / straighten / rotate / flip, spot removal (heal / clone), masks (linear, radial, brush, luminance range, color range, combined with add / subtract / intersect, local adjustments incl. texture / clarity / dehaze / sharpness).
- **Lightroom presets:** import `.xmp`, `.lrtemplate` and `.zip` preset packs (settings apply like Lightroom, with an Amount slider), export presets as `.xmp`.
- Undo / redo, auto-saved edits (per photo, in the browser), copy / paste settings, before / after.
- Full-resolution export: JPEG / PNG / WebP / 16-bit TIFF, resize, output sharpening, sRGB or Display P3 (RAW), EXIF kept, export presets, batch export as ZIP.
- Presets and LUTs sync through the server.

## Notes

- Edits are keyed by file name + size + modified time and stored in the browser's IndexedDB.
- On iOS, exports are capped at ~16 MP (Safari's canvas limit). Pick RAFs through the **Files** picker; the Photos picker may hand over a converted JPEG.
- The built-in Fujifilm-style looks are approximations built from the sliders, not Fujifilm's own film simulations.

## License and credits

Directed by [Hert Niks](https://github.com/hertn). Built by [Claude](https://claude.com/claude-code) (Anthropic).

MIT, see `LICENSE`. RAW decoding uses [LibRaw](https://www.libraw.org/) (LGPL 2.1 / CDDL 1.0) through [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) (ISC). DarkShed is an independent project, not affiliated with or endorsed by Adobe or Fujifilm. Lightroom, Adobe and Fujifilm are trademarks of their owners.
