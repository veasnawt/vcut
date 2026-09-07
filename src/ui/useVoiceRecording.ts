import { useEffect, useRef, useState } from "react";
import { AddClipCommand } from "../commands/index.ts";
import { applyRecordingEffects, NO_EFFECTS, type RecordingEffectsOptions } from "../audio/recordingEffects.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { useTranslation } from "../i18n/useTranslation.ts";

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

export interface VoiceRecordingState {
  recording: boolean;
  elapsed: number;
  /** `null` unless actively recording — the modal's own big record button reads this to decide
   *  tap-vs-hold affordances without needing its own separate "am I recording" flag. */
  start: (effects?: RecordingEffectsOptions) => Promise<void>;
  stop: () => void;
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
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const effectsRef = useRef<RecordingEffectsOptions>(NO_EFFECTS);
  const targetRef = useRef<{ trackId: string; start: number } | null>(null);

  function releaseStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }

  // Leaving the page (or this hook's owner unmounting) mid-recording must not leave the microphone
  // silently "hot" — same reasoning `VoiceoverRecorder` always had.
  useEffect(() => releaseStream, []);

  async function start(effects: RecordingEffectsOptions = NO_EFFECTS) {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      const insecure = typeof window !== "undefined" && window.isSecureContext === false;
      setStatus(
        insecure
          ? t("Recording needs a secure connection (HTTPS, or localhost) — this page was opened over a plain http:// LAN address, which browsers block microphone access from.")
          : t("This browser can't record audio — no microphone API available"),
        "error"
      );
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO_CONSTRAINTS });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      setStatus(
        name === "NotAllowedError"
          ? t("Microphone access was denied — allow it for this site in your browser's settings and try again.")
          : name === "NotFoundError"
            ? t("No microphone was found on this device.")
            : t("Microphone access was denied or unavailable"),
        "error"
      );
      return;
    }

    const target = useEditorStore.getState().beginVoiceoverRecording();
    if (!target) {
      stream.getTracks().forEach((track) => track.stop());
      setStatus(t("Open a project before recording a voiceover"), "error");
      return;
    }
    targetRef.current = target;
    effectsRef.current = effects;

    streamRef.current = stream;
    chunksRef.current = [];
    const mimeType = CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      releaseStream();
      const finalTarget = targetRef.current;
      targetRef.current = null;
      const rawBlob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      chunksRef.current = [];

      let blob = rawBlob;
      let ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
      try {
        blob = await applyRecordingEffects(rawBlob, effectsRef.current);
        if (blob !== rawBlob) ext = "wav";
      } catch {
        // Falls back to the raw, unprocessed take rather than losing the recording entirely — a failed
        // effects render (an unsupported codec `decodeAudioData` can't handle, say) shouldn't cost the
        // user their take, just the styling they asked for on top of it.
        blob = rawBlob;
      }

      const stamp = new Date().toLocaleTimeString([], { hour12: false }).replace(/:/g, "-");
      const file = new File([blob], `Voiceover ${stamp}.${ext}`, { type: blob.type });
      const [asset] = await importFiles([file], { hiddenFromLibrary: true });
      if (asset && finalTarget) run(new AddClipCommand(finalTarget.trackId, asset.id, finalTarget.start));
      useEditorStore.getState().clearRecordingIndicator();
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
  }

  function stop() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setRecording(false);
    useEditorStore.getState().finalizeRecordingIndicator();
  }

  return { recording, elapsed, start, stop };
}

export { pad2 };
