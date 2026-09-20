import { clipDuration, clipEnd } from "../project/createProject.ts";
import type { Clip, Track, TransitionType } from "../project/types.ts";

/** Every OFFERED `TransitionType`, in the order shown in both the Inspector's "Transition In" dropdown
 *  and the toolbar's picker grid — grouped by family (crossfade, wipe, slide, slice, circle, glitch/
 *  water-ripple, zoom blur, whip pan, flash zoom) matching `transitionFamily`'s own grouping, so the
 *  list reads as short runs rather than an arbitrary order. `dissolve` is deliberately absent — it's a
 *  legacy alias of `crossfade` (see `TransitionType`'s doc comment). One shared source of truth (not a
 *  separately-maintained list per UI), since a video and a text clip transition through the exact same
 *  `TransitionType` union. */
export const TRANSITION_TYPE_OPTIONS: TransitionType[] = [
  "crossfade",
  "wipeLeft",
  "wipeRight",
  "wipeUp",
  "wipeDown",
  "slideLeft",
  "slideRight",
  "slideUp",
  "slideDown",
  "sliceUp",
  "sliceDown",
  "circleOpen",
  "circleClose",
  "glitchCut",
  "waterRippleCut",
  "zoomBlur",
  "whipPanLeft",
  "whipPanRight",
  "flashZoom",
];

/** The subset of `TransitionType` that renders via a per-pixel corruption/blur/flash stage rather than
 *  pure geometry (see that type's own doc comment) — `drawtext` has no equivalent, so text clips can't
 *  use them. A named export (rather than each caller re-listing the six names) so a future addition
 *  can't be added to `TransitionType` while forgetting this one exclusion list. */
export const VIDEO_ONLY_TRANSITION_TYPES: TransitionType[] = [
  "glitchCut",
  "waterRippleCut",
  "zoomBlur",
  "whipPanLeft",
  "whipPanRight",
  "flashZoom",
];

export const TRANSITION_TYPE_LABEL: Record<TransitionType, string> = {
  crossfade: "Crossfade",
  dissolve: "Dissolve",
  wipeLeft: "Wipe Left",
  wipeRight: "Wipe Right",
  wipeUp: "Wipe Up",
  wipeDown: "Wipe Down",
  slideLeft: "Slide Left",
  slideRight: "Slide Right",
  slideUp: "Slide Up",
  slideDown: "Slide Down",
  sliceUp: "Slice Up",
  sliceDown: "Slice Down",
  circleOpen: "Circle Open",
  circleClose: "Circle Close",
  glitchCut: "Glitch Cut",
  waterRippleCut: "Water Ripple",
  zoomBlur: "Zoom Blur",
  whipPanLeft: "Whip Pan Left",
  whipPanRight: "Whip Pan Right",
  flashZoom: "Flash Zoom",
};

/** What a freshly-enabled transition starts at — half a second is a reasonable default crossfade
 *  length. Shared by the Inspector's checkbox and the toolbar's toggle button, so enabling a
 *  transition from either place produces the identical starting value (editable afterward via the
 *  Inspector's own Duration field either way). */
export const DEFAULT_TRANSITION: NonNullable<Clip["transitionIn"]> = { duration: 0.5, type: "crossfade" };

/** How close two clips' edges have to be to count as "genuinely adjacent" — a plain equality check
 *  would reject a pair that's off by float noise from repeated edits, the same reasoning `carveRange`
 *  already applies via `frameDuration`-scale tolerances elsewhere in this file's sibling module. */
const ADJACENCY_TOLERANCE = 1e-6;

/** Resolves a clip's `transitionIn` (see `Clip.transitionIn`'s own doc comment for why this is
 *  checked fresh here rather than maintained through edits) into what it should actually blend FROM,
 *  plus the effective duration once clamped against real current lengths.
 *
 *  `partner` is the preceding clip to blend from when one is genuinely adjacent (zero gap); `null`
 *  when there isn't one (this clip opens the track, or a gap has since opened up before it) — NOT
 *  treated as "no transition" the way it used to be, but as a SOLO fade instead (from black for
 *  video/image, from fully transparent for text — see `PlaybackEngine`'s two callers for how each
 *  renders a `null` partner). Duration is clamped against the partner's length too when there is one,
 *  otherwise just against this clip's own.
 *
 *  Returns `null` outright — meaning "render this clip as a plain cut" — only when `transitionIn`
 *  itself is absent or its stored duration is non-positive, or the clamped duration collapses to
 *  non-positive (this clip trimmed to nothing). The duration IS still clamped (not rejected) when it
 *  merely exceeds a clip's own length — a trim that shrinks a clip out from under its own transition
 *  should shrink the transition to match, not silently drop it entirely, which would be a more
 *  jarring surprise than a shorter blend.
 *
 *  The ONE place both `PlaybackEngine` and `buildExportPlan` decide "is there a real transition here,
 *  what does it blend from, and how long is it" — kept as pure data lookup (no rendering). */
