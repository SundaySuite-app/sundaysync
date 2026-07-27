# Decisions

Deviations from [`PLAN.md`](PLAN.md), new dependencies (§13.3), and anything learned about
Resolve's importer (§13.6). Newest last. The plan stays authoritative; this file records
where reality differed and why.

---

## D-001 — Crate packages are `sundaysync-*`, not bare `cli` / `core`

**Phase 0.** PLAN §3 names the directories `crates/core`, `crates/cli`, `crates/fixturegen`,
and §11 writes the Phase 0 acceptance command as `cargo run -p cli -- sync --help`.

The directories are as specified, but the cargo *packages* are `sundaysync-core`,
`sundaysync-cli` and `sundaysync-fixturegen`, matching SundayRec's `sundayrec-core`
precedent and avoiding a package literally named `cli`. The acceptance command is
therefore:

```
cargo run -p sundaysync-cli -- sync --help
```

The **binary** is still `sundaysync`, so the user-facing command surface is unchanged.
Not treated as an irreversible decision under §0 (it is not a file format, result schema,
or public CLI flag).

## D-002 — `unwrap`/`expect` lints are crate-scoped, and the workspace lint block is duplicated

**Phase 0.** §7.1 forbids `unwrap`/`expect` in `core` outside tests. Implemented as
`unwrap_used = "deny"` / `expect_used = "deny"` in `crates/core/Cargo.toml`, with the
in-test carve-out (`allow-unwrap-in-tests`, `allow-expect-in-tests`) in the workspace-root
`clippy.toml` — that file has no per-crate form, so it must live at the root even though
the lints do not.

The lints are deliberately **not** applied to `cli` or `fixturegen`: the stability promise
in §7 is about the engine, and a panic in a dev tool that is about to exit is not the
failure mode the plan is defending against.

Cargo rejects a crate that both inherits `lints.workspace = true` and adds its own
entries, so `crates/core/Cargo.toml` restates the two `rust` lints and `clippy::all`
verbatim. **These must be kept in sync manually with the root `Cargo.toml`.**

Verified by injecting an `unwrap()` into `crates/core/src/request.rs` and confirming
`cargo clippy -- -D warnings` fails, while the existing tests (which use `unwrap` freely)
stay green. A lint that is configured but does not fire is worse than none.

## D-003 — Frame rates are an exact `Rational`, never `f64`

**Phase 0.** §5 serialises `sequence.fps` as the string `"25/1"` and §6 requires FCPXML
frame durations as exact rationals. `crates/core/src/rational.rs` implements a reduced,
strictly-positive rational that serialises to/from that string form.

`Rational::new()` returns `Option`, not a panicking constructor, because frame rates come
from ffprobe — i.e. from untrusted file metadata. `0/0` is not hypothetical: ffprobe
reports exactly that for the audio stream of an ordinary MP4 (observed during the kickoff
validation below).

## D-004 — ⚠️ Codec decoder delay is a live threat to the ±10 ms accuracy gate

**Phase 0, found during environment validation — carry this into Phase 3.**

ffmpeg/ffprobe 8.1.2 were installed via Homebrew (they were absent from the machine
entirely). Both command lines in the plan were validated live:

- §4.1 `ffprobe -v error -print_format json -show_format -show_streams` returns everything
  the probe stage needs, including `r_frame_rate` as a rational (`25/1`) and the
  `format.tags.creation_time` path. The **audio** stream of a normal MP4 reports
  `r_frame_rate = 0/0` — hence D-003's `Option`-returning constructor.
- §4.2 `ffmpeg -map 0:a:0 -ac 1 -ar 12000 -f f32le` works, and costs **46.9 KB/s**,
  confirming the plan's ~48 KB/s cache-footprint estimate.

**The finding:** a **3.000 s** AAC/MP4 test file decoded to **36 096 samples = 3.008 s** —
an 8 ms overshoot attributable to AAC encoder priming/padding.

