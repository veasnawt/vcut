"use client";

import { useEffect, useRef, useState } from "react";
import { Microphone } from "@veasnawt/vicons";
import { useTranslation } from "../i18n/useTranslation.ts";
import { ToolPanelFrame } from "./ToolPanelFrame.tsx";
import { useVisualViewportHeight } from "./useVisualViewportHeight.ts";
import { useVoiceRecording, pad2 } from "./useVoiceRecording.ts";
import type { RecordingEffectsOptions } from "../audio/recordingEffects.ts";

/** How long a press has to be held before it escalates from "about to be a tap" into "recording
 *  immediately, for as long as this stays held" — short enough that a deliberate press-and-hold
 *  doesn't feel like it's waiting on anything, long enough that a normal tap-and-release never
 *  accidentally crosses it (a quick tap is well under 200ms; this leaves real margin either side). */
const HOLD_THRESHOLD_MS = 350;
const COUNTDOWN_SECONDS = 3;

type Phase = "idle" | "countdown" | "recording-tap" | "recording-hold";

const EFFECT_OPTIONS: { value: RecordingEffectsOptions["effect"]; label: string }[] = [
  { value: "none", label: "None" },
  { value: "reverb", label: "Reverb" },
  { value: "echo", label: "Echo" },
  { value: "radio", label: "Radio" },
];

