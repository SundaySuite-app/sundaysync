# Changelog

## Unreleased

### Changed

- **Vinduet sier ikke lenger navnet sitt to ganger (D-058).** Den innebygde macOS-tittellinja
  skrev «SundaySync» rett over appens eget ordmerke. Tittelteksten er nå skjult i vinduet;
  navnet står fortsatt i Mission Control, i Dock og i ⌘-tab, der systemet trenger det. Selve
  tittellinja er urørt — knappene sitter der de alltid har sittet, ingenting er flyttet.
- **Ikonet hører hjemme i familien (D-058).** Korset i SundaySync-ikonet har nå nøyaktig samme
  form som i SundayRec, bølgene er tegnet tynnere, og gullet er den samme to-trinns
  gradienten som resten av suiten bruker. Lilla bakgrunn og den hårfine hvite ringen er som
  før. Hele ikonsettet er generert på nytt fra kilde-SVG-en, og de to kommandoene som gjør
  det står nå dokumentert i SVG-en selv.
- **The timeline is the main view now (D-061).** Drop your files and they are on the
  timeline immediately — one track per device, each clip where its own recording timestamp
  says it belongs — instead of a list of filenames you have to sync before you can see
  anything. The picture is what tells you whether the app read your card properly, so it
  arrives first. Those pre-sync clips are drawn in a muted grey, not the placed green: they
  are the files' own claim about when they were recorded, not the engine's. Files with no
  timestamp at all (a field recorder's WAV usually has none) sit at the start, and the
  timeline says in as many words how many they are, rather than quietly implying they all
  began together.
- **The timeline stays on screen while the sync runs.** Pressing Sync no longer replaces
  everything with a progress bar on an empty screen: the progress and its Cancel appear
  above the clips, which stay visible and dimmed until the result lands in their place.
  Nothing you were looking at moves out from under you.
- **The file list is now a compact panel under the timeline.** Everything it did before it
  still does — starring a reference, moving a file to another device, the badges, the
  summary chips — it just no longer has to be the main event.
- **Unusable files fold into one collapsed group.** The count still shows (on its own chip
  and on the group's own line); the list of them is one click away instead of being the
  loudest block on the screen when the drop went fine.

## v0.3.0-beta.1

**v0.3 — see it, and hear it, before you export.** The result screen stops being a report
you have to take on trust and becomes something you can actually inspect: a real timeline
with waveforms, at any zoom, that you can play.

### New

- **The result view is a real timeline (D-051).** The old per-device lanes drew every clip
  as a percentage of the widest span, so a four-second offset inside a ninety-minute
  service was a sliver too small to judge. The new view has a zoom: fit the whole day on
  screen, then wind in until the millisecond the engine is claiming is visible as a
  millisecond. ⌘/Ctrl-scroll or `+`/`−` zooms around the cursor, `0` or `F` fits, a
  sideways (or shift-) scroll pans, dragging the background pans, dragging the ruler moves
  the playhead. Clips from one device that cover the same instant (a multitrack board dump)
  stack into separate rows instead of hiding behind each other, and a device that synced
  nothing still gets its own track, still saying so. The clip-detail dialog, the red "not
  synced" shelf with its move-to-device fix, the green/orange colour language and the
  dimming of a stale result are all unchanged — this is the same information, finally at a
  readable scale. Still a viewer, not an editor: clips do not drag.
- **Every clip draws its own waveform (D-052, D-054).** A faint peak outline behind a solid
  RMS body, at whatever detail the current zoom can actually show. It is drawn from the
  analysis audio the sync already cached, so it costs **no ffmpeg spawns and no second
  decode** of your media — and it is a picture of the very signal the offsets were computed
  from, not an independent approximation of it. Waveforms are anchored to real time, so if a
  camera's audio ends before its video the last stretch of the clip is simply left
  unpainted, which is the truth. A clip whose cached analysis has been swept (or was never
  built) shows a small "Rebuild waveform" control in place of the canvas; one click brings
  it back. If a sync or another cache-maintenance pass is running, the same control
  relabels with why and stays retryable rather than dead-ending.
- **You can hear whether the sync is right, before exporting (D-055).** The timeline has a
  transport: press play (or Space) and every clip sounds at once, at the offsets the engine
  worked out. Two recordings of the same room that are correctly aligned sound *phasey* — a
  hollow, chorus-like doubling, which is what two copies of one sound a few samples apart
  do. A distinct echo means something is wrong, and now you find that out in ten seconds
  instead of after an export and a round trip through Resolve. Each device gets **M** (mute)
  and **S** (solo) buttons in its track gutter, so "which one of these is late?" is a
  question you can answer by ear. Click the ruler to seek while playing. The audio is the
  **12 kHz mono analysis audio the sync engine itself listened to** — dull and lo-fi on
  purpose, and the transport says so: it is there to prove alignment, not to be a mix. No
  re-decoding, no second copy of your media, no network. A clip whose cache entry has been
  swept says so and is skipped; the rest keeps playing.
- **Drift correction during playback is now switchable in Settings (D-055, D-057).**
  Measured clock drift is corrected in playback exactly as it will be on export, and the
  new toggle turns that off so you can hear the difference. Separate from the export
  setting on purpose — comparing the two is the point — and it takes effect immediately,
  mid-playback, rather than at the next launch.
- **The timeline works from the keyboard (D-057).** `←`/`→` nudge the playhead a second at
  a time (ten with shift), `Home`/`End` jump to the ends, Space plays and pauses, `+`/`−`
  zoom, `0`/`F` fit. The scrollbar is a proper tab stop with arrow, page, Home and End keys.
  The clip the playhead is standing in is announced as the current one. None of these fire
  while you are typing in a field or adjusting the volume slider.

### Fixed

- **The waveform inside each clip is drawn against real time (D-056).** It used to be
  stretched to fill the clip's box exactly, which sounds harmless and is not: the box's
  width comes from the container's duration and the waveform's bins come from the decoded
  audio, and those two disagree by anything from a few milliseconds to most of a second on
  a normal camera file. Closing that gap by stretching moved everything in the middle of
  the clip too — up to 400 ms out of place on a one-hour clip, and by a different amount on
  each camera. On a view whose whole job is letting you see whether clips line up, that
  meant correctly-synced material could be drawn looking misaligned.
- **Waveform bars no longer smear together on a non-retina display (D-056).** At some zoom
  levels each bar was drawn twice as wide as its slot and painted over its neighbour —
  invisible on a built-in retina screen, plainly visible on an external monitor. Detail is
  now chosen against the screen's actual pixels, so a retina display also gets the finer
  waveform it can genuinely show.
- **The timeline scrollbar no longer freezes before the end (D-056), and grabbing the thumb
  no longer jumps the view (D-057).** Zoomed in far on a long service, the thumb used to
  stop moving over the last few minutes of material while the timeline underneath kept
  scrolling. Separately, pressing the thumb anywhere but its exact middle threw the view
  half a screen sideways before the drag had even begun; the thumb now stays under your
  finger, and clicking the empty track still jumps.
- **Scrolling the page over the timeline works again (D-057).** The timeline swallowed every
  scroll and turned it into a sideways pan, so the export bar and the "not synced" shelf
  below it could not be reached by scrolling over the thing filling the screen. A plain
  scroll is the page's again; sideways and shift-scroll still pan.
- **A waveform that fails to load is no longer stuck for the session (D-056).** A one-off
  read failure used to leave that clip permanently blank; changing the zoom now gives it
  another go. A clip with an unreadable waveform can also still be clicked to open its
  details — the "unavailable" line no longer swallows the click.
- **"Already busy" now says so in Norwegian (D-056).** Asking to rebuild a waveform while a
  sync is running showed the engine's own English message dressed up as a crash («Noe gikk
  galt: busy: sync in progress»). It now reads as what it is — an expected wait — with the
  technical detail on hover.
- **The end of a clip is no longer drawn louder than it is (D-056).** The last bin of every
  zoom level averaged a short trailing piece of audio as if it were full length, which could
  show the final fraction of a second up to ~58 % too loud.
- **Zoomed all the way out on a multi-hour shoot, the timeline was doing far more work than
  it drew (D-056).** The waveform detail ladder now goes coarse enough for the widest zoom,
  so a 3-hour clip stops computing ~19 bars for every pixel it paints.
- **Rebuilding a waveform can no longer leave the old one on screen (D-057).** A read that
  landed in the wrong moment could put the stale picture back into memory *while* the entry
  was being rebuilt, and it would then be shown for the rest of the session — in exactly the
  case the rebuild button exists for.
- **A clip whose length the app does not know now says so (D-057).** It used to be drawn as
  a three-pixel sliver, indistinguishable from a camera that recorded half a second.
- **Fixed export hint: media-pool-first Resolve import order.** Owner-verified A/B testing
  traced the "clip was not found" failure on large exports to Resolve's Load XML media
  *matcher*, not media ingest or our FCPXML. The in-app hint now instructs importing the
  media files into Resolve's Media Pool first, then File → Import Timeline (Load XML) — the
  matcher then binds against the already-imported clips, which is required for large files.
  `docs/KNOWN_LIMITATIONS.md` corrected to describe the matcher mechanism and the workaround
  instead of the earlier "scripted import refuses multi-GB media" framing.

### Faster

- **Opening a result no longer reads gigabytes it does not need (D-057).** Every clip on
  screen asked the engine to describe its waveform, and answering meant streaming the whole
  cached analysis for that clip — on an eight-camera hour-long shoot, over a gigabyte of
  disk reads the instant the results appeared, including for clips just off the edge of the
  screen. The answer is now arithmetic, and the audio is read only for waveforms actually
  drawn.

### QA

- **Scale, memory and the owner's listening protocol (V03-S7).** A Playwright suite proves
  the interactive timeline stays responsive at real-service scale — six devices, 302
  placements across an exact 3-hour span, several overlapping per device — by checking
  that only the clips near the visible window ever get a DOM node
  (`app/e2e/timeline-scale.spec.ts`). A vitest simulation drives the playback chunk
  planner across a 3-hour, 10-device sweep and confirms resident audio never exceeds the
  documented 256 MB budget, and that nothing needed is evicted while still needed
  (`app/src/audio/playbackMemory.simulation.test.ts`). `docs/QA_TIMELINE_LISTENING.md` is
  the practical, Norwegian checklist for running all of this against real multicam footage
  by ear — sync a real shoot, listen for the comb-filtered doubling that means "in sync"
  versus the distinct echo that means "bug," check drift correction and mute/solo, and
  confirm Resolve agrees with what was heard.

### Internal

- **Waveform peaks pipeline (D-052).** `crates/core/src/peaks.rs` — a streamed
  multi-resolution peak+RMS pyramid built from the analysis audio the sync engine has
  *already* cached. Thirteen levels span 10 ms to 40.96 s per bin (D-056 raised the ceiling
  from 2.56 s); level data reaches the UI as raw bytes (an `ArrayBuffer`), not JSON. Three
  shell commands (`waveform_meta`, `waveform_level`, `regenerate_analysis`) with a 64-entry
  in-memory cache. Reading a waveform is read-only and deliberately does not block, or get
  blocked by, a running sync (D-046). `peaks::meta_from_sample_count` derives the ladder's
  shape from a sample count alone, held bin-for-bin equal to the fold by test (D-057).
- **Timeline math foundation (D-051).** `app/src/timeline/` — pure, unit-tested modules for
  time↔pixel mapping, zoom-around-anchor, ruler ticks, clip virtualization, multi-row
  overlap layout, a shared playhead store, and the scrollbar's forward and inverse mappings.
  Adapted from SundayEdit's NLE timeline math (same owner) rather than a shared package for
  now.
- **Playback engine (D-055).** `app/src/audio/` — a sample-accurate Web Audio scheduler over
  windowed PCM reads from the analysis cache (`read_audio_window`), with its schedule
  mirrored for the Playwright tier so every timing claim is asserted rather than assumed.
- **`THIRD-PARTY-NOTICES` added (D-053)**, carrying Clypra's MIT licence for the bucket
  peak/RMS math adapted in `peaks.rs`. Their `HTMLAudioElement` playback transport
  (0.5–2.0 s drift tolerance), per-zoom ffmpeg waveform extraction and unvirtualized
  timeline were reviewed and deliberately not adopted.

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
