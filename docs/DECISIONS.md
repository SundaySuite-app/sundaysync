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

## D-016 — ✅ RESOLVED by D-042 (E6): drift is now corrected via a per-clip `<timeMap>`

**Resolution (E6, 2026-08-08).** Option 3 was taken — drift correction ships in v0.2 — but
without moving placement off the median. The exporter writes a per-clip `<timeMap>` retime
(the owner-signed-off, spike-proven mechanism, D-042) for any clip whose measured drift
exceeds half a frame, so short clips keep the median's balanced ±half-drift and long clips
are actively corrected end-to-end. The gate collision this note flagged no longer bites: a
90-minute 40 ppm camera now lands both ends on the reference instead of ±108 ms. The
analysis below is retained as the reasoning that led there.

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

## D-026 — Dark-only UI on SundayRec's Brand Sheet v1.0 tokens

**UX round.** The app adopts SundayRec's design tokens verbatim (bg `#0c1020`, four
surface/border layers, four-level text hierarchy, gold `#EBB84B` accent, radius/shadow
scales) so the two desktop apps read as one suite. Dark-only — the light theme is gone,
and with it the two contrast bugs its `prefers-color-scheme: dark` block shipped:
`.banner--error` at ~1.9:1 and the gold primary button at ~1.6:1.

The system font stack replaces Playfair Display / Hanken Grotesk. Those were *named* in
the old CSS but never loaded — no `@font-face`, no vendored files — so every user already
saw the fallback. Dropping the names makes the CSS tell the truth, and SundayRec desktop
uses the system stack too.

Two contrast rules baked into the stylesheet: gold surfaces carry **dark** ink
(`#0c1020` on `#EBB84B` ≈ 10:1), and banners are tint-background + coloured border +
normal text — coloured text on a 10 % tint of the same colour is exactly how the old
1.9:1 happened.

## D-027 — "Re-sync single clips" (§9) is a full re-run with device overrides

A partial-pipeline API would break the §7.3 accounting invariant (every input in exactly
one bucket — a "previously placed, not re-examined" third bucket is a §5 schema change)
and §3 determinism (a result assembled from two runs is a function of run *history*).

The full re-run costs almost nothing warm: decode dominates (§10 "decode-bound") and the
content-keyed cache makes a re-sync correlation-only — the same §10 "<30 s warm" budget
already promised. The UI makes the cheapness legible: the re-sync button carries the
subtitle "bufret analyse gjenbrukes", and a result goes visibly stale the moment inputs,
overrides or the reference change. The user's *intent* — fix this one clip's grouping and
get it re-placed — is one click and seconds of work, which is what §9 was after.

## D-028 — `SyncRequest` gains `device_overrides` and `segment_count`; neither enters §5

The request type is not schema-frozen (`SCHEMA_VERSION` covers `SyncResult` only).
Semantics chosen for UI resilience: an override key matching no scanned file is
**ignored** — a stale entry left after the user removed an input must not abort a run —
and a target id the grouping never produced creates a fresh device (reachable from the
CLI/JSON side only; the UI offers existing ids). `segment_count` is clamped to
`SEGMENT_COUNT_RANGE` (2..=15) at the pipeline boundary, and is recorded in the
diagnostics bundle rather than the frozen §5 `Parameters` block.

Overrides are applied to the manifest *before* candidates are built, so a moved file
flows into placement — including the §4.4 same-device-overlap invariant, which is
exactly what lets a user resolve a `device_overlap` refusal (and honestly earn new ones).

## D-029 — Settings persist via one localStorage JSON key

The SundayRec pattern, not `tauri-plugin-store`: proven in the suite, zero new
dependencies, and these are UI-tier preferences. Per-field validation on load — one bad
field degrades to its default rather than discarding the rest. Every engine-related
field defaults to `null` = "use the engine's default", which is what keeps §9's promise
that advanced settings never change simple-mode behaviour.

## D-030 — Engine errors localise by stable Display-prefix matching

`app/src/errors.ts` maps the engine's thiserror Display strings (which are stable) onto
dictionary keys by prefix. `cancelled` maps to a **notice**, never an error banner — the
first build painted a red banner reading "cancelled" over the user's own deliberate
action, erasing §7.4's distinction between "you stopped this" and "this broke". Unknown
errors keep the raw text embedded: §7.5's honesty applies to failures too.

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

## D-031 — ⚠️ ffmpeg is bundled; resolution order is bundled → PATH → GUI-fallback dirs

**v0.2 stage E1.** The v0.1.0 test build told the owner "ffmpeg ble ikke funnet" on a
machine where ffmpeg was installed and worked perfectly from a terminal.