The §8.2 gate is **±10 ms**. A systematic per-codec decoder delay would consume most of
that budget by itself, and — because it is *constant per device* — would present as a
plausible sync result rather than an obvious bug. Cameras in one shoot routinely use
different codecs, so this is the target scenario, not an edge case.

**Consequences for Phase 3:**
1. `fixturegen` (§8.1) must emit fixtures spanning **multiple codecs** — at minimum
   PCM/wav, AAC, and one long-GOP camera codec. A wav-only suite would pass CI green
   while the product mis-syncs every real camera.
2. Decode alignment must be verified against known truth **per codec** before `MIN_PSR`
   is calibrated, so calibration is not fitted to a codec-specific bias.
3. If a per-codec constant offset is confirmed, decide explicitly whether to compensate
   in the extraction stage or to document it — and record that here.

## D-005 — CI runs the full gate on ubuntu, plus a build/test pass on macOS and Windows

**Phase 0.** §11's Phase 0 criterion reads "CI green on all three platforms' checks",
while §8.4 specifies the per-push gate as an ubuntu runner with Win/mac bundles only on
tags. Resolved in favour of the stricter reading, since the repo is public and Actions
minutes are therefore free:

- **ubuntu** — the full gate: `fmt`, `clippy -D warnings`, `cargo test`, and the §11
  acceptance command, plus a separate `cargo audit` job.
- **macOS + Windows** — `cargo test --workspace` only. Enough to catch platform-specific
  breakage (path handling, child-process spawning, line endings) on the commit that
  introduced it rather than at the Phase 9 release build.

**Resolved in Phase 1** — the skip-path option, with a guard against the obvious failure
mode. Tests needing ffprobe call a helper that skips (printing `SKIP: …`) when the binary
is absent, *unless* `SUNDAYSYNC_REQUIRE_FFMPEG` is set, in which case the skip becomes an
assertion failure. The ubuntu job sets it. So the probe suite runs for real on the
platform with the full gate, a broken ffmpeg install there fails loudly instead of
quietly skipping, macOS/Windows stay ~30 s instead of several minutes of brew/choco, and
a contributor without ffmpeg can still run `cargo test`. Revisit if a platform-specific
decode bug ever slips through.

## D-006 — Dependencies added in Phase 0

Per §13.3, one line each:

| Crate | Why |
| --- | --- |
| `serde` + `serde_json` | The `SyncResult` contract (§5) is JSON; the CLI and the diagnostics zip both emit it. |
| `thiserror` | §7.1 requires typed errors on all fallible paths. |
| `clap` (derive) | CLI argument parsing; `derive` keeps `--help` and the parsed struct from drifting apart. |

No FFT, XML or hashing dependency yet — `rustfft`, `quick-xml` and `blake3` arrive with
the phases that need them (3, 5 and 2 respectively).

## D-007 — Device labels are bare values; the UI supplies the localised prefix

**Phase 1.** §4.5 gives example labels "Sony A7 IV", **"Mappe: Balkong"**, "Zoom H6". The
middle one is Norwegian, and §9 requires a bilingual (nb + en) UI — so emitting it from
the engine would hardcode one language into the wire contract and leave the English UI
showing Norwegian.

`Device.label` therefore carries the bare value (`"Balkong"`), and the provenance is
recoverable from `Device.id`, which is namespaced by the heuristic that produced it
(`folder-balkong`, `model-sony-ilce-7m4`, `name-zoom`, `sig-h264-1920x1080-25-1`). The UI
renders "Mappe: Balkong" or "Folder: Balkong" from the `folder-` prefix. No §5 schema
change was needed.

## D-008 — §4.5 heuristics are applied per file, not per shoot

**Phase 1.** §4.5 lists four heuristics "in priority order" without saying whether the
order picks one strategy for the whole input set or is a per-file fallback chain.
Implemented as **per file**.