const VOICE_CHANGER_OPTIONS: { value: RecordingEffectsOptions["voiceChanger"]; label: string }[] = [
  { value: "none", label: "Normal" },
  { value: "deep", label: "Deep" },
  { value: "chipmunk", label: "Chipmunk" },
  { value: "robot", label: "Robot" },
];

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-40 ${
            value === opt.value ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Voice Record, as a modal — replaces the old always-armed toolbar button (instant-record on click)
 *  with a deliberate record surface: tap the button and it counts down from 3 first (time to get
 *  ready without losing the start of the take), or press and hold it and it starts capturing
 *  immediately for exactly as long as it's held (a walkie-talkie-style quick take with no countdown
 *  needed since the deliberate press-and-hold IS the "I'm ready now" signal). An optional Teleprompter
 *  panel scrolls a typed-in script while recording. ALL post-processing — Voice Enhance, Noise
 *  Reduction, Audio Effects, Voice Changer — is picked AFTER the take stops, in a review step
 *  (`reviewing`/`confirmReview`/`discardReview` — see `useVoiceRecording`'s own doc comment): the take
 *  is already safely captured by then, so trying a few styles against what was ACTUALLY said costs
 *  nothing and needs no imagining-in-advance before a single word was recorded. */
export function VoiceRecordModal({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const viewportHeight = useVisualViewportHeight();
  const {
    recording,
    elapsed,
    prepareMicrophone,
    micRequesting,
    micError,
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
  } = useVoiceRecording();

  const [phase, setPhase] = useState<Phase>("idle");
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const phaseRef = useRef<Phase>("idle");
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerDownRef = useRef(false);

  const [showTeleprompter, setShowTeleprompter] = useState(false);
  const [script, setScript] = useState("");
  const [scrollSpeed, setScrollSpeed] = useState(40); // px/sec
  const teleprompterRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);

  function setPhaseBoth(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
  }

  function clearTimers() {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    countdownTimerRef.current = null;
  }

  useEffect(() => clearTimers, []);

  function runCountdownThenRecord() {
    setPhaseBoth("countdown");
    setCountdown(COUNTDOWN_SECONDS);
    let remaining = COUNTDOWN_SECONDS;
    const tick = () => {
      remaining -= 1;
      if (phaseRef.current !== "countdown") return; // cancelled mid-countdown
      if (remaining <= 0) {
        setPhaseBoth("recording-tap");
        // `start()` only resolves `true` once `MediaRecorder` actually started — on `false` (permission
        // denied/blocked, no mic, no open project) the button must fall back to idle instead of being
        // left stuck showing "recording" with a frozen timer, which is the bug a real device test
        // caught: the optimistic `setPhaseBoth` above makes a tap feel instant, but has to be rolled
        // back if the recording it promised never actually began. Guarded on `phaseRef` still matching
        // in case the user already tapped again (stopping it) before this resolves.
        void start().then((started) => {
          if (!started && phaseRef.current === "recording-tap") setPhaseBoth("idle");
        });
        return;
      }
      setCountdown(remaining);
      countdownTimerRef.current = setTimeout(tick, 1000);
    };
    countdownTimerRef.current = setTimeout(tick, 1000);
  }

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    if (micBlocked) {
      // The OS will never show its own permission dialog again — starting a normal tap/hold take here
      // would just fail silently, so this button's own tap instead goes straight to Settings.
      void openMicSettings();
      return;
    }
    if (phase === "countdown") {
      // A second tap while counting down cancels it — the same "tap toggles" mental model as tapping
      // an already-recording take to stop it, just one stage earlier.
      clearTimers();
      setPhaseBoth("idle");
      return;
    }
    if (phase === "recording-tap") {
      // Tapping again while a TAP-started take is running stops it — a HOLD-started take stops on
      // release instead (handled in `onPointerUp`), never here.
      stop();
      setPhaseBoth("idle");
      return;
    }
    if (phase !== "idle") return;

    pointerDownRef.current = true;
    const prep = prepareMicrophone();
    holdTimerRef.current = setTimeout(() => {
      if (!pointerDownRef.current) return;
      setPhaseBoth("recording-hold");
      // See the tap path's identical comment above — same optimistic-UI rollback, for the hold path.
      void prep.then((ready) => {
        if (!ready || !pointerDownRef.current || phaseRef.current !== "recording-hold") {
          setPhaseBoth("idle");
          return;
        }
        void start().then((started) => {
          if (!started && phaseRef.current === "recording-hold") setPhaseBoth("idle");
        });
      });
    }, HOLD_THRESHOLD_MS);
  }

  function onPointerUp() {
    const wasDown = pointerDownRef.current;
    pointerDownRef.current = false;
    if (phaseRef.current === "recording-hold") {
      stop();
      setPhaseBoth("idle");
      return;
    }
    if (phaseRef.current === "idle" && wasDown && holdTimerRef.current) {
      // Released before the hold threshold fired — a genuine tap: cancel the pending hold-escalation
      // and start the countdown instead once microphone is prepared.
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      void prepareMicrophone().then((ready) => {
        if (!ready) {
          setPhaseBoth("idle");
          return;
        }
        runCountdownThenRecord();
      });
    }
  }

  // Teleprompter auto-scroll — a plain time-based `requestAnimationFrame` loop rather than a CSS
  // animation, since `scrollSpeed` can change live (the speed slider) without needing to restart or
  // recompute a keyframe animation's own duration mid-take.
  useEffect(() => {
    if (!recording || !showTeleprompter) return;
    let lastTime: number | null = null;
    function step(time: number) {
      const el = teleprompterRef.current;
      if (el && lastTime !== null) {
        const deltaSeconds = (time - lastTime) / 1000;
        el.scrollTop += scrollSpeed * deltaSeconds;
      }
      lastTime = time;
      scrollRafRef.current = requestAnimationFrame(step);
    }
    scrollRafRef.current = requestAnimationFrame(step);
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    };
  }, [recording, showTeleprompter, scrollSpeed]);

  const isRecording = phase === "recording-tap" || phase === "recording-hold";
  // Reviewing counts as busy too — closing the modal or nudging pre-recording controls mid-review would
  // silently abandon (or misleadingly suggest it affects) a take that hasn't been confirmed yet.
  const isBusy = phase !== "idle" || reviewing;

  return (
    <ToolPanelFrame
      ariaLabel={t("Voice Record")}
      onClose={onClose}
      canClose={!isBusy}
      maxHeight={Math.max(320, viewportHeight)}
      // Short by default; tall only while the Teleprompter (script area) is open.
      compact={!showTeleprompter}
    >
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold text-white">{t("Voice Record")}</h2>
          <button
            onClick={onClose}
            disabled={isBusy}
            aria-label={t("Close")}
            title={t("Close")}
            className="rounded p-1 text-white/40 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-none px-4 py-3">
          {/* Teleprompter — script entry when idle, an auto-scrolling read-only view once recording. */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setShowTeleprompter((v) => !v)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                showTeleprompter ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
              }`}
            >
              {t("Teleprompter")}
            </button>
            {showTeleprompter && recording && (
              <input
                type="range"
                min={10}
                max={120}
                value={scrollSpeed}
                onChange={(e) => setScrollSpeed(Number(e.target.value))}
                title={t("Scroll speed")}
                className="h-1 w-20 accent-sky-500"
              />
            )}
          </div>
          {showTeleprompter && (
            <div
              ref={teleprompterRef}
              className={`mt-2 h-28 overflow-y-auto rounded-lg border border-white/10 bg-black/40 p-2 text-[13px] leading-relaxed text-white/85 ${
                recording ? "scrollbar-none" : ""
              }`}
            >
              {recording ? (
                <p className="whitespace-pre-wrap">{script || t("No script written")}</p>
              ) : (
                <textarea
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  placeholder={t("Type or paste your script here…")}
                  className="h-full w-full resize-none bg-transparent text-[13px] leading-relaxed text-white/85 outline-none placeholder:text-white/30"
                />
              )}
            </div>
          )}

          {reviewing ? (
            /* Review step — the take is already safely captured; Audio Effects/Voice Changer are
             * picked HERE, against the actual recording, with a live re-rendered preview on every
             * change (see `useVoiceRecording`'s own doc comment for why this moved out of pre-recording). */
            <div className="mt-5 flex flex-col gap-4">
              <div className="flex flex-col items-center gap-2">
                <div className="flex h-20 w-20 items-center justify-center rounded-full border-2 border-emerald-400/50 bg-emerald-500/10 text-white">
                  <Microphone size={30} />
                </div>
                <p className="text-center text-[11px] text-white/50">{t("Recording complete — pick a style, then confirm")}</p>
              </div>
              {previewUrl && (
                // `key` forces a fresh element per render, not just a swapped `src` — avoids the
                // browser holding onto a stale decoded buffer for the PREVIOUS effect/voiceChanger pick.
                <audio key={previewUrl} src={previewUrl} controls className="h-9 w-full" />
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={previewRendering}
                  onClick={() => setReviewVoiceEnhance(!reviewVoiceEnhance)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-40 ${
                    reviewVoiceEnhance ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  {t("Voice Enhance")}
                </button>
                <button
                  type="button"
                  disabled={previewRendering}
                  onClick={() => setReviewNoiseReduction(!reviewNoiseReduction)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-40 ${
                    reviewNoiseReduction ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  {t("Noise Reduction")}
                </button>
              </div>
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-white/40">{t("Audio Effects")}</p>
                <SegmentedControl
                  value={reviewEffect}
                  options={EFFECT_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
                  onChange={setReviewEffect}
                  disabled={previewRendering}
                />
              </div>
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-white/40">{t("Voice Changer")}</p>
                <SegmentedControl
                  value={reviewVoiceChanger}
                  options={VOICE_CHANGER_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
                  onChange={setReviewVoiceChanger}
                  disabled={previewRendering}
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={discardReview}
                  className="flex-1 rounded-lg border border-white/10 bg-white/5 py-2 text-[12px] font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
                >
                  {t("Discard")}
                </button>
                <button
                  type="button"
                  disabled={previewRendering}
                  onClick={() => {
                    // Fire-and-forget: `confirmReview` captures everything it needs into local
                    // variables before its first `await`, so it finishes the import/add-to-timeline
                    // work fine even after this modal unmounts — no need to keep it open until then.
                    void confirmReview();
                    onClose();
                  }}
                  className="flex-1 rounded-lg bg-sky-500 py-2 text-[12px] font-semibold text-white transition hover:bg-sky-400 disabled:opacity-50"
                >
                  {previewRendering ? t("Rendering…") : t("Use This Take")}
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* The record surface itself. */}
              <div className="mt-5 flex flex-col items-center gap-2">
                <button
                  type="button"
                  aria-label={t("Record a voiceover from your microphone")}
                  onPointerDown={onPointerDown}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => {
                    pointerDownRef.current = false;
                    clearTimers();
                    if (phaseRef.current === "recording-hold") stop();
                    setPhaseBoth("idle");
                  }}
                  onContextMenu={(e) => e.preventDefault()}
                  className={`flex h-20 w-20 select-none items-center justify-center rounded-full border-2 text-white transition [touch-action:none] ${
                    micBlocked
                      ? "border-amber-400/60 bg-amber-500/10 active:scale-95"
                      : isRecording
                        ? "border-rose-400 bg-rose-500/30"
                        : phase === "countdown"
                          ? "border-amber-400 bg-amber-500/20"
                          : micRequesting
                            ? "border-sky-400/60 bg-sky-500/10 animate-pulse"
                            : "border-white/20 bg-white/10 hover:bg-white/20 active:scale-95"
                  }`}
                >
                  {phase === "countdown" ? (
                    <span className="text-2xl font-bold tabular-nums text-amber-200">{countdown}</span>
                  ) : isRecording ? (
                    <span className="text-sm font-semibold tabular-nums text-rose-100">
                      {pad2(Math.floor(elapsed / 60))}:{pad2(Math.floor(elapsed) % 60)}
                    </span>
                  ) : (
                    <Microphone size={30} />
                  )}
                </button>
                {micError && <p role="alert" className="text-center text-xs text-amber-200">{micError}</p>}
                <p className="text-center text-[11px] text-white/50">
                  {micBlocked
                    ? t("Microphone access is blocked — tap to open Settings")
                    : micRequesting
                      ? t("Waiting for microphone…")
                      : phase === "countdown"
                        ? t("Get ready…")
                        : isRecording
                          ? t("Tap or release to stop")
                          : t("Tap or press and hold to record")}
                </p>
              </div>
            </>
          )}
        </div>
    </ToolPanelFrame>
  );
}
