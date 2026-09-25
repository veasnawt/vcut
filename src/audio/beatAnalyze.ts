import { detectBeats, toMonoDownsampled, type BeatAnalysis } from "./beatDetection.ts";

/** Longest audio (seconds) we'll analyse — decoding keeps the whole track in memory. */
export const MAX_BEAT_ANALYSIS_SECONDS = 15 * 60;

/** Downloads an audio (or video-with-sound) file, decodes it in the browser, and finds its beats. Rejects with a readable
 *  message if the file can't be fetched or decoded, is too long, or has no clear pulse. */
export async function analyzeAudioUrl(url: string): Promise<BeatAnalysis> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Couldn't load the audio to listen to it");
  const bytes = await response.arrayBuffer();
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) throw new Error("This browser can't analyse audio");
  const context = new Context();
  try {
    const buffer = await context.decodeAudioData(bytes);
    if (buffer.duration > MAX_BEAT_ANALYSIS_SECONDS) throw new Error("That audio is too long to analyse (over 15 minutes)");
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const { samples, sampleRate } = toMonoDownsampled(channels, buffer.sampleRate);
    const result = detectBeats(samples, sampleRate);
    if (result.beats.length < 4) throw new Error("No clear beat found in this audio");
    return result;
  } finally {
    void context.close().catch(() => {});
  }
}
