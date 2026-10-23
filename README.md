# DarkShed

<img src="public/icon-192.png" width="96" align="right" alt="DarkShed logo">

*A darkroom, but in a shed.*

A free, Lightroom-style **RAW + JPEG photo editor** that runs in your browser on Mac, iPad and iPhone. You host it yourself, on a home server or any machine that runs Docker.

- **Private:** editing happens on your own device (decoding with LibRaw/WebAssembly, rendering on the GPU). Photos are never uploaded, not even to your server.
- **Synced presets:** your presets and LUTs sync between all your devices through your own server.
- **Made for RAW:** Fujifilm RAF, DNG, CR2/3, NEF, ARW and more, plus JPEG, PNG and HEIC. Imports and exports Lightroom presets.

*Why it exists:* Lightroom costs money, and the other vibe-coded "Lightroom killers" were desktop-only or tied to specific hardware. DarkShed is one web app that works on whatever you own.

> **Status: beta (0.9).** Tested on desktop browsers and on an iPhone 16 Pro. Expect rough edges.

---

## What it does

- **Edit:** Light, Curves, Color (white balance with presets, HSL, color grading), Effects (texture, clarity, dehaze, vignette, grain), Detail (sharpening, noise reduction), Optics (color fringing, distortion), Calibration, B&W, LUTs, profiles.
- **Local tools:** crop and straighten, spot removal (heal and clone), masks (linear, radial, brush, luminance and color range, with add, subtract and intersect).
- **Library:** multiple photos with a filmstrip and a grid for culling (ratings, flags, filters).
- **Presets:** import `.xmp`, `.lrtemplate` and `.zip` packs (with an Amount slider), export as `.xmp`. A few Fujifilm-inspired looks are built in.
- **Export:** JPEG, PNG, WebP or 16-bit TIFF, with resize, output sharpening, sRGB or Display P3, and batch export as a ZIP.
- **Safety net:** undo and redo, autosave, and copies of your open photos kept on the device so work survives an app reload. Stored copies clean themselves up (7 days unused, 1 GB cap by default; changeable in Settings).

The Fujifilm-style looks are approximations built from the sliders, not Fujifilm's own film simulations.

## Install

### With Docker (recommended)

You need a machine with [Docker](https://docs.docker.com/engine/install/) and the Compose plugin.

**1. Download the compose file**

```bash
mkdir darkshed && cd darkshed
curl -O https://raw.githubusercontent.com/hertn/darkshed/main/docker-compose.yml
```

**2. Start it**

```bash
docker compose up -d
```

**3. Open it**

Go to `http://<your-server-ip>:8080` in a browser.

That's it. Your presets are saved in the `data` folder next to the compose file.

**Things you might need to change in `docker-compose.yml`:**

| What | How |
|---|---|
| Port 8080 is already used | Change the left number in `ports: ["8080:8080"]`, for example `"8082:8080"` |
| Require a password for syncing | Set `DARKSHED_TOKEN` to any secret, then enter it in **Menu → Sync & settings** |
| Fedora / RHEL (SELinux) | Already handled (`:z` on the data folder) |
| Automatic updates | Already included: the bundled Watchtower checks hourly. Delete the `watchtower` block if you already run Watchtower or prefer to update by hand |

**Update by hand:** `docker compose pull && docker compose up -d`

### Without Docker

Needs Node.js 20 or newer.

```bash
npm install
npm run build
npm start        # http://localhost:8080
```

Environment variables: `DARKSHED_PORT` (default 8080), `DARKSHED_DATA` (default `./data`), `DARKSHED_TOKEN` (optional sync password).

## Use it on iPhone and iPad

1. Open the address in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open DarkShed from the new icon. It runs full-screen like an app.

Good to know:

- **Add to Home Screen works over plain `http://`** on a home network. For access from outside your home, put it behind HTTPS (for example `tailscale serve --bg 8080`, a Cloudflare tunnel, or a reverse proxy like Caddy). HTTPS is also needed for offline use.
- JPEG exports keep their full size on iPhone and iPad (DarkShed encodes them itself). PNG and WebP exports are limited to about 16 megapixels there (a Safari limit), and 16-bit TIFF is desktop only.
- Open RAW files through the **Files** picker. The Photos picker may hand over a converted JPEG.

## Syncing presets

Sync is automatic when you open the app from your own server, and **optional**: everything also works on a single device without it.

Under **Menu → Sync & settings** you can see the status, enter a token if you set one, or point the app at a different server address. Photos and per-photo edits are never sent to the server.

## Development

```bash
npm install
npm run dev      # http://localhost:5173, also reachable from your phone on the same Wi-Fi
```

Plain JavaScript with no framework. Image processing is WebGL2 shaders; the server (`server/index.mjs`) is one Node file with no dependencies and only stores presets and LUTs.

## License and credits

Directed by [Hert Niks](https://github.com/hertn). Built by [Claude](https://claude.com/claude-code) (Anthropic).

MIT, see `LICENSE`. RAW decoding uses [LibRaw](https://www.libraw.org/) (LGPL 2.1 / CDDL 1.0) through [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) (ISC). DarkShed is an independent project, not affiliated with or endorsed by Adobe or Fujifilm. Lightroom, Adobe and Fujifilm are trademarks of their owners.
