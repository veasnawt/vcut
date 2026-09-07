"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Microphone } from "@veasnawt/vicons";
import { useTranslation } from "../i18n/useTranslation.ts";
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
 *  panel scrolls a typed-in script while recording; Voice Enhance/Noise Reduction/Audio Effects/Voice
 *  Changer are post-processing choices applied to the take once it stops (`applyRecordingEffects`) —
 *  picked BEFORE a take starts so what you hear played back afterward is what actually got kept, not a
 *  live-monitored preview that then differs from the saved result. */
export function VoiceRecordModal({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const viewportHeight = useVisualViewportHeight();
  const { recording, elapsed, start, stop } = useVoiceRecording();

  const [phase, setPhase] = useState<Phase>("idle");
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const phaseRef = useRef<Phase>("idle");
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerDownRef = useRef(false);

  const [voiceEnhance, setVoiceEnhance] = useState(false);
  const [noiseReduction, setNoiseReduction] = useState(false);
  const [effect, setEffect] = useState<RecordingEffectsOptions["effect"]>("none");
  const [voiceChanger, setVoiceChanger] = useState<RecordingEffectsOptions["voiceChanger"]>("none");

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

  function currentEffects(): RecordingEffectsOptions {
    return { voiceEnhance, noiseReduction, effect, voiceChanger };
  }

  function runCountdownThenRecord() {
    setPhaseBoth("countdown");
    setCountdown(COUNTDOWN_SECONDS);
    let remaining = COUNTDOWN_SECONDS;
    const tick = () => {
      remaining -= 1;
      if (phaseRef.current !== "countdown") return; // cancelled mid-countdown
      if (remaining <= 0) {
        setPhaseBoth("recording-tap");
        void start(currentEffects());
        return;
      }
      setCountdown(remaining);
      countdownTimerRef.current = setTimeout(tick, 1000);
    };
    countdownTimerRef.current = setTimeout(tick, 1000);
  }

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
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
    holdTimerRef.current = setTimeout(() => {
      if (!pointerDownRef.current) return;
      setPhaseBoth("recording-hold");
      void start(currentEffects());
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
      // and start the countdown instead.
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      runCountdownThenRecord();
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
  const isBusy = phase !== "idle";

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={() => !isBusy && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={t("Voice Record")}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: Math.max(320, viewportHeight - 32) }}
        className="flex w-full max-w-sm flex-col rounded-xl border border-white/10 bg-[#12151c] p-5 shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between">
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

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto scrollbar-none">
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

          {/* The record surface itself. */}
          <div className="mt-5 flex flex-col items-center gap-2">
            <button
              type="button"
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onContextMenu={(e) => e.preventDefault()}
              className={`flex h-20 w-20 select-none items-center justify-center rounded-full border-2 text-white transition [touch-action:none] ${
                isRecording
                  ? "border-rose-400 bg-rose-500/30"
                  : phase === "countdown"
                    ? "border-amber-400 bg-amber-500/20"
                    : "border-white/20 bg-white/10 hover:bg-white/20"
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
            <p className="text-center text-[11px] text-white/50">
              {phase === "countdown"
                ? t("Get ready…")
                : isRecording
                  ? t("Tap or release to stop")
                  : t("Tap or press and hold to record")}
            </p>
          </div>

          {/* Post-processing, chosen before the take starts (see this file's own doc comment). */}
          <div className="mt-5 flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={isBusy}
                onClick={() => setVoiceEnhance((v) => !v)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-40 ${
                  voiceEnhance ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
                }`}
              >
                {t("Voice Enhance")}
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => setNoiseReduction((v) => !v)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-40 ${
                  noiseReduction ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
                }`}
              >
                {t("Noise Reduction")}
              </button>
            </div>
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-white/40">{t("Audio Effects")}</p>
              <SegmentedControl value={effect} options={EFFECT_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} onChange={setEffect} disabled={isBusy} />
            </div>
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-white/40">{t("Voice Changer")}</p>
              <SegmentedControl
                value={voiceChanger}
                options={VOICE_CHANGER_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
                onChange={setVoiceChanger}
                disabled={isBusy}
              />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
