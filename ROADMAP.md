# VCut roadmap — remaining production-readiness work

Source: the stabilization audit (P0–P3). This file is the durable copy; update the status column as items ship.
Last updated 2026-09-25.

## P0 — critical

| Item | Status |
|---|---|
| P0-1 Credit functions callable by any user | Done (migration 0012) |
| P0-2 Billing amounts came from the client | Done |
| P0-3 LUT / sound / font delete wiped unsaved edits | Done |
| P0-4 Autosave can silently drop edits | Done — `SaveCoordinator`: saves again after an edit made mid-request, retries failures with backoff, `flush()` waits for in-flight saves, save on `pagehide`/`visibilitychange` via keepalive, project-switch save retries and reports failure, server temp files unique per request, native writes atomic (temp + swap) with crash recovery and no more overwriting a damaged file with a blank project |
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
| P1-7 Server storage only grows, no backups | Partly done — hosted exports are deleted after 24h (hourly sweep). Still open: exports/uploads don't count toward quota, and there are no volume backups (a Railway-side setting) |
| P1-8 Jobs only in memory; restart loses spent credits | Done for credits — `job_holds` table (migration 0013, must be applied) records credits spent on in-memory AI video / Remove Object / Captions jobs; holds from a dead process are refunded once. Provider-side predictions of a killed job may still run (not cancelled) |
| P1-9 Two tabs/devices silently overwrite each other | Open |
| P1-10 Stripe webhook out-of-order events | Done — plan derived from the customer's CURRENT subscriptions (order/redelivery-independent); free users no longer refilled by repeated non-active events; unmatched/failed writes answer 5xx so Stripe retries. Not exercised against live Stripe |
| P1-11 Copy/paste + standard shortcuts (`PasteClipsCommand` is unused) | Open |
| P1-12 Undo edge cases | Open |
| P1-13 Long audio can exhaust browser memory | Open |
| P1-14 Mobile import loads the whole file into memory | Open |
| P1-15 No CI | Done — `.github/workflows/vcut-ci.yml` runs typecheck, the full suite (with a full-featured FFmpeg), studio lint and the production build on every push / PR |
| P1-16 BP Studio embed may be blocked by `frame-ancestors` | Unchecked |

## Shipped since the audit (not in the original list)

- LUT import fixes end to end; LUT **intensity** slider (blends the lattice, so preview and export match).
- Filter presets write their whole look (no carry-over of blur/brightness from the previous preset).
- Timeline: scrub/pan during playback (pauses while dragging, resumes at the release point); zoomed-out
  timelines keep a scroll range / full-width ruler.
- Rotation handle snapping.
- +Text opens the composer immediately (input focused) with Style / Font / Animation tabs, all live on the canvas.
- Text animations: In / Out / Loop tabs — 17 entrances (mirrored as exits) and 3 new loops (Float, Shake,
  Heartbeat) beside the original five. 10 whole-block entrances (Fade, Slide x4, Rise, Drop, Pop, Zoom In/Out) and
  7 per-letter / per-word cascades (Letter Rise/Drop/Fade/Pop, Word Rise/Fade/Pop). Whole-block ones export as
  FFmpeg expressions (a test checks them against the JS math); cascades export through the browser-render path,
  which draws with the same `drawTextFrame` as the preview (proven end to end on a production build).
  Not yet: rotation-based In/Out (spin, swing), In/Out on Word Highlight text and on rotated text's motion
  (opacity fades do carry over), cascades in native/mobile export (falls back to no animation).

## Known gaps, not scheduled

- Keyframed text styles can't use browser-rendered styles in export.
- Text-window safety cap not stress-tested live; hosted-only early quota check not tested live.
- Uploads under the size cap are still buffered, not streamed.

## Proposed order

1. ~~P0-4 autosave reliability~~ (done).
2. ~~P1-15 CI green~~ (done).
3. ~~P1-8 + P1-10 + P1-7 (retention)~~ (done; volume backups and quota-counting exports remain).
4. P1-1 smooth keyframes in export.
5. P1-9 multi-tab overwrite protection, P1-11 copy/paste + shortcuts, P1-12 undo edge cases.
6. P1-5 / P1-6 / P1-13 / P1-14 import + memory work.
7. P2 polish, P3 future.