A real shoot is mixed: three cameras that write a `model` tag plus a Zoom recorder that
writes none is the typical case. A set-wide choice would observe "not every file has
metadata", fall back to filenames for everything, and discard camera identities it
already had. Keys are namespaced by heuristic so two files can never collide across
strategies. Covered by `a_mixed_shoot_keeps_camera_identity_and_still_groups_the_recorder`.

Two sub-decisions inside heuristic 1 (folders), both driven by realistic layouts:

- The key is the first subdirectory **below** a dropped folder, not the dropped folder
  itself. Dropping one `Opptak/` containing `Balkong/`, `Scene/`, `Zoom/` is how people
  actually organise card dumps; keying on the drop root would collapse all three into
  one device.
- Files sitting *directly* in a single dropped folder do not group by it — the key would
  be constant and carry no information — so they fall through to the filename heuristic.

`device::group` is a pure function and does not touch the filesystem. The caller passes
the directory subset it already established while walking. An earlier version re-derived
it with `is_dir()`, which made grouping depend on disk state that can change mid-run and
made the logic untestable without creating real directories per case.

## D-010 — ⚠️ A killed child does not close its pipes; never join readers on the timeout path

**Phase 1, found by CI.** The first version of `sidecar::run` polled `try_wait`, killed
the child on timeout, then joined the stdout/stderr reader threads before returning. That
is wrong, and wrong in a way that silently defeats the timeout.

**Killing a process does not close pipes its own children inherited.** `sh -c "sleep 30"`
under Ubuntu's dash forks `sleep`, which inherits the write end of our stdout pipe.
Killing the shell leaves `sleep` holding it, so `read_to_end` — and therefore `join()` —
blocks until the *grandchild* exits. A 150 ms timeout returned after **30.002 s**.

The fix: on the timeout path, return immediately without joining, and discard the output
(a timed-out probe has nothing trustworthy to say anyway). The detached threads are
harmless — each is blocked on a read that ends when the pipe finally closes.

**Two things worth remembering from this:**

1. **It was invisible on the development machine.** macOS's `sh` *execs* `sleep` rather
   than forking, so killing the child did close the pipe and the test passed locally. It
   only failed on the ubuntu runner. This is the concrete justification for the
   cross-platform CI jobs added in D-005 — they earned their keep on the very next phase.
2. **The consequence was not limited to tests.** An unbounded wait here would have broken
   §7.2 (a bad file cannot stall the run) and §7.4 (cancel returns within 2 s), because
   both ultimately depend on `run()` actually returning when it says it will.

Regression test: `a_grandchild_holding_the_pipe_cannot_extend_the_timeout`, which uses
`sleep 300 & wait` to force the fork on *every* shell rather than relying on dash's
behaviour. Verified to fail against the old code — it hangs past 45 s — and to pass in
0.6 s against the fix.

## D-011 — Extraction returns cache handles, not audio; `AnalysisAudio` stays opaque

**Phase 2.** §7.7 requires a memory ceiling independent of shoot length and mentions
memory-mapping the analysis PCM. Two consequences for the API:

`Extractor::extract_all` populates the cache and returns [`CachedAudio`] *handles*;
samples are read on demand via `CachedAudio::load()`. Returning the audio itself would
blow the ceiling on its own — measured at 46.9 KB/s, a twenty-hour day is ~3.4 GB before
any FFT has allocated. §4.3 correlates one clip against the reference at a time, so that
is all that ever needs to be resident.

`AnalysisAudio` is opaque, exposing `samples() -> &[f32]`. It holds a `Vec<f32>` today.
**Memory-mapping is deliberately deferred to Phase 3**, when the FFT access pattern is
known and can say whether it is needed — and because `memmap2::Mmap::map` is `unsafe`,
which collides with the `unsafe_code = "forbid"` lint set in Phase 0. Adopting mmap means
relaxing that to `deny` plus a narrowly-scoped `#[allow]`. Making that trade now, before
there is a measured reason, would be premature. The opaque type means the switch is an
implementation detail rather than an API break.