**The diagnosis.** macOS hands a GUI application a minimal environment. A double-clicked
`.app` gets `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — none of the directories a login shell's
profile would have added. Homebrew installs ffmpeg into `/opt/homebrew/bin` (Apple
Silicon) or `/usr/local/bin` (Intel), MacPorts into `/opt/local/bin`; a GUI app sees none
of them. The development build had never shown the bug because `tauri dev` is launched
from a terminal and inherits its `PATH`. **The lesson generalises to the whole suite: a
desktop app must never assume the environment its developer's shell has.**

**The fix has two halves.**

1. *Hotfix.* `Sidecar::from_path` now resolves each binary as bare name (the `PATH`
   lookup) first, then walks `fallback_candidates()` — `/opt/homebrew/bin`,
   `/usr/local/bin`, `/opt/local/bin`, unix-only, in that fixed order. Ten lines that
   unblock every current tester with an installed ffmpeg. Verified: with
   `PATH=/usr/bin:/bin:/usr/sbin:/sbin` the CLI now resolves `/opt/homebrew/bin/ffmpeg`
   and syncs, where before it aborted.
2. *Bundling.* `app/scripts/fetch-ffmpeg.mjs` (ported from SundayRec, same pins) fetches
   SHA-256-pinned static builds into `app/src-tauri/binaries/ffmpeg-<target-triple>`, and
   `tauri.conf.json`'s `bundle.externalBin` puts them next to the app executable. The
   shell resolves `current_exe()/../ffmpeg` first, verifies the pair, and only then falls
   back to the user's machine. Nothing to install by hand.

**Why the engine stays Tauri-free (D-023 upheld).** `crates/core` cannot ask where the
application bundle is — that is a shell question. So `SyncRequest` gained
`sidecar: Option<Sidecar>`: the shell resolves and verifies the bundled pair, and hands
the engine two absolute paths. `None` keeps the old behaviour (resolve from this machine),
which is what the CLI, the tests and `bench` use. `Sidecar` also gained a
`source: SidecarSource` field — `Bundled` or `System` — pure provenance, shown in
onboarding and the diagnostics bundle. Like `SyncRequest` itself, it is **not** part of
the frozen §5 schema; it never enters `SyncResult` (D-028's rule, applied again).

`check_sidecar` re-resolves on every call rather than reading the cached value, so
onboarding's "check again" button tells the truth for a user who installs ffmpeg while the
app is open. In `tauri dev` there are no binaries next to `target/debug/sundaysync-app`;
that case is silent by design (the absent-file check happens before any verification), and
only a *present but unusable* sidecar logs.

**Licensing: GPL, unchanged from SundayRec.** The macOS/Linux builds come from
[ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de) (release channel, signed and
notarized by the publisher) and the Windows build from
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/) "essentials" — the same two sources, the
same pinned 8.1.2, and the same obligations SundayRec already documents in its
`docs/DISTRIBUTION.md`: both are `--enable-gpl --enable-version3`, nothing is
`--enable-nonfree`, the GPL covers the redistributed binaries, and anyone handed an
installer is entitled to the corresponding source — point them at the publisher's build
page and ffmpeg's own 8.1.2 tarball. URLs are pinned to an exact build id, not "latest",
so a rebuild a year from now fetches the same bytes; both the archive and the unpacked
binary are SHA-256-pinned (`app/scripts/ffmpeg-checksums.json`), and a mismatch fails the
build rather than shipping.

**⚠️ The §10 installer budget is superseded.** §10 says "< 40 MB per platform *excluding*
ffmpeg", which was always a number that hid the real download. Measured on this machine
(aarch64-apple-darwin, 2026-08-08):

| | v0.1.0 | v0.1.2 |
| --- | --- | --- |
| DMG | **3.8 MB** | **60.3 MB** |
| `SundaySync.app` on disk | ~13 MB | **135 MB** |
| of which ffmpeg + ffprobe | 0 | 131 MB |

The app itself is 10 MB — comfortably inside the old budget. The other 125 MB is ffmpeg 8
static builds, which are simply large (SundayRec measured the same ~131 MB pair; there is
no small 8.x static build). **The honest number to quote from here on is ~60 MB
downloaded, ~135 MB installed**, and it is also what a future updater ships per release.
Deliberate trade: one 60 MB download beats a manual install step that half of testers get
wrong and the other half hit this bug on.

## D-032 — E3 security hardening: protocol whitelist, XML control-char stripping, diagnostics scrub

**E3, from the E2 threat model.** The engine was already unusually defensive (no shell, no
`unsafe`, symlinks not followed, device files skipped, cache delete scoped by suffix), so
this stage is focused, not sprawling. The judgment calls:

**S-1 — ffmpeg/ffprobe protocol whitelist (the one to fix first).** §4.1 rejects nothing
by extension — a dropped "media" file is the product's explicit input — so a file that is
really an HLS playlist or a `concat`/`ffconcat` script would make ffmpeg fetch remote URLs
(SSRF, incl. the `169.254.169.254` cloud-metadata address) or read `file:///…` during
probe/extract. Fix: `-protocol_whitelist file` before every `-i`, in both `probe.rs` and
`extract.rs`. Measured against ffmpeg 8.1.2: the flag propagates to the HLS demuxer's
nested-protocol layer, which then refuses `http` with *"Protocol 'http' not on whitelist
'file'"* — the `probe.rs` test `the_protocol_whitelist_reaches_the_nested_demuxer_protocol`
pins exactly that stderr. Modern ffmpeg already ships defensive defaults (concat `safe=1`,
HLS nested whitelist `file,crypto,data`), but those are version/build-dependent and broader
than we need; pinning `file` makes the guarantee explicit, minimal and stable across the
bundled 8.1.2 and whatever system ffmpeg a user has on PATH.

- **`-safe 1` is on `probe.rs` only, not `extract.rs`.** This is the non-obvious call.
  ffprobe accepts `-safe 1` on any input (verified harmless on wav/mp4/flac/aac), so it is
  added there to pin the concat demuxer's safe-mode on. **ffmpeg rejects it** as *"Option
  safe not found"* on non-concat input, which would break every normal extraction — so it
  is deliberately omitted from the extract vector. The concat demuxer's own `safe=1`
  default already blocks unsafe names there, and the whitelist blocks the protocol vector.
- **`extract.rs` needs `file` only, not `file,pipe`.** The decode writes to a temp *file*
  (`-f f32le -y <temp>`), not `pipe:`, so `file` is the minimal set that keeps extraction
  working — verified across containers.
- **S-2 folded in:** the probe path was a bare trailing positional, so a file named
  `-show_data_hex` parsed as a flag. It is now `-i`'s value in both stages.
- Committed hostile corpus in `fixtures/hostile/` (tiny — bytes, not media) drives the
  "attack is now blocked" tests through the real `probe`/`extract` code path.

**S-3 — FCPXML escaper strips XML-illegal control chars.** The five injection chars were
already escaped correctly (no breakout — kept), but C0 controls (`0x00–0x08`, `0x0B`,
`0x0C`, `0x0E–0x1F`) passed through raw, so one bell or NUL in a filename yielded a
non-well-formed document Resolve rejects wholesale (silent wrongness, §7.5). **Choice:
drop** the illegal controls (they are not representable even as a numeric character
reference in XML 1.0, so there is nothing to escape them *to*), and **normalise** the three
legal whitespace controls (tab/newline/CR) to a single space, matching how a parser
flattens them inside an attribute anyway.

**S-5 — export path validation.** IPC arguments are trust-boundary data; the OS save dialog
is a convention, not an enforced guard. `validate_export_path` rejects an existing-directory
target and (for `export_timeline`) a path not ending in `.fcpxml`, so a hostile `invoke`
cannot steer a raw `fs::write` onto an arbitrary writable file. Defense-in-depth behind the
S-4 CSP.

**S-6 — `export_diagnostics` is now actually media-free.** It claimed to be safe to send to
support while embedding the full `SyncResult` — absolute paths (→ the macOS username under
`/Users/…`), device/folder labels (often the church/service name) and every filename — plus
the absolute ffmpeg path. `scrub_result` collapses every path to its bare basename, drops
each device label to its neutral id (e.g. `folder-balkong`, the handle §4.5/D-028 already
use), and the report omits the ffmpeg path entirely, keeping only `bundled`/`system`. Test
asserts no `/Users/`, no surviving absolute path, and no raw label. Doc-comment corrected to
describe what the bundle actually contains.

