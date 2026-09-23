# Face Effects integration status

VCut now has the project and provider boundary needed for Face Effects, but no Face Effect is exposed in the editor yet. This is intentional: the repository does not contain a licensed Banuba or DeepAR runtime, a provider credential, or a real Big Mouth effect asset. Showing an effect card before those are available would create a preview-only or fake feature.

## Architecture review

- Filters use `Clip.effects`, color grading, and LUTs. They remain independent of Face Effects.
- Existing Effects use `Clip.pixelEffect` and run in Canvas preview plus an equivalent FFmpeg filter graph.
- Face Effects use an ordered `Clip.faceEffects` stack. It serializes as plain project data, supports multiple future effects and targets, and coexists with Filters and standard Effects.
- `SetClipFaceEffectsCommand` and `setClipFaceEffects` provide undo/redo and locked-track handling.
- `FaceEffectsEngine` owns lazy initialization, provider reuse, no-face handling, user-safe errors, and disposal. It exchanges RGBA frames so browser, native, and hosted export adapters can share one contract.
- Export accepts a provider-processed file through `faceEffectInputPathFor`. It must cover the full original source timeline from zero, preserve video audio, and remain a still image for image clips. VCut then applies trims, reverse, speed, transitions, and compositing. An active Face Effect without that result fails export explicitly, so the effect can never disappear silently.

## Provider investigation

Banuba remains the preferred provider. Its WebAR SDK supports WebAssembly/WebGL, image/video inputs, frame outputs, and processed-video capture. Its native SDKs expose synchronous video processing and video file output. Banuba requires a client token and licensed effect archives/modules. Official references:

- https://docs.banuba.com/far-sdk/
- https://docs.banuba.com/far-sdk/tutorials/development/api_overview/
- https://github.com/Banuba/quickstart-web
- https://www.banuba.com/terms

DeepAR is the fallback. Its Web SDK accepts video elements or RGBA frames and renders to its canvas, but requires a domain-bound license key and a real `.deepar` effect asset. Official references:

- https://docs.deepar.ai/deepar-sdk/platforms/web/getting-started/
- https://docs.deepar.ai/deepar-sdk/deep-ar-sdk-for-web/api-reference/classes/DeepAR.html
- https://docs.deepar.ai/deepar-sdk/filters/

Neither SDK can be represented by VCut's existing FFmpeg-only filters. Preview and export need the same provider effect asset and parameters, with a preprocessing pass before the existing transform/filter/compositing graph. Web/desktop hosted export can run that pass in a controlled browser or vendor-supported offline renderer. Android and iOS need their corresponding licensed native adapters or a verified WebView frame pipeline.

## Required materials

Provide all of the following before the real vertical slice can be completed and shown in Effects:

1. A Banuba commercial/trial client token covering `vcut.io`, local development, Electron/Windows, Android, and iOS, plus the SDK packages permitted by that license.
2. A real Banuba Big Mouth effect archive and every required tracking/module archive, with confirmation that the asset may be bundled or downloaded by VCut. The preset catalog is empty until this asset has been verified in preview and export.
3. Native Banuba licence/configuration for VCut's Android application id and iOS bundle id.
4. Confirmation of the licensed server/headless export approach. If Banuba does not permit or support it, provide equivalent DeepAR web/native keys and a Big Mouth `.deepar` effect asset.

Do not commit credentials or licensed archives to the public repository. They should be supplied through deployment secrets/private artifact storage and mapped into `FaceEffectsProviderConfiguration.effectAssets` by each host.

## Next implementation slice

With those materials available, implement only Big Mouth first:

1. Add the Banuba web adapter and bind its output into preview.
2. Map the VCut 0..1 intensity to the real effect parameter verified in the supplied archive.
3. Build hosted, desktop, Android, and iOS preprocessing adapters that render the trimmed source range and preserve timestamps/audio.
4. Feed the rendered replacement through `faceEffectInputPathFor` and compare preview/export frames.
5. Expose the Face category and Big Mouth card only after the platform adapter reports ready.
6. Verify image, video, pause, seek, trim, save/reopen, undo/redo, no-face behavior, memory cleanup, and export before adding another preset.
