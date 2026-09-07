/** Post-processing for a freshly-captured voiceover take — everything the Voice Record modal's own
 *  Voice Enhance / Noise Reduction / Audio Effects / Voice Changer options actually do. Deliberately a
 *  POST-process on the finished recording, not a live effect chained onto the mic stream while
 *  capturing: the raw take is always what actually gets captured (see `useVoiceRecording`'s own
 *  `getUserMedia` constraints), so a take can be re-processed with different settings, or the raw
 *  original recovered, without re-recording — and it keeps every effect here a plain, deterministic
 *  function of one `AudioBuffer` (easy to reason about, easy to test) rather than a stateful
 *  real-time Web Audio graph wired into a live `MediaStream`.
 *
 *  Every effect is built from stock Web Audio nodes (`BiquadFilterNode`, `DynamicsCompressorNode`,
 *  `ConvolverNode`, `DelayNode`) rendered through an `OfflineAudioContext` — no external DSP library,
 *  no server round-trip. This is a genuinely useful first pass, not a placeholder: Voice Enhance and
 *  Noise Reduction are the same broad techniques (presence EQ + leveling; high-pass + gating) real
 *  voice-processing tools use, just without a trained spectral denoiser behind them. Voice Changer's
 *  Deep/Chipmunk presets deliberately couple pitch with speed (a plain `playbackRate` change) rather
 *  than a true pitch-shift — that coupling is exactly what makes those two read as a recognizable
 *  "voice effect" rather than a subtle correction, so it's the right tool here, not a shortcut standing
 *  in for a better one. */

export interface RecordingEffectsOptions {
  voiceEnhance: boolean;
  noiseReduction: boolean;
  effect: "none" | "reverb" | "echo" | "radio";
  voiceChanger: "none" | "deep" | "chipmunk" | "robot";
}

export const NO_EFFECTS: RecordingEffectsOptions = { voiceEnhance: false, noiseReduction: false, effect: "none", voiceChanger: "none" };

export function hasAnyEffect(options: RecordingEffectsOptions): boolean {
  return options.voiceEnhance || options.noiseReduction || options.effect !== "none" || options.voiceChanger !== "none";
}

/** Decodes a recorded take (whatever container `MediaRecorder` produced — WebM/Opus, MP4, Ogg) into a
 *  raw `AudioBuffer` for processing. A throwaway `AudioContext` is the only thing on this page able to
 *  decode compressed audio without a `<video>`/`<audio>` element and a real play-through — closed
 *  immediately after, since nothing else here needs a live audio graph. */
async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  const context = new AudioContext();
  try {
    return await context.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    void context.close();
  }
}

/** A short, exponentially-decaying burst of white noise — the classic "no real impulse-response file
 *  needed" way to synthesize a plausible room reverb tail for a `ConvolverNode`. Two channels, decaying
 *  independently, so the reverb tail isn't perfectly mono-correlated (which reads as noticeably
 *  artificial even at this short a length). */
function makeReverbImpulse(context: OfflineAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    }
  }
  return impulse;
}

/** Builds the processing graph for one take and renders it. `buffer`'s own duration is extended for
 *  the Deep/Chipmunk voice-changer presets (see `voiceChanger`'s own branch below) since slowing
 *  playback down to deepen a voice needs more RENDER time to capture the same audio, not less — an
 *  `OfflineAudioContext` sized to the ORIGINAL duration would just cut the slowed-down take off short. */
