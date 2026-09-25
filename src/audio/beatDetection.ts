/** Result of listening to a piece of music: its tempo and where the beats fall. */
export interface BeatAnalysis {
  /** Beats per minute (one decimal). */
  bpm: number;
  /** Beat times in seconds from the start of the audio, ascending. */
  beats: number[];
  /** 0..1 — how clearly periodic the music is. Low means the beat grid is a guess. */
  confidence: number;
}

/** Envelope rate: one value every 10 ms. Coarse enough to be fast, fine enough to place a beat within ~5 ms. */
const ENVELOPE_RATE = 100;
const MIN_BPM = 60;
const MAX_BPM = 180;

/** Finds the tempo and beat positions of mono audio. No external dependencies: it measures how much louder each 10 ms is
 *  than the one before (the onset envelope), finds the repeat interval that envelope lines up with best (autocorrelation,
 *  leaning toward everyday tempos so a 60 BPM track isn't reported as 120), then picks the phase where a regular grid of
 *  that spacing lands on the most onsets. It works for music with a clear pulse (drums, plucks, claps); for ambient or
 *  free-time audio `confidence` comes back low. */
export function detectBeats(samples: Float32Array, sampleRate: number): BeatAnalysis {
  const hop = Math.max(1, Math.round(sampleRate / ENVELOPE_RATE));
  // The real frame rate: `hop` is a whole number of samples, so it differs a little from ENVELOPE_RATE (100.2 Hz at 22.05 kHz),
  // and using the nominal rate would stretch every time by that fraction.
  const frameRate = sampleRate / hop;
  const frames = Math.floor(samples.length / hop);
  if (frames < frameRate * 4) return { bpm: 0, beats: [], confidence: 0 };

  // 1. Loudness per frame, then how much it rose (onset strength).
  const level = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i++) sum += samples[start + i] * samples[start + i];
    level[f] = Math.sqrt(sum / hop);
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, level[f] - level[f - 1]);
  // Remove the slowly varying part so loud passages don't dominate quiet ones.
  const window = Math.round(frameRate * 0.6);
  let running = 0;
  const smoothed = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    running += onset[f];
    if (f >= window) running -= onset[f - window];
    smoothed[f] = running / Math.min(window, f + 1);
  }
  let peakOnset = 0;
  for (let f = 0; f < frames; f++) {
    onset[f] = Math.max(0, onset[f] - smoothed[f] * 1.2);
    if (onset[f] > peakOnset) peakOnset = onset[f];
  }
  if (peakOnset <= 0) return { bpm: 0, beats: [], confidence: 0 };
  for (let f = 0; f < frames; f++) onset[f] /= peakOnset;

  // 2. Tempo: which repeat interval does the onset envelope match best?
  const minLag = Math.floor((60 / MAX_BPM) * frameRate);
  const maxLag = Math.ceil((60 / MIN_BPM) * frameRate);
  const correlation = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let f = lag; f < frames; f++) sum += onset[f] * onset[f - lag];
    correlation[lag] = sum / (frames - lag);
  }
  let bestLag = minLag;
  let bestScore = -1;
  let totalScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * frameRate) / lag;
    // A gentle preference for tempos around 120 (log-distance), so half/double-time isn't picked by accident.
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    // A real beat also repeats at twice the interval; adding that support favours the true period over a subharmonic.
    const doubled = lag * 2 <= maxLag + 1 ? correlation[lag * 2] ?? 0 : 0;
    const score = (correlation[lag] + 0.5 * doubled) * prior;
    totalScore += score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  // Refine to a fraction of a frame (parabola through the peak and its neighbours).
  const a = correlation[bestLag - 1];
  const b = correlation[bestLag];
  const c = correlation[bestLag + 1];
  const denominator = a - 2 * b + c;
  const lag = bestLag + (denominator !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denominator)) : 0);
  const meanScore = totalScore / (maxLag - minLag + 1);
  const confidence = Math.max(0, Math.min(1, meanScore > 0 ? (bestScore / meanScore - 1) / 6 : 0));

  // 3. Phase: where does a grid of that spacing hit the most onsets?
  let bestPhase = 0;
  let bestPhaseScore = -1;
  const steps = Math.max(1, Math.round(lag));
  for (let phase = 0; phase < steps; phase++) {
    let sum = 0;
    for (let position = phase; position < frames; position += lag) {
      const index = Math.round(position);
      // Onsets land a frame or two off the exact grid, so give credit for the nearest few.
      sum += Math.max(onset[index] ?? 0, 0.6 * (onset[index - 1] ?? 0), 0.6 * (onset[index + 1] ?? 0));
    }
    if (sum > bestPhaseScore) {
      bestPhaseScore = sum;
      bestPhase = phase;
    }
  }

  // 4. Tighten the tempo. The autocorrelation lag is only accurate to a fraction of a frame, which adds up over a long song
  // (0.1 BPM off drifts a beat by 60 ms after 24 s). So find the strongest onset near each grid position, fit a straight line
  // through them (frame = start + i * spacing), and lay the final grid on that line.
  const search = Math.max(2, Math.round(lag * 0.25));
  const points: { i: number; frame: number }[] = [];
  for (let i = 0, position = bestPhase; position < frames; i++, position += lag) {
    const centre = Math.round(position);
    let best = -1;
    let bestValue = 0.3;
    for (let d = -search; d <= search; d++) {
      const value = onset[centre + d] ?? 0;
      if (value > bestValue) {
        bestValue = value;
        best = centre + d;
      }
    }
    if (best >= 0) points.push({ i, frame: best });
  }
  let start = bestPhase;
  let spacing = lag;
  if (points.length >= 8) {
    let sumI = 0;
    let sumF = 0;
    let sumII = 0;
    let sumIF = 0;
    for (const point of points) {
      sumI += point.i;
      sumF += point.frame;
      sumII += point.i * point.i;
      sumIF += point.i * point.frame;
    }
    const count = points.length;
    const slope = (count * sumIF - sumI * sumF) / (count * sumII - sumI * sumI);
    // Only accept a refinement that stays close to the measured tempo.
    if (Number.isFinite(slope) && Math.abs(slope - lag) < lag * 0.03) {
      spacing = slope;
      start = (sumF - slope * sumI) / count;
    }
  }
  const beats: number[] = [];
  for (let position = start; position < frames; position += spacing) {
    const centre = Math.round(position);
    let best = centre;
    let bestValue = onset[centre] ?? 0;
    for (let d = -2; d <= 2; d++) {
      const value = onset[centre + d] ?? 0;
      if (value > bestValue + 0.15) {
        bestValue = value;
        best = centre + d;
      }
    }
    const frame = bestValue > 0.15 ? best : position;
    beats.push(Math.round((frame / frameRate) * 1000) / 1000);
  }
  return { bpm: Math.round(((60 * frameRate) / spacing) * 10) / 10, beats, confidence };
}

/** Beats at every `n`th position, starting from the first (n = 1 is every beat; 4 is one per bar of 4/4). */
export function everyNthBeat(beats: readonly number[], n: number): number[] {
  const step = Math.max(1, Math.round(n));
  return beats.filter((_, index) => index % step === 0);
}

/** Mixes decoded channels down to mono and shrinks the sample rate to about `targetRate` by averaging, so a ten-minute
 *  song analyses in a fraction of a second. */
export function toMonoDownsampled(channels: readonly Float32Array[], sampleRate: number, targetRate = 11025): { samples: Float32Array; sampleRate: number } {
  const factor = Math.max(1, Math.floor(sampleRate / targetRate));
  const length = Math.floor(channels[0].length / factor);
  const out = new Float32Array(length);
  const scale = 1 / (factor * channels.length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    const start = i * factor;
    for (const channel of channels) for (let j = 0; j < factor; j++) sum += channel[start + j];
    out[i] = sum * scale;
  }
  return { samples: out, sampleRate: sampleRate / factor };
}
