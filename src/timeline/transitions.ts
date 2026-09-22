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

/** Where the OUTGOING clip's own footage/audio is, `elapsedPastCut` seconds past the nominal cut seam:
 *  it simply keeps playing past its out-point into the rest of its source, the way an NLE uses "handles".
 *  In the centered transition model, the blend window spans `[cut - duration/2, cut + duration/2]`.
 *  At the cut (`elapsedPastCut = 0`), the outgoing clip is exactly at `partner.sourceOut`. Past the cut
 *  (`elapsedPastCut > 0`), it consumes its tail handle.
 *
 *  With `sourceDuration` given, the result is clamped to the end of the source — a clip used right to
 *  the end of its file holds its final frame (and goes silent) for the rest of the blend rather than
 *  running past the media. */
export function transitionPartnerSourceTime(partner: Clip, elapsedPastCut: number, sourceDuration?: number): number {
  const time = partner.sourceOut + elapsedPastCut;
  if (sourceDuration === undefined || !(sourceDuration > 0)) return time;
  return Math.min(time, Math.max(partner.sourceIn, sourceDuration));
}

/** How far PAST its own nominal out-point `clip`'s media keeps playing, because the clip right after it
 *  blends out of it centered on the cut — `blend.duration / 2` when one does, 0 when nothing does.
 *  What an audio scheduler needs so the outgoing clip's audio flows straight on into the second half of
 *  the blend instead of stopping at the cut. */
export function transitionTailExtension(track: Track, clip: Clip): number {
  const successor = findAdjacentSuccessor(track, clip);
  if (!successor) return 0;
  const blend = findTransitionPartner(track, successor);
  return blend?.partner?.id === clip.id ? blend.duration / 2 : 0;
}

/** Whether `clip` has an eligible following neighbor to blend INTO, independent of whether
 *  `transitionOut` is actually set — the successor-side mirror of `findTransitionCandidate`. Used by
 *  `TransitionPickerMenu`/`TransitionPreviewTile` to show the real next clip's own thumbnail (or black
 *  when there isn't one) in the "Out" tab's preview tiles, the same way `findTransitionCandidate`
 *  already lets the "In" tab preview the real previous clip. */
