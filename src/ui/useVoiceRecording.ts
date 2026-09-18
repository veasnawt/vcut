import { useEffect, useRef, useState } from "react";
import { AddClipCommand } from "../commands/index.ts";
import { applyRecordingEffects, type RecordingEffectsOptions } from "../audio/recordingEffects.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import {
  checkMicPermissionState,
  isNativeMicPermissionAvailable,
  openMicPermissionSettings,
  requestMicPermission,
} from "../api/nativeMicPermission.ts";

/** How often the live recording indicator's length is refreshed while capturing — see
 *  `Timeline.tsx`'s own `recording &&` overlay, the one thing this drives on every tick. */
const INDICATOR_TICK_MS = 150;

/** Candidate `MediaRecorder` mime types, most-preferred first — see the original `VoiceoverRecorder`'s
 *  own doc comment (now folded into this hook) for why probing is needed instead of one fixed type. */
const CANDIDATE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

/** The actual `getUserMedia` audio constraints every capture uses — explicitly RAW, not the browser's
 *  own default (which is `echoCancellation`/`noiseSuppression`/`autoGainControl` all `true`).
 *  Confirmed a real, reported quality regression once recording alongside live sequence PLAYBACK
 *  became possible (see `VoiceoverRecorder`'s — now this hook's — playhead-conflict fix): a browser's
 *  echo canceller is tuned for suppressing a phone call's own far-end audio, not a mixed music/dialogue
 *  sequence playing back through open speakers, and fighting that signal in real time visibly muffled
 *  and distorted the captured voice. Recording with headphones (no real echo path to begin with) or
 *  with the new sequence-mute toggle (no signal to fight at all) both make raw capture strictly
 *  better than the browser's own processing; recording without either still gets whatever bleed the
 *  mic naturally picks up, which is the honest tradeoff for a clean, unprocessed take — the modal's own
 *  Noise Reduction/Voice Enhance options exist to be a deliberate, visible, undoable choice instead of
 *  invisible always-on DSP nobody agreed to. */
const RAW_AUDIO_CONSTRAINTS: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function extensionFor(blob: Blob): string {
  if (blob.type.includes("wav")) return "wav";
  if (blob.type.includes("ogg")) return "ogg";
  if (blob.type.includes("mp4")) return "m4a";
  return "webm";
}

export interface VoiceRecordingState {
  recording: boolean;
  elapsed: number;
  /** Resolves `true` only once `MediaRecorder` has actually started — `false` for every early-return
   *  (permission denied/blocked, no mic, no open project). The modal's own countdown/hold flow sets its
   *  UI to "recording" OPTIMISTICALLY, before this resolves (so a tap/hold feels instant) — it must
   *  await this and roll back to idle on `false`, or the button is left stuck showing "recording" with
   *  a frozen 00:00 timer forever, the exact bug a real device test caught. Takes no options — ALL
   *  post-processing (Voice Enhance/Noise Reduction/Audio Effects/Voice Changer) is a review-step
   *  choice now, made after the take exists, not before it starts. */
  start: () => Promise<boolean>;
  stop: () => void;
  /** Android/iOS only, always `false` on the web — the OS has permanently denied the mic and will never
   *  show its own permission dialog again, so `start()` short-circuits with a status message instead of
   *  making a `getUserMedia` call that can only ever reject. The modal uses this to swap its own record
   *  button hint for an "Open Settings" affordance. See `nativeMicPermission.ts`. */
  micBlocked: boolean;
  /** Opens this app's own Settings page — the only way to actually clear `micBlocked`. A no-op promise
   *  on the web/where the native plugin isn't available. */
  openMicSettings: () => Promise<void>;
  /** True from the moment recording stops until the user calls `confirmReview`/`discardReview` — the
   *  modal swaps its record button for a review step during this window, where ALL FOUR post-processing
   *  choices live now: the take is already safely captured by the time this starts, so trying different
   *  styles costs nothing and can be heard against the ACTUAL recording rather than imagined in advance
   *  before a single word was said — same "post-process, not baked in live" reasoning
   *  `recordingEffects.ts`'s own doc comment gives for why this is a post-process at all. */
  reviewing: boolean;
  reviewVoiceEnhance: boolean;
  setReviewVoiceEnhance: (value: boolean) => void;
  reviewNoiseReduction: boolean;
  setReviewNoiseReduction: (value: boolean) => void;
  reviewEffect: RecordingEffectsOptions["effect"];
  setReviewEffect: (effect: RecordingEffectsOptions["effect"]) => void;
  reviewVoiceChanger: RecordingEffectsOptions["voiceChanger"];
  setReviewVoiceChanger: (voiceChanger: RecordingEffectsOptions["voiceChanger"]) => void;
  /** Object URL for the take rendered with the CURRENT review selection — `null` only while the very
   *  first render (right after stopping) hasn't landed yet. */
  previewUrl: string | null;
  /** True while a preview render is in flight (initial, or after changing any review control) — the
   *  modal disables Confirm during this so it can never bake in a stale render. */
  previewRendering: boolean;
  /** Adds the take rendered with the CURRENT review selection to the timeline, exactly where recording
   *  began, then clears the review step. */
  confirmReview: () => Promise<void>;
  /** Drops the take entirely — no import, no clip, no trace left in the project. */
  discardReview: () => void;
}