**S-7 — `clear_cache` cache marker.** `dir` is caller-chosen (D-013), so `clear` could
delete a user's unrelated `.tmp`/`.f32` in any named folder. `ensure_dir` now stamps a
`.sundaysync-cache` marker (a dotfile — the scan's `is_hidden` skips it, `clear`'s suffix
filter spares it), and `clear` refuses a *non-default* directory that lacks the marker
(`Error::NotACacheDir`). The default dir stays frictionless (trusted unconditionally); a
missing directory is still a no-op, not a refusal.

**S-8 — scan width cap + cancel-in-loop.** `walk` had unbounded width and checked cancel
only per-directory. **Ceiling: `MAX_FILES = 100_000`** — orders of magnitude past any real
multi-camera service, so it can only fire on an obvious mis-drop (a home directory, a whole
disk); on breach it returns `Error::TooManyFiles { limit }`, a loud honest refusal rather
than a silent truncation that would violate §7.3. Cancel is now also checked *inside* the
entry loop, so one huge directory is interruptible (§7.4). A wedged network-mount
`read_dir`/`metadata` syscall remains uninterruptible — inherent to `std::fs`, documented in
the code, not fixed here.

**Fuzzing.** `cargo-fuzz` targets for `probe::from_json`, `place::parse_iso8601_epoch` and
`Rational::parse` live in `fuzz/` — its own workspace, excluded from the root gates like
`app/src-tauri`. The WAV *reader* the brief names does not exist (fixturegen only *writes*
WAV; the engine reads back its own raw `f32le` cache), so it is not fuzzed — noted, not
skipped by accident. `probe::from_json` is `pub(crate)`; a `fuzzing`-gated `fuzz_from_json`
door exposes it without widening the shipping API. The targets dual-build: under cargo-fuzz
(`--cfg fuzzing --features libfuzzer`, nightly) they are libFuzzer targets; on plain stable
`cargo build` they are ordinary smoke-runner binaries over a few adversarial seeds, so the
harness stays committed and verifiable here where cargo-fuzz/nightly are unavailable. Run
instructions in `fuzz/README.md`.

**New `Error` variants.** S-8 and S-7 needed fatal outcomes with no honest fit among the
existing variants (`Invariant` means *engine bug*, which a user mis-drop is not), so
`TooManyFiles { limit }` and `NotACacheDir { path }` were added to `error.rs` — additive
only.

**Stale docs fixed in passing (E2 explorer findings):** the `crates/core/src/lib.rs` module
docstring called the pipeline a "Phase 2" stub with correlation unimplemented — corrected to
describe the complete pipeline `sync` now runs. `extract.rs`'s memmap-deferral note cited
D-012 (which is about cancellation); it should be **D-011**, now fixed.

## D-033 — Strict local-only CSP, and the npm-audit gate scopes to shipped deps (E3)

**E3, conductor.** Two hardening decisions that sit outside the two builder agents'
file ownership.

**CSP (closes S-4).** `tauri.conf.json` `security.csp` went from `null` to a strict,
local-only policy: `default-src 'self'`, `script-src 'self'` (the production bundle has no
inline/eval scripts and no `dangerouslySetInnerHTML` anywhere in `app/src`), `style-src
'self' 'unsafe-inline'` (Vite injects a style tag and the app uses a few React inline
`style={{}}` attributes), `img-src 'self' asset: data:`, `connect-src 'self' ipc:
http://ipc.localhost` (Tauri 2 IPC), and `object-src/base-uri/frame-ancestors/form-action`
locked down. No remote origin is reachable — the app is 100 % local, so a future XSS
(a new dependency, an accidental `dangerouslySetInnerHTML`) can no longer reach the IPC
command surface (which includes arbitrary-dir cache deletion and file writes).

Verified the policy is **accepted by `tauri build` and embedded** both in the frontend
bundle and compiled into the app binary. The one thing not verifiable headlessly is that
the UI still *renders* under it — that is on the E11 owner smoke checklist (a blank window
would be the failure mode). The policy is the community-standard tight CSP for a
local-only Vite/React Tauri app, so the risk is low.

**npm-audit gate (part of S-9b).** The CI `npm-audit` job runs `npm audit --omit=dev
--audit-level=high` — it gates the **shipped** dependency tree, not the build/test tooling.
Every current advisory lives in the `vitest → vite → esbuild/nanoid` dev chain
(vitest-UI arbitrary-file-read, vite dev-server path traversal, nanoid loop); none reaches
the Tauri bundle a user runs, and `npm audit --omit=dev` reports **0**. Their only fix is a
semver-major vitest bump, tracked as a follow-up rather than blocking every push on tooling
that never ships. A `high`-or-worse advisory in an actual runtime dependency still fails the
job. A second, non-blocking `|| true` step runs the full dev audit so those advisories stay
visible in the log.

**Follow-up tracked:** bump `vitest` to v4 (breaking; re-verify the 27 vitest specs) to
clear the dev-tree advisories at source.

## D-034 — E4 memory strategy: single-alloc load(), the per-run anchor cache, and memmap stays deferred

**E4, stability.** §7.7's 4 GB RSS ceiling was untested and, on paper, breakable. Three
changes bring the engine under it and one non-change is reaffirmed.

`CachedAudio::load()` now allocates the `Vec<f32>` once at `file_len / 4` and streams the
cache file through a 64 KiB scratch buffer. The previous form read a whole `Vec<u8>` and
then `.collect()`ed a second full `Vec<f32>`, both resident at once — a transient ~8
bytes/sample peak. On a long reference this was the actual gate-breaker: at 46.9 KB/s
(D-004/D-013), a 20 h reference is ~3.38 GB of analysis audio, so the old load() spiked to
~6.8 GB while decoding it into memory, before any FFT had allocated. The streamed form
peaks at the samples vector plus one 64 KiB buffer.

`place()` pass 2 previously re-loaded each anchor's cache file on every (clip, anchor) pair
and linear-scanned `candidates` for durations inside the sort comparator and for each
anchor lookup — O(n²) I/O and O(n²) scans. It now builds a `by_path` index once (O(1)
lookups) and a lazily-filled per-run `anchor_cache` that reads each distinct anchor's cache
file at most once and reuses it across all unresolved clips. The reference is not stored in
the cache; it is reused in place from the single `ref_audio` load, so the dominant stream
is never duplicated.

