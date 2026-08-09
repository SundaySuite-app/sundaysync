# Changelog

## Unreleased

- **The result view is now a real timeline (D-051).** The old per-device lanes drew every
  clip as a percentage of the widest span, so a four-second offset inside a ninety-minute
  service was a sliver too small to judge. The new view has a zoom: fit the whole day on
  screen, then wind in until the millisecond the engine is claiming is visible as a
  millisecond. Scroll to pan, ⌘/Ctrl-scroll or `+`/`-` to zoom around the cursor, `0` to
  fit, drag the background to pan, drag the ruler to move the playhead. Clips from one
  device that cover the same instant (a multitrack board dump) now stack into separate
  rows instead of hiding behind each other, and a device that synced nothing still gets
  its own track, still saying so. The clip detail dialog, the red "not synced" shelf with
  its move-to-device fix, the green/orange colour language and the dimming of a stale
  result are all unchanged — this is the same information, finally at a readable scale.
  Still a viewer, not an editor: clips do not drag.
- **Internal: waveform peaks pipeline for the v0.3 interactive timeline (D-052).** Added
  `crates/core/src/peaks.rs` — a streamed multi-resolution peak+RMS pyramid built from
  the analysis audio the sync engine has *already* cached, so drawing waveforms costs
  **zero ffmpeg spawns** and no second decode of the source media. Nine levels span 10 ms
  to 2.56 s per bin; level data reaches the UI as raw bytes (an `ArrayBuffer`), not JSON.
  Three new shell commands (`waveform_meta`, `waveform_level`, `regenerate_analysis`) with
  a 64-entry in-memory cache. Reading a waveform is read-only and deliberately does not
  block, or get blocked by, a running sync (D-046); a clip whose cache entry has been
  swept is reported as a regenerable state rather than an error. No UI changes yet — S2 of
  the v0.3 program.
- **Internal: `THIRD-PARTY-NOTICES` added (D-053)**, carrying Clypra's MIT licence for the
  bucket peak/RMS math adapted in `peaks.rs`. Their `HTMLAudioElement` playback transport
  (0.5–2.0 s drift tolerance), per-zoom ffmpeg waveform extraction and unvirtualized
  timeline were reviewed and deliberately not adopted.
- **Internal: timeline math foundation for the v0.3 interactive result view (D-051).**
  Added `app/src/timeline/` — pure, unit-tested modules for time↔pixel mapping,
  zoom-around-anchor, ruler ticks, clip virtualization, multi-row overlap layout, and a
  shared playhead store. Adapted from SundayEdit's NLE timeline math (same owner) rather
  than a shared package for now. No UI changes yet — S1 of the v0.3 program; the
  interactive timeline itself lands in later stages.
- **Fixed export hint: media-pool-first Resolve import order.** Owner-verified A/B testing
  traced the "clip was not found" failure on large exports to Resolve's Load XML media
  *matcher*, not media ingest or our FCPXML. The in-app hint now instructs importing the
  media files into Resolve's Media Pool first, then File → Import Timeline (Load XML) —
  the matcher then binds against the already-imported clips, which is required for large
  files. `docs/KNOWN_LIMITATIONS.md` corrected to describe the matcher mechanism and the
  workaround instead of the earlier "scripted import refuses multi-GB media" framing.

## v0.2.0-beta.4 — 2026-08-09

The corpus-calibration beta: three more real multicam projects (2013–2023) taught the
engine how real material actually behaves.

- **Far better recall, same zero-false record (D-049).** Matches with enough segments to
  measure a clock are now judged by physics first: a credible drift regression admits a
  clip down to a lower PSR bar, because on real material one quiet stretch between songs
  used to drag a true 23-minute clip below the old flat threshold. Every previously
  refused *false* match stays refused (they all carried impossible clocks). Measured:
  a 5-camera living-room session went from 2 placeable snippets to the real takes;
  a 2013 audition corpus went from 2 to 9 placements.
- **Multitrack recordings survive (D-050).** A folder of per-channel board exports
  (Ch01…Ch16) no longer collapses to one channel — three or more clips that cover each
  other almost entirely are physically impossible from one camera and are kept, each on
  its own lane.
- **Cleaner scans (D-050).** GoPro/DSLR thumbnails and the AVCHD index family
  (`.thm`/`.cpi`/`.bdm`/`.mpl`/`.tdt`/`.tid`) no longer show up as "broken media".
- **Drift measurements validated against PluralEyes** on a real project: agreement to
  ±2 ppm with its drift-corrected output — and drift correction (timeMap) engaged on
  real footage for the first time.

## v0.2.0-beta.3 — 2026-08-09

The night-review beta: a four-reviewer full-code audit found and fixed **20 confirmed
defects** (6 high). If you only read three:

- **Windows exports work now** — every `file://` URL in a Windows-built FCPXML was
  unrelinkable in Resolve.
- **Better placements** — the transitive pass kept the *last* acceptable anchor instead
  of the strongest, and one long clip could hide overlapping shorter ones from the
  same-camera eviction.
