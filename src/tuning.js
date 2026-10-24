// How strongly the sliders act, fitted so that a Lightroom value gives the same look here: +10 temperature, -31 highlights or
// 40 shadow saturation on a photo should look like the same numbers in Lightroom. The shader and the white balance solver read these.
export const TUNE = {
  wbKt: [1.435, 0.142, 0.076, 0.033, 1.212, 0.054, -0.019, -0.007, 0.977], // colour change at temperature +25 (rows: red, green, blue out)
  wbKn: [1.022, 0.058, 0.003, 0.0, 0.988, 0.0, 0.014, 0.018, 1.085],      // colour change at tint +20
  hlK: 0.49,      // stops of highlight pull at -100
  hlLo: 0.54,    // brightness (0..1) where the highlights slider starts to act
  grdK: 0.43,    // colour grading strength
  exK: 1.03,      // exposure: stops per unit
  ctK: 0.55,      // contrast strength
  shK: 2.35,      // stops of shadow lift at +100
  shHi: 0.50,     // brightness (0..1) where the shadows slider stops acting
  shLift: 0.015, // extra linear lift for the deepest shadows
  whK: 0.23,      // whites: how far the white point moves at +100
  blK: 0.17,     // blacks: how far the black point moves at +100
  vbK: 0.91,     // vibrance strength
  saK: 1.0,      // saturation strength
  hsC: [-18.5, 35, 43.6, 124.7, 170.9, 201, 306.8, 324.8], // hue centre of each HSL band
  hsH: 45.0,       // degrees of hue shift at 100
  hsS: 0.76,      // HSL saturation strength
  hsL: 0.33,      // HSL luminance strength
  hsM: 0.05,        // 0 = triangular band windows, 1 = smooth
  msK: 0.44,     // shadows / highlights react to the brightest channel (1) or to luma (0)
  wbL: 0.0,      // white balance keeps luminance constant (1) or not (0)
  wbS: 0.0,      // white balance gains roll off into the highlights (1) or clip (0)
  gdL: 0.19,     // grading luminance strength
  gdA: 4.0,      // grading zone falloff at blending 0
  gdB: 1.0,     // grading zone falloff at blending 100
  gdF: 0.0,      // grading tint fades out towards pure black and white over this brightness range
  wbF: 0.4,      // white balance fades out towards the highlights by this much
  wbA: 0.56,     // ... starting at this brightness
  satLin: 1.0,   // vibrance / saturation work in linear light (1) or on the encoded values (0)
  hlTop: 0.998,  // brightness where the highlights slider fades out again (white stays white)
};
// (fitted on one preset and photo against Lightroom's own export; DarkShed's built-in looks were rescaled to keep their appearance)
