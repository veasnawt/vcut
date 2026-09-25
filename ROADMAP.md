# VCut roadmap — remaining production-readiness work

Source: the stabilization audit (P0–P3). This file is the durable copy; update the status column as items ship.
Last updated 2026-09-25.

## P0 — critical

| Item | Status |
|---|---|
| P0-1 Credit functions callable by any user | Done (migration 0012) |
| P0-2 Billing amounts came from the client | Done |
| P0-3 LUT / sound / font delete wiped unsaved edits | Done |
| **P0-4 Autosave can silently drop edits** | **Open** — no retry after a failed save; save skipped while another is in flight; nothing saves on `visibilitychange`/`pagehide`; `beforeunload` relies on an async fetch; project switch swallows save errors; mobile writes `project.json` in place (no temp file + rename) |
| P0-5 Paused preview showed the wrong frame | Done |
| P0-6 Text styles missing from export | Done, except keyframed text styles |
| P0-7 Large upload could crash the server | Done |

## P1 — high

| Item | Status |
|---|---|
| P1-1 Keyframed motion is stepped in export (0.15s / 0.3s hosted) | Open |
| P1-2 Preview full-resolution CPU pixel work | Done |
| P1-3 Mask export very slow | Done |
| P1-4 Inspector re-rendered every frame | Done |
| P1-5 No codec check / proxies on import | Open |
| P1-6 Two network lookups per hosted media request | Open |
| P1-7 Server storage only grows, no backups | Open |
| P1-8 Jobs only in memory; restart loses spent credits | Open |
| P1-9 Two tabs/devices silently overwrite each other | Open |
| P1-10 Stripe webhook out-of-order events | Open |
| P1-11 Copy/paste + standard shortcuts (`PasteClipsCommand` is unused) | Open |
| P1-12 Undo edge cases | Open |
| P1-13 Long audio can exhaust browser memory | Open |
| P1-14 Mobile import loads the whole file into memory | Open |
| P1-15 No CI | In progress — `.github/workflows/vcut-ci.yml` added; failing after the vicons build step |
| P1-16 BP Studio embed may be blocked by `frame-ancestors` | Unchecked |

## Shipped since the audit (not in the original list)

- LUT import fixes end to end; LUT **intensity** slider (blends the lattice, so preview and export match).
- Filter presets write their whole look (no carry-over of blur/brightness from the previous preset).
- Timeline: scrub/pan during playback (pauses while dragging, resumes at the release point); zoomed-out
  timelines keep a scroll range / full-width ruler.
- Rotation handle snapping.
- +Text opens the composer immediately (input focused) with Style / Font / Animation tabs, all live on the canvas.
- Text animations: In / Out / Loop tabs — 10 entrances (mirrored as exits) and 3 new loops (Float, Shake,
  Heartbeat) beside the original five. Preview and export share one set of easing definitions (a test checks the
  FFmpeg expressions against the JS math); Khmer/styled text exports through the browser-render path too.
  Not yet: per-letter / per-word cascades, rotation-based In/Out (spin, swing), In/Out on Word Highlight text and
  on rotated text's motion (opacity fades do carry over).

## Known gaps, not scheduled

- Keyframed text styles can't use browser-rendered styles in export.
- Text-window safety cap not stress-tested live; hosted-only early quota check not tested live.
- Uploads under the size cap are still buffered, not streamed.

## Proposed order

1. P0-4 autosave reliability (can lose user work).
2. P1-15 CI green (protects everything after it).
3. P1-8 + P1-10 + P1-7 money/ops: durable job records with orphan refunds, webhook ordering, export retention.
4. P1-1 smooth keyframes in export.
5. P1-9 multi-tab overwrite protection, P1-11 copy/paste + shortcuts, P1-12 undo edge cases.
6. P1-5 / P1-6 / P1-13 / P1-14 import + memory work.
7. P2 polish, P3 future.
