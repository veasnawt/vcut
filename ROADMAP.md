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
| P1-1 Keyframed motion is stepped in export | Mostly done — position (pan) and zoom (scale) keyframes, and rotation-only keyframes, now export as one per-frame expression (smooth, matching the preview's linear interpolation). Still sliced (0.15-0.3s): zoom combined with rotation or crop, crop keyframes, rotation animating together with position, and effects / color-grading keyframes |
| P1-2 Preview full-resolution CPU pixel work | Done |
| P1-3 Mask export very slow | Done |
| P1-4 Inspector re-rendered every frame | Done |
| P1-5 No codec check / proxies on import | Open |
| P1-6 Two network lookups per hosted media request | Done in code — verified sessions are cached 30s (never past the token's own expiry, keyed by a hash of the token) and confirmed project ownership 60s (positives only; project delete clears it), so a burst of media requests costs 0 lookups after the first. Unit-tested only; not measured against live Supabase. Trade-off: a session revoked elsewhere can take up to 30s to stop working for requests on this server |
| P1-7 Server storage only grows, no backups | Partly done — hosted exports are deleted after 24h (hourly sweep). Still open: exports/uploads don't count toward quota, and there are no volume backups (a Railway-side setting) |
| P1-8 Jobs only in memory; restart loses spent credits | Done for credits — `job_holds` table (migration 0013, must be applied) records credits spent on in-memory AI video / Remove Object / Captions jobs; holds from a dead process are refunded once. Provider-side predictions of a killed job may still run (not cancelled) |
| P1-9 Two tabs/devices silently overwrite each other | Done — projects carry a server `revision`; a save from a stale copy is refused (409) and the user chooses "Load the latest version" or "Keep my version". Page-hide saves now go through the normal save path (keepalive) so they can't create false conflicts. Native (single device) is unaffected |
| P1-10 Stripe webhook out-of-order events | Done — plan derived from the customer's CURRENT subscriptions (order/redelivery-independent); free users no longer refilled by repeated non-active events; unmatched/failed writes answer 5xx so Stripe retries. Not exercised against live Stripe |
| P1-11 Copy/paste + standard shortcuts | Done — Ctrl/⌘ + C / X / V / A, End, ↑/↓ to previous/next edit point, Esc to deselect (J/K/L not added) |
| P1-12 Undo edge cases | Done — a command that throws no longer vanishes from history (the step is put back and the user is told); undo/redo refuses to resurrect a clip whose media was since removed. Not done: making media removal itself undoable (it deletes the file). The refusal was unit-tested, not driven through the real Media-remove button |
| P1-13 Long audio can run the browser out of memory | Done — tracks whose decoded size would exceed ~200MB (about 8.7 min stereo) play through an `<audio>` element instead of being decoded; the decoded-buffer cache now has a byte budget (scaled by device memory) and never evicts a buffer that is playing. Proven with a 12-minute file (0 decodes) vs a 1-minute file (decoded). Reversed clips of huge files still need a decode |
| P1-14 Mobile import loads the whole file into memory | Done in code — native import now writes the file in 4MB slices (first written, rest appended), so memory stays flat instead of ~2.3x the file size; a failed import removes the partial file. Unit-tested with a fake filesystem; NOT run on a real device, and it only reaches phones with the next mobile app release |
| P1-15 No CI | Done — `.github/workflows/vcut-ci.yml` runs typecheck, the full suite (with a full-featured FFmpeg), studio lint and the production build on every push / PR |
| P1-16 BP Studio embed may be blocked | Fixed — BP does embed VCut, and the blanket `frame-ancestors 'none'` + `X-Frame-Options: DENY` blocked it everywhere. Off the hosted deployment VCut is now framable from loopback origins only; vcut.io stays un-framable |

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
4. ~~P1-1 smooth keyframes in export~~ (pan + zoom done; the combinations above remain).
5. ~~P1-9 multi-tab overwrite protection~~, ~~P1-11 copy/paste + shortcuts~~ (done), ~~P1-12 undo edge cases~~ (done).
6. P1-5 / P1-6 / P1-13 / P1-14 import + memory work.
7. P2 polish, P3 future.