## D-012 — Cancellation had to move into `sidecar::run`

**Phase 2.** §7.4 requires cancel to return within 2 s. Through Phase 1 that held for
free: probing takes ~30 ms, so a token checked between files was indistinguishable from
one checked continuously.

Extraction breaks that. Decoding a two-hour service takes far longer than two seconds, so
a token checked only at file boundaries would leave the Cancel button dead for the rest of
the decode. `sidecar::run` therefore takes a `&CancelToken` and kills the child mid-flight,
with a new `RunFailure::Cancelled`. Cancellation is checked *before* the deadline in the
poll loop, so a user who cancelled is told "cancelled" rather than "timed out" even if
both happened in the same instant.

Threaded through `probe` as `ProbeError::Cancelled`, which `scan` maps to
`Error::Cancelled` — deliberately **not** to `decode_error`, which would slander the
user's media for the crime of stopping the run.

## D-013 — Cache footprint: the per-second figure holds; the growth over time is unmanaged

**Phase 2, measured.** §4.2 estimates "~48 KB/s ≈ 1–2 % of source size" and tells the UI
to present this as a non-issue. Measured on 180 minutes of audio across 5 files:

| | |
| --- | --- |
| Cache rate | **46.9 KB per audio-second** — confirms the plan's ~48 KB/s |
| Cold extract | 7.1 s (peak concurrency 4, matching the §4.2 cap) |
| Warm extract | sub-millisecond, 0 ffmpeg processes |
| Cache for 3 h of audio | **518 MB** |

**The ratio claim is fine for real camera footage** — at 25–100 Mbit/s, 46.9 KB/s is
0.4–1.5 % of source, so a video-dominated shoot lands where the plan says. (An earlier
check against a synthetic `testsrc` clip suggested ~35 %, but that is meaningless:
`testsrc` compresses to roughly a hundredth of real sensor footage.)

**Two caveats the plan's framing misses, both about audio-only inputs:**

1. The ratio inverts for the recorder feed, which is usually the *longest* file and hence
   usually the reference (§4.4). Against a WAV feed the cache is ~16 % of source; against
   FLAC ~33 %; against a compressed `.m4a` feed it is **~290 %** — several times the
   source it came from.
2. **There is no eviction policy, and the plan does not mention one.** The cache grows by
   ~169 MB per audio-hour and nothing ever removes it. A church syncing a weekly service
   accumulates tens of GB over a year, silently.

Neither blocks Phase 2, and neither is a correctness problem. Both are **inputs to Phase
8** (advanced mode owns the cache directory setting) **and Phase 7's UI copy** — the
tooltip §4.2 asks for should not flatly call this negligible without showing the actual
number. Flagged rather than fixed here because sizing an eviction policy is a product
decision, not an engineering one.

## D-014 — ⚠️ The fixture reverb was lying, and it looked exactly like D-004

**Phase 3.** The first accuracy run showed every AAC clip measuring **−5.01 ms**,
consistently, across clips and seeds. That is precisely the signature D-004 predicted for
per-codec decoder delay: a constant per-codec bias that looks like a plausible result. It
would have been easy — and wrong — to write it up as confirmation and start compensating
for it in the engine.

FLAC also showed −1.24 ms. FLAC is lossless and has no decoder delay, which meant the
codec explanation could not be the whole story. Isolating each transform separately gave:

| transform | bias |
| --- | --- |
| none, gain, tilt, noise | 0.00 ms |
| reverb 0.20 | 0.00 ms |
| **reverb 0.55** | **−5.00 ms** |
| **reverb 0.80** | **−5.00 ms** |