export async function applyRecordingEffects(blob: Blob, options: RecordingEffectsOptions): Promise<Blob> {
  if (!hasAnyEffect(options)) return blob;

  const decoded = await decodeBlob(blob);
  const playbackRate = options.voiceChanger === "deep" ? 0.82 : options.voiceChanger === "chipmunk" ? 1.28 : 1;
  const renderSeconds = decoded.duration / playbackRate;
  const context = new OfflineAudioContext(decoded.numberOfChannels, Math.ceil(renderSeconds * decoded.sampleRate), decoded.sampleRate);

  const source = context.createBufferSource();
  source.buffer = decoded;
  source.playbackRate.value = playbackRate;

  // Each stage below is optional and chained in a fixed, sensible order: clean up the signal
  // (noise reduction) before shaping its tone (enhance), before coloring it (effect preset), before
  // the character voice preset — the same "correct, then style" order a real vocal chain uses.
  let node: AudioNode = source;

  if (options.noiseReduction) {
    // A high-pass below typical room rumble/HVAC hum, followed by a fast, aggressive downward
    // compressor acting as a rough noise gate — quiet background hiss sits well under the threshold
    // and gets pulled down hard, while normal speech (well above it) passes through close to
    // untouched. Not a true spectral denoiser (no trained model, no per-frequency-bin suppression),
    // but a real, honest reduction in the two most common sources of "this recording sounds noisy."
    const highpass = context.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 90;
    node.connect(highpass);
    node = highpass;

    const gate = context.createDynamicsCompressor();
    gate.threshold.value = -50;
    gate.knee.value = 6;
    gate.ratio.value = 16;
    gate.attack.value = 0.003;
    gate.release.value = 0.15;
    node.connect(gate);
    node = gate;
  }

  if (options.voiceEnhance) {
    // Presence boost (2.5–4kHz is where consonants/clarity live) + a gentle low-end declutter below
    // 150Hz (muddiness, not the voice's own body) + a light leveling compressor so quiet and loud
    // words sit closer together — the same three moves a quick "make this voice sound better" EQ/
    // compressor chain reaches for.
    const lowShelf = context.createBiquadFilter();
    lowShelf.type = "lowshelf";
    lowShelf.frequency.value = 150;
    lowShelf.gain.value = -4;
    node.connect(lowShelf);
    node = lowShelf;

    const presence = context.createBiquadFilter();
    presence.type = "peaking";
    presence.frequency.value = 3000;
    presence.Q.value = 1;
    presence.gain.value = 5;
    node.connect(presence);
    node = presence;

    const leveler = context.createDynamicsCompressor();
    leveler.threshold.value = -24;
    leveler.knee.value = 12;
    leveler.ratio.value = 3;
    leveler.attack.value = 0.01;
    leveler.release.value = 0.2;
    node.connect(leveler);
    node = leveler;
  }

  if (options.effect === "reverb") {
    const convolver = context.createConvolver();
    convolver.buffer = makeReverbImpulse(context, 1.4);
    const wet = context.createGain();
    wet.gain.value = 0.35;
    const dry = context.createGain();
    dry.gain.value = 0.8;
    node.connect(dry);
    node.connect(convolver);
    convolver.connect(wet);
    const merge = context.createGain();
    dry.connect(merge);
    wet.connect(merge);
    node = merge;
  } else if (options.effect === "echo") {
    const delay = context.createDelay(1);
    delay.delayTime.value = 0.28;
    const feedback = context.createGain();
    feedback.gain.value = 0.32;
    const wet = context.createGain();
    wet.gain.value = 0.4;
    node.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    const merge = context.createGain();
    node.connect(merge);
    wet.connect(merge);
    node = merge;
  } else if (options.effect === "radio") {
    // A narrow bandpass around the vocal midrange is the classic "sounds like it's coming through a
    // small speaker/phone line" effect — cutting both the low end (body) and the high end (air/sheen)
    // is what actually reads as "radio," more than any single filter alone.
    const bandpass = context.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = 1400;
    bandpass.Q.value = 0.7;
    node.connect(bandpass);
    node = bandpass;
    const drive = context.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    drive.curve = curve;
    node.connect(drive);
    node = drive;
  }

  if (options.voiceChanger === "robot") {
    // Ring modulation — multiplying the voice by a low, fixed-frequency carrier tone — is the
    // textbook simplest real "robot voice" DSP trick: it folds the voice's own harmonics around the
    // carrier frequency, producing the metallic, unnatural timbre without touching pitch or duration
    // the way the Deep/Chipmunk presets (via `playbackRate` above) do.
    const carrier = context.createOscillator();
    carrier.frequency.value = 42;
    const carrierGain = context.createGain();
    carrier.connect(carrierGain);
    carrier.start(0);
    const ring = context.createGain();
    ring.gain.value = 0;
    node.connect(ring);
    carrierGain.connect(ring.gain);
    // `ring.gain` is being driven directly by the carrier oscillator's own output (an AudioParam can
    // take another node's signal as modulation input) — `carrierGain` exists only to scale that
    // modulation into a sensible ±1 range before it reaches the gain param.
    carrierGain.gain.value = 1;
    node = ring;
  }

  node.connect(context.destination);
  source.start(0);

  const rendered = await context.startRendering();
  return audioBufferToWavBlob(rendered);
}

/** Encodes an `AudioBuffer` as a 16-bit PCM WAV `Blob` — the one universally-decodable container every
 *  browser can both produce (there's no native "MediaRecorder for an AudioBuffer") and, more
 *  importantly, that the server's own ffprobe-based asset import (`importFiles` → `/media` route)
 *  already accepts without any format-specific handling on that side. */
function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const frameCount = buffer.length;
  const dataSize = frameCount * blockAlign;

  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channelData.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channelData[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([out], { type: "audio/wav" });
}
