/** Making sound play even when an iPhone's ring/silent switch is on silent.
 *
 *  iOS treats sound made through the Web Audio API — and a media element whose page is in the default "ambient"
 *  audio category — as ambient, which the silent switch mutes. A video editor's preview and a voiceover the user
 *  just recorded are media playback, not notification sounds, so they must be audible either way. Two mechanisms:
 *
 *  1. `navigator.audioSession.type = "playback"` (Safari 16.4+) — the proper switch. Re-asserted at the moment
 *     sound is about to play, because recording (`getUserMedia`) moves the session to "play-and-record" and other
 *     interactions can reset it; setting it once at start-up isn't enough.
 *  2. Older iOS has no `audioSession`. There, playing ANY HTML media element promotes the page to the playback
 *     category, so a looping, inaudible one is started (from a user gesture) to keep it there — the long-standing
 *     workaround for Web Audio being silenced by the switch.
 *
 *  Both are no-ops off iOS. None of this can be exercised without an iPhone; the pure part (the silent WAV) is
 *  unit-tested. */

/** A tiny valid WAV file of silence: mono, 8kHz, 16-bit, `seconds` long. */
export function buildSilentWav(seconds = 0.5): Uint8Array {
  const sampleRate = 8000;
  const samples = Math.max(1, Math.round(sampleRate * seconds));
  const dataBytes = samples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer); // the sample bytes are already zero: silence
}

type AudioSessionLike = { type: string };

function audioSession(): AudioSessionLike | undefined {
  return typeof navigator === "undefined" ? undefined : (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
}

/** iPhone / iPad, including iPadOS reporting itself as a Mac. */
export function isIosLike(userAgent: string, maxTouchPoints: number): boolean {
  return /iP(hone|od|ad)/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 0);
}

let silentElement: HTMLAudioElement | null = null;

/** Puts the page in the "playback" audio category so sound isn't muted by the silent switch. Call it from a user
 *  gesture right before audio is about to play (the Play tap, the recorder's preview Play). Idempotent and cheap. */
export function unlockPlaybackAudio(): void {
  const session = audioSession();
  if (session) {
    try {
      session.type = "playback";
    } catch {
      // A build that rejects the value — fall through to the element trick.
    }
    return;
  }
  if (typeof navigator === "undefined" || typeof document === "undefined") return;
  if (!isIosLike(navigator.userAgent, navigator.maxTouchPoints ?? 0)) return;
  if (silentElement) {
    if (silentElement.paused) void silentElement.play().catch(() => {});
    return;
  }
  try {
    const url = URL.createObjectURL(new Blob([buildSilentWav().buffer as ArrayBuffer], { type: "audio/wav" }));
    const element = document.createElement("audio");
    element.src = url;
    element.loop = true;
    element.setAttribute("playsinline", "");
    element.setAttribute("aria-hidden", "true");
    element.style.display = "none";
    silentElement = element;
    void element.play().catch(() => {
      // Refused (no gesture): drop it so the next call, from a real tap, can try again.
      silentElement = null;
    });
  } catch {
    silentElement = null;
  }
}
