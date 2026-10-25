# DarkShed

<img src="public/icon-192.png" width="96" align="right" alt="DarkShed logo">

*A darkroom, but in a shed.*

A free, Lightroom-style **RAW + JPEG photo editor** that runs in your browser on Mac, Windows, Linux, iPad and iPhone. You run it yourself, on your own computer or a home server, and your presets sync between all your devices.

**Private by design:** editing happens on your own device (RAW decoding with LibRaw/WebAssembly, rendering on the GPU). Photos are never uploaded, not even to your own server.

*Why it exists:* Lightroom costs money, and the other vibe-coded "Lightroom killers" were desktop-only or tied to specific hardware. DarkShed is one web app that works on whatever you own.

> **Status: beta (0.9).** Tested on desktop browsers and on an iPhone 16 Pro. Expect rough edges.

---

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/edit.png" alt="Editing a photo: Light and Color sliders, histogram and filmstrip"><br><sub><b>Edit.</b> Sliders, histogram and filmstrip.</sub></td>
    <td width="50%"><img src="docs/screenshots/masks.png" alt="A radial mask with its own adjustments"><br><sub><b>Masks.</b> Radial, linear, brush and range masks.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/presets.png" alt="Presets: built-in looks, your own presets and LUTs, each previewed on the photo"><br><sub><b>Presets.</b> Built-in looks, imported presets and LUTs, previewed on your photo.</sub></td>
    <td width="50%"><img src="docs/screenshots/grid.png" alt="Grid view for culling, with ratings and flags"><br><sub><b>Grid.</b> Culling with ratings and flags.</sub></td>
  </tr>
</table>

The same app on a phone, with a layout built for touch:

<table>
  <tr>
    <td width="25%"><img src="docs/screenshots/phone-edit.png" alt="Phone: editing with the tool dock at the bottom"><br><sub><b>Edit</b></sub></td>
    <td width="25%"><img src="docs/screenshots/phone-color.png" alt="Phone: Color panel"><br><sub><b>Color</b></sub></td>
    <td width="25%"><img src="docs/screenshots/phone-presets.png" alt="Phone: presets and looks"><br><sub><b>Presets</b></sub></td>
    <td width="25%"><img src="docs/screenshots/phone-grid.png" alt="Phone: grid view for culling"><br><sub><b>Grid</b></sub></td>
  </tr>
</table>