/** The actual microphone-capture engine behind the Voice Record modal — extracted out of what used to
 *  be a single always-mounted toolbar component (`VoiceoverRecorder`) so the modal can own the
 *  record/countdown/hold UI on top of it without duplicating any of the permission-handling,
 *  `MediaRecorder` setup, or timeline-placement logic. Still goes through the same `importFiles` path
 *  a dragged-in audio file does once capture ends (probed, copied into the project, added as a normal
 *  asset) — recording (now optionally post-processed, see `applyRecordingEffects`) is just another
 *  SOURCE of a `File`, not a parallel import system. */
export function useVoiceRecording(): VoiceRecordingState {
  const importFiles = useEditorStore((s) => s.importFiles);
  const run = useEditorStore((s) => s.run);
  const setStatus = useEditorStore((s) => s.setStatus);
  const t = useTranslation();

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [micBlocked, setMicBlocked] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewVoiceEnhance, setReviewVoiceEnhance] = useState(false);
  const [reviewNoiseReduction, setReviewNoiseReduction] = useState(false);
  const [reviewEffect, setReviewEffect] = useState<RecordingEffectsOptions["effect"]>("none");
  const [reviewVoiceChanger, setReviewVoiceChanger] = useState<RecordingEffectsOptions["voiceChanger"]>("none");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewRendering, setPreviewRendering] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const targetRef = useRef<{ trackId: string; start: number } | null>(null);
  const rawBlobRef = useRef<Blob | null>(null);
  const previewBlobRef = useRef<Blob | null>(null);

  function releaseStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }

  function clearReviewState() {
    setReviewing(false);
    setReviewVoiceEnhance(false);
    setReviewNoiseReduction(false);
    setReviewEffect("none");
    setReviewVoiceChanger("none");
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    previewBlobRef.current = null;
    rawBlobRef.current = null;
    targetRef.current = null;
  }

  // Leaving the page (or this hook's owner unmounting) mid-recording must not leave the microphone
  // silently "hot" — same reasoning `VoiceoverRecorder` always had. A pending review's own preview
  // object URL would otherwise leak too.
  useEffect(
    () => () => {
      releaseStream();
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    },
    []
  );

  // Native only (see `isNativeMicPermissionAvailable`). Checked on mount so the record button can
  // already show its "blocked" affordance before the user even taps it once, and re-checked whenever
  // the app regains focus — the only way `micBlocked` can go back to `false` is the user leaving to
  // Settings and granting it there, which this catches without needing a manual refresh. Uses
  // `checkMicPermissionState` (a hint) rather than `requestMicPermission` (authoritative but can pop
  // the OS dialog) — this must never trigger a permission prompt just from the modal being open.
  useEffect(() => {
    if (!isNativeMicPermissionAvailable()) return;
    let cancelled = false;
    const recheck = () => {
      void checkMicPermissionState().then((state) => {
        if (!cancelled) setMicBlocked(state === "blocked");
      });
    };
    recheck();
    document.addEventListener("visibilitychange", recheck);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);

  // Renders (or re-renders) the review preview whenever the take first lands, or the user changes ANY
  // review control — `applyRecordingEffects` is a pure function of the RAW take plus options (see its
  // own doc comment), so re-running it from scratch on every change is simple and correct, just not
  // free; `previewRendering` exists so the modal can block Confirm mid-render rather than let a stale
  // blob slip through.
  useEffect(() => {
    if (!reviewing || !rawBlobRef.current) return;
    let cancelled = false;
    setPreviewRendering(true);
    const options: RecordingEffectsOptions = {
      voiceEnhance: reviewVoiceEnhance,
      noiseReduction: reviewNoiseReduction,
      effect: reviewEffect,
      voiceChanger: reviewVoiceChanger,
    };
    applyRecordingEffects(rawBlobRef.current, options)
      .then((blob) => {
        if (cancelled) return;
        previewBlobRef.current = blob;
        const url = URL.createObjectURL(blob);
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      })
      .catch(() => {
        // Falls back to previewing the raw take rather than leaving the modal stuck on a spinner — the
        // user can still Confirm (yielding the raw take, via the same fallback `confirmReview` itself
        // has) or just pick a different effect and try again.
        if (cancelled || !rawBlobRef.current) return;
        previewBlobRef.current = rawBlobRef.current;
        const url = URL.createObjectURL(rawBlobRef.current);
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      })
      .finally(() => {
        if (!cancelled) setPreviewRendering(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `rawBlobRef` is a ref, not state
  }, [reviewing, reviewVoiceEnhance, reviewNoiseReduction, reviewEffect, reviewVoiceChanger]);

  async function start(): Promise<boolean> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      const insecure = typeof window !== "undefined" && window.isSecureContext === false;
      setStatus(
        insecure
          ? t("Recording needs a secure connection (HTTPS, or localhost) — this page was opened over a plain http:// LAN address, which browsers block microphone access from.")
          : t("This browser can't record audio — no microphone API available"),
        "error"
      );
      return false;
    }

    // The AUTHORITATIVE check (see `requestMicPermission`'s own doc comment) — performs a real OS
    // request/reconfirmation through this app's own plugin, so its answer reflects true device history
    // regardless of what `getUserMedia`'s own separate native permission path did before. Skips the
    // `getUserMedia` call entirely unless this says granted — calling it after a "blocked" answer could
    // only ever reject, and after a fresh "prompt" denial would just be a redundant second ask.
    if (isNativeMicPermissionAvailable()) {
      const state = await requestMicPermission();
      setMicBlocked(state === "blocked");
      if (state !== "granted") {
        setStatus(
          state === "blocked"
            ? t("Microphone access is blocked — tap the record button again to open Settings and allow it.")
            : t("Microphone access was denied — try recording again to be asked for permission."),
          "error"
        );
        return false;
      }
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO_CONSTRAINTS });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      const friendly =
        name === "NotAllowedError"
          ? isNativeMicPermissionAvailable()
            ? t("Microphone access was denied or unavailable.")
            : t("Microphone access was denied — allow it for this site in your browser's settings and try again.")
          : name === "NotFoundError"
            ? t("No microphone was found on this device.")
            : t("Microphone access was denied or unavailable");
      setStatus(friendly, "error");
      return false;
    }

    const target = useEditorStore.getState().beginVoiceoverRecording();
    if (!target) {
      stream.getTracks().forEach((track) => track.stop());
      setStatus(t("Open a project before recording a voiceover"), "error");
      return false;
    }
    targetRef.current = target;

    streamRef.current = stream;
    chunksRef.current = [];
    const mimeType = CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      releaseStream();
      rawBlobRef.current = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      chunksRef.current = [];
      useEditorStore.getState().clearRecordingIndicator();
      // `targetRef` stays set — `confirmReview`/`discardReview` (not this handler) are what finally
      // clear it, once the user actually decides what happens to this take. Review controls reset to
      // their defaults here too — a fresh take never inherits the PREVIOUS take's own picks.
      setReviewVoiceEnhance(false);
      setReviewNoiseReduction(false);
      setReviewEffect("none");
      setReviewVoiceChanger("none");
      setReviewing(true);
    };

    recorder.start();
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsed(0);
    setRecording(true);
    timerRef.current = setInterval(() => {
      const elapsedSeconds = (Date.now() - startedAtRef.current) / 1000;
      setElapsed(Math.floor(elapsedSeconds));
      const store = useEditorStore.getState();
      store.updateRecordingElapsed(elapsedSeconds);
      // Skipped while playback is ALSO running — see `VoiceoverRecorder`'s original fix for why:
      // `PlaybackEngine` already owns the playhead every frame in that case, at real transport speed,
      // and this timer's own coarser nudge would otherwise fight it.
      if (!store.playing) store.setPlayhead(target.start + elapsedSeconds);
    }, INDICATOR_TICK_MS);
    return true;
  }

  function stop() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setRecording(false);
    useEditorStore.getState().finalizeRecordingIndicator();
  }

  async function confirmReview() {
    const target = targetRef.current;
    const finalBlob = previewBlobRef.current ?? rawBlobRef.current;
    if (!target || !finalBlob) {
      clearReviewState();
      return;
    }
    const stamp = new Date().toLocaleTimeString([], { hour12: false }).replace(/:/g, "-");
    const file = new File([finalBlob], `Voiceover ${stamp}.${extensionFor(finalBlob)}`, { type: finalBlob.type });
    clearReviewState();
    const [asset] = await importFiles([file], { hiddenFromLibrary: true });
    if (asset) run(new AddClipCommand(target.trackId, asset.id, target.start));
  }

  function discardReview() {
    clearReviewState();
  }

  function openMicSettings(): Promise<void> {
    if (!isNativeMicPermissionAvailable()) return Promise.resolve();
    return openMicPermissionSettings();
  }

  return {
    recording,
    elapsed,
    start,
    stop,
    micBlocked,
    openMicSettings,
    reviewing,
    reviewVoiceEnhance,
    setReviewVoiceEnhance,
    reviewNoiseReduction,
    setReviewNoiseReduction,
    reviewEffect,
    setReviewEffect,
    reviewVoiceChanger,
    setReviewVoiceChanger,
    previewUrl,
    previewRendering,
    confirmReview,
    discardReview,
  };
}

export { pad2 };
