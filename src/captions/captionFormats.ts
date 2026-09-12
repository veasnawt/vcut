/** SRT/VTT caption import and export — the gap `packages/vcut/README.md`'s own "What is deliberately
 *  NOT here yet" section flagged plainly: Auto Captions produces real, editable caption clips, but
 *  there was no way to bring an EXTERNAL subtitle file in, or take this project's own captions OUT to
 *  round-trip with another tool (a client's review pass, a different platform's caption requirements).
 *
 *  Deliberately scoped to plain text cues only — neither format's own styling/positioning markup
 *  (VTT's `<b>`/`<i>`/`<c.class>` tags, cue settings like `align:`/`position:`, SRT's rarer `<font>`
 *  extensions) is interpreted or preserved. This app's own caption clips are plain text plus a
 *  separate `TextStyle` (font/color/animation, chosen once for the whole batch — see
 *  `AddCaptionsCommand`), not per-cue inline styling, so there's no equivalent structure on this side
 *  to round-trip that markup INTO even if it were parsed out. */

import { findAsset } from "../project/createProject.ts";
import type { Project } from "../project/types.ts";

export interface CaptionCue {
  /** Absolute sequence-timeline seconds — same convention as `CaptionSegment.start`
   *  (`api/client.ts`), not relative to any one clip. */
  start: number;
  end: number;
  text: string;
}

/** Splits a timestamp into its component units from ONE rounded integer millisecond count, rather
 *  than flooring hours/minutes/seconds and computing milliseconds as the remainder — the latter can
 *  round the millisecond remainder up to 1000 for a value like `4.9996`, producing an invalid
 *  `"00:00:04:1000"` instead of correctly carrying into `"00:00:05,000"`. Rounding ONCE up front and
 *  deriving every unit from that single integer makes an out-of-range remainder structurally
 *  impossible. */
