import type { FaceEffectInstance } from "../project/types.ts";

export const FACE_EFFECT_CATEGORIES = ["face"] as const;
export type FaceEffectCategory = (typeof FACE_EFFECT_CATEGORIES)[number];
export type FaceEffectsProviderId = "banuba" | "deepar";

export interface FaceEffectMorph {
  mouthSize?: number;
  smile?: number;
  lipSize?: number;
  eyeSize?: number;
  eyeSpacing?: number;
  noseWidth?: number;
  faceWidth?: number;
  faceLength?: number;
  jaw?: number;
  chin?: number;
  cheeks?: number;
}

export interface FaceEffectPreset {
  id: string;
  name: string;
  category: FaceEffectCategory;
  thumbnail?: string;
  /** Logical asset keys, resolved by host configuration to licensed vendor effect files. Keeping URLs
   * out of the catalog prevents accidental publication of licensed assets and lets each VCut target
   * use its correctly licensed package. */
  providerEffects: Partial<Record<FaceEffectsProviderId, { assetKey: string }>>;
  morph?: FaceEffectMorph;
  defaultIntensity: number;
  tags: string[];
  featured?: boolean;
  trending?: boolean;
  isNew?: boolean;
  sortOrder: number;
}

const MORPH_KEYS: (keyof FaceEffectMorph)[] = [
  "mouthSize", "smile", "lipSize", "eyeSize", "eyeSpacing", "noseWidth",
  "faceWidth", "faceLength", "jaw", "chin", "cheeks",
];

/** Throws at startup/test time for an invalid catalog entry. Vendor rendering code never owns preset
 * validation, so adding a definition cannot smuggle malformed intensity/morph data into a provider. */
export function validateFaceEffectPreset(preset: FaceEffectPreset): FaceEffectPreset {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(preset.id)) throw new Error(`Invalid Face Effect id: ${preset.id}`);
  if (!preset.name.trim()) throw new Error(`Face Effect ${preset.id} needs a name`);
  if (!FACE_EFFECT_CATEGORIES.includes(preset.category)) throw new Error(`Invalid Face Effect category: ${preset.category}`);
  if (!Number.isFinite(preset.defaultIntensity) || preset.defaultIntensity < 0 || preset.defaultIntensity > 1) {
    throw new Error(`Face Effect ${preset.id} defaultIntensity must be between 0 and 1`);
  }
  if (!Number.isInteger(preset.sortOrder) || preset.sortOrder < 0) throw new Error(`Face Effect ${preset.id} needs a non-negative sortOrder`);
  if (Object.keys(preset.providerEffects).length === 0) throw new Error(`Face Effect ${preset.id} needs at least one provider asset`);
  for (const [provider, ref] of Object.entries(preset.providerEffects)) {
    if (provider !== "banuba" && provider !== "deepar") throw new Error(`Unknown Face Effects provider: ${provider}`);
    if (!ref?.assetKey.trim()) throw new Error(`Face Effect ${preset.id} has an empty ${provider} asset key`);
  }
  for (const key of MORPH_KEYS) {
    const value = preset.morph?.[key];
    if (value !== undefined && (!Number.isFinite(value) || value < -1 || value > 1)) {
      throw new Error(`Face Effect ${preset.id} morph.${key} must be between -1 and 1`);
    }
  }
  return preset;
}

/** A preset enters this catalog only after a real provider asset and matching export path are
 * verified. There are none in the repository yet; presenting Big Mouth as available now would
 * promise an effect VCut cannot render. */
export const FACE_EFFECT_PRESETS: readonly FaceEffectPreset[] = Object.freeze([]);

export function faceEffectPresetById(id: string, presets: readonly FaceEffectPreset[] = FACE_EFFECT_PRESETS): FaceEffectPreset | undefined {
  return presets.find((preset) => preset.id === id);
}

export function activeFaceEffects(effects: readonly FaceEffectInstance[] | undefined): FaceEffectInstance[] {
  return (effects ?? []).filter((effect) => effect.enabled !== false && effect.intensity > 0);
}

export function newFaceEffectInstance(preset: FaceEffectPreset, id: string): FaceEffectInstance {
  if (!id) throw new Error("Face Effect instance id is required");
  return { id, presetId: preset.id, intensity: preset.defaultIntensity, target: { kind: "all" } };
}