- **Telemetry that actually arrives** — the path scrubber was narrower than the
  server's screen, so some payloads were silently rejected wholesale; the entire wire
  contract is now pinned as tests. Consent revocation now halts an in-flight send, and
  two app instances can no longer corrupt each other's state.

Also: a camera chosen as the sync reference now exports **with** picture; cache
maintenance and a running sync are mutually exclusive (no more mid-sync cache
evictions); `--min-psr` rejects values that would have disabled the acceptance gate;
scanning shows real progress; macOS builds are **code-signed** (from beta.2); telemetry
build metadata is stamped correctly; `npm audit` is clean including dev dependencies.
(D-046–D-048.)

## v0.2.0-beta.1 — 2026-08-08

The "Solid in Use" release: everything the v0.2 program (docs/V02-PROGRAM.md, stages
E1–E10) built, in one beta. Decision log references in parentheses.

### Nothing to install
- **ffmpeg is bundled.** Download → open → sync. The v0.1.0 "ffmpeg ble ikke funnet"
  bug (macOS gives GUI apps a minimal PATH) is gone; a system ffmpeg is only a fallback.
  Installer grew accordingly — honestly documented in KNOWN_LIMITATIONS. (D-031)

### Sync quality — the headline
- **Drift correction.** Clips on a fast/slow camera clock now stay in sync to the last
  second: the exporter writes a per-clip `<timeMap>` retime into the FCPXML (no media is
  touched; DaVinci Resolve applies it exactly, verified live against Resolve Studio 21).
  On by default for clips drifting more than half a frame; toggleable in Settings.
  A 90-minute 40 ppm camera lands both ends on the reference instead of ~108 ms out.
  (D-042, closes D-016)
- **The credibility gate.** Learned from the first real corpus: a match must now be
  *physically believable* — segment offsets that cannot be one rigid recording against
  another (an edited mix used as a reference, sidelobe hits) are refused instead of
  placed-with-a-warning, and short clips with no segment evidence must clear a higher
  PSR bar. All three false placements observed on real footage are refused; the real
  placement and every synthetic accuracy gate survive unchanged. (D-045)
- **`.lrv` proxy files are skipped** during folder scans (Insta360/GoPro low-res
  duplicates of a sibling original) — no more duplicate content on one device. (D-045)

### Speed & footprint
- **Correlation is ~4× faster**: the reference's FFT is finally computed once and cached
  (a 3-hour service drops from ~3.5 min to ~1 min of correlation), with placements
  proven bit-for-bit identical. (D-038)
- **Memory ceiling proven**: a long-service sync peaks at ~2.4 GB, under the 4 GB
  promise (was over it before the fix). (D-034)
- **Probing is parallel** (byte-identical results), the scan shows live progress, and
  the analysis cache now cleans itself: entries untouched for 90 days are swept at
  startup, with an optional size cap in Settings. (D-040, D-041, closes D-013)

### Trust & privacy
- **Security hardening**: ffmpeg/ffprobe run behind a protocol whitelist (a hostile
  "media" file can no longer make them fetch URLs or read arbitrary files), a strict
  CSP, scrubbed support diagnostics (no paths, names, or labels leave the machine),
  supply-chain gates in CI, and a fuzzing suite. (D-032, D-033)
- **Anonymous, opt-in telemetry** — off until you say yes. Versioned consent at first
  launch, a random install-id, deletion on request, and a payload of counts and coarse
  buckets only: never filenames, folders, device names, or anything from your content.
  "Show what we send" in Settings displays the exact payload. Data controller:
  SundaySuite. *(The server side ships separately; until then the app sends nothing.)*
  (D-043)
- **In-app auto-updater** with a stable and a beta channel (Settings → System). Updates
  are cryptographically signed; the update check sends no version or system information
  in the URL. (D-044)

### Robustness
- Adversarial-media suite (truncated files, lying headers, exotic rates/layouts), a
  100-run cancellation storm, two-instance concurrency safety, uniform poison-recovery
  in the app shell, an export-staleness guard, and 36 end-to-end UI tests now gate every
  change. (D-036, D-037)

### Known limitations worth reading
- A produced/edited mix is **not** a valid sync reference — the app now refuses it
  honestly instead of guessing. Use a raw recorder file or the longest camera.
- Short clips (< ~45 s) clear a higher confidence bar and may be refused where v0.1
  would have gambled.
- macOS builds are not yet notarized (right-click → Open on first launch); Windows
  SmartScreen will warn.

## v0.1.2 — 2026-08-08
- Bundled ffmpeg/ffprobe (fixes "ffmpeg ble ikke funnet" on machines where it IS
  installed — the GUI-PATH bug), GUI-invisible PATH fallbacks, onboarding self-test.

## v0.1.0 — 2026-07-28
- First test release: GCC-PHAT engine (−0.01 ms on the accuracy suite,
  Resolve-verified), scan → sync → FCPXML for DaVinci Resolve, dark UI, onboarding.