function splitSeconds(totalSeconds: number): { hours: number; minutes: number; seconds: number; millis: number } {
  const totalMillis = Math.round(Math.max(0, totalSeconds) * 1000);
  const millis = totalMillis % 1000;
  const totalWholeSeconds = Math.floor(totalMillis / 1000);
  const seconds = totalWholeSeconds % 60;
  const totalMinutes = Math.floor(totalWholeSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return { hours, minutes, seconds, millis };
}

function pad(n: number, length = 2): string {
  return String(n).padStart(length, "0");
}

function formatSrtTimestamp(seconds: number): string {
  const { hours, minutes, seconds: s, millis } = splitSeconds(seconds);
  return `${pad(hours)}:${pad(minutes)}:${pad(s)},${pad(millis, 3)}`;
}

function formatVttTimestamp(seconds: number): string {
  const { hours, minutes, seconds: s, millis } = splitSeconds(seconds);
  return `${pad(hours)}:${pad(minutes)}:${pad(s)}.${pad(millis, 3)}`;
}

/** Collects every text clip across every `kind: "text"` track into one chronological cue list — the
 *  source both `serializeSrt`/`serializeVtt` consume. Merges ACROSS tracks (not just within one)
 *  deliberately: a project can carry more than one text track (Auto Captions run twice without
 *  clearing the first pass, a hand-authored title track alongside generated captions, ...), and
 *  restricting export to a single chosen track would need new picker UI for what's usually a
 *  non-issue — the common case is exactly one text track, where this is equivalent to reading it
 *  alone. Empty-text and zero-or-negative-duration clips are dropped rather than emitted as blank/
 *  inverted cues no real player could show meaningfully. */
export function extractCaptionCues(project: Project): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const track of project.sequence.tracks) {
    if (track.kind !== "text") continue;
    for (const clip of track.clips) {
      const text = findAsset(project, clip.assetId)?.textContent?.trim() ?? "";
      const end = clip.timelineStart + (clip.sourceOut - clip.sourceIn);
      if (text.length === 0 || end <= clip.timelineStart) continue;
      cues.push({ start: clip.timelineStart, end, text });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** SRT's own format: a 1-based cue index line, a `HH:MM:SS,mmm --> HH:MM:SS,mmm` timing line (comma
 *  decimal separator — the one detail that actually distinguishes it from VTT's timestamp syntax),
 *  then the cue's text (which may itself span multiple lines), one blank line between cues. */
export function serializeSrt(cues: CaptionCue[]): string {
  return (
    cues.map((cue, i) => `${i + 1}\n${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}\n${cue.text}`).join("\n\n") + "\n"
  );
}

/** WebVTT's own format: a mandatory `WEBVTT` header line, then cues separated by blank lines — no
 *  index number required (unlike SRT), a `HH:MM:SS.mmm --> HH:MM:SS.mmm` timing line (dot decimal
 *  separator), then the cue's text. */
export function serializeVtt(cues: CaptionCue[]): string {
  const body = cues.map((cue) => `${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}\n${cue.text}`).join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

/** Accepts EITHER a bare `HH:MM:SS(,|.)mmm` or a shorter `MM:SS(,|.)mmm` (no hours component — valid,
 *  common WebVTT shorthand for anything under an hour; SRT technically always includes hours, but
 *  reading the shorthand too costs nothing and is more forgiving of hand-edited/other-tool-authored
 *  files). Accepts either decimal separator regardless of which format is being parsed — a real SRT
 *  file with a dot or a VTT file with a comma (an easy typo/hand-edit, or a tool that got it backwards)
 *  still parses correctly rather than silently producing a garbage cue. */
function parseTimestamp(raw: string): number | null {
  const match = raw.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (!match) return null;
  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  // Zero-padded to 3 digits before parsing — a raw "5" from a rare 1-digit-millisecond file means 500ms,
  // not 5ms, the same left-alignment convention every timestamp format with a variable-width fractional
  // part uses.
  const millis = parseInt(match[4].padEnd(3, "0"), 10);
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/** Shared block-based parser for both formats — SRT's leading numeric index line and VTT's mandatory
 *  `WEBVTT` header (plus optional NOTE/STYLE blocks and optional cue-identifier lines) are both simply
 *  "whatever precedes the line containing `-->`" from this parser's point of view, so one pass handles
 *  both without needing to know which format it's actually reading. A block with no `-->` line at all
 *  (VTT's header block, a NOTE/STYLE block, a stray blank cue) is skipped rather than erroring — a
 *  hand-edited or slightly-malformed file should still yield whatever cues it DOES have instead of
 *  failing the whole import over one bad block.
 *
 *  Cue text is taken verbatim from every line after the timing line, joined back with newlines — VTT's
 *  own inline styling tags (`<b>`, `<c.className>`, ...) are NOT stripped (see this module's own
 *  top-of-file comment for why), so they'll appear as literal text in the resulting caption clip.
 *  Anything after the second timestamp on the timing line itself (VTT's own cue settings —
 *  `align:start position:10%`, ...) IS correctly ignored: the timing regex only ever captures the two
 *  whitespace-delimited timestamp tokens, never what follows them. */
function parseCueBlocks(content: string): CaptionCue[] {
  const normalized = content.replace(/\r\n?/g, "\n");
  const blocks = normalized
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const cues: CaptionCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timingLineIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingLineIndex === -1) continue;
    const timingMatch = lines[timingLineIndex].match(/^\s*(\S+)\s*-->\s*(\S+)/);
    if (!timingMatch) continue;
    const start = parseTimestamp(timingMatch[1]);
    const end = parseTimestamp(timingMatch[2]);
    if (start === null || end === null || end <= start) continue;
    const text = lines
      .slice(timingLineIndex + 1)
      .join("\n")
      .trim();
    if (text.length === 0) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function parseSrt(content: string): CaptionCue[] {
  return parseCueBlocks(content);
}

export function parseVtt(content: string): CaptionCue[] {
  return parseCueBlocks(content);
}

/** Picks the right parser by sniffing the content itself rather than trusting a file extension (a
 *  browser file-picker's `accept=".srt,.vtt"` still lets a user rename/mis-extension a file, and the
 *  two formats are similar enough — plain-text, `-->` timing lines — that using the wrong one of these
 *  specific two parsers wouldn't even fail loudly, just silently ignore an existing `WEBVTT` header
 *  line as a skipped block). WebVTT requires its header to be the literal first thing in the file
 *  (optionally after a UTF-8 BOM), so checking for it is a reliable, spec-backed discriminator; a
 *  missing "WEBVTT" line defaults to SRT parsing (identical logic anyway — see `parseCueBlocks` — so
 *  a genuine VTT file missing its own header still parses correctly regardless of which branch this
 *  takes). */
export function parseCaptionFile(content: string): CaptionCue[] {
  const withoutBom = content.replace(/^﻿/, "");
  return withoutBom.trimStart().startsWith("WEBVTT") ? parseVtt(withoutBom) : parseSrt(withoutBom);
}