export function findTransitionSuccessorCandidate(track: Track, clip: Clip): Clip | undefined {
  return findAdjacentSuccessor(track, clip) ?? undefined;
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

/** Detail of a transition actively underway at the given timeline time, for live playback / preview rendering. */
export interface ActiveTransitionInfo {
  kind: "junction" | "solo-in" | "solo-out";
  type: TransitionType;
  duration: number;
  progress: number;
  elapsed: number;
  fromClip?: Clip;
  toClip?: Clip;
  fromSourceTime?: number;
  toSourceTime?: number;
  cut?: number;
}

/** Detects if `time` falls inside an active transition on `track`, whether a two-clip junction
 *  transition centered on the cut `[cut - D/2, cut + D/2]` or a solo fade-in / fade-out.
 *  Returns the active clips, transition type, progress [0, 1] (exactly 0.5 at the cut seam),
 *  and exact source times for both sides. */
export function findActiveTransitionAtTime(track: Track, time: number): ActiveTransitionInfo | null {
  for (const clip of track.clips) {
    const blend = findTransitionPartner(track, clip);
    if (blend) {
      const D = blend.duration;
      if (blend.partner) {
        const cut = clip.timelineStart;
        const start = cut - D / 2;
        const end = cut + D / 2;
        if (time >= start && time <= end) {
          const elapsed = time - start;
          const progress = Math.min(1, Math.max(0, elapsed / D));
          const fromClip = blend.partner;
          const toClip = clip;
          const fromSourceTime = transitionPartnerSourceTime(fromClip, elapsed - D / 2);
          const toSourceTime = Math.max(0, toClip.sourceIn - D / 2 + elapsed);
          return {
            kind: "junction",
            type: clip.transitionIn?.type ?? "crossfade",
            duration: D,
            progress,
            elapsed,
            fromClip,
            toClip,
            fromSourceTime,
            toSourceTime,
            cut,
          };
        }
      } else {
        // Solo fade-in: [clip.timelineStart, clip.timelineStart + D]
        const start = clip.timelineStart;
        const end = start + D;
        if (time >= start && time <= end) {
          const elapsed = time - start;
          const progress = Math.min(1, Math.max(0, elapsed / D));
          return {
            kind: "solo-in",
            type: clip.transitionIn?.type ?? "crossfade",
            duration: D,
            progress,
            elapsed,
            toClip: clip,
            toSourceTime: clip.sourceIn + elapsed,
          };
        }
      }
    }

    const transitionOut = findTransitionOut(track, clip);
    if (transitionOut) {
      const D = transitionOut.duration;
      const start = clip.timelineStart + clipDuration(clip) - D;
      const end = clip.timelineStart + clipDuration(clip);
      if (time >= start && time <= end) {
        const elapsed = time - start;
        const progress = Math.min(1, Math.max(0, elapsed / D));
        return {
          kind: "solo-out",
          type: clip.transitionOut?.type ?? "crossfade",
          duration: D,
          progress,
          elapsed,
          fromClip: clip,
          fromSourceTime: clip.sourceIn + (time - clip.timelineStart),
        };
      }
    }
  }

  return null;
}

/** What `clip`'s own live audio gain should be RIGHT NOW, given `time` (the current playhead position,
 *  already known to fall within `clip`'s own `[timelineStart, timelineStart+duration)` window) — plus,
 *  during a real crossfade blend, the partner clip that should ALSO be audible at this exact instant,
 *  with its own gain and `sourceTime`.
 *
 *  In the centered transition model, the blend window spans `[cut - D/2, cut + D/2]`:
 *  - During `[cut - D/2, cut)`: `clip` is Clip A (predecessor), ramping down from 1 to 0.5;
 *    partner is Clip B (successor), ramping up from 0 to 0.5.
 *  - During `[cut, cut + D/2)`: `clip` is Clip B (successor), ramping up from 0.5 to 1.0;
 *    partner is Clip A (predecessor), ramping down from 0.5 to 0.0.
 *  At the cut (`time = cut`), both clips have gain 0.5. */
export interface AudioTransitionGain {
  gain: number;
  partner: { clip: Clip; gain: number; sourceTime: number } | null;
}

export function resolveAudioTransitionGain(track: Track, clip: Clip, time: number): AudioTransitionGain {
  // Case 1: Tail transition into successor (this clip is outgoing partner Clip A)
  const successor = findAdjacentSuccessor(track, clip);
  if (successor) {
    const successorTransition = findTransitionPartner(track, successor);
    if (successorTransition && successorTransition.partner?.id === clip.id) {
      const D = successorTransition.duration;
      const cut = successor.timelineStart;
      const transitionStart = cut - D / 2;
      const transitionEnd = cut + D / 2;
      if (time >= transitionStart && time <= transitionEnd) {
        const elapsed = time - transitionStart;
        const progress = Math.min(1, Math.max(0, elapsed / D));
        const partnerSourceTime = Math.max(0, successor.sourceIn - D / 2 + elapsed);
        return {
          gain: 1 - progress,
          partner: {
            clip: successor,
            gain: progress,
            sourceTime: partnerSourceTime,
          },
        };
      }
    }
  }

  // Case 2: Head transition (this clip is Clip B)
  const transitionIn = findTransitionPartner(track, clip);
  if (transitionIn) {
    const D = transitionIn.duration;
    if (transitionIn.partner) {
      const cut = clip.timelineStart;
      const transitionStart = cut - D / 2;
      const transitionEnd = cut + D / 2;
      if (time >= transitionStart && time <= transitionEnd) {
        const elapsed = time - transitionStart;
        const progress = Math.min(1, Math.max(0, elapsed / D));
        const partner = transitionIn.partner;
        const partnerSourceTime = transitionPartnerSourceTime(partner, elapsed - D / 2);
        return {
          gain: progress,
          partner: {
            clip: partner,
            gain: 1 - progress,
            sourceTime: partnerSourceTime,
          },
        };
      }
    } else {
      // Solo fade-in: [clip.timelineStart, clip.timelineStart + D)
      if (time < clip.timelineStart + D) {
        const elapsed = time - clip.timelineStart;
        const progress = Math.min(1, Math.max(0, elapsed / D));
        return { gain: progress, partner: null };
      }
    }
  }

  // Case 3: Solo fade-out: [clipEnd - D, clipEnd)
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
