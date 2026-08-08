# Changelog

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
