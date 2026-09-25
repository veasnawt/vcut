import type { ClipEffects } from "./types.ts";
import { IDENTITY_EFFECTS } from "./types.ts";

/** A quick-apply combination of `ClipEffects`' own existing sliders (brightness/contrast/saturation/
 *  blur) — deliberately NOT a new pixel-level filter type: this app's `ClipEffects` has no notion of
 *  color temperature/tint, grayscale, or sepia, so preset names describe what brightness/contrast/
 *  saturation/blur can actually produce rather than promising a look they can't deliver. `opacity` is
 *  left untouched by every preset — same "independent choice a preset shouldn't silently override"
 *  reasoning `TextStylePreset`'s own doc comment gives for `fontFamily`/`fontSize`/`align`. Applying one
 *  goes through the exact same `SetClipEffectsCommand`/`patchEffects` path a manual slider drag already
 *  does, so the sliders stay fully adjustable afterward — a preset is just a fast starting point, not a
 *  separate mechanism. */
export interface EffectPreset {
  id: string;
  label: string;
  values: Partial<ClipEffects>;
}

/** Blur strengths (sequence pixels, the same unit as the Inspector's Blur slider) for the two presets
 *  that blur. Were 3 and 2 — a real, reported "the blur doesn't work on Dreamy and Soft Focus": measured
 *  directly in the live preview, blur 2 and 3 on a 1080-wide sequence change the frame by an average of
 *  ~0.2 and ~0.6 out of 255 (imperceptible), because the preview used to EXAGGERATE blur 2-3x (it ignored
 *  the canvas's own device scale) and these were tuned against that; once the preview was corrected to
 *  match export (`deviceScaleOf`), they silently became invisible. Both renderers agree now, so these
 *  are picked to be visibly soft at real sequence resolution — still just starting points, fully
 *  adjustable with the slider afterward. */
export const PRESET_BLUR_SOFT = 8;
export const PRESET_BLUR_DREAMY = 6;

export const EFFECT_PRESETS: EffectPreset[] = [
  { id: "vivid", label: "Vivid", values: { brightness: 0.03, contrast: 1.15, saturation: 1.4 } },
  { id: "punchy", label: "Punchy", values: { contrast: 1.3, saturation: 1.3 } },
  { id: "high-contrast", label: "High Contrast", values: { contrast: 1.5, saturation: 1.1 } },
  { id: "muted", label: "Muted", values: { contrast: 0.95, saturation: 0.55 } },
  { id: "faded", label: "Faded", values: { brightness: 0.08, contrast: 0.75, saturation: 0.7 } },
  { id: "moody", label: "Moody", values: { brightness: -0.08, contrast: 1.2, saturation: 0.65 } },
  { id: "bright-airy", label: "Bright & Airy", values: { brightness: 0.15, contrast: 0.95, saturation: 0.9 } },
  { id: "soft-focus", label: "Soft Focus", values: { brightness: 0.05, blur: PRESET_BLUR_SOFT } },
  // Four more, each covering a combination none of the eight above actually reaches: Noir goes far
  // more desaturated than anything else here (the lowest existing saturation, Muted's, is still 0.55);
  // Crisp is the only preset that leaves saturation completely untouched — a pure contrast/brightness
  // lift for footage whose color is already right; Flat is a deliberately gentle contrast pull for a
  // log-like starting point, distinct from Faded's stronger, warmer-reading fade; Dreamy is the only
  // preset combining a soft/bright look WITH blur (Soft Focus has blur but no contrast/brightness
  // pairing, Bright & Airy has the brightness/contrast pairing but no blur).
  { id: "noir", label: "Noir", values: { contrast: 1.3, saturation: 0.15 } },
  { id: "crisp", label: "Crisp", values: { contrast: 1.2, brightness: 0.02 } },
  { id: "flat", label: "Flat", values: { contrast: 0.65, saturation: 0.85 } },
  { id: "dreamy", label: "Dreamy", values: { brightness: 0.12, contrast: 0.85, blur: PRESET_BLUR_DREAMY } },
];

/** The four look fields a preset owns — everything in `ClipEffects` except `opacity`, which is an
 *  independent choice no preset overrides (see `EffectPreset`'s own doc comment). */
export type PresetLook = Pick<ClipEffects, "brightness" | "contrast" | "saturation" | "blur">;

/** What applying `preset` must WRITE: every look field, with anything the preset doesn't mention reset
 *  to its identity value — a preset is a WHOLE look, not a patch. Passing `preset.values` straight to
 *  the "merge onto the clip's current effects" edit path (what the grid used to do) left whatever the
 *  PREVIOUS preset set and this one doesn't: pick Soft Focus (blur), then Vivid (no blur), and the clip
 *  stayed blurred — same for a leftover brightness or contrast. Never includes `opacity`, so it's
 *  preserved. */
export function presetLook(values: Partial<ClipEffects>): PresetLook {
  const resolved = { ...IDENTITY_EFFECTS, ...values };
  return { brightness: resolved.brightness, contrast: resolved.contrast, saturation: resolved.saturation, blur: resolved.blur };
}

/** Whether `current` is exactly this preset's look (opacity ignored — presets never touch it, so a
 *  clip faded to 50% is still "on" whichever preset it has). Full-object equality on the four look
 *  fields, not just the ones the preset happens to set: a hand-tweaked unrelated field means it's no
 *  longer really that preset. */
export function presetMatches(current: ClipEffects, values: Partial<ClipEffects>): boolean {
  const look = presetLook(values);
  return (
    current.brightness === look.brightness && current.contrast === look.contrast && current.saturation === look.saturation && current.blur === look.blur
  );
}