export function findTransitionPartner(track: Track, clip: Clip): { partner: Clip | null; duration: number } | null {
  const requested = clip.transitionIn;
  if (!requested || requested.duration <= 0) return null;

  const partner = findAdjacentPredecessor(track, clip);
  const duration = partner
    ? Math.min(requested.duration, clipDuration(partner), clipDuration(clip))
    : Math.min(requested.duration, clipDuration(clip));
  if (duration <= 0) return null;

  return { partner: partner ?? null, duration };
}

function findAdjacentPredecessor(track: Track, clip: Clip): Clip | undefined {
  return track.clips.find((c) => Math.abs(clipEnd(c) - clip.timelineStart) < ADJACENCY_TOLERANCE);
}

/** Whether `clip` has an eligible preceding neighbor to blend FROM at all, independent of whether
 *  `transitionIn` is actually set yet. Transitions are enabled on every clip now regardless (see
 *  `findTransitionPartner`'s own doc comment on the solo-fade fallback) — this is purely informational,
 *  used by the Inspector and toolbar picker to word the "enable a transition" copy correctly
 *  ("Crossfade/Transition from previous clip" when a candidate exists, "Fade in" when one doesn't). */
export function findTransitionCandidate(track: Track, clip: Clip): Clip | undefined {
  return findAdjacentPredecessor(track, clip);
}

function findAdjacentSuccessor(track: Track, clip: Clip): Clip | undefined {
  return track.clips.find((c) => Math.abs(c.timelineStart - clipEnd(clip)) < ADJACENCY_TOLERANCE);
}

/** Where the OUTGOING clip's own footage/audio is, `elapsed` seconds into a two-clip blend: it simply
 *  keeps playing past its out-point into the rest of its source, the way an NLE uses "handles". The
 *  blend window sits at the start of the incoming clip, so the outgoing clip has already played right
 *  up to its out-point when the blend begins.
 *
 *  This used to rewind to `sourceOut - duration` instead — replaying the outgoing clip's last
 *  `duration` seconds a second time, underneath the blend — so every transition visibly (and
 *  audibly) jumped back in time at the cut: A ends, then A's last half-second plays again while B
 *  fades in. With `sourceDuration` given, the result is clamped to the end of the source — a clip
 *  used right to the end of its file holds its final frame (and goes silent) for the rest of the
 *  blend rather than running past the media. */
export function transitionPartnerSourceTime(partner: Clip, elapsed: number, sourceDuration?: number): number {
  const time = partner.sourceOut + Math.max(0, elapsed);
  if (sourceDuration === undefined || !(sourceDuration > 0)) return time;
  return Math.min(time, Math.max(partner.sourceOut, sourceDuration));
}

/** How far PAST its own out-point `clip`'s media keeps playing, because the clip right after it
 *  blends out of it (see `transitionPartnerSourceTime`) — 0 when nothing does. What an audio scheduler
 *  needs so the outgoing clip's audio flows straight on into the blend instead of stopping at the cut
 *  and restarting a tick later. */
export function transitionTailExtension(track: Track, clip: Clip): number {
  const successor = findAdjacentSuccessor(track, clip);
  if (!successor) return 0;
  const blend = findTransitionPartner(track, successor);
  return blend?.partner?.id === clip.id ? blend.duration : 0;
}

/** Whether `clip` has an eligible following neighbor to blend INTO, independent of whether
 *  `transitionOut` is actually set — the successor-side mirror of `findTransitionCandidate`. Used by
 *  `TransitionPickerMenu`/`TransitionPreviewTile` to show the real next clip's own thumbnail (or black
 *  when there isn't one) in the "Out" tab's preview tiles, the same way `findTransitionCandidate`
 *  already lets the "In" tab preview the real previous clip. */
export function findTransitionSuccessorCandidate(track: Track, clip: Clip): Clip | undefined {
  return findAdjacentSuccessor(track, clip);
}

/** Resolves a clip's `transitionOut` (see its own doc comment) into an effective fade-out duration,
 *  clamped to the clip's real current length. `null` — meaning "no fade-out, render this clip's tail
 *  as a plain cut" — whenever `transitionOut` is absent/non-positive, a genuine successor exists on
 *  this track (that boundary belongs to the SUCCESSOR's own `transitionIn`, not this), or the clamped
 *  duration collapses to non-positive. Unlike `findTransitionPartner`, there's no partner to resolve
 *  here — `transitionOut` is always a solo fade to black/transparent, never a blend — so the return
 *  shape is just the duration on its own. */