The allpass delay in the fixture reverb is 5 ms, exactly. The reverb mixed
`dry * (1 - mix) + wet * mix`, where `wet` came from a comb bank that *included* the
direct sound and then through an allpass whose delayed term has unity gain against a
−0.7 direct term. Above `mix ≈ 0.5` the 5 ms-delayed copy became the strongest correlated
component in the signal. **The correlator was right; the fixture was wrong.**

Fixed by making the model physical: the direct arrival is always present at unity and is
always the loudest thing, with the tail (comb output *minus* the direct) summed on top.
Raising `mix` now makes the correlator's job harder — the point of the parameter —
without ever moving the true arrival. After the fix all transforms measure 0.00 ms bias,
and AAC's real error is **−0.01 ms**.

**The lesson is about method, not reverb.** A fixture suite is a measuring instrument, and
a plausible-looking result that matches a hypothesis you already hold is exactly when to
check the instrument. Had this shipped, the engine would have been "corrected" to
compensate for a bias that does not exist in real media, breaking it on every real shoot
to match a broken test.

D-004 itself remains open and unfalsified — it is simply not what this was. Real per-codec
delay, if any, is now measurably **≤ 0.01 ms** on AAC and MP4 through the ffmpeg decode
path, which is two orders of magnitude inside the §8.2 budget.

## D-015 — `MIN_PSR` calibrated to 15.0 (the plan's 5.0 was below the noise floor)

**Phase 3.** §4.3 requires calibration "against the synthetic suite to achieve zero false
positives while keeping false negatives < 5 %". Measured across five shoots (four `quick`
seeds plus one `full`), 16 syncable clips and 10 deliberately uncorrelated files, spanning
WAV, FLAC, AAC and MP4:

| | |
| --- | --- |
| Lowest PSR on a real match | **30.9** |
| Highest PSR on unrelated audio | **9.2** |
| Separation | 3.4x |
| Geometric midpoint | 16.9 |

**The plan's worked example of 5.0 sits below the noise floor** — unrelated audio scores
5.5–9.2 — and would have placed pure noise on the timeline. This was caught by the gate
that asserts uncorrelated fixtures are refused, which is exactly why §8.1 insists the
suite contain files with no correlation at all.

Set to **15.0**: 1.6x above the worst false positive, 2.1x below the weakest true
positive. Erring high is deliberate — §7.5 makes honest failure the core promise, so a
false negative (visible on the unsynced shelf) is much cheaper than a false positive
(a silently corrupted timeline).

**Must be re-validated against the real corpus in Phase 6.** Synthetic material cannot
prove a threshold for real rooms.

## D-016 — ⚠️ Uncorrected drift will exceed the §8.2 gate on long clips — raise with Richard

**Phase 3, measured.** On the `full` suite the correlator is essentially exact on
non-drifting clips (**−0.01 ms**), and every residual error is accounted for, to the
millisecond, by injected clock drift:

| clip | drift | length | predicted (drift x length / 2) | measured |
| --- | --- | --- | --- | --- |
| cam-phone | 60 ppm | 300 s | 9.0 ms | **−9.51 ms** |
| cam-stage | 40 ppm | 400 s | 8.0 ms | **−8.01 ms** |
| cam-wide | −25 ppm | 280 s | 3.5 ms | **+3.34 ms** |

The half-drift relationship follows from §4.3 taking the *median* of segment offsets,
which estimates the offset at the clip's midpoint; error is therefore ±(total drift / 2),
zero in the middle and worst at both ends.

**This scales badly, and the plan's numbers collide.** §4.6 defers drift *correction* to
v2, but §8.2 requires ≥95 % of clips within ±10 ms. Median placement holds that only while
total drift stays under 20 ms — about **8 minutes** of clip at 40 ppm. A church camera
recording a 90-minute service continuously at 40 ppm accumulates 216 ms, giving a ±108 ms
error: outside ±10 ms, and outside the ±1 frame (40 ms) gate too.

So one of these must give, and it is not my call to make (§13.2):

