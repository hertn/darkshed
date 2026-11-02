# Changelog

## 0.9.15
- Shadows and Highlights on RAW files rebuilt from measurements of Lightroom Classic exports (14 photos, night and daylight, four cameras, each slider exported on its own at several amounts). Like Lightroom, they now adapt to the photo: Shadows works relative to the photo's brightest parts and Highlights relative to its average brightness, so a street lamp in a night shot is pulled down much harder than a bright sky in daylight, and opening the shadows lifts the darkest areas most. Highlights pulled down now darkens bright areas as strongly as Lightroom does (it used to be far too weak), and it works before the tone curve, so detail in bright areas is kept. Highlights + is gentler than - and fades out towards white; Shadows - mirrors +. Measured improvements against Lightroom (average colour difference): night photo, Shadows +100: 11.0 to 4.1; daylight, Shadows +100: 11.3 to 8.4; night, Highlights only: 3.7 to 2.5; 25 / 50 / 100 series: 7.6 to 6.3. One set of 10 night edits that the old settings had been tuned on came out slightly worse (7.6 to 8.0).
- RAW white balance no longer darkens the picture when it moves to cooler / more magenta settings: with it, warm night shots set cooler came out about 3 lightness units darker in the mid-tones than in Lightroom.
- Lifted shadows are a little less colourful, as in Lightroom.

## 0.9.14
- RAW colours are closer to Lightroom: every RAW file now gets DarkShed's own colour table, a gentle hue and saturation correction that depends on the colour and its brightness (for example reds, skin tones and blues come out the way Lightroom renders them). It was fitted by rendering test colour charts in DarkShed and in Lightroom Classic and measuring the difference; it contains no Adobe data. Works for every camera automatically, with a tungsten and a daylight version blended by the photo's light. Measured on 10 real Lightroom edits: the typical colour difference dropped from 6.0 to 5.3 (average 8.2 to 7.6); on the test charts from 5.2-6.6 to 5.0. Camera Matching is unchanged (it fits the camera's own JPEG instead).

## 0.9.13
- Shadows and Highlights now work the way Lightroom's do: how much a spot is lifted or darkened depends on the area around it, not on that one pixel. Detail inside dark or bright areas keeps its contrast instead of going flat, and a lit face in a dark scene gets the same lift as the scene around it. Checked against Lightroom Classic exports of 10 real edits plus single-slider tests: the typical colour difference dropped by about a quarter (median 6.5 to 5.0), better or equal on all but one photo.
- Highlights pulled down (minus) is gentler, matching Lightroom (it used to darken bright areas much more).
- Noise reduction: the Luminance slider now keeps working all the way to 100 (it used to stop doing anything visible past about 20) and also reaches the coarser, blotchy noise of high-ISO photos. Color noise reduction reaches wider colour blotches. Edges stay sharp.
- RAW colour and white balance match Lightroom much more closely: Kelvin and Tint use Lightroom's numbers (a Lightroom preset's own Temperature and Tint now carry over), Fujifilm RAW files get the camera's exposure offset that Lightroom applies, and HSL, Calibration, Contrast, Vignette, Sharpening and the built-in film looks were re-measured against Lightroom Classic.
- Manual lens distortion now bends the right way round (as in Lightroom).
- White balance Temp slider no longer goes haywire: on photos with a strong magenta tint (many night and indoor shots), dragging it warm made the colours jump, flip and snap back. It now changes smoothly all the way, with the same safety limits Lightroom uses. The slider knob also stays under your finger instead of jumping to the nearest 50 K mark.
- Phone: after a reload the open tool's sheet came back empty (except Light) until you switched tools, when solo mode (one section open at a time) was on. Solo mode now only acts on desktop.

## 0.9.12
- Reset (the button and "Reset all edits") now also takes the applied preset off: its tile is no longer outlined, so one click applies it again (it used to take two).
- Delete or Backspace in the editor removes the open photo (it asks first, as in the grid). A selected mask or healing spot is still deleted first.
- Enter confirms a question (Remove, Delete, OK, Export…); Escape still cancels. While a window is open, keys no longer act on the app behind it.
- Highlights reaches further into the lighter tones, and its range widens as you drag: small amounts touch only the brightest parts, -100 / +100 reach well into the mid-tones.

## 0.9.11
- Masks: a Duplicate button (next to Delete mask) copies the selected mask with all its shapes, brush strokes and adjustments. The copy is placed right below the original and selected, ready to change.
- Remove from the menu in the grid now removes every selected photo (it used to remove only the photo open in the editor).
- Healing on dark backgrounds: a healed spot no longer comes out grey (which then showed the grain as white speckles). The colour match around the spot now ignores bright bits at its edge, such as part of what you are removing, instead of averaging them in.

## 0.9.10
- Phone: swiping between photos now follows your finger. Let go past a third of the screen, or with a quick flick, and the photo springs away and the next one springs in; let go earlier and it springs back. At the first and last photo it stretches with Apple's rubber-band curve. The springs keep the speed of your finger, like iOS.
- Phone: double-tapping a slider to reset it now sticks. iPhone Safari sometimes sent a late update from the tap that set the slider back to another value (for example when you pressed Done right after).

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
