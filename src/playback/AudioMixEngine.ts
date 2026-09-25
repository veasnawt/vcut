import type { Clip } from "../project/types.ts";
import { detectRealSeek, lruEvictByBytes, shouldStreamInsteadOfDecode } from "./audioScheduling.ts";
import { unlockPlaybackAudio } from "./playbackUnlock.ts";
import { holdMediaAtEnd } from "./mediaEnd.ts";

/** Same shape `PlaybackEngine.activeAudioClips` already returns — declared here (not imported from
 *  there) to avoid a circular import; `PlaybackEngine` composes an `AudioMixEngine` instance, not the
 *  other way around. */
export interface ActiveAudioTrackClip {
  /** Which track this clip is playing on — needed to route its own `GainNode` through the right
   *  shared per-track node (see `trackGainNodes`), not folded into `gain` itself: track gain is
   *  applied downstream by that shared node, not baked into this per-clip scalar. */
  trackId: string;
  clip: Clip;
  sourceTime: number;
  gain: number;
  /** Where in the source this clip's audio should stop — `clip.sourceOut` unless it keeps playing past
   *  its out-point into a transition blend (see `transitionTailExtension`). */
  sourceEnd?: number;
}

/** How far an already-scheduled audio-track clip's expected position may drift from where it actually
 *  is before it's treated as a genuine scrub/jump and restarted — see `detectRealSeek`'s own doc
 *  comment. Deliberately generous: an `AudioBufferSourceNode` has no per-frame polling loop to misfire
 *  the way the old element-based sync did, so this only ever needs to catch a REAL discontinuity, not
 *  routine clock noise. */
const SEEK_DETECTION_TOLERANCE = 0.15;
/** Time constant for `AudioParam.setTargetAtTime`'s exponential approach — used everywhere a gain
 *  value is set from a freshly-computed per-tick target (video-clip gain, audio-track clip gain),
 *  instead of a bare `.value =` assignment, specifically to avoid "zipper noise": an abrupt sample-to-
 *  sample jump in a control signal is audible as a soft click/buzz on some hardware even when the
 *  underlying VALUE change is small and intentional (a gain slider being dragged, a transition ramp
 *  advancing frame to frame). ~15ms is fast enough that a real fade still tracks its target closely,
 *  slow enough to smooth out the graininess of only updating once per animation frame. */
const GAIN_SMOOTHING_TIME_CONSTANT = 0.015;
/** How long `duckAroundSeek`'s silence ramp takes — see its own doc comment for why this exists at
 *  all. Short enough to read as a quick dip, not a dropout of its own. */
const DUCK_RAMP_SECONDS = 0.015;
/** Decoded `AudioBuffer`s kept resident at once. A stereo 48kHz buffer is roughly 370KB per second of
 *  audio — this bounds memory for a project with several multi-minute music beds without needing to
 *  track raw byte counts; tune-able if real projects prove it too small/large. */
const BUFFER_CACHE_LIMIT = 12;

/** How many bytes of decoded audio may stay resident. Scales with the device (`navigator.deviceMemory`, in GB,
 *  where the browser reports it — Chromium only) so a low-memory phone gets a small budget; clamped so even a big
 *  machine doesn't hoard. The count limit above still applies too. */
function decodedBufferBudgetBytes(): number {
  const deviceMemoryGb = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const MB = 1024 * 1024;
  if (!deviceMemoryGb) return 192 * MB;
  return Math.min(512 * MB, Math.max(96 * MB, deviceMemoryGb * 48 * MB));
}

/** A single track whose decoded size would exceed this is never decoded into memory: it plays through an
 *  `<audio>` element, which streams from the file. ~200MB is about 8.7 minutes of stereo 48kHz — a normal song
 *  decodes as before, a podcast-length or hour-long file (up to ~1.4GB decoded) no longer can take the tab down. */
const STREAM_INSTEAD_OF_DECODE_BYTES = 200 * 1024 * 1024;

interface TrackClipNode {
  /** The asset this node plays from — lets the buffer cache spare it from eviction while it's sounding. */
  assetId?: string;
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  /** Downstream of `gainNode`, upstream of the shared per-track chain (or `masterGain` directly for
   *  the retimed/reversed video-audio path, which reuses this same interface) — see `Clip.pan`'s own
   *  doc comment for why this sits at the CLIP level, one below the track's own `StereoPannerNode`. */
  panNode: StereoPannerNode;
  contextTimeAtStart: number;
  sourceTimeAtStart: number;
}

interface VideoClipNode {
  mediaSource: MediaElementAudioSourceNode;
  gainNode: GainNode;
  /** `TrackClipNode.panNode`'s own counterpart for a forward-playing video clip's embedded audio. */
  panNode: StereoPannerNode;
}

/** Owns the entire Web Audio mixing graph for the live preview — see this feature's own plan
 *  (`Web Audio Mixing Engine for VCut Live Preview`) for the full rationale. Two categories of
 *  audio, handled differently on purpose:
 *
 *  - **Audio-track clips** (no picture, unconstrained): `AudioBufferSourceNode`s scheduled against
 *    `audioContext.currentTime` — a sample-accurate hardware clock. This is what actually eliminates
 *    the click at its root: there is no `currentTime`-seeking, no per-frame drift-polling loop to
 *    misfire the way the old element-based `syncMedia` did for these clips. Buffers are decoded once
 *    per ASSET (not per clip), shared across every clip referencing it.
 *  - **Video-track clips' own embedded audio** (constrained — the SAME `<video>` element must stay the
 *    picture source `PlaybackEngine.drawTransformed` draws from): `createMediaElementSource` routes
 *    that element's audio output through a dedicated `GainNode` instead of `element.volume`. The
 *    element still needs `PlaybackEngine.syncMedia`'s existing currentTime/playbackRate correction for
 *    its PICTURE, so this category is NOT fully immune to the original click — see `duckAroundSeek`'s
 *    own doc comment for the mitigation this enables (new, but a mitigation, not a structural fix).
 *
 *  Every method here assumes it's only ever called from `PlaybackEngine`'s own per-frame `tick()` (or
 *  its teardown path) — it has no clock/loop of its own beyond the `AudioContext`'s own scheduling. */