Memory tension, resolved deliberately. Caching anchors resident raises pass-2 peak above
the old drop-after-each-use behaviour, so the worst case matters. Peak resident RSS is
`reference + anchors actually touched + one in-flight clip`. The largest-first order with
early-exit on a strong match usually touches only a few big anchors, so the realistic
church-service case (a ~2–3 h recorder reference ≈ 0.34–0.51 GB plus a handful of short
camera clips) stays well under 1 GB. The adversarial bound is the E4 20 h / 200-file day:
if nearly every clip is placed and one straggler forces a full-anchor pass 2, the touched
set approaches the whole shoot's analysis audio — ~3.38 GB (F10 cites ~3.46 GB at 48 KB/s)
— which is the same footprint §7.7 already contemplates. Adding the correlator's overlap-
save working set (2²⁰-sample f32 blocks, tens of MB; the reference FFT is still recomputed
per call until P-1 lands in E5) and program baseline (<0.2 GB) leaves peak ≈ 3.6 GB, under
4 GB with ~0.4 GB of headroom. This is analytical; the RSS bench built alongside E4
(fixturegen 20 h day + peak-RSS sampling, `crates/core/tests/memory_gate.rs`) is what
proves it. If that bench ever shows a realistic 20 h day over 4 GB, the documented next
step is a size-ceilinged, drop-after-last-use anchor cache — accepting bounded cache-file
re-reads for the rare many-anchor pass 2 — deferred now because it trades a guaranteed
bound for complexity the measured data has not yet justified.

The same F9 fix rides in this path: on Windows `rename` errors when the destination exists,
so two cold instances decoding one file made the loser emit a spurious `decode_error`. Same
cache key ⇒ byte-identical audio, so an existing destination is a cache hit — drop the temp,
no error. Unix atomic overwrite is unchanged.

memmap (D-011) stays deferred. With the transient 2× copy gone and the anchor cache
bounding pass 2, there is no acute pressure left for `memmap2::Mmap::map` to relieve. The
case against it is unchanged and now stronger: it is `unsafe`, colliding with the
`unsafe_code = "forbid"` lint (adopting it means relaxing to `deny` plus a scoped
`#[allow]`); the f32le → f32 conversion still needs a full pass over the bytes, so a mapping
buys no arithmetic; and a mapped cache file complicates the Windows cache-overwrite path
(a mapping holds the file open, and F9's whole point is that a second instance may replace
it). Revisit only if the E5 RSS bench shows the single-alloc + anchor-cache profile still
exceeds 4 GB on a realistic day — which the arithmetic above says it does not.

## D-035 — E4 robustness: lossless path hashing (F7) and a bounded runnable() (F11)

**E4, stability.** Two independent correctness fixes with no bearing on the §5 schema.

The cache key hashed `path.to_string_lossy()`, which maps every invalid byte to U+FFFD. Two
distinct non-UTF-8 paths differing only in their invalid bytes therefore hashed identically
and collided — the second file was served the first's cached analysis audio, a
silent-wrongness bug (§7.5) rather than an honest failure. The key now hashes the lossless
OS encoding: raw bytes on unix (`OsStrExt::as_bytes`), UTF-16 code units on Windows
(`encode_wide`), and the lossy form only on targets with no OS-string accessor (where paths
are UTF-8 anyway). Changing the encoding changes cache filenames, which costs one cold
re-decode and nothing else — no on-disk state or fixture pins a specific `{hash}.f32` name.

`runnable()` ran `<bin> -version` with a plain blocking `status()`, unlike `sidecar::run()`,
which has the D-010/D-012 bounded poll loop. A bundled ffmpeg wedged on `-version`
(quarantine limbo, a dead FUSE mount, a stalled network binary) would hang `check_sidecar`
and the onboarding probe forever and uncancellably. `runnable()` now delegates to `run()`
with a 10 s ceiling — generous for a `-version` that normally answers in ~30 ms — inheriting
both the bounded wait and the D-010 rule that a killed child is never joined on its reader
threads on the timeout path. A wedged binary is reported as not-runnable instead of
hanging. (The frontend invoke-timeout half of F11/F14 is a separate, shell-side change; see
D-036.)

## D-036 — Uniform AppState poison policy, an inputs fingerprint on export, and a client-side invoke timeout (E4)

**E4, shell+frontend.** Three stability fixes on the Tauri command surface (F1, F3, F6,
F11-frontend/F14), none of which touch the engine (D-023).

**Poison policy (F1).** The shell's `AppState` mutexes were handled inconsistently:
`cancel_sync` took `if let Ok(slot) = lock()` and silently did nothing when the lock was
poisoned — the one safety control disabled with no banner — while `export_*` surfaced an
error. Every command now acquires its lock through one helper, `lock_state(slot, OnPoison)`.
`OnPoison::Recover` recovers the guard via `PoisonError::into_inner` for the cancel-token
slot, the scan-cancel slot, and the sidecar cache: a lock poisoned there means only that a
prior thread panicked mid-update, and the `Option<_>` it holds is still safe to read or
replace — cancel must fire regardless. `OnPoison::Reject` returns a clean "internal state
was poisoned" error for the `LastRun` slot, where a half-written result must never be
exported as a finished run. `store_last` recovers, overwrites wholesale, then calls
`clear_poison()` so a healthy sync re-enables the Reject read path in export.

**Scan-cancel identity (F3).** `scan_inputs` cleared "only our own token" by checking
`is_cancelled()` outside the lock — a late-finishing scan could clear a newer scan's slot
and leave the newer run uncancellable. The scan-cancel slot now holds `Arc<CancelToken>`,
and the finishing scan clears the slot only when it still holds *its* Arc (`Arc::ptr_eq`
under the lock).

**Export inputs fingerprint (F6).** The frontend hides export behind `phase.stale`, but that
is a UI convention, not a guard. `LastRun` is now stamped with a cheap deterministic
`DefaultHasher` fingerprint of the sources that produced it — the source set (order/dup-
independent), device overrides, and chosen reference, mirroring the frontend's staleness
triggers. `export_timeline` recomputes it from the caller-supplied current sources and
refuses on mismatch. `DefaultHasher`'s cross-version instability is irrelevant: store and
compare happen in the same binary and session, never persisted.

**Invoke timeout (F11-frontend/F14).** No `invoke` had a timeout; a no-cancel command
(notably `check_sidecar`, spawning `ffmpeg -version`) could wedge the UI forever.
`invokeWithTimeout` races `invoke` against a bound (10 s for `check_sidecar`) and rejects
with a distinguishable, localised message mapped to a NOTICE — a timeout is recoverable, not
a crash. It bounds only how long the UI waits; the backend call is not aborted (Tauri
exposes no cancel token). `run_sync`/`scan_inputs` keep their real cancel path and get no
short timeout.

