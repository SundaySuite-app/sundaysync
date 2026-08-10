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

## The pre-sync timeline shows camera clocks, not the answer (v0.4, extended in v0.5)

Files land on the timeline the moment they are scanned, positioned by whatever clock the app
can find without listening to anything. That is frequently wrong: cameras drift, cameras are
set to the wrong time zone, and a camera that lost its battery comes back reading 1970. Those
clips are drawn in a muted grey rather than the placed green, and they say «foreløpig» in as
many words — but the picture is still a *claim by the cards*, not by SundaySync, until the
sync corrects it.

Since v0.5 (D-067) that clock is a **ladder of four kinds of evidence**, not one field, and
the specific shapes are these:

- **Everything below the top rung is an estimate, and only the top rung is a measurement.**
  A container `creation_time` is the camera's own record of when it started rolling. A BWF's
  split date + clock, a timestamp spelled into a filename, and an mtime minus the file's
  duration are all *reconstructions*, and the app marks them as such — a dashed top edge on
  the clip, «anslått fra …» in its spoken description, and its own count in the legend. On the
  owner's real corpus 163 of 386 files are positioned this way. A pre-sync position below the
  top rung is a starting guess for the eye, never a number to act on.
- **An mtime does not survive every copy (R1).** The lowest rung reads the file's modification
  time and subtracts its duration, which is exact when the file has been left alone — measured
  to the second across 136 AVCHD `.MTS` files. It is *worthless* when the card was copied by
  something that did not preserve mtimes: every file then carries the time of the copy, they
  agree with each other perfectly, and nothing in the file says so. The session gate catches
  the case where a real clock exists to contradict them — a block of copy-dated files lands
  outside the day the timestamped cameras agree on and is demoted rather than placed. It
  cannot catch a drop where the copy-dated files are the *only* evidence there is: they are
  then self-consistent, admitted, and laid out in a plausible-looking order that is a fact
  about the copy rather than about the shoot. **The sync is the answer to this**, and it
  always was: nothing downstream of the correlator depends on the ladder.
- **Files nothing can time are laid out in filename order (v0.5, D-068).** They used to pile
  at zero; they now sit end to end on their own device's row, after that device's last placed
  clip. The app does not know when they started; it does know what followed what. The strip
  is an *order*, not a schedule — the gaps between those files are not real, and their end is
  not a claim about when the device stopped recording. Measured on the real corpus, the strips
  add **0.7 %** to the timeline's total length.
- **The hop after a sync is the correction, and it can be large.** A ten-minute jump means
  the card's clock was ten minutes out, not that anything went wrong.

## Waveforms are not drawn below 24 px, and are not read either (v0.5)

A clip narrower than 24 px carries no waveform: no `<canvas>`, no draw, and no
`waveform_meta` read behind it (D-072). `barGeometry` draws one bar per device pixel, so a
3 px box is three bars — a smudge, not a shape. On the owner's 386-file corpus at fit zoom the
median clip is 3 px and only 24 of 386 clear the threshold, so **most of a real drop shows no
waveforms until you zoom in**, which is the intended behaviour and not a failure to load. They
appear as soon as a clip is wide enough to hold one.

## "Fit" does not fit a session longer than about eleven hours (v0.3, measured in v0.5)

`MIN_PX_PER_MS` is 2 × 10⁻⁵, so the widest view the timeline will ever adopt shows about
**11.6 hours** in an 840 px lane column. The owner's real wedding spans **15.5 hours** end to
end, and at Fit the last quarter of it is off the right edge — measured in this round: 346 of
386 clips mounted, 40 (25 Fuji, 15 AVCHD) past the edge until the operator pans. Pressing Fit
again changes nothing, because Fit is already at the floor.

Nothing is lost — the scrollbar row is there and panning reaches them — but "Fit" quietly
stops meaning "everything on screen" past that length, with nothing saying so.

Deliberately **not** changed in v0.5. The zoom floor is a v0.3 constant that governs every
timeline, and at the current floor one device pixel is already ~50 s of audio against a
coarsest pyramid bin of ~41 s (`peaks.rs`, 13 levels) — lowering it puts the waveform layer in
a regime it was not designed for. That is not a change to make at the last gate before a
release, in a stage that cannot drive the native window to look at the result. It is the
highest-value item this round found for the next one.

## A stale pre-analysis tick can survive one drop into the next (v0.5)

`prewarm:progress` carries no sequence number of its own — the backend emits a plain
`ProgressEvent` — so the reducer can only gate it on the phase. Drop a second folder while the
first is still pre-analysing and the abandoned pass is cancelled, but it goes on emitting
until it notices; between the new scan landing and that moment, one stale tick can move the
«analyserer N av M» line to the old drop's counts.

Cosmetic, self-correcting within one file, and deliberately **not** patched with a heuristic
(matching on `total`, say) that would look like a rule while being a guess. The honest fix is
a sequence on the backend event, and it is not worth an IPC change at a release gate.

## The background analysis starts before you have finished choosing (v0.4)

Pre-analysis (D-059/D-062) begins the moment a scan finishes, on every file the scan found —
which is before the operator has had a chance to remove the lens-cap take, the duplicate
board dump or the file that belongs to a different service. So the app reads media it may
turn out not to need, and on a NAS that read is over the network.

**This is a deliberate trade the owner accepted**, and it is the whole point of the feature:
the reason the timeline draws waveforms while you are still reading the sources list is that
the decode is already running. Waiting for the file list to be final would mean waiting for
the operator, which is exactly the wait the feature exists to remove. The cost is bounded and
recoverable rather than open-ended:

- The work is the same decode the sync would have done anyway, into the same cache — nothing
  is done twice, and an excluded file's cache entry is simply never read.
- An excluded file is skipped by any *later* pass, and by the sync itself.
- Pressing Sync preempts the pass within a second or two (D-059); dropping a different folder
  cancels it (D-063); clearing the sources cancels it.
- The cache is swept on the 90-day mtime rule (D-040), so an unneeded entry is not permanent.

What it is not: it is not something to wait for, and it never reports failure. A pass that is
refused, cancelled or preempted is the system working.

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
