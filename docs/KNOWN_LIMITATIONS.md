# Known limitations

What v1 does not do, and what is not yet proven. Kept honest rather than flattering —
§7.5 makes "honest failure over silent wrongness" the product's promise, and that applies
to its documentation too.

## Drift is measured, not corrected

v1 reports clock drift per clip (`drift_ppm`, `projected_end_error_ms`) and warns when the
projected end error exceeds half a frame. It does not resample. That is a deliberate v1/v2
split (PLAN §1.3, §2).

**Consequence you should know about:** because placement uses the median of segment
offsets, a drifting clip is centred rather than start-aligned, so its error is
±(total drift ÷ 2) — zero in the middle, worst at both ends. At 40 ppm that stays inside
±10 ms only up to about 8 minutes of clip. A 90-minute continuous recording at 40 ppm
lands roughly ±108 ms out at its extremes. See DECISIONS.md D-016; this is unresolved and
needs a product decision.

## FCPXML: what is verified and what is not

- Times are exact rationals throughout, including NTSC rates, and every time in the
  document is a whole multiple of the frame duration.
- Video snaps to the frame grid; the residual is recorded per clip.
- **Sub-frame audio placement is not implemented.** §6 allows it, but everything is
  currently frame-aligned. Whether Resolve would honour sub-frame audio offsets is
  untested, and §6 says to accept frame precision rather than fight the importer.
- **No DTD validation.** §6 asks for validation against the bundled FCPXML DTD. Apple does
  not ship one with Resolve and none is present on a normal macOS install, so the tests
  assert structure and well-formedness instead. See DECISIONS.md D-021.
- **A single sequence format is emitted**, not one per distinct video geometry. `SyncResult`
  does not carry per-file resolution, so mixed-geometry shoots all reference one format.
  The `mixed_fps` warning still fires. See D-021.

## Performance at real-shoot scale

Correlation cost scales with reference length: roughly 10 transform blocks per segment for
a 10-minute reference, and around 160 for a three-hour one. §10's six-minute target assumes
the run is decode-bound, which stops being true at that scale. The known fix is a decimated
coarse search followed by a narrow refine. Deferred until the Phase 6 corpus shows whether
it bites in practice.

## The installer is large, because ffmpeg is inside it

Since v0.1.2 the app ships its own ffmpeg and ffprobe (D-031), so there is **nothing to
install alongside it** — the earlier "requires ffmpeg on PATH" instruction is gone, along
with the bug where a GUI app could not see a perfectly good Homebrew install. The price is
size: **~60 MB downloaded, ~135 MB installed** on macOS, of which 131 MB is the ffmpeg
pair. That supersedes PLAN §10's "< 40 MB excluding ffmpeg" budget, which only ever
described the part of the download the user did not have to think about. The app's own
code is 10 MB.

## The analysis cache grows without bound

Roughly 169 MB per hour of audio, and nothing removes it. A church syncing weekly will
accumulate tens of GB over a year. There is no eviction policy and the plan does not
specify one. See DECISIONS.md D-013.

## Thresholds are calibrated on synthetic material only

`MIN_PSR = 15.0` was measured against generated fixtures (D-015). Real rooms, real mics and
real congregations are not in that sample. Phase 6's corpus is what would make this claim
trustworthy; until then, treat the threshold as provisional.

## UI

- **Dark theme only** (D-026). The light look was dropped along with its contrast bugs;
  the suite's desktop apps are dark.
- **Device re-assignment targets existing devices** from the UI. Creating a brand-new
  device by name is reachable only via the CLI/JSON path (D-028).
- **The app has no visual regression tests.** The engine is exhaustively tested; the UI
  is verified by launch and by hand. vitest covers the reducer, error mapping and
  settings logic.