## D-037 — Process-global scratch nonce so two same-process Extractors never collide (E4)

**E4, conductor integration.** E4's two-instance concurrency test surfaced a real bug
distinct from F9. `Cache::temp_path` names a scratch file from `(cache key, process::id(),
nonce)`, but the nonce was a per-`Extractor` `AtomicU64` starting at 0. Two `Extractor`s
constructed in the *same* OS process (identical pid) therefore collided on the Nth file's
`<key>.<pid>-<nonce>.tmp` path: one worker's `fs::rename` moved the shared temp out from
under the other's still-running ffmpeg, which then failed its `fs::metadata` check with a
spurious `decode_error` on a perfectly good file. This reproduces on POSIX, so it is not
the Windows-rename issue F9 fixed. It is reachable in the real app: `sync_with_durations`
builds a fresh `Extractor` on every call, so two overlapping `sync()` runs (a re-sync fired
before the first finishes) hit it.

Fix: the nonce is now a single process-global `static SCRATCH_NONCE: AtomicU64`
(`crates/core/src/extract.rs`), unique across every `Extractor` in the process; the pid in
`temp_path` still carries cross-process uniqueness. The previously `#[ignore]`d
`two_extractors_in_one_process_*` test is un-ignored as a passing regression
(`crates/core/tests/concurrency.rs`).

## D-038 — E5/P-1: the reference transform is finally "computed once and cached" (bit-identical), plus deterministic segment parallelism

§4.3 promised the reference's forward-FFT block spectra are "computed once and cached", but
`Correlator` held only an `FftPlanner`, so `find()` re-ran the whole overlap-save loop over
the reference for every segment of every clip — ~48,000 2²⁰ FFTs on a 3 h/30-clip service,
the ~8 min of pass-1 correlation the E2 explorers measured.

`Correlator` now memoises the reference's PHAT-normalised block spectra, keyed by **(BLAKE3
content hash of the reference samples, segment length)**. Keying on a content hash rather
than a slice pointer is deliberate: a freed reference's address can be reused for different
content, which pointer-identity would serve stale spectra for — a §7.5 silent-wrongness bug.
The hash makes aliasing two distinct references cryptographically impossible, the same
guarantee the on-disk cache relies on (D-035). Segment length is in the key because two
segment lengths can share an FFT size `n` yet tile the reference differently. The cache is
single-entry and byte-budgeted at 1.75 GiB: a reference whose spectra would exceed the
budget (≈ a >4 h reference at the default 20 s segment) streams exactly as before, one block
resident at a time, so the cache never breaches §7.7's 4 GB ceiling (D-034). The memoisation
is pure — a miss recomputes identical values — so it is **bit-identical by construction** to
the retained exhaustive path (`match_clip_exhaustive`). Proven so field-for-field over the
real §8.1 fixtures and across positive/zero/negative/edge lags.

The independent per-segment correlations additionally fan out across
`extract::worker_count()` (§4.3(c)), sharing the spectra read-only and writing indexed slots
assembled in input order, so placements are identical regardless of thread scheduling
(§13.4). Peak memory is unchanged from the serial cached path — segment-level (not
cross-clip) parallelism was chosen precisely so per-thread caches never multiply the
reference spectra by the worker count. `MIN_PSR` is untouched: the arithmetic per segment is
identical, so the Phase-3/D-015 calibration still holds without re-validation.

Measured (12 min reference, 12×90 s clips, 4 workers): Tier-1 memoisation ~1.85×, segment
parallelism ~2.1×, combined ~3.7–4.1× (machine-dependent). Projected shipping correlation:
the §10 realistic 3 h/20-clip service **~57 s** (down from ~214 s; spectra 1.4 GB, cached);
the 8 h/100-file stress day ~23 min (spectra 3.6 GB exceeds the budget → streams, parallel
only — see D-039).

## D-039 — E5/P-1: the decimated coarse-search is deferred, not abandoned

Tier-1 caching + segment parallelism bring the §10 realistic 1.5–3 h church service
comfortably within budget (~57 s of correlation), but do **not** meet §10's literal 8 h/100-
file stress day in < 6 min (~23 min projected). That day is also the case where the
reference's spectra (~3.6 GB) exceed both the cache budget and, with the resident reference
audio, the 4 GB ceiling — so it must stream, and caching cannot help it. The remaining lever
is the plan's decimated coarse search (÷8 → ~1.5 kHz to localise each offset, then a
full-rate refine over a narrow window), which shrinks both the FFT size and the block count
and would simultaneously make the long-reference spectra small enough to cache again.

It is deferred rather than shipped because it is the one change that alters the arithmetic
(placements within ±1 sample, not bit-identical), and §13.2/§13.4 demand it be gated hard:
the coarse decimation factor and refine half-window must be chosen and **proven** so the
coarse localisation error can never exceed the refine window on adversarial offsets (clip
before the reference, near either end, negative lag), and PSR must be taken from the
full-rate refine window (or `MIN_PSR` re-calibrated per D-015) with D-014's caution that a
change which looks better is exactly when to suspect the instrument. That validation is a
task in its own right; shipping it under-proven risks the false placements §8.2/§7.5 make the
product's core promise against. The exhaustive path (`match_clip_exhaustive`) is retained
precisely as the oracle a future decimated path must diff against. Recommended for E10's
real-corpus loop, where the ±1-sample budget can be validated against real rooms rather than
only synthetic material.

## D-040 — Cache eviction closes D-013: 90-day mtime sweep by default, size cap off