*Photos by [Hert Niks](https://www.pexels.com/@hert/) on Pexels.*

---

## Features

- **Editing:** light, curves, color (white balance, HSL, color grading), effects, detail, optics, B&W and calibration, plus crop, spot healing and masks (linear, radial, brush and range).
- **RAW and more:** Fujifilm RAF, DNG, CR2/3, NEF, ARW and others, plus JPEG, PNG and HEIC. RAW files get camera-style profiles, including one that copies the look of the JPEG your camera stored in the file.
- **Presets and LUTs:** import Lightroom presets (`.xmp`, `.lrtemplate`, `.zip`) and `.cube` LUTs, export your own as `.xmp`. A few Fujifilm-inspired looks are built in.
- **Library:** a filmstrip and a grid for culling, with ratings, flags and filters.
- **Export:** JPEG, PNG, WebP or 16-bit TIFF, with resize, output sharpening, sRGB or Display P3, and batch export as a ZIP.
- **Safety net:** undo and redo, autosave, and recovery copies of your open photos kept on the device.
- **Built for desktop and touch:** one-key tool shortcuts on desktop (**Menu → Keyboard shortcuts**), and a separate layout made for phones.

The Fujifilm-style looks are approximations built from the sliders, not Fujifilm's own film simulations. RAW rendering and the sliders are tuned to resemble Lightroom, but they are not an exact match.

## Install

<table><tr><td>

<details>
<summary><b>💻&nbsp; On your own computer</b>: Mac, Windows or Linux. The easiest way, nothing else to install.</summary>

<br>

**1. Download the file for your computer** from the [Releases page](https://github.com/hertn/darkshed/releases/latest). Scroll to **Assets** and pick the right one (ignore the "Source code" files):

| Your computer | Download |
|---|---|
| Mac with an Apple chip (M1, M2, M3, M4 and later) | `DarkShed-…-mac-apple-silicon.zip` |
| Mac with an Intel chip | `DarkShed-…-mac-intel.zip` |
| Windows (64-bit) | `DarkShed-…-windows.zip` |
| Linux (Intel or AMD) | `DarkShed-…-linux-intel-amd.tar.gz` |
| Linux (ARM, for example a Raspberry Pi) | `DarkShed-…-linux-arm.tar.gz` |

Not sure which Mac you have? Click the Apple menu, then **About This Mac**. It says "Chip: Apple M…" or "Processor: Intel".

**2. Unzip it** (on Windows: right-click the zip, **Extract All**), move the `DarkShed` folder somewhere permanent such as Documents (not Downloads), and open **READ ME FIRST.txt** in it. It is short and walks you through your system.

**3. Start it.** Double-click **Start DarkShed**. A window with text opens (that is normal, leave it open) and your browser opens DarkShed. The window also shows the address to use on your phone or tablet (same Wi-Fi). Your computer may ask once to allow network connections: click **Allow**.

The files are not code-signed, so Mac and Windows show a one-time warning the first time. The READ ME has the exact steps for your system. On a recent Mac, you open **System Settings → Privacy & Security** and click **Open Anyway**.

**Good to know**

- Presets and LUTs are saved in the `data` folder next to the app. Every device that opens DarkShed from the same address shares them. Photos and settings stay on each device.
- On your computer, open the network address that the window shows (it starts with `http://192.168…`), not `localhost`, so the computer and the phone share presets.
- **Run in background** (optional) starts DarkShed by itself when you log in, with no window, so your phone can use it without an open window on your computer. The computer has to be awake. It can ask you for a sync password. **Stop running in background** undoes it.
- **Update:** download the new version, copy your old `data` folder into it, then delete the old folder. If you use background mode, run **Stop running in background** in the old folder first and **Run in background** in the new one.
- **Uninstall:** run **Stop running in background** if you used it, then delete the folder. Copy the `data` folder first if you want to keep your presets.

</details>

</td></tr></table>

<table><tr><td>

<details>
<summary><b>🐳&nbsp; On a home server</b>: with Docker.</summary>

<br>

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

Go to `http://<your-server-ip>:8080` in a browser. Your presets are saved in the `data` folder next to the compose file.

**Things you might need to change in `docker-compose.yml`:**

| What | How |
|---|---|
| Port 8080 is already used | Change the left number in `ports: ["8080:8080"]`, for example `"8082:8080"` |
| Require a password for syncing | Set `DARKSHED_TOKEN` to any secret, then enter it in **Menu → Sync & settings** |
| Fedora / RHEL (SELinux) | Already handled (`:z` on the data folder) |
| Automatic updates | Already included: the bundled Watchtower checks hourly. Delete the `watchtower` block if you already run Watchtower or prefer to update by hand |

**Update by hand:** `docker compose pull && docker compose up -d`

</details>

</td></tr></table>

## Use it on iPhone and iPad

1. Open the address in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open DarkShed from the new icon. It runs full-screen like an app.

Good to know:

- **Add to Home Screen works over plain `http://`** on a home network. For access from outside your home, put it behind HTTPS (for example `tailscale serve --bg 8080`, a Cloudflare tunnel, or a reverse proxy like Caddy). HTTPS is also needed for offline use.
- JPEG exports keep their full size. PNG and WebP exports are limited to about 16 megapixels there (a Safari limit), and 16-bit TIFF is desktop only.
- Open RAW files through the **Files** picker. The Photos picker may hand over a converted JPEG.

## Syncing presets

Sync is automatic when you open the app **from your own DarkShed** (the download on your computer, or a Docker server), and optional: everything also works on a single device without it. Leave **Server URL** empty, and enter a **Token** only if you set a sync password (`DARKSHED_TOKEN` with Docker, or the password asked by **Run in background**).

- **Use the same address on every device.** A different address (for example `localhost`, or a test copy from `npm run dev`) is a separate app with its own presets.
- **When it syncs:** when the app opens, a moment after you change a preset, and when you switch back to the app.
- **Check it:** **Menu → Sync & settings** shows "Connected" or says why it is not syncing.
- Photos and per-photo edits are never sent to the server.

## Development

Needs Node.js 20 or newer.

```bash
npm install
npm run dev      # http://localhost:5173, also reachable from your phone on the same Wi-Fi
npm run build    # production build into dist/
npm start        # serves it with the preset sync server on http://localhost:8080
```

Environment variables for the server: `DARKSHED_PORT` (default 8080), `DARKSHED_DATA` (default `./data`), `DARKSHED_TOKEN` (optional sync password).

Plain JavaScript with no framework. Image processing is WebGL2 shaders; the server (`server/index.mjs`) is one Node file with no dependencies and only stores presets and LUTs.

## Contributing

Forks, bug reports and pull requests are welcome. DarkShed is a hobby project made for personal use, so replies can be slow and I can't promise to merge everything or fix every issue. If you want something different, fork it and make it yours, the license allows that.

- **Found a bug or have an idea?** Open an [issue](https://github.com/hertn/darkshed/issues). A short description and your device (for example "iPhone 16 Pro, iOS 26") helps a lot.
- **Want to change the code?** Fork the repo, make your change, and open a pull request. `CLAUDE.md` has notes on how the project is laid out and how it is tested.

## License and credits

Directed by [Hert Niks](https://github.com/hertn). Built by [Claude](https://claude.com/claude-code) (Anthropic).

MIT, see `LICENSE`. RAW decoding uses [LibRaw](https://www.libraw.org/) (LGPL 2.1 / CDDL 1.0) through [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) (ISC). DarkShed is an independent project, not affiliated with or endorsed by Adobe or Fujifilm. Lightroom, Adobe and Fujifilm are trademarks of their owners.