export function findTransitionOut(track: Track, clip: Clip): { duration: number } | null {
  const requested = clip.transitionOut;
  if (!requested || requested.duration <= 0) return null;
  if (findAdjacentSuccessor(track, clip)) return null;

  const duration = Math.min(requested.duration, clipDuration(clip));
  if (duration <= 0) return null;

  return { duration };
}

/** What `clip`'s own live audio gain should be RIGHT NOW, given `time` (the current playhead position,
 *  already known to fall within `clip`'s own `[timelineStart, timelineStart+duration)` window — this
 *  never checks that itself, same "caller already knows this clip is active" contract
 *  `findTransitionPartner`/`findTransitionOut` both already have) — plus, during a real crossfade
 *  blend, the OUTGOING partner clip that should ALSO be audible at this exact instant, with its own
 *  gain and the `sourceTime` its own footage should be at.
 *
 *  `gain`/`partner.gain` are pure [0,1] RAMP MULTIPLIERS, not final volumes — multiplying in `Clip.gain`
 *  (the separate, unrelated volume-slider concept) is the caller's job, same separation of concerns
 *  `findTransitionPartner`/`findTransitionOut` already draw between "timing" and "rendering".
 *
 *  This is `PlaybackEngine`'s live-preview counterpart to `buildAudioTrackStream`'s export-time
 *  `acrossfade`/`afade` — the one place both agree on exactly how far into a transition `time` is and
 *  what that means for loudness, even though the underlying MECHANISM is completely different (a gain
 *  ramped every animation frame here, one FFmpeg filter call baked into the export ahead of time
 *  there). Always linear — this app never exposes a fade curve choice for audio (see
 *  `buildAudioTrackStream`'s own comment on why `acrossfade` never varies by `TransitionType`), so
 *  "how far through the window, 0 to 1" IS the gain, both directions.
 *
 *  Three cases, checked in order — a clip can only ever be in one at a time, since a `transitionIn`
 *  blend window and a `transitionOut` fade window can never overlap (the earliest a fade-out window
 *  can start is at `duration - transitionOut.duration`, and `findTransitionOut` already refuses to
 *  return anything at all once a genuine successor exists, which is exactly the case a `transitionIn`
 *  blend on THIS clip would require to not apply to the CURRENT clip in the first place):
 *  1. Inside this clip's own `transitionIn` window, blending from a real partner — both ramp
 *     opposite directions (`gain` rises 0→1, `partner.gain` falls 1→0), and the partner's `sourceTime`
 *     carries on past its own out-point (`transitionPartnerSourceTime`), advancing at the same rate
 *     the blend itself progresses. Mirrors export's "transition" segment exactly (the partner's slice
 *     starting at `-ss sourceOut`), just evaluated live instead of baked into a filter graph.
 *  2. Inside this clip's own `transitionIn` window, but SOLO (no partner) — only this clip ramps, up
 *     from silence.
 *  3. Inside this clip's own `transitionOut` window (checked only once neither of the above applies,
 *     which — per the note above — is already guaranteed whenever `transitionOut` would even resolve
 *     to non-null) — only this clip ramps, down toward silence.
 *  Outside all three: `gain: 1`, `partner: null` — the ordinary, untouched case. */
export interface AudioTransitionGain {
  gain: number;
  partner: { clip: Clip; gain: number; sourceTime: number } | null;
}

export function resolveAudioTransitionGain(track: Track, clip: Clip, time: number): AudioTransitionGain {
  const transitionIn = findTransitionPartner(track, clip);
  if (transitionIn && time < clip.timelineStart + transitionIn.duration) {
    const elapsed = time - clip.timelineStart;
    const progress = Math.min(1, Math.max(0, elapsed / transitionIn.duration));
    if (transitionIn.partner) {
      const partner = transitionIn.partner;
      return {
        gain: progress,
        partner: { clip: partner, gain: 1 - progress, sourceTime: transitionPartnerSourceTime(partner, elapsed) },
      };
    }
    return { gain: progress, partner: null };
  }

  const transitionOut = findTransitionOut(track, clip);
  if (transitionOut) {
    const fadeOutStart = clip.timelineStart + clipDuration(clip) - transitionOut.duration;
    if (time >= fadeOutStart) {
      const progress = Math.min(1, Math.max(0, (time - fadeOutStart) / transitionOut.duration));
      return { gain: 1 - progress, partner: null };
    }
  }

  return { gain: 1, partner: null };
}