E5, P-4. D-013 left cache growth (~169 MB/audio-hour) unmanaged pending a product call. The
engine now exposes `Cache::sweep_older_than(age)` and `Cache::enforce_size_cap(max_bytes)`,
both returning `Evicted { entries, bytes }`. The analysis cache is regenerable, so age
eviction is non-destructive to user data — a swept entry simply cold-decodes if that shoot is
re-synced. Conductor-approved defaults: a **90-day sweep on app start** (on — run off the
main thread in the shell's `setup()`, non-fatal), a **size cap in Settings (off by
default)**, and the manual "Tøm buffer" stays. Both reuse the S-7 marker guard `clear()` uses
(refuse an unmarked non-default dir), operate only on finished `.f32` entries — never an
in-flight `.tmp` a live extraction owns, never a foreign file, never the marker — and are
safe under a concurrent run (a vanished entry is success, not error). Age is from **mtime,
not atime** (atime is frozen/absent under `relatime`/`noatime`/network mounts; mtime is
written once at the write-then-rename commit, so "older than `age`" cleanly means "committed
more than `age` ago"). The cap evicts least-recently-modified first, tie-broken by path, so
the evicted set is a deterministic function of the inputs. Shell wiring: the `sweep_cache`
and `enforce_cache_cap` commands, the startup sweep, and a `cacheCapMb` setting (null = off)
driving `enforce_cache_cap` from the Settings panel.

## D-041 — Parallel probing must be byte-identical to the serial result

E5, P-2. Probing moved from a serial loop to the bounded extract worker pool
(`worker_count()`, `min(4, cores)`) — one 30 s-timeout file no longer stalls the scan with
idle cores. To keep the engine a deterministic function of its inputs (§3, §13.4),
`probe_candidates` writes each probe outcome into an **index-aligned slot** and the caller
folds them in candidate order, so `probed`, `unsynced`, and the manifest are identical
whatever the thread schedule. Guaranteed by a test that runs the scan with 1 worker (serial)
and 8 workers (parallel) over a mixed good/bad shoot and asserts the manifests are byte-equal
(serde) and the raw `Probed` vectors are equal. Cancellation is preserved: workers check the
token before taking work, an in-flight probe cancels via `probe`'s token path (§7.4), and a
set token returns `Error::Cancelled` before any slot is unwrapped. The D-005 skip-guard
behaviour is unchanged.

## D-042 — E6: `<timeMap>` drift correction, on by default past half a frame

**E6, drift correction — closes D-016; the v2 headline pulled into v0.2.** The engine has
always *measured* clock drift (`drift.rs`: signed `ppm` + `projected_end_error_ms`); v0.1
did not *correct* it, so a long camera on a fast/slow clock drifts out of sync by the clip's
end (D-016: a 90-minute 40 ppm camera ends ±108 ms out).

**Spike first (owner-gated).** Against real DaVinci Resolve Studio 21 the conductor proved
the importer **honours a per-clip `<timeMap>`** on an `<asset-clip>` and preserves the ratio
*exactly, sub-frame*: a +250 ppm map (source 60.000 s → timeline 60.015 s) round-tripped
through Resolve's own FCPXML export as `<timept time="12003/200s" value="60/1s"/>` — 60.015 s
kept as an exact rational, not snapped to a frame. `<conform-rate>` is **ignored** by
Resolve. The clip's timeline *boundary* is frame-quantised (cosmetic); the retime *ratio*
that drives the audio resample is exact. Live-verified again in the engine's full
gap/spine/lane layout: a 10 % timeMap read back as 66.0 s while the reference clip stayed at
60.0 s. **Owner sign-off (2026-08-08): mechanism = `<timeMap>`; on by default; correct only
clips whose drift exceeds half a frame; toggleable.**

**Mechanism.** For any clip whose measured drift exceeds half a frame (`Drift::exceeds_half_frame`),
the exporter emits a `<timeMap>` stretching the clip's timeline span to
`source_span · (1 + ppm·1e-6)` — the reciprocal of D-019's `1/(1+ppm·1e-6)` *resample*, i.e.
the timeline has to be *longer* by the drift for the far end to land where the reference
puts it. Because §4.3 places on the **median** (the offset estimate is at the clip midpoint),
a corrected clip's start is first re-referenced by half the projected end error
(`projected_end_error_ms/2000` s) so the stretch pivots on the reference-correct start; both
ends then land within the gate. Timepts are exact rationals over `AUDIO_TIMEBASE` (48000);
the asset-clip `duration`/`offset` stay frame-aligned as before. The reference clip is never
corrected (it defines the origin).

**Sign is the trap (D-014/D-019), so it is test-pinned.** Inverting the ratio moves the end
the wrong way and *doubles* the error. `drift::tests` and the full-tier accuracy gate assert,
for both signs of injected drift, a 40 ppm / 400 s clip: **uncorrected end ~16 ms → corrected
~0 ms; inverted → ~32 ms** — so the tolerance is never doing the work, and an inverted
correction fails loudly.

**Toggle.** `SyncRequest.correct_drift` (default `true`) governs whether correction is
applied at all; export carries it via `ExportOptions`/`export_fcpxml_with_options`. The shell
threads it from a Settings switch (`correctDrift`, on by default) through `run_sync` and
stores it on the run so a later export uses the same setting. With it off, output is v0.1
**byte-for-byte** (no `<timeMap>`); the no-drift golden is unchanged, and a new
`timeline_drift.fcpxml` golden locks the corrected form.

**Verification harness.** `scripts/resolve-verify.py` now reports each clip's **END**
alignment (start + duration), not only its start — that is where uncorrected drift shows.

## D-043 — E7: consent + anonymous telemetry client

**E7, mirror of SundayRec's telemetry client.** SundaySync ships an **opt-in, off-until-granted**
telemetry client (data controller: **SundaySuite**), versioned at **consent v1** — a scope bump
re-asks everyone, and a "no" at v1 never silently becomes a "yes" at v2. A random UUIDv4
install-id is minted **only on grant** (`NIL_INSTALL_ID` otherwise) and is deletable by id (local
clear + remote `DELETE /v1/install/:id`, issued even with consent off since it carries only a
retired random id).

**The payload is anonymous and bucketed by construction.** From a completed `SyncResult` the
projection reads only counts, closed enums, and coarse bands — never a filename, path, device or
folder label, project name, or recording timestamp. Fields: file/device counts, total-duration and
run-duration buckets, §5 unsynced-reason histogram, PSR distribution bands, drift-correction
flags (`enabled`/`clips`/`corrected`), a **file-format histogram** (extensions only, a closed set),
`mixedFps`. Crash messages are the sole free text — scrubbed (paths → `<path>`) and length-capped,
on both the Rust panic-hook ring and the frontend `window.onerror`/`unhandledrejection` path. A
load-bearing test builds a `SyncResult` full of church paths/labels and asserts none of those
strings appear anywhere in the serialized payload.

**Consent copy ↔ payload reconciled (owner, 2026-08-08).** The approved v1 copy enumerated
"buffertreff" (cache hit-rate), which v1 does **not** collect, and omitted the file-format histogram,
which it **does** send. Owner chose to make the copy exactly truthful: drop the cache-hit line, add
"hvilke filformater (kun filendelser, aldri filnavn)". The copy now names precisely what leaves the
machine — the SundayRec "consent covers what is sent" rule.

**Transport.** Rides the shared `sunday-telemetry` Worker `/v1/ingest` with a top-level
`app:"sundaysync"` marker. A ≤50 outbox drops-oldest and treats a non-2xx as logged-and-kept/dropped
(4xx permanent, 429/5xx backed-off) — **never silently discarded** (the ellipsis-bug lesson). State
persists to JSON under the app data dir. `reqwest` is pinned to `native-tls` so the license
allow-list (cargo-deny) stays satisfied.

**Worker dependency (E8).** The shared Worker does **not yet** accept sundaysync payloads until
E8's branch merges and deploys. *(Amended same day, owner-directed:)* the client now posts to the
app registry's **app-scoped door** — `POST /v1/apps/sundaysync/ingest` and
`DELETE /v1/apps/sundaysync/install/:id` with the `x-write-key` header (`WRITE_KEY_SUNDAYSYNC`
Worker-side) — matching the `audit/wire-seams` app-dimension foundation the owner chose as the
shared layer, rather than the frozen legacy `/v1/ingest` alias (which means "sundayrec" and would
400 this payload). That is by design (client built in E7, Worker taught in
E8); the client logs the 400 locally and sends nothing in production until a release ships against a
deployed Worker. **E8 status:** a Worker branch (`e8/sundaysync-app-dimension` in the sunday-telemetry
repo) is built and tested but **parked, not merged, not deployed** — it collides with concurrent
app-dimension work on that shared repo (`audit/wire-seams` has its own `src/apps.ts` + `0006`
migration), and its validator shape still needs reconciling field-for-field against this client. Both
are owner/cross-program coordination items.

## D-044 — E9: in-app updater + stable/beta ring

**E9.** SundaySync gets an in-app auto-updater via `tauri-plugin-updater`, polling the
shared Sunday Suite feed at the **app-scoped** route
`updates.sundaysuite.app/v1/update/sundaysync/{stable,beta}` (not SundayRec's frozen
`/v1/update/{channel}` alias — the Worker's `/v1/update/:app/:channel` is what the app-
dimension foundation serves). The ring is a per-machine `betaChannel` localStorage setting
(default off), passed to the backend on each check so it hits `/beta` vs `/stable` — no DB,
unlike SundayRec. Privacy URL shape mirrors SundayRec: **no version/target/arch in the
path** (a unit test asserts this). No GitHub fallback feed, so the Worker's `204`-as-pause
is an authoritative kill-switch. Updater artifacts are minisign-signed (pubkey in
`tauri.conf.json`, private key a GitHub Actions secret); NSIS-only Windows bundling on
`-beta.` tags because MSI cannot express a prerelease version. Opting into the beta ring
gently re-surfaces the E7 consent card for installs that haven't decided yet.

**⚠️ Security incident + resolution (2026-08-08).** The agent that built E9 generated a
signing keypair and printed the **private** key into its output — a credential leak. That
keypair is **burned**: it must never be set as `TAURI_SIGNING_PRIVATE_KEY` or used to sign a
release. Resolution: the conductor generated a **fresh** keypair (private key written only to
a local file, never printed) and swapped its public key into `tauri.conf.json`; the burned
public key no longer appears anywhere in the tree. **Owner action before any release:**
either set the two `TAURI_SIGNING_*` secrets from the fresh keypair, OR (recommended)
generate a brand-new keypair locally, hold the private key yourself, set the secrets, and
swap in that pubkey. Until a signing secret is set, `tauri-action` skips updater signing and
clients reject unsigned updates by design — so there is no unsigned-release risk in the
meantime. Lesson for the suite: signing-key generation must keep the private key out of all
agent/tool output.

## D-045 — E10 corpus: the credibility gate, a stricter single-segment floor, and the .lrv skip

**E10, the first real corpus (a 2026-04-05 multicam baptism: 70-min XH2 main camera +
XT4 + two iPhones + an Insta360 X + a produced stereo mix).** The §8.3 ritual surfaced a
release blocker and settled two open questions. Findings first, honestly:

**Three false placements, zero true ones admitted wrongly after the fix.**
1. The 70-min XH2 against the produced mix: placed at PSR 15.2 (MIN_PSR is 15),
   confidence 0.02, **drift −587,484 ppm**. The mix is *edited* — every segment's audio
   genuinely exists in it, at different offsets (cuts). The regression fitted a line
   through the scatter; v1-era code warned and placed anyway; E6 then "corrected" the
   clip by −59 %.
2. A 95-s iPhone clip against the raw XH2: PSR 15.4, **−1,937,858 ppm** — the same shape
   against an unedited reference, so this is not only an edited-mix problem.
3. A 14-s iPhone clip against the raw XH2: PSR 19.0, placed an hour from where its
   metadata puts it. Single whole-clip peak — no segments, so nothing for a consistency
   check to catch.

**The fix is two gates in `place::admissible`, both refusal-shaped (§7.5):**
- **Credibility** (`Drift::credible`): a match with ≥ 3 segments must survive the drift
  regression — `|ppm| ≤ 500` (`MAX_CREDIBLE_DRIFT_PPM`: consumer crystals are tens of
  ppm; 500 is a generous ceiling) AND residual MAD around the fitted line ≤ 15 ms
  (`RESIDUAL_LIMIT_MS`). Fitting the line *first* is what keeps D-016's legitimate case
  alive: a 90-min 40 ppm camera has offsets ON a line (raw MAD around the median would
  false-alarm — why `ClipMatch::consistent` was never a hard gate), while cuts and
  sidelobes scatter around any line.
- **No-evidence floor**: a match with < 3 segments (`MIN_SEGMENTS_FOR_DRIFT`) has PSR as
  its only evidence and must clear `min_psr × 5/3` (`NO_DRIFT_EVIDENCE_PSR_FACTOR`,
  effective 25 at the default). Provisional calibration from this corpus — observed false
  peaks 15.2–19.0, synthetic true matches ≫ 25 — and the full §8.1 accuracy suites pass
  unchanged, which is the standing guard against over-tightening. D-015 (MIN_PSR on real
  rooms) remains open; more corpus refines the factor.

Re-run after the fix: **all three false placements refused** (`low_confidence`), every
synthetic gate green, no legitimate placement lost. On this corpus that means zero
placements at all — also honest: the cameras were largely in different rooms/times (the
XT4's first clip *ends* ten minutes before the XH2 starts, by their own metadata), and
the one nominal 23-min overlap (XT4's second clip) refused at PSR < 15, which is what
different acoustic spaces look like. **Recall on real corpora is still unmeasured** — a
possible false negative there cannot be distinguished from a genuinely unrelated room
without ears on the material; more corpus, ideally with a known-good multicam pair in one
room, is the E10/E12 loop's job.

**Also settled: D-009's `.lrv` question, with real files.** The Insta360 writes an
`LRV_….lrv` low-res proxy beside every `VID_….insv` original — same audio twice in one
folder-device. The recursive walk now skips `.lrv` (case-insensitive), classified with
the dotfile skip: a deliberate, narrow exception to §4.1's no-extension-filtering rule,
because a proxy is a duplicate by construction, not doubtful media. An explicitly passed
`.lrv` file is still honoured.

**Guidance encoded in KNOWN_LIMITATIONS:** a produced/edited mix is not a valid sync
reference — the engine now *refuses* instead of mis-placing, and the UI's reference
override should point at a raw recorder file or the longest camera instead.

## D-046 — Cache maintenance and a running sync must not overlap (night review)

The eviction sweeps (D-040) spare in-flight `.tmp` scratch files, so they cannot disturb
an extraction mid-write — but they could evict a **committed** entry a running sync had
already checked, and `place`'s `load()?` then killed the whole run with an `Io` error
naming a `{hash}.f32` path, for media that is perfectly fine. Half of this was worse and
is fixed in the engine: the extraction stage used to read existence and length in two
separate stats and could mint a **zero-sample** handle when they disagreed
(`Cache::entry_len` now answers both in one stat, and an unusable entry falls through to
an honest re-decode). The rest is scheduling, enforced in the shell: an `AppState`
activity slot (RAII-guarded) makes `run_sync` and every maintenance pass (`clear_cache`,
`sweep_cache`, `enforce_cache_cap`, the startup sweep) mutually exclusive — the loser
gets an honest `busy:` error. Making `load()` failures per-file `decode_error`s was
rejected: it would report the user's media as broken when the fault is entirely ours.

## D-047 — The Worker is the wire's authority, and its 400 is silent data loss (night review)

The telemetry client treats a 4xx as permanent, so a client/server shape mismatch does
not fail loudly — it discards every report from every affected install, indefinitely.
Three such drifts shipped in E7 and were caught the same night: a scrubber whose
path-boundary set was narrower than the Worker's screen (`[C:\…` survived scrubbing and
tripped the Worker), an uncapped `appVersion`, and a non-finite float that serialises as
JSON `null`. **Rule:** the client's scrub must be a *superset* of the endpoint's screen,
and every cap, enum and key the Worker enforces is pinned in the shell's
`mod wire_contract` — transcribed from `schema-sync.ts` — so drift fails a test instead
of deleting a month of reports. Corollaries: `NIL_INSTALL_ID` is a preview id and never
enters a send path (a deletion retires the identity; continued consent mints a fresh
one); consent is re-checked immediately before each POST, not once per pump; outbox
entries are leased under the same lock that reads them; and atomic writes stage through a
per-writer temp name, because `open -n` relaunch makes two live instances a real state.

## D-048 — A gate must branch on what evidence exists, not on whether reading it succeeded (night review)

Two defects shared one shape. `place::admissible` selected D-045's ordinary bar or its
stricter no-evidence floor by matching on `drift::measure`'s `Option` — so a many-segment
match whose regression *declined* (degenerate fit, non-finite slope) was routed to the
branch meaning "too short to check" and admitted on PSR alone, inverting D-045. And
`fcpxml::correction_of` retimed on a `drift_ppm` it never examined, with a comment
explaining the upstream gate made checking unnecessary — the exact path that stretched
the E10 corpus's −587,484 ppm clip by −59 %. Both are the D-014 lesson at one remove:
a *reading whose absence was mistaken for a benign default*. **Rule:** branch on the
precondition (segment count, input length); treat a failed read of an available
instrument as a refusal; and where a value crosses a public API or serialised contract,
re-check it on the far side (`Drift::credible()` now guards the exporter too) even when
the near side guarantees it.

## D-049 — Evidence-graded admission: a credible clock lowers the PSR bar (owner-delegated)

The second corpus round (three real projects, 2013–2023) settled D-015's open question
with numbers: **true and false matches overlap in PSR** (true min-segment-PSR observed at
13.3–73.1; false at 15.2–19.0), so no PSR threshold alone can ever separate them. What
does separate them, in every observed case, is the drift regression: every false match
carried a physically impossible clock; every true one a physiological clock — agreeing
with PluralEyes' independent measurement of the same project to ±2 ppm. Meanwhile §4.3's
min-over-segments scoring meant one quiet stretch (banter between songs) dragged a true
23-minute clip to 13.9 and refused it: PSR 15 was costing recall without buying
precision.

Admission is therefore graded by the evidence that exists:
- **< 3 segments** (nothing to cross-check): PSR is the only judge — the D-045 floor
  stands, `min_psr × 5/3` (25 at default).
- **≥ 3 segments**: the credible-drift gate is mandatory (as since D-045), and PSR drops
  to corroboration at `min_psr × 2/3` (10 at default). Both factors scale with the §9
  knob, preserving its meaning.

Guards against over-loosening: the full tier's `unrelated.wav` (PSR 9.2) still refuses;
the residual-MAD limit still refuses scattered segments regardless of PSR; and the one
theoretical false mode left — strongly periodic material locking sidelobes onto a
zero-slope line — is why the floor is not lower. The E12 corpus loop watches that mode.
Measured effect on the 5-camera living-room corpus: a true 23-minute clip (13.9, −31 ppm)
and a true 5-minute clip (13.3, −91 ppm) go from refused to placed; nothing previously
refused for incredible drift is readmitted.

## D-050 — Sidecar family skip, and the multitrack-dump exemption (owner-delegated)

Two §4.4/§4.1 refinements confirmed by all three corpus projects:

**Sidecar family.** The walk's skip set (D-045's `.lrv`) grows to the closed set
`.lrv .thm .cpi .bdm .mpl .tdt .tid` — GoPro/DSLR thumbnails and the AVCHD index family
that litters every `PRIVATE/` card dump. They are descriptions of sibling media, not
media; on the 2013 corpus they produced nine spurious `decode_error`s that read as broken
footage. An explicitly passed file is still honoured, and `.bmp`/other generic formats
stay un-filtered (they are real formats and land honestly in `no_audio`/`decode_error`).

**Multitrack dump.** §4.4's same-device eviction rests on "one camera cannot record two
overlapping clips". A folder of per-channel recorder exports (Ch01…Ch16) breaks the
folder=device assumption the other way — and cost 9 of 16 board channels on the 2013
corpus. Detection is physical, not name-based: **three or more** same-device clips that
each cover ≥ 90 % of one another cannot come from one camera and are kept intact (each
channel on its own lane — what a music edit wants). A two-clip full overlap keeps the old
rule: that shape IS producible by one device family (the Insta360 dual-lens pair), where
eviction is correct.
