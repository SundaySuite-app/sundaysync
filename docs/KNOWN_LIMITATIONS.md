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

## Playback is the analysis audio, not the mix (v0.3)

The transport plays the **12 kHz mono audio the correlator itself listened to**, read
straight out of the analysis cache — not the media files, and not anything resembling
export quality. That is the point rather than a shortcut: what you are checking is whether
two recordings of the same room line up, and the honest thing to play is the signal the
offsets were computed from. It also means playback needs no second decode, no `asset://`
protocol and no copy of your media (D-055).

Consequences worth knowing before you press play:

- It sounds **dull and lo-fi**. Nothing above ~6 kHz exists in it at all.
- Correct sync sounds **phasey** — a hollow, chorus-like doubling, which is what two copies
  of one sound a few samples apart do to each other. That is the pass condition. A distinct
  *echo* is the failure.
- It is mono and unmixed; levels are raw. Do not judge balance, tone or noise from it.
- A clip whose cache entry has been swept is skipped and says so; the rest keeps playing.

Judging the final audio still means exporting and listening in Resolve.

## UI

- **Dark theme only** (D-026). The light look was dropped along with its contrast bugs;
  the suite's desktop apps are dark.
- **Device re-assignment targets existing devices** from the UI. Creating a brand-new
  device by name is reachable only via the CLI/JSON path (D-028).
- **The app has no visual regression tests.** The engine is exhaustively tested; the UI
  is verified by launch, by hand, and — since v0.2 E10 — by Playwright journeys in CI.
  vitest covers the reducer, error mapping, settings logic and every pure timeline module.
- **One known accessibility violation, accepted deliberately.** The "Rebuild waveform"
  affordance inside a clip is a `role="button"` span nested inside the clip's own real
  `<button>`, which axe flags as `nested-interactive`. Both halves are forced: the clip
  root must stay a `<button>` (the timeline tells a clip click from a background-pan
  gesture by `target.closest("button, …")`), and a genuinely nested `<button>` is
  *un-nested by the HTML parser*, which would break the DOM rather than merely fail a
  validator. The span is keyboard-operable (`tabIndex`, Enter/Space, `aria-disabled`), so
  the practical cost is the flagged rule, not a lost control. See D-054/D-055/D-057.

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

## Resolve's Load XML matcher fails on large media unless it is pre-imported

`scripts/resolve-verify.py`'s deep gate drives Resolve's scripting API, whose
`ImportTimelineFromFile` refuses timelines referencing multi-gigabyte media files
(measured 2026-08-09 by systematic A/B: codec, container, path encoding, and volume all
exonerated; a 22 MB clip imports from everywhere, a 12 GB clip refuses even locally).

Follow-up owner verification (2026-08-09) traced this to the same mechanism in the
**GUI**: File → Import Timeline ("Load XML") shows "The clip was not found" for FCPXML
referencing large files (7–12 GB tested) even though the paths are correct — and the
identical file imports fine when dragged straight into the Media Pool. The fault is
Resolve's Load XML media *matcher*, not media ingest and not our FCPXML (verified clean,
only `%20` path encoding). `ImportTimelineFromFile` exercises that same matcher, which is
why the scripted gate fails identically.

**Workaround, proven in concept:** import the media files into the Media Pool *first*
(drag them in), then File → Import Timeline — the matcher then binds against the
already-imported pool clips instead of trying to resolve paths itself. Alternatively,
when the "clip was not found" dialog appears, choose Yes and point it at the folder
containing the media to relink manually. The in-app export hint now instructs the
media-pool-first order. The scripted gate remains authoritative for the synthetic
accuracy suites, whose media is small.
