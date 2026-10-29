# Changelog

## 0.9.9
- New look: an Apple-style design pass over the whole interface (styles only, no change to editing, RAW or sync).
- Controls react the instant you press them and ease back smoothly; slider knobs grow under your finger. Tiles, presets, the dock and the tool rail get the same press feedback.
- Menus, dialogs, the toast, the floating toolbar and the panel header are now translucent glass. Menus grow out of the button that opened them, and dialogs blur and dim the app behind them. The area around the photo stays solid black.
- Cleaner type and separators: system font with tighter spacing, hairline lines instead of black rules, sentence-case group titles, segmented tabs with a lifted thumb.
- A new empty screen, and clearer red selection outlines on thumbnails.
- Respects the system settings for reduced motion, reduced transparency and increased contrast. Keyboard focus is now clearly visible.

## 0.9.8
- Export from the grid now exports the photos selected in the grid (it used to export the photo still open in the editor).
- Phone: a Select button in the grid lets you tick several photos by tapping, for Export selected. Ticks show as a round checkmark; tapping a ticked photo unticks it.
- Selected photos have a red border in the grid and the filmstrip (the open photo also gets a thin white inner line).
- Phone: swipe left or right on a photo that fits the screen to go to the next or previous photo, with a slide animation (and a small nudge at the first and last photo).
- The Reset button (back to how the photo looked on import) is now in the top bar next to Undo on every screen size, not only on phones.
- Sliders: while you hold one, the thumb grows and the label and value turn red, so you can tell you grabbed it.

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