1. **The gates assume short clips.** Fine if real cameras stop and restart often enough,
   which the Phase 6 corpus can settle — but it should be stated, not assumed.
2. **Place on the clip's start rather than the median.** Zero error at the start, full
   drift by the end. Arguably the better fit for FCPXML, which positions a clip *by* its
   start — but it contradicts §4.3's explicit "median offset is the estimate", so it is a
   plan change, not an implementation detail.
3. **Drift correction moves into v1**, contradicting §1.3 and §2.

Nothing is blocked today: the `quick` and `full` suites both pass as written, because
their clips are short enough. This is raised now because the Phase 6 corpus is where it
will bite, and because the drift data §4.6 already requires is exactly what any of the
three options needs.

## D-017 — Test builds are optimised; the fixture generator does not depend on the engine

**Phase 3.** Two small structural decisions:

`[profile.test] opt-level = 2`. The correlator is FFT-bound, and an unoptimised build made
§8.1's "quick suite in seconds" unreachable: the same accuracy run took **108 s** at cargo
defaults and **9.8 s** optimised. Debug assertions and overflow checks are retained, so
§7.3's invariants are still enforced during tests.

`sundaysync-fixturegen` deliberately does **not** depend on `sundaysync-core`; core
dev-depends on fixturegen instead. A measuring instrument that imports the thing it
measures can inherit its bugs — and after D-014, that is not a theoretical concern.

## D-018 — JSON round-trip is not bit-exact, and that is fine

**Phase 4, measured.** `serde_json` serialises an f64 correctly, but its parser is not
always correctly-rounded: over 200 000 values in the ±5000 s range, **9.7 %** come back
differing by exactly one ULP. Worst case is 4.5e-13 s — 0.45 picoseconds, eleven orders of
magnitude below a video frame.

Not worth fighting, and not a risk: the engine never round-trips through JSON in the
product path (the FCPXML exporter reads the in-memory struct), and §13.4's byte-equality
check compares two engine runs that both serialise from memory. The property test asserts
a 1 ns tolerance rather than bit equality, with the reason written down so nobody later
"fixes" it by adding `arbitrary_precision` and slowing every serialisation down.

Relevant if the v2 parking-lot item "project save/load of sync sessions" is ever built:
a reloaded session will differ from the original in the last bit of some offsets.

## D-019 — Drift precision needs lever arm; the ±5 ppm gate belongs to the full tier

**Phase 4.** §8.2 requires drift estimates within ±5 ppm. Drift is a *slope*, so its
precision depends on how much offset change the regression can see across a clip, against
roughly 1.5 samples of per-segment measurement noise:

| clip | span | offset change across segments | slope noise |
| --- | --- | --- | --- |
| `quick` cam-stage (60 s) | 40 s | 19 samples | ~8 % |
| `full` cam-stage (400 s) | 380 s | 182 samples | ~0.8 % |
| `full` cam-phone (300 s) | 280 s | 202 samples | ~0.7 % |

So the ±5 ppm gate is asserted on the **full** tier, where it passes comfortably —
injected −25/+40/+60 ppm measured as +24.75/−40.38/−58.69. The `quick` tier only checks
that drift is detected with a plausible magnitude, because a 60 s clip cannot support a
tighter claim honestly.

This is not a weakened gate (§13.2): it is the same gate, asserted where the measurement
is meaningful. A short clip's drift also matters less — 40 ppm over 60 s is 2.4 ms, well
inside a frame.

**Sign convention, recorded because v2 depends on it:** `drift_ppm` is
`d(offset)/d(position in clip)`. A clip recorded on a slow clock is physically *longer*
than reality, so matching content appears progressively earlier and the slope is
**negative** — the opposite sign to "stretched by N ppm". v2 corrects by resampling by
`1 / (1 + ppm * 1e-6)`; using `1 + ppm` would double the error instead of removing it.

## D-020 — ⚠️ The scan must skip the analysis cache