interface BufferInfo {
  status: "pending" | "decoded" | "failed";
  startedAt: number;
  url: string;
  attempts: number;
  /** When the (last) attempt's response headers arrived, relative to `startedAt`. */
  headersMs?: number;
  httpStatus?: number;
  bytes?: number;
  decodeMs?: number;
  duration?: number;
  error?: string;
}

/** An audio-track clip played through an `<audio>` element instead of a decoded buffer — see
 *  `elementFallbackAssets`. Routed into the same per-track chain as a buffer source, so track/master
 *  gain, pan and metering all still apply. */
interface ElementClipNode {
  assetId: string;
  trackId: string;
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gainNode: GainNode;
  /** `TrackClipNode.panNode`'s own counterpart for the `<audio>`-element fallback path. */
  panNode: StereoPannerNode;
  playPending: boolean;
  /** Set only for a `play()` refused by autoplay policy (`NotAllowedError`) — nothing short of a new
   *  gesture changes that answer, so `syncElementClip` stops retrying until the next Play tap. */
  playError?: string;
  /** Any other rejected `play()` (seen on iOS: `AbortError`, the element still loading when started) is
   *  retried from `syncElementClip` once this time has passed. */
  retryPlayAt?: number;
  lastPlayError?: string;
  playAttempts: number;
  seeks: number;
}

/** How soon a `play()` that failed for a reason other than autoplay policy is tried again. */
const ELEMENT_PLAY_RETRY_MS = 250;

/** How far an `<audio>`-element clip may drift from the transport before it's re-seeked. Looser than
 *  the buffer path's own seek detection: an element's clock drifts a little on its own, and a seek on
 *  a streaming element is audible, so small drift is left alone. */
const ELEMENT_DRIFT_TOLERANCE = 0.5;

/** How long after a failed DOWNLOAD (not decode) an audio file may be fetched again. A failure used to
 *  clear the cache and refetch on the very next animation frame — every frame, for as long as playback
 *  sat over the clip. */
const BUFFER_RETRY_DELAY_MS = 5000;

/** How long an audio file's request may go without response headers before it's abandoned and retried
 *  once. On an iPhone, an extracted audio clip's request was seen still waiting for headers three
 *  seconds into playback, never reaching the server at all, leaving the clip silent. Headers only —
 *  the body of a long file on a slow connection legitimately takes longer. */
const AUDIO_FETCH_HEADERS_TIMEOUT_MS = 8000;

/** The browser's own Resource Timing record for a URL (compared without its `token` param), rounded —
 *  whether the request went out, when its first byte came back, how much arrived and over what
 *  protocol. `null` while the request hasn't finished (no entry exists yet) or when none was kept. */
