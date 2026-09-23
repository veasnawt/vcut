import type { FaceEffectInstance } from "../project/types.ts";
import {
  activeFaceEffects,
  FACE_EFFECT_PRESETS,
  faceEffectPresetById,
  type FaceEffectPreset,
  type FaceEffectsProviderId,
} from "./faceEffects.ts";

/** Plain RGBA is the common preview/export boundary. A browser adapter can read/write Canvas pixels;
 * a native adapter can bridge its SDK pixel buffer; a hosted exporter can feed decoded frames. */
export interface FaceEffectsFrame {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  timestampSeconds: number;
}

export interface FaceDetection {
  trackingId: string;
  confidence: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface FaceEffectsProviderConfiguration {
  provider: FaceEffectsProviderId;
  /** A Web client token/domain key or a native licence token as required by the selected adapter. */
  credential: string;
  /** Logical catalog asset key to a licensed .zip/.deepar/native effect resource. */
  effectAssets: Record<string, string>;
}

export interface FaceEffectsProvider {
  readonly id: FaceEffectsProviderId;
  initialize(configuration: FaceEffectsProviderConfiguration): Promise<void>;
  detectFaces(frame: FaceEffectsFrame): Promise<FaceDetection[]>;
  applyEffects(frame: FaceEffectsFrame, effects: readonly FaceEffectInstance[], presets: readonly FaceEffectPreset[]): Promise<FaceEffectsFrame>;
  updateEffects(effects: readonly FaceEffectInstance[], presets: readonly FaceEffectPreset[]): Promise<void>;
  dispose(): Promise<void>;
}

export type FaceEffectsProviderFactory = () => Promise<FaceEffectsProvider>;
export type FaceEffectsErrorCode =
  | "missing-configuration"
  | "provider-unavailable"
  | "unsupported-device"
  | "initialization-failed"
  | "missing-effect-asset"
  | "unknown-preset"
  | "no-face"
  | "processing-failed"
  | "disposed";

export class FaceEffectsError extends Error {
  readonly code: FaceEffectsErrorCode;

  constructor(code: FaceEffectsErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "FaceEffectsError";
  }
}

export function faceEffectsUserMessage(error: unknown): string {
  if (!(error instanceof FaceEffectsError)) return "VCut couldn't apply that Face Effect. Try again.";
  switch (error.code) {
    case "no-face": return "VCut couldn't find a face in this frame. Try another clip or frame.";
    case "unsupported-device": return "Face Effects aren't supported on this device.";
    case "missing-configuration":
    case "provider-unavailable":
    case "missing-effect-asset": return "Face Effects aren't available right now.";
    default: return "VCut couldn't apply that Face Effect. Try again.";
  }
}

export function validateFaceEffectsConfiguration(
  configuration: FaceEffectsProviderConfiguration | null | undefined,
  effects: readonly FaceEffectInstance[],
  presets: readonly FaceEffectPreset[] = FACE_EFFECT_PRESETS
): FaceEffectsProviderConfiguration {
  if (!configuration?.credential.trim()) {
    throw new FaceEffectsError("missing-configuration", "Face Effects provider credentials are not configured");
  }
  for (const effect of activeFaceEffects(effects)) {
    const preset = faceEffectPresetById(effect.presetId, presets);
    if (!preset) throw new FaceEffectsError("unknown-preset", `Unknown Face Effect preset: ${effect.presetId}`);
    const assetKey = preset.providerEffects[configuration.provider]?.assetKey;
    if (!assetKey || !configuration.effectAssets[assetKey]?.trim()) {
      throw new FaceEffectsError("missing-effect-asset", `Missing ${configuration.provider} asset for ${effect.presetId}`);
    }
  }
  return configuration;
}

/** Owns one lazily-created provider. It intentionally has no global singleton: an editor/project host
 * owns an engine and disposes it on unmount/project switch, making WASM/WebGL cleanup testable. */
export class FaceEffectsEngine {
  private provider: FaceEffectsProvider | null = null;
  private initializing: Promise<FaceEffectsProvider> | null = null;
  private disposed = false;
  private factory: FaceEffectsProviderFactory | null;
  private configuration: FaceEffectsProviderConfiguration | null;
  private presets: readonly FaceEffectPreset[];

  constructor(
    factory: FaceEffectsProviderFactory | null,
    configuration: FaceEffectsProviderConfiguration | null,
    presets: readonly FaceEffectPreset[] = FACE_EFFECT_PRESETS
  ) {
    this.factory = factory;
    this.configuration = configuration;
    this.presets = presets;
  }

  private async ready(effects: readonly FaceEffectInstance[]): Promise<FaceEffectsProvider> {
    if (this.disposed) throw new FaceEffectsError("disposed", "Face Effects engine has been disposed");
    const configuration = validateFaceEffectsConfiguration(this.configuration, effects, this.presets);
    if (this.provider) return this.provider;
    if (!this.factory) throw new FaceEffectsError("provider-unavailable", "No Face Effects provider adapter is installed");
    if (!this.initializing) {
      this.initializing = this.factory().then(async (provider) => {
        if (provider.id !== configuration.provider) {
          await provider.dispose();
          throw new FaceEffectsError("provider-unavailable", `Configured ${configuration.provider}, received ${provider.id}`);
        }
        try {
          await provider.initialize(configuration);
        } catch (cause) {
          await provider.dispose().catch(() => undefined);
          throw new FaceEffectsError("initialization-failed", "Face Effects provider could not initialize", { cause });
        }
        if (this.disposed) {
          await provider.dispose();
          throw new FaceEffectsError("disposed", "Face Effects engine has been disposed");
        }
        this.provider = provider;
        return provider;
      }).finally(() => { this.initializing = null; });
    }
    return this.initializing;
  }

  async apply(frame: FaceEffectsFrame, effects: readonly FaceEffectInstance[]): Promise<FaceEffectsFrame> {
    const active = activeFaceEffects(effects);
    if (active.length === 0) return frame;
    const provider = await this.ready(active);
    const presets = active.map((effect) => faceEffectPresetById(effect.presetId, this.presets)!);
    let faces: FaceDetection[];
    try {
      faces = await provider.detectFaces(frame);
    } catch (cause) {
      throw new FaceEffectsError("processing-failed", "Face detection failed", { cause });
    }
    if (faces.length === 0) throw new FaceEffectsError("no-face", "No face detected");
    try {
      await provider.updateEffects(active, presets);
      return await provider.applyEffects(frame, active, presets);
    } catch (cause) {
      throw new FaceEffectsError("processing-failed", "Face Effect processing failed", { cause });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.initializing;
    if (pending) await pending.catch(() => undefined);
    const provider = this.provider;
    this.provider = null;
    if (provider) await provider.dispose();
  }
}