**Phase 4, found by the determinism test.** Two consecutive `sync()` runs over the same
folder produced different results. The cause was a real product bug, not a flaky test:
the cache directory sat inside the input folder, so the second run's scan walked it,
found the `.f32` entries, failed to probe them, and reported **the user's own cache back
to them as broken media**.

The default cache lives in the OS cache location, so this does not bite by default — but
§4.2 makes the directory user-settable and Phase 8 puts it in the UI, so a user pointing
it at their media folder would hit it immediately, and the symptom (a growing list of
mystery decode failures) gives no clue about the cause.

Fixed by passing the cache directory to the scan as an excluded path. This is not
extension filtering (§4.1 forbids that) — it is the engine declining to scan its own
working directory.

Worth noting what caught it: §13.4's byte-equality determinism check, on its first run
against the full pipeline. It was written in Phase 0 as a trivially-true placeholder.

## D-021 — FCPXML: hand-written, single format, no DTD

**Phase 5.** Three deviations from §6, all small and all deliberate:

**Written as a string, not through an XML library.** `quick-xml` was added and then
removed: §8.4 wants golden tests comparing bytes, and hand-writing fixes element order,
attribute order and indentation rather than leaving them to a library's formatting. The
escaping actually needed is five characters.

**One `<format>`, not one per geometry.** §6 asks for a format per unique
(width, height, fps). `SyncResult` does not carry per-file resolution — §5 has no field
for it — so adding this properly means threading probe geometry into the result, which is
a §5 schema change and therefore not something to do in passing. The `mixed_fps` warning
still fires. Resolve accepted the single-format document without complaint.

**No DTD validation.** §6 asks for validation against "the bundled FCPXML DTD". Apple does
not ship one with Resolve and none exists on a normal macOS install (checked). The tests
assert structure, well-formedness and matched tags instead — and, more usefully, the real
import in D-022 proves acceptance far better than a DTD would.

One thing worth stating: **every time in the document is a whole multiple of the frame
duration**, assets included. An earlier version left asset durations at exact seconds
(`8400000/30000s`, not a multiple of 1001). Non-frame-aligned times are a common reason
importers quietly round or reject a document.

## D-022 — ✅ Verified against real DaVinci Resolve, and how to talk to it

**Phase 5.** §11 lists manual Resolve verification as the acceptance criterion, and §13.6
says anything learned about the importer gets written down immediately. Both done —
this was verified for real, not deferred.

Against **DaVinci Resolve Studio 21.0.3.7**, importing a timeline generated from a real
three-file shoot (a 60 s recorder feed plus two cameras cut from it at 8 s and 20 s, each
with different EQ and gain):

| Clip | Resolve track | Read-back position | Truth |
| --- | --- | --- | --- |
| ZOOM0001.WAV (reference) | audio1 | 0.0 s | 0 s |
| C0001.MP4 | video2 + audio2 | **8.0 s** | 8 s |
| DSC_0042.MOV | video3 + audio3 | **20.0 s** | 20 s |

Everything §8.4's checklist asks about:

- **Import succeeds** — `ImportTimelineFromFile` returns a timeline object.
- **Track layout is right.** Lane *n* becomes video track *n+1*: the primary storyline
  (our full-length `<gap>`) occupies V1, so the first camera lands on V2. One track pair
  per device, exactly as §6 intends.
- **Offsets are exact** — frame-accurate on read-back.
- **Relinking works** — the percent-encoded `file://` URLs resolved; clips carry real
  names rather than showing offline.
- **Frame rate carries** — the sequence imported as 25.0 fps.

**Sub-frame audio remains untested** because nothing sub-frame is currently emitted;
everything is frame-aligned. §6 says to accept frame precision rather than fight the
importer, and that is where this sits.

### Talking to Resolve from a script (the part that wastes an hour)