function resourceTimingFor(url: string): Record<string, unknown> | null {
  if (typeof performance === "undefined" || typeof location === "undefined") return null;
  const strip = (value: string) => value.replace(/([?&])token=[^&]*&?/, "$1").replace(/[?&]$/, "");
  const target = strip(new URL(url, location.href).href);
  const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  const entry = [...entries].reverse().find((e) => strip(e.name) === target);
  if (!entry) return null;
  const round = (value: number) => Math.round(value);
  return {
    startTime: round(entry.startTime),
    requestStart: round(entry.requestStart),
    responseStart: round(entry.responseStart),
    responseEnd: round(entry.responseEnd),
    transferSize: entry.transferSize,
    encodedBodySize: entry.encodedBodySize,
    nextHopProtocol: entry.nextHopProtocol,
    responseStatus: (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus ?? null,
    entries: entries.length,
  };
}

export class AudioMixEngine {
  private audioContext: AudioContext;
  private masterGain: GainNode;
  private getMediaUrl: (assetId: string) => string | null;

  private bufferCache = new Map<string, Promise<AudioBuffer>>();
  private reversedBufferCache = new Map<string, Promise<AudioBuffer>>();
  private retimedVideoClipNodes = new Map<string, TrackClipNode>();
  private bufferLastUsed = new Map<string, number>();
  /** Decoded size of each cached buffer (`bufferCache` holds promises, so the size is recorded once one settles). */
  private bufferBytes = new Map<string, number>();
  private readonly bufferBudgetBytes = decodedBufferBudgetBytes();
  private getAssetDuration: ((assetId: string) => number | null) | undefined;
  private trackClipNodes = new Map<string, TrackClipNode>();
  /** What happened to each audio-track asset's fetch and decode, kept even after a failure clears
   *  `bufferCache` — read only by `diagnostics`, for the preview's on-device audio report. */
  private bufferInfo = new Map<string, BufferInfo>();
  /** How many times each audio-track clip's buffer source was (re)started — a clip restarting every
   *  frame is as silent as one that never starts. Diagnostics only. */
  private trackClipStarts = new Map<string, number>();
  private videoClipNodes = new Map<string, VideoClipNode>();
  /** One shared GainNode per AUDIO track — every clip currently playing on that track routes its own
   *  clip-level GainNode through this ONE node before reaching `masterGain` (by way of that track's own
   *  pan/analyser nodes — see `getOrCreateTrackChain`), instead of connecting straight to `masterGain`
   *  itself. Lazily created (`getOrCreateTrackChain`) the first time a
   *  clip on that track starts playing OR the Mixer panel first touches that track's fader, and never
   *  torn down proactively — an audio-context-lifetime cache, cheap enough (one GainNode per track)
   *  not to need eviction the way `bufferCache` does. This is what lets `setTrackGain` move a track's
   *  whole mix level with ONE `setTargetAtTime` call regardless of how many clips are on it, and
   *  without ever touching (let alone restarting) a clip's own `AudioBufferSourceNode` — those are
   *  one-shot/un-seekable, so recomputing a per-clip gain scalar instead would mean restarting every
   *  scheduled node on that track just because a fader moved, reintroducing exactly the click this
   *  engine's own rearchitecture eliminated. */
  private trackGainNodes = new Map<string, GainNode>();
  /** One shared `StereoPannerNode` per audio track, downstream of that track's own `GainNode` — see
   *  `getOrCreateTrackChain`'s own comment for the full chain shape and why pan sits after gain. */
  private trackPanNodes = new Map<string, StereoPannerNode>();
  /** One shared `AnalyserNode` per audio track, downstream of pan — the tap `getTrackLevelDb` reads
   *  from. Sitting LAST in the per-track chain (post-fader, post-pan) means the meter reflects exactly
   *  what's actually being sent to `masterGain`, not some pre-fader signal that wouldn't match what's
   *  audible. A plain pass-through node — connecting through it doesn't alter the signal at all, it
   *  just exposes FFT/waveform data alongside forwarding audio onward unchanged. */
  private trackAnalyserNodes = new Map<string, AnalyserNode>();
  /** Master-bus metering tap, inserted between `masterGain` and `audioContext.destination` — same
   *  pass-through reasoning as the per-track analysers, just for the final summed mix. */
  private masterAnalyser: AnalyserNode;

  /** Called once per asset whose buffer took unusually long, needed a retry, or failed — the follow-up
   *  to `PlaybackEngine`'s own three-second audio report. Diagnostics only. */
  private onBufferReport: ((details: Record<string, unknown>) => void) | undefined;
  private bufferReported = new Set<string>();
  /** Assets whose file downloaded but couldn't be DECODED here — played through an `<audio>` element
   *  instead (`syncElementClip`). Seen on iOS Safari: an AAC .m4a extracted from a video, which a media
   *  element plays fine, failed `decodeAudioData` with "EncodingError: Decoding failed" on every attempt,
   *  leaving the clip silent. */
  private elementFallbackAssets = new Set<string>();
  private elementClipNodes = new Map<string, ElementClipNode>();
  private bufferRetryAfter = new Map<string, number>();
  /** Called when an `<audio>`-element clip's `play()` is refused (autoplay policy) — the host stops the
   *  transport, so the next Play tap (a real gesture, `primeElementClipsFromGesture`) can start it. */
  private onElementBlocked: (() => void) | undefined;
  /** Called the moment an asset switches to `<audio>`-element playback, so the host can create those
   *  clips' elements right away (`prepareElementClip`) — an element made only inside the Play tap has
   *  loaded nothing yet, and on an iPhone its first `play()` was aborted and the clip stayed silent. */
  private onElementFallback: ((assetId: string) => void) | undefined;
  private onDecodeFailed: ((assetId: string) => void) | undefined;

  /** Called when a file downloaded fine but `decodeAudioData` refused it (see `elementFallbackAssets`). */
  setOnDecodeFailed(callback: (assetId: string) => void): void {
    this.onDecodeFailed = callback;
  }

  /** Forget that `assetId` couldn't be decoded and try again from its (new) URL: the `<audio>`-element stand-in is stopped and the
   *  clip goes back to the sample-accurate buffer path once decoding succeeds. */
  retryAsset(assetId: string): void {
    if (!this.elementFallbackAssets.delete(assetId)) return;
    this.bufferCache.delete(assetId);
    this.bufferInfo.delete(assetId);
    this.bufferRetryAfter.delete(assetId);
    this.bufferReported.delete(assetId);
    for (const [clipId, node] of this.elementClipNodes) {
      if (!node.element.paused) node.element.pause();
      void clipId;
    }
  }

  constructor(
    getMediaUrl: (assetId: string) => string | null,
    onBufferReport?: (details: Record<string, unknown>) => void,
    onElementBlocked?: () => void,
    onElementFallback?: (assetId: string) => void,
    getAssetDuration?: (assetId: string) => number | null
  ) {
    this.getMediaUrl = getMediaUrl;
    this.getAssetDuration = getAssetDuration;
    this.onBufferReport = onBufferReport;
    this.onElementBlocked = onElementBlocked;
    this.onElementFallback = onElementFallback;
    // Room for more than the default 250 entries — media range requests can use those up quickly,
    // and `resourceTimingFor` needs the audio file's own entry to still be there.
    if (typeof performance !== "undefined" && typeof performance.setResourceTimingBufferSize === "function") {
      performance.setResourceTimingBufferSize(2000);
    }
    this.audioContext = new AudioContext();
    this.masterGain = this.audioContext.createGain();
    this.masterAnalyser = this.audioContext.createAnalyser();
    // Small FFT — a UI meter only ever needs a cheap-to-read time-domain snapshot every animation
    // frame, not fine frequency resolution; 1024 keeps `getFloatTimeDomainData` fast even with several
    // per-track analysers plus this one all being read every rAF while the Mixer panel is open.
    this.masterAnalyser.fftSize = 1024;
    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.audioContext.destination);
    // iOS counts sound made through Web Audio as "ambient" by default, which the ringer/silent switch
    // mutes — and every sound in this preview is Web Audio (audio-track clips as decoded buffers, video
    // clips captured through `createMediaElementSource`). A video editor's preview is media playback,
    // so it asks to be treated as one. `navigator.audioSession` exists in Safari 16.4+; a no-op anywhere
    // it doesn't. (Reported: an extracted audio clip silent on an iPhone.)
    const audioSession = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (audioSession) {
      try {
        audioSession.type = "playback";
      } catch {
        // An unsupported value on some older build — leave the default.
      }
    }
  }

  /** `AudioContext` starts `suspended` until a user gesture resumes it — mirrors the existing
   *  `element.play().catch(() => {})` pattern for the same reason: this is called from inside `tick()`
   *  right alongside that deferred `.play()` call (see this feature's plan, "Autoplay/gesture
   *  handling"), always after a real click has already happened, but the rejection still needs
   *  swallowing rather than surfacing as an unhandled promise rejection. */
  resume(): void {
    if (this.audioContext.state !== "running") void this.audioContext.resume().catch(() => {});
  }

  /** Same call as `resume`, but meant to run synchronously INSIDE the Play control's own event
   *  handler. WebKit (every iOS browser) only lets an `AudioContext` start from within a real user
   *  gesture and ignores a `resume()` issued from a later animation frame, which is the only place
   *  `resume` above ever ran from. iOS also parks the context in a non-standard `"interrupted"` state
   *  that the old `=== "suspended"` check never matched. Every video clip's audio is captured into
   *  this context (`syncVideoClipAudio`), so a context that never starts can hold those elements back
   *  too, not just silence them. */
  resumeFromGesture(): void {
    // Every Play tap re-asserts the "playback" audio category (and, on older iOS, the silent-media unlock) so the
    // mix stays audible with the ring/silent switch on silent — recording or other audio use in between can reset
    // the category set once at construction.
    unlockPlaybackAudio();
    if (this.audioContext.state !== "running") void this.audioContext.resume().catch(() => {});
  }

  get contextTime(): number {
    return this.audioContext.currentTime;
  }

  /** The audio engine's own state for a set of active audio-track clips — for the preview's on-device
   *  audio report (`PlaybackEngine.maybeReportAudio`). Never includes a media URL (they carry a token). */
  diagnostics(active: { clipId: string; assetId: string }[]): Record<string, unknown> {
    const audioSession = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    return {
      contextState: this.audioContext.state,
      sampleRate: this.audioContext.sampleRate,
      baseLatency: this.audioContext.baseLatency,
      audioSessionType: audioSession?.type ?? null,
      masterGain: this.masterGain.gain.value,
      // Actual output, not just "a node started": above the -60 floor means sound is really leaving
      // the mix right now.
      masterLevelDb: Math.round(this.getMasterLevelDb() * 10) / 10,
      clips: active.map(({ clipId, assetId }) => {
        const info = this.bufferInfo.get(assetId);
        const node = this.elementClipNodes.get(clipId);
        return {
          playing: this.trackClipNodes.has(clipId) || (node !== undefined && !node.element.paused),
          starts: this.trackClipStarts.get(clipId) ?? 0,
          elementFallback: this.elementFallbackAssets.has(assetId),
          element: node
            ? {
                paused: node.element.paused,
                readyState: node.element.readyState,
                networkState: node.element.networkState,
                currentTime: Math.round(node.element.currentTime * 100) / 100,
                seeks: node.seeks,
                playPending: node.playPending,
                playAttempts: node.playAttempts,
                playError: node.playError ?? null,
                lastPlayError: node.lastPlayError ?? null,
                mediaError: node.element.error?.code ?? null,
              }
            : null,
          buffer: info ? this.describeBuffer(info) : null,
        };
      }),
    };
  }

  private describeBuffer(info: BufferInfo): Record<string, unknown> {
    return {
      status: info.status,
      ageMs: Math.round(performance.now() - info.startedAt),
      attempts: info.attempts,
      headersMs: info.headersMs,
      httpStatus: info.httpStatus,
      bytes: info.bytes,
      decodeMs: info.decodeMs,
      duration: info.duration,
      error: info.error,
      resourceTiming: resourceTimingFor(info.url),
    };
  }

  get contextState(): string {
    return this.audioContext.state;
  }

  /** Lazily creates (once — see `trackGainNodes`' own comment) and wires an audio track's whole mixing
   *  chain: `gain → pan → analyser → masterGain`. Gain comes first so panning never interacts with its
   *  own `setTargetAtTime` smoothing; the analyser comes last (post-fader, post-pan) so `getTrackLevelDb`
   *  reflects exactly what's being sent to master, not a pre-fader/pre-pan signal that wouldn't match
   *  what's actually audible. Every existing caller that used to reach for the gain node alone now goes
   *  through this instead, and still gets the SAME gain node back — only the wiring downstream of it
   *  changed, not its identity. */
  private getOrCreateTrackChain(trackId: string): { gain: GainNode; pan: StereoPannerNode } {
    let gain = this.trackGainNodes.get(trackId);
    if (!gain) {
      gain = this.audioContext.createGain();
      const pan = this.audioContext.createStereoPanner();
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 1024;
      gain.connect(pan).connect(analyser).connect(this.masterGain);
      this.trackGainNodes.set(trackId, gain);
      this.trackPanNodes.set(trackId, pan);
      this.trackAnalyserNodes.set(trackId, analyser);
    }
    // `trackPanNodes` is always populated in the exact same branch that just set `trackGainNodes`
    // above, so a lookup miss here would mean the two maps somehow desynced — a bug, not a real "might
    // be absent" case worth a defensive null check.
    return { gain, pan: this.trackPanNodes.get(trackId)! };
  }

  /** Live per-track mix level — called once per tick by `PlaybackEngine.tick()` for every audio track,
   *  regardless of whether anything on it is currently playing (cheap: a no-op scalar reconciliation
   *  when nothing changed, `AudioParam.setTargetAtTime` handles the smoothing). Creates the track's
   *  whole chain on first call if nothing has played on it yet, so a fader touched before its track's
   *  first clip ever starts is already correct the instant it does. */
  setTrackGain(trackId: string, gain: number): void {
    this.getOrCreateTrackChain(trackId).gain.gain.setTargetAtTime(gain, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
  }

  /** Live per-track pan — same `setTargetAtTime`/smoothing convention as `setTrackGain`, called once
   *  per tick by `PlaybackEngine.tick()` for every audio track. See `Track.pan`'s own doc comment for
   *  the equal-power algorithm this node computes natively. */
  setTrackPan(trackId: string, pan: number): void {
    this.getOrCreateTrackChain(trackId).pan.pan.setTargetAtTime(pan, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
  }

  /** Live master mix level — called once per tick by `PlaybackEngine.tick()`. `masterGain` has existed
   *  since this engine's own constructor (reserved for exactly this, connected straight to
   *  `audioContext.destination`); this is simply its first writer. */
  setMasterGain(gain: number): void {
    this.masterGain.gain.setTargetAtTime(gain, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
  }

  /** RMS level in dBFS for one track's post-fader/pan signal, read fresh every call — polled by
   *  `LevelMeter`'s own `requestAnimationFrame` loop, NOT by `PlaybackEngine.tick()` (metering has no
   *  connection to the render/composite loop; it just needs a live reading on demand). `null` when the
   *  track has never played anything yet (no chain/analyser exists) — the meter reads "silent" for
   *  that, same as an actual silent signal would. */
  getTrackLevelDb(trackId: string): number | null {
    const analyser = this.trackAnalyserNodes.get(trackId);
    return analyser ? this.rmsDb(analyser) : null;
  }

  /** Master-bus level — same shape as `getTrackLevelDb`, always available since the master analyser
   *  exists from construction. */
  getMasterLevelDb(): number {
    return this.rmsDb(this.masterAnalyser);
  }

  /** Reused across every `rmsDb` call (any track's analyser, or the master's) rather than allocated
   *  fresh each time — several meters can be polling every animation frame at once while the Mixer
   *  panel is open, and every analyser here shares the same `fftSize`, so one scratch buffer sized to
   *  match is enough for all of them. */
  private rmsDbScratch = new Float32Array(1024);

  /** Plain time-domain RMS converted to dBFS, floored at -60 rather than returning `-Infinity` for
   *  near/true silence — matches a hardware meter's own bottom-of-scale convention, and gives
   *  `LevelMeter`'s dB→fraction math a finite range to work with. */
  private rmsDb(analyser: AnalyserNode): number {
    const buffer = this.rmsDbScratch.length === analyser.fftSize ? this.rmsDbScratch : (this.rmsDbScratch = new Float32Array(analyser.fftSize));
    analyser.getFloatTimeDomainData(buffer);
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) sumSquares += buffer[i] * buffer[i];
    const rms = Math.sqrt(sumSquares / buffer.length);
    return rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
  }

  /** Replaces `PlaybackEngine.syncAudioTracks`'s old element-pool body wholesale. `active` is exactly
   *  what `PlaybackEngine.activeAudioClips` already computes (including a transition partner as its
   *  own separate entry during a real crossfade) — this schedules/reconciles/stops
   *  `AudioBufferSourceNode`s to match it, once per tick. */
  syncAudioTrackClips(active: ActiveAudioTrackClip[], playing: boolean): void {
    const activeIds = new Set(active.map((a) => a.clip.id));
    for (const [clipId, node] of this.trackClipNodes) {
      if (!playing || !activeIds.has(clipId)) this.stopTrackClipNode(clipId, node);
    }
    for (const [clipId, node] of this.elementClipNodes) {
      if ((!playing || !activeIds.has(clipId)) && !node.element.paused) node.element.pause();
    }
    if (!playing) return;

    for (const { trackId, clip, sourceTime, gain, sourceEnd } of active) {
      if (this.elementFallbackAssets.has(clip.assetId)) {
        this.syncElementClip(trackId, clip, sourceTime, gain);
        continue;
      }
      const existing = this.trackClipNodes.get(clip.id);
      if (!existing) {
        this.startTrackClip(trackId, clip, sourceTime, gain, sourceEnd);
        continue;
      }
      // Cheap scalar reconciliation on an already-scheduled clip: is it still roughly where it should
      // be (routine clock noise, left alone), or did the timeline genuinely jump out from under it
      // (a scrub, a loop, resuming after a throttled tab — restart at the new position)?
      const expectedSourceTime = existing.sourceTimeAtStart + (this.audioContext.currentTime - existing.contextTimeAtStart);
      if (detectRealSeek(expectedSourceTime, sourceTime, SEEK_DETECTION_TOLERANCE)) {
        this.stopTrackClipNode(clip.id, existing);
        this.startTrackClip(trackId, clip, sourceTime, gain, sourceEnd);
        continue;
      }
      // `gain` already carries both `Clip.gain` and any live transition ramp (`activeAudioClips` folds
      // both together) — see `audioScheduling.ts`'s own doc comment for why this is a plain per-tick
      // scalar rather than a precomputed automation curve. Track gain is NOT part of this scalar — it's
      // applied downstream by the shared per-track node this clip's own node connects through (see
      // `startTrackClip`), so `setTrackGain` can move the whole track without touching any clip node.
      existing.gainNode.gain.setTargetAtTime(gain, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
      existing.panNode.pan.setTargetAtTime(clip.pan ?? 0, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
    }
  }

  /** Starts every active clip that plays through an `<audio>` element, synchronously inside the Play
   *  tap — iOS only lets a media element start from a real gesture (see `PlaybackEngine.primeFromGesture`,
   *  which calls this). Clips still on the buffer path are untouched. */
  primeElementClipsFromGesture(active: ActiveAudioTrackClip[]): void {
    for (const { trackId, clip, sourceTime, gain } of active) {
      if (!this.elementFallbackAssets.has(clip.assetId)) continue;
      const node = this.elementClipFor(trackId, clip);
      if (!node) continue;
      node.gainNode.gain.value = gain;
      node.panNode.pan.value = clip.pan ?? 0;
      if (node.element.readyState >= 1) node.element.currentTime = sourceTime;
      node.playError = undefined;
      node.retryPlayAt = undefined;
      if (node.element.paused) this.playElement(node);
    }
  }

  /** Creates (and starts loading) the `<audio>` element for a clip whose asset plays through one, well
   *  before Play — a no-op for a clip still on the buffer path, or one already prepared. */
  prepareElementClip(trackId: string, clip: Clip): void {
    if (this.elementFallbackAssets.has(clip.assetId)) this.elementClipFor(trackId, clip);
  }

  private syncElementClip(trackId: string, clip: Clip, sourceTime: number, gain: number): void {
    const node = this.elementClipFor(trackId, clip);
    if (!node) return;
    node.gainNode.gain.setTargetAtTime(gain, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
    node.panNode.pan.setTargetAtTime(clip.pan ?? 0, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
    const element = node.element;
    if (holdMediaAtEnd(element, sourceTime)) return;
    if (element.readyState >= 1 && !element.seeking && Math.abs(element.currentTime - sourceTime) > ELEMENT_DRIFT_TOLERANCE) {
      element.currentTime = sourceTime;
      node.seeks += 1;
    }
    // A refused `play()` isn't retried at all (a new gesture is the only thing that changes the answer);
    // an interrupted one is, a moment later.
    if (element.paused && !node.playPending && !node.playError && performance.now() >= (node.retryPlayAt ?? 0)) this.playElement(node);
  }

  private elementClipFor(trackId: string, clip: Clip): ElementClipNode | null {
    const existing = this.elementClipNodes.get(clip.id);
    if (existing && existing.assetId === clip.assetId) {
      if (existing.trackId !== trackId) {
        existing.gainNode.disconnect();
        existing.panNode.disconnect();
        existing.gainNode.connect(existing.panNode).connect(this.getOrCreateTrackChain(trackId).gain);
        existing.trackId = trackId;
      }
      return existing;
    }
    if (existing) this.releaseElementClip(clip.id, existing);
    const url = this.getMediaUrl(clip.assetId);
    if (!url) return null;
    const element = document.createElement("audio");
    element.preload = "auto";
    element.src = url;
    const source = this.audioContext.createMediaElementSource(element);
    const gainNode = this.audioContext.createGain();
    const panNode = this.audioContext.createStereoPanner();
    source.connect(gainNode).connect(panNode).connect(this.getOrCreateTrackChain(trackId).gain);
    const node: ElementClipNode = { assetId: clip.assetId, trackId, element, source, gainNode, panNode, playPending: false, playAttempts: 0, seeks: 0 };
    this.elementClipNodes.set(clip.id, node);
    return node;
  }

  private playElement(node: ElementClipNode): void {
    node.playPending = true;
    node.playAttempts += 1;
    node.element.play().then(
      () => {
        node.playPending = false;
        node.retryPlayAt = undefined;
      },
      (err: unknown) => {
        node.playPending = false;
        const name = err instanceof Error ? err.name : String(err);
        node.lastPlayError = name;
        if (name === "NotAllowedError") {
          node.playError = name;
          this.onElementBlocked?.();
        } else {
          node.retryPlayAt = performance.now() + ELEMENT_PLAY_RETRY_MS;
        }
      }
    );
  }

  private releaseElementClip(clipId: string, node: ElementClipNode): void {
    node.element.pause();
    node.element.removeAttribute("src");
    node.element.load();
    node.source.disconnect();
    node.gainNode.disconnect();
    node.panNode.disconnect();
    this.elementClipNodes.delete(clipId);
  }

  private startTrackClip(trackId: string, clip: Clip, sourceTime: number, gain: number, sourceEnd = clip.sourceOut): void {
    const url = this.getMediaUrl(clip.assetId);
    if (!url) return;
    // A huge file streams through an element instead; the next tick's sync picks it up on that path.
    if (this.routeHugeAssetToElement(clip.assetId)) return;
    this.getOrDecodeBuffer(clip.assetId, url)
      .then((buffer) => {
        // The clip may no longer be the CURRENT thing scheduled for this id by the time decode
        // finishes (a later tick's own start, or a stop, already ran) — never overwrite a node that
        // already exists, and never schedule for a clip that's since gone silent/inactive.
        if (this.trackClipNodes.has(clip.id)) return;
        const offset = Math.min(Math.max(0, sourceTime), buffer.duration);
        // How much of the CLIP's own trim window remains from this starting point — not the buffer's
        // own full remaining length, or a clip trimmed short of its source's real duration would keep
        // playing straight past its intended `sourceOut` (`sourceEnd` extends that only across a
        // transition blend out of this clip).
        const remaining = Math.max(0, Math.min(sourceEnd, buffer.duration) - offset);
        if (remaining <= 0) return;

        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = gain;
        const panNode = this.audioContext.createStereoPanner();
        panNode.pan.value = clip.pan ?? 0;
        // Through the track's own shared gain→pan→analyser chain, not straight to masterGain — see
        // `getOrCreateTrackChain`'s own doc comment for why. `panNode` sits between this clip's own
        // gain and that shared chain — see `Clip.pan`'s own doc comment.
        source.connect(gainNode).connect(panNode).connect(this.getOrCreateTrackChain(trackId).gain);

        const contextTimeAtStart = this.audioContext.currentTime;
        source.start(contextTimeAtStart, offset, remaining);
        this.trackClipNodes.set(clip.id, { assetId: clip.assetId, source, gainNode, panNode, contextTimeAtStart, sourceTimeAtStart: offset });
        this.trackClipStarts.set(clip.id, (this.trackClipStarts.get(clip.id) ?? 0) + 1);

        source.onended = () => {
          // Only clean up if this node is STILL the current one for this clip id — a natural end
          // racing against a reseek/restart that already replaced it must not delete the new node.
          if (this.trackClipNodes.get(clip.id) === undefined) return;
          if (this.trackClipNodes.get(clip.id)?.source === source) this.trackClipNodes.delete(clip.id);
        };
      })
      .catch(() => {
        // A decode failure (corrupt/unreachable asset) degrades to silence rather than throwing into
        // the render loop — matches this app's broader "drag/play can't destroy work" leniency.
      });
  }

  private stopTrackClipNode(clipId: string, node: TrackClipNode): void {
    try {
      node.source.stop();
    } catch {
      // Already stopped, or already ran to its natural end — nothing left to stop.
    }
    node.source.disconnect();
    node.gainNode.disconnect();
    node.panNode.disconnect();
    this.trackClipNodes.delete(clipId);
  }

  /** Wires (once — see `videoClipNodes`' own comment) or reconciles a video clip's embedded-audio
   *  routing. Called every tick a video clip is on screen, right after `PlaybackEngine.syncMedia`
   *  handles that same element's PICTURE timing. `muted`/`gain` fold together into one target value —
   *  matches export's own "muted clip becomes a zero-signal source" semantics for free, no separate
   *  mute branch needed here either. */
  syncVideoClipAudio(clip: Clip, element: HTMLVideoElement, gain: number, muted: boolean): void {
    let node = this.videoClipNodes.get(clip.id);
    if (!node) {
      // `createMediaElementSource` throws `InvalidStateError` if called twice on the same element
      // across its lifetime — keying this map by clip id (the SAME key `PlaybackEngine`'s own element
      // pool uses) guarantees it only ever runs once per element/clip pairing.
      const mediaSource = this.audioContext.createMediaElementSource(element);
      const gainNode = this.audioContext.createGain();
      const panNode = this.audioContext.createStereoPanner();
      mediaSource.connect(gainNode).connect(panNode).connect(this.masterGain);
      node = { mediaSource, gainNode, panNode };
      this.videoClipNodes.set(clip.id, node);
    }
    node.gainNode.gain.setTargetAtTime(muted ? 0 : gain, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
    node.panNode.pan.setTargetAtTime(clip.pan ?? 0, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
  }

  /** Reverse playback cannot come from an HTMLMediaElement (negative playbackRate is unsupported),
   *  so its embedded audio uses the same decoded-buffer clock as audio-track clips. */
  syncRetimedVideoClipAudio(clip: Clip, sourceTime: number, speed: number, gain: number, muted: boolean, playing: boolean): void {
    const existing = this.retimedVideoClipNodes.get(clip.id);
    if (!playing || muted) {
      if (existing) {
        try { existing.source.stop(); } catch {}
        existing.source.disconnect();
        existing.gainNode.disconnect();
        existing.panNode.disconnect();
        this.retimedVideoClipNodes.delete(clip.id);
      }
      return;
    }
    const target = clip.reverse ? -sourceTime : sourceTime;
    if (existing) {
      const expected = existing.sourceTimeAtStart + (this.audioContext.currentTime - existing.contextTimeAtStart) * existing.source.playbackRate.value;
      if (!detectRealSeek(expected, target, SEEK_DETECTION_TOLERANCE)) {
        existing.gainNode.gain.setTargetAtTime(gain, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
        existing.panNode.pan.setTargetAtTime(clip.pan ?? 0, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
        existing.source.playbackRate.setTargetAtTime(speed, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
        return;
      }
      try { existing.source.stop(); } catch {}
      existing.source.disconnect();
      existing.gainNode.disconnect();
      existing.panNode.disconnect();
      this.retimedVideoClipNodes.delete(clip.id);
    }
    const url = this.getMediaUrl(clip.assetId);
    if (!url) return;
    const promise = clip.reverse
      ? (this.reversedBufferCache.get(clip.assetId) ?? this.getOrDecodeBuffer(clip.assetId, url).then((buffer) => {
          const reversed = this.audioContext.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
          for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            const input = buffer.getChannelData(channel);
            const output = reversed.getChannelData(channel);
            for (let i = 0, j = input.length - 1; i < input.length; i++, j--) output[i] = input[j];
          }
          return reversed;
        }))
      : this.getOrDecodeBuffer(clip.assetId, url);
    if (clip.reverse && !this.reversedBufferCache.has(clip.assetId)) this.reversedBufferCache.set(clip.assetId, promise);
    void promise.then((buffer) => {
      if (this.retimedVideoClipNodes.has(clip.id) || !playing) return;
      const offset = Math.min(buffer.duration, Math.max(0, clip.reverse ? buffer.duration - sourceTime : sourceTime));
      const remainingSource = clip.reverse ? sourceTime - clip.sourceIn : clip.sourceOut - sourceTime;
      if (remainingSource <= 0) return;
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = speed;
      const gainNode = this.audioContext.createGain();
      gainNode.gain.value = gain;
      const panNode = this.audioContext.createStereoPanner();
      panNode.pan.value = clip.pan ?? 0;
      source.connect(gainNode).connect(panNode).connect(this.masterGain);
      const contextTimeAtStart = this.audioContext.currentTime;
      source.start(contextTimeAtStart, offset, Math.min(remainingSource, buffer.duration - offset));
      const node = { source, gainNode, panNode, contextTimeAtStart, sourceTimeAtStart: clip.reverse ? -sourceTime : sourceTime };
      this.retimedVideoClipNodes.set(clip.id, node);
      source.onended = () => {
        if (this.retimedVideoClipNodes.get(clip.id)?.source === source) this.retimedVideoClipNodes.delete(clip.id);
      };
    }).catch(() => {});
  }

  /** Mitigation for the one click category this rearchitecture does NOT structurally fix — see this
   *  class's own doc comment on video-embedded audio. Called by `PlaybackEngine.syncMedia` exactly
   *  where it already decides a hard `currentTime` reseek on a video element is unavoidable: ducks that
   *  clip's dedicated `GainNode` to silence over `DUCK_RAMP_SECONDS`, via the audio thread's OWN
   *  automation clock — immune to the main-thread jank that made a flat `playbackRate` nudge
   *  insufficient in the first place (this session's earlier attempt). Deliberately schedules no
   *  ramp-BACK-up of its own: the next `syncVideoClipAudio` call — once `drawVideoClip` gets past its
   *  own `readyState < 2` early-return again — naturally smooths back to the correct target via its own
   *  `setTargetAtTime`, overriding this duck's tail end. If readiness recovery takes unusually long, the
   *  clip just stays silent a bit longer instead of resuming at a stale gain — a strictly better failure
   *  mode than the click this replaces. */
  duckAroundSeek(clipId: string): void {
    const node = this.videoClipNodes.get(clipId);
    if (!node) return;
    const now = this.audioContext.currentTime;
    node.gainNode.gain.cancelScheduledValues(now);
    node.gainNode.gain.setValueAtTime(node.gainNode.gain.value, now);
    node.gainNode.gain.linearRampToValueAtTime(0, now + DUCK_RAMP_SECONDS);
  }

  /** Must be called before a pooled video element's `src` is cleared (`PlaybackEngine.release`/
   *  `evictStale`) — otherwise this clip's `MediaElementAudioSourceNode`/`GainNode` dangle in the graph
   *  with nothing left referencing them from the picture side. */
  releaseVideoClipAudio(clipId: string): void {
    const node = this.videoClipNodes.get(clipId);
    if (!node) return;
    node.mediaSource.disconnect();
    node.gainNode.disconnect();
    node.panNode.disconnect();
    this.videoClipNodes.delete(clipId);
  }

  /** Fire-and-forget decode kickoff for a clip about to become active soon (not yet) — fed by
   *  `PlaybackEngine`'s own low-frequency scan of upcoming audio-track clips, not called every rAF.
   *  Safe to call redundantly; `getOrDecodeBuffer` dedupes via its own cache. */
  prefetchAsset(assetId: string, url: string): void {
    if (this.elementFallbackAssets.has(assetId)) return;
    if (this.routeHugeAssetToElement(assetId)) return;
    void this.getOrDecodeBuffer(assetId, url).catch(() => {});
  }

  /** A track too long to hold decoded (`STREAM_INSTEAD_OF_DECODE_BYTES`) is switched to `<audio>`-element
   *  playback — the same path an undecodable file already takes — instead of being decoded into hundreds of
   *  megabytes. Returns whether it was (or already is) routed that way. Judged from the asset's own duration;
   *  an unknown duration decodes as before. */
  private routeHugeAssetToElement(assetId: string): boolean {
    if (this.elementFallbackAssets.has(assetId)) return true;
    if (this.bufferCache.has(assetId)) return false; // already decoded and resident — nothing to save
    if (!shouldStreamInsteadOfDecode(this.getAssetDuration?.(assetId), this.audioContext.sampleRate, STREAM_INSTEAD_OF_DECODE_BYTES)) return false;
    this.elementFallbackAssets.add(assetId);
    this.onElementFallback?.(assetId);
    return true;
  }

  private getOrDecodeBuffer(assetId: string, url: string): Promise<AudioBuffer> {
    const existing = this.bufferCache.get(assetId);
    if (existing) {
      this.bufferLastUsed.set(assetId, performance.now());
      return existing;
    }
    const retryAfter = this.bufferRetryAfter.get(assetId);
    if (retryAfter !== undefined && performance.now() < retryAfter) return Promise.reject(new Error("Waiting to retry this audio file"));
    const info: BufferInfo = { status: "pending", startedAt: performance.now(), url, attempts: 0 };
    this.bufferInfo.set(assetId, info);
    const promise = this.fetchAudioBytes(url, info)
      .then((data) => {
        info.bytes = data.byteLength;
        return this.audioContext.decodeAudioData(data);
      })
      .then(
        (buffer) => {
          info.status = "decoded";
          this.bufferBytes.set(assetId, buffer.length * buffer.numberOfChannels * 4);
          info.duration = buffer.duration;
          info.decodeMs = Math.round(performance.now() - info.startedAt);
          return buffer;
        },
        (err: unknown) => {
          info.status = "failed";
          info.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          throw err;
        }
      );
    promise.then(
      () => this.reportBuffer(assetId, info),
      () => this.reportBuffer(assetId, info)
    );
    this.bufferCache.set(assetId, promise);
    this.bufferLastUsed.set(assetId, performance.now());
    this.evictStaleBuffers();
    // A failed decode shouldn't stay permanently cached — a later retry (e.g. after a transient
    // network error) should get a fresh attempt rather than the same rejected promise forever.
    promise.catch(() => {
      this.bufferCache.delete(assetId);
      this.bufferLastUsed.delete(assetId);
      // Downloaded but undecodable: no amount of retrying changes that, so this asset switches to an
      // `<audio>` element for good. A failed download may just be the network — retry, but not at once.
      if (info.bytes !== undefined) {
        this.elementFallbackAssets.add(assetId);
        this.onElementFallback?.(assetId);
        this.onDecodeFailed?.(assetId);
      } else {
        this.bufferRetryAfter.set(assetId, performance.now() + BUFFER_RETRY_DELAY_MS);
      }
    });
    return promise;
  }

  /** The file's bytes — abandoning and retrying once (bypassing the HTTP cache) a request that gets no
   *  response headers within `AUDIO_FETCH_HEADERS_TIMEOUT_MS`. */
  private async fetchAudioBytes(url: string, info: BufferInfo): Promise<ArrayBuffer> {
    for (;;) {
      info.attempts += 1;
      const firstAttempt = info.attempts === 1;
      const controller = new AbortController();
      const timer = firstAttempt ? setTimeout(() => controller.abort(), AUDIO_FETCH_HEADERS_TIMEOUT_MS) : null;
      try {
        const response = await fetch(url, firstAttempt ? { signal: controller.signal } : { cache: "no-store" });
        if (timer) clearTimeout(timer);
        info.headersMs = Math.round(performance.now() - info.startedAt);
        info.httpStatus = response.status;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.arrayBuffer();
      } catch (err) {
        if (timer) clearTimeout(timer);
        if (firstAttempt && controller.signal.aborted) continue;
        throw err;
      }
    }
  }

  private reportBuffer(assetId: string, info: BufferInfo): void {
    if (!this.onBufferReport || this.bufferReported.has(assetId)) return;
    const totalMs = performance.now() - info.startedAt;
    if (info.status !== "failed" && info.attempts <= 1 && totalMs < 3000) return;
    this.bufferReported.add(assetId);
    this.onBufferReport(this.describeBuffer(info));
  }

  /** Drops least-recently-used decoded buffers until the cache fits its count limit AND its byte budget, sparing
   *  any asset a clip is playing from right now. Called when a new buffer is requested and again as each one
   *  finishes decoding (only then is its real size known). */
  private evictStaleBuffers(): void {
    const playing = new Set<string>();
    for (const node of this.trackClipNodes.values()) if (node.assetId) playing.add(node.assetId);
    const entries = [...this.bufferLastUsed.entries()].map(([key, lastUsed]) => ({ key, lastUsed, bytes: this.bufferBytes.get(key) ?? 0 }));
    for (const assetId of lruEvictByBytes(entries, BUFFER_CACHE_LIMIT, this.bufferBudgetBytes, playing)) {
      this.bufferCache.delete(assetId);
      this.bufferLastUsed.delete(assetId);
      this.bufferBytes.delete(assetId);
    }
  }

  /** Tears down the entire graph — stops every scheduled node, disconnects every video-audio route,
   *  closes the context. Called from `PlaybackEngine.detach()`. */
  dispose(): void {
    for (const [clipId, node] of this.trackClipNodes) this.stopTrackClipNode(clipId, node);
    for (const [clipId, node] of [...this.elementClipNodes]) this.releaseElementClip(clipId, node);
    for (const clipId of [...this.videoClipNodes.keys()]) this.releaseVideoClipAudio(clipId);
    for (const [clipId, node] of this.retimedVideoClipNodes) {
      try { node.source.stop(); } catch {}
      node.source.disconnect();
      node.gainNode.disconnect();
      node.panNode.disconnect();
      this.retimedVideoClipNodes.delete(clipId);
    }
    for (const node of this.trackGainNodes.values()) node.disconnect();
    this.trackGainNodes.clear();
    for (const node of this.trackPanNodes.values()) node.disconnect();
    this.trackPanNodes.clear();
    for (const node of this.trackAnalyserNodes.values()) node.disconnect();
    this.trackAnalyserNodes.clear();
    this.masterAnalyser.disconnect();
    this.masterGain.disconnect();
    void this.audioContext.close().catch(() => {});
  }
}
