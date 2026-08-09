# Known limitations

What v1 does not do, and what is not yet proven. Kept honest rather than flattering —
§7.5 makes "honest failure over silent wrongness" the product's promise, and that applies
to its documentation too.

## Drift is corrected (v0.2)

As of v0.2 clock drift is measured **and corrected** (DECISIONS.md D-042, closing D-016).
For any clip whose projected end error exceeds half a frame, the exporter writes a per-clip
`<timeMap>` retime into the FCPXML — no media file is touched; DaVinci Resolve resamples on
playback/render. A spike proved Resolve honours the retime and preserves the sub-frame ppm
ratio exactly, so a 90-minute 40 ppm camera now lands both ends on the reference instead of
±108 ms. It is on by default and can be turned off in Settings (then output is byte-identical
to v0.1). Verified against the engine's real FCPXML layout in DaVinci Resolve Studio 21; the
one thing left for the owner's release QA is a drift-corrected export of a real long-service
camera (E11 checklist).

**Residual, minor:** the clip's *timeline boundary* stays frame-aligned (the retime ratio
that governs the audio is exact and sub-frame; only the visible clip edge is quantised).

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

## A produced or edited mix is not a valid sync reference

Correlation assumes the reference is one continuous recording. A post-produced mix
(cut, tightened, rearranged) contains each clip's audio at *several different* offsets,
so no single placement exists. As of v0.2 (D-045) the engine detects this — the segment
offsets cannot be reconciled with any physically credible clock — and **refuses** the
clip as `low_confidence` instead of placing it wrongly. Choose a raw recorder file or
the longest camera as the reference; the produced mix belongs in the edit, not in the
sync.

## Short clips clear a higher bar

A clip under ~45 s correlates as a single whole-clip pass, so there are no segments to
cross-check and PSR is the only evidence. Such matches must clear `min_psr × 5/3`
(25 at the default) — a provisional calibration from the first real corpus, where every
observed *false* placement scored between 15 and 19 (D-045, D-015). A genuinely matching
short clip in the same room scores far above this; a distant, noisy one may now be
refused where v0.1 would have gambled.

## Scripted Resolve verification cannot cover long-form media

`scripts/resolve-verify.py`'s deep gate drives Resolve's scripting API, whose
`ImportTimelineFromFile` refuses timelines referencing multi-gigabyte media files
(measured 2026-08-09 by systematic A/B: codec, container, path encoding, and volume all
exonerated; a 22 MB clip imports from everywhere, a 12 GB clip refuses even locally).
The exported FCPXML is valid — Resolve's normal **GUI** import is the supported path for
real shoots, and that is what the release QA checklist uses. The scripted gate remains
authoritative for the synthetic accuracy suites, whose media is small.