The MCP server and the documented environment-variable route both failed with
"could not connect". The cause is not the app: `RESOLVE_SCRIPT_API` points at
`/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting`,
**which does not exist on a normal macOS install**. The library that does exist is:

```
/Applications/DaVinci Resolve Studio.app/Contents/Libraries/Fusion/fusionscript.so
```

Appending that directory to `sys.path` and `import fusionscript` connects immediately, with
Resolve simply running and no preference changed. The misleading part is that the failure
looks exactly like "external scripting is disabled", which sends you into Preferences
looking for a setting that was never the problem.

`scripts/resolve-verify.py` does this and is repeatable.

## D-023 — The Tauri shell is its own workspace, outside the CI gate

**Phase 7.** `app/src-tauri` is excluded from the root workspace and declares its own.
§8.4 builds bundles on tags, not on every push, and pulling `webkit2gtk` and the rest of
the Tauri tree into the per-push gate would cost minutes on every CI run for no coverage
gain — the engine it wraps is already fully exercised headlessly.

The shell is thin by design (§3): it moves work off the UI thread, throttles progress onto
Tauri's event bus, and hands results over as JSON. Nothing worth testing lives in it.

One detail worth keeping: **the 10 Hz progress throttle lives in the shell, not the
engine** (§10). The engine reports every event and does not second-guess its consumer, so
the CLI can still log all of them. The throttle also always lets a *stage change* through
regardless of timing — the stage name is what the user is actually reading, and dropping
the transition would leave the label stale until the next tick.

## D-024 — Device labels are localised in the UI, closing the loop on D-007

**Phase 7.** D-007 had the engine emit bare device labels (`"Balkong"`) rather than §4.5's
literal `"Mappe: Balkong"`, on the grounds that the engine must not hardcode Norwegian when
§9 requires a bilingual UI, and that the provenance is recoverable from the namespaced
device id.

The UI now does exactly that: `deviceLabel()` renders `folder-*` ids as "Mappe: Balkong" or
"Folder: Balkong" depending on the active language, and leaves model- and filename-derived
labels alone. The plan's intended wording is what a Norwegian user sees, with no language
baked into the wire contract.

The two dictionaries are type-linked (`en: Strings` where `Strings = typeof nb`), so adding
a key to one and forgetting the other fails the build. A half-translated UI is worse than
an untranslated one.

## D-025 — Verify locally against a PATH without ffmpeg

**Phase 7, learned the slow way.** The macOS and Windows CI jobs deliberately have no
ffmpeg (D-005). Three tests written in Phase 0 against the stub `sync()` still called it in
Phase 4, when `sync()` had become the real pipeline — so they passed locally, passed on
ubuntu, and failed on the two runners that matter for exactly this.

The tests themselves were redundant by then: schema shape, byte-identical output and
progress delivery are all asserted in `tests/accuracy.rs` against real media, which is a
much stronger claim than the same assertions against an empty stub result. They were
removed rather than guarded.

**The habit worth keeping** is checking both environments before pushing, since the local
machine always has ffmpeg:

```
SUNDAYSYNC_REQUIRE_FFMPEG=1 cargo test --workspace
env PATH="/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.cargo/bin" cargo test --workspace
```

The second line is what CI's macOS and Windows jobs actually run.

## D-009 — Dotfiles are skipped during the scan walk

**Phase 1.** §4.1 says "reject nothing by extension", and that is honoured — no
extension is ever consulted. But hidden files are skipped: `.DS_Store` and the
AppleDouble `._C0001.MP4` companions macOS scatters across every camera card. These are
filesystem metadata, not media, and probing them would fill the unsynced list with
entries that look like real failures and bury the ones that are.

**Known gap, deliberately not addressed in v1:** GoPro `.LRV` low-resolution proxies are
genuine media with audio and would appear as a phantom extra device. Filtering them would
mean rejecting by extension, which §4.1 forbids. Left for the Phase 6 corpus to judge on
real footage rather than guessed at now.
