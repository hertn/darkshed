# Changelog

## 0.9.7
- Fixed saving a preset not keeping all settings: exposure, white balance (Temp, Tint), sharpening, noise reduction and the Optics settings are now saved too. Presets saved before this are missing them: save them again to include them.

## 0.9.6
- Preset Amount slider now runs 0-100 (100 = the full preset, 0 = as if it was never applied, everything in between is a smooth blend). The old 0-200 range could overshoot.
- Fixed Amount turning a preset off below 50 and on above it: curves with a different number of points now blend smoothly. (B&W is still an on/off switch and flips at 50.)
- Fixed RAW photos going very green or blue in the middle of the Amount slider when a preset changes white balance.
- The backslash key shows the "before" only while it is held; letting go returns to the edit.

## 0.9.5
- Hasselblad 3FR and FFF raw files are accepted by the pickers and drag and drop.

## 0.9.4
- Detail and Effects groups are always open; before/after keeps the profile; stronger preview sharpening and noise reduction; Alt-drag on the Masking slider shows the sharpening mask.
