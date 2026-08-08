# SundaySync v0.2 Program — "Solid in Use"

> Multi-week quality program taking SundaySync from a working v0.1 test build to a
> self-contained, self-updating, observable v0.2. Modelled on SundayRec's
> kvalitetsprogram (started 2026-08-06), reusing its infrastructure and its lessons.
> **Owner:** Richard. **Conductor:** Fable orchestrates every stage; Opus executes the
> heavy work (architecture, Rust, DSP, security), Sonnet the mechanical work (i18n,
> docs, schema boilerplate, test scaffolds). One stage = one session/night; the owner
> says **"kjør etappe N"**. Pace ~2–3 stages/week → **5–6 weeks**.

## Operating rules

1. Every stage ends with: full gates green (fmt, clippy `-D warnings`, `cargo test`
   under BOTH PATH variants per D-025, tsc, vitest, vite build) → PR → CI green →
   merge → stage report appended to this file → memory updated.
2. §13.2 stands: accuracy gates are never weakened to pass. New capabilities get new
   gates, asserted where the measurement is meaningful (the D-019 rule).
3. §5 `SyncResult` schema changes remain irreversible-class decisions; anything touching
   it goes to the owner first.
4. Max 2–3 parallel Opus agents; content-heavy agents write incrementally
   (SundaySchool lesson). Telemetry payload changes ALWAYS deploy Worker-side first
   with fields optional, client second (SundayRec schema-rollout rule) — and every
   free-text limit gets a test spanning both repos (the 08-08 ellipsis lesson).
5. Owner decisions are surfaced at the START of the stage that needs them, listed
   per stage below. Nothing blocks silently.

## Locked owner choices (2026-08-08)

- **Drift correction ships in v0.2** (own stage, E6) — resolves D-016 properly.
- **Telemetry:** shared `sunday-telemetry` Worker/D1, app dimension + own sundaysync
  schema. Fully anonymous (random install-id, deletion by id, never person/church
  linkage), consent at first launch + settings toggle, 90 d raw retention, EU (WEUR).
  Same privacy posture as SundayRec's locked choices.
- **Updater:** same `updates.sundaysuite.app` Worker, new app-scoped rings
  `/v1/update/sundaysync/{stable,beta}`. Kill-switch + promotion flow reused as-is.
- **Corpus:** owner supplies 1–3 real services during the program → corpus-gated
  stages (E10) sit late.

## Why v0.2 exists (what v0.1 taught us)

The v0.1.0 test build surfaced the exact problem this program opens with: **the release
app reports "ffmpeg ble ikke funnet" on a machine where ffmpeg IS installed.** macOS
gives GUI apps a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) without
`/opt/homebrew/bin`; the dev build worked only because `tauri dev` inherited the
terminal's PATH. Diagnosis first confirmed on the owner's own machine, 2026-08-08.
Bundling ffmpeg (E1) fixes the bug and removes the last manual installation step in one
move.

---

## Stages

### E1 — Self-contained install (bundled ffmpeg) 🔜 first

The user's top ask: download → open → works. Nothing to install by hand.

- **Hotfix first (`v0.1.2`, shippable same session):** `Sidecar::from_path` falls back
  to the common GUI-invisible locations (`/opt/homebrew/bin`, `/usr/local/bin`,
  `/opt/local/bin`) before giving up. Ten lines; unblocks current testers immediately.
- Port SundayRec's `scripts/fetch-ffmpeg.mjs` (SHA-256-pinned static ffmpeg+ffprobe
  from martin-riedl.de / gyan.dev, per-target-triple naming) → `app/src-tauri/binaries/`,
  `externalBin` in tauri.conf. GPL build → ship the license notices the same way
  SundayRec's DISTRIBUTION.md does.
- Engine: `Sidecar` gains an explicit resolution order — **bundled sidecar path
  (from the Tauri shell) → PATH → GUI-fallback dirs**. The shell resolves the bundled
  path via Tauri's resource API and passes it down; the engine stays Tauri-free
  (thin-shell rule D-023). CLI keeps PATH resolution.
- Onboarding step 3 becomes a green confirmation ("alt innebygd — ingenting å
  installere") with the check retained as a self-test; the brew instruction survives
  only as the fallback text if the bundled binary is somehow missing/damaged.
- CI: release.yml fetches sidecars per platform; the D-005 skip-guard logic in tests
  must now also cover "bundled but PATH empty".
- **Gates:** installer size budget re-checked (§10 says < 40 MB *excluding* ffmpeg —
  document the new with-ffmpeg number honestly); fresh-VM-style launch test: rename
  /opt/homebrew/bin/ffmpeg away and verify the app still syncs.

### E2 — Mapping (the "full gjennomgang" baseline)

Three Explore agents in parallel, exactly like SundayRec's kartlegging:

1. **Security top-10** — threat-model the real surfaces: arbitrary-tree scan walk
   (symlinks, device files, network mounts), ffprobe/ffmpeg argument injection via
   filenames, FCPXML output escaping (verify the 5-char escaper against adversarial
   names), `tauri.conf.json` `"csp": null` (a real finding already), capability
   over-grant, `scan_inputs`/`run_sync` invoked with hostile paths, dependency tree.
2. **Stability/QA top-10** — panic surface outside core, error-path coverage, races
   (scan superseding sync? double cancel? two app instances sharing one cache dir),
   what happens at 0 files/1 file/10 000 files, unicode/long paths, disk-full during
   cache write and export.
3. **Backend/perf top-10** — profile a synthetic 3 h reference (the known ~160
   blocks/segment correlation scaling), probe serialisation, memory ceiling reality
   vs §7.7's 4 GB promise, cache growth (D-013), progress gaps (Placing/MeasuringDrift
   never tick, pass 2 silent).

Output: prioritised backlog written into this file under E3–E5; anything
severity-critical gets pulled into its stage as the first item.

### E3 — Security hardening

From E2's list plus the already-known:

- Real CSP in tauri.conf (no `null`), capability re-audit (drop anything unused).
- Path handling: symlink policy made explicit and tested; refuse to walk into
  device/special files; scan depth/width limits documented as limits.
- Fuzzing: `cargo-fuzz` targets for `probe::from_json`, `parse_iso8601_epoch`,
  `Rational::parse` and the WAV-fixture reader — parsers fed by untrusted files are
  exactly where fuzzing pays. Corpus of mangled media checked into `fixtures/hostile/`
  (tiny, committed).
- FCPXML injection test: filenames like `"/x/<script>&' .mp4` must produce valid,
  correctly-escaped XML that Resolve still imports (extend `resolve-verify.py`).
- `cargo audit` in CI already; add `cargo deny` (licenses + duplicate deps + advisories)
  and pin the GitHub Actions by SHA.
- `SECURITY.md` via GitHub advisories (no published e-mail — SundayRec E1 pattern).
- **Owner decision in this stage:** none expected.

**E2 security backlog (ranked; the explorer verified the code is already unusually
defensive — no shell, no `unsafe`, symlinks not followed, device files skipped, cache
delete scoped by suffix — so this list is focused, not sprawling):**

| # | Finding | Sev | Where |
| --- | --- | --- | --- |
| S-1 | **ffmpeg/ffprobe run with no protocol whitelist → SSRF + local-file disclosure.** Since input isn't rejected by extension, a dropped file *containing* an HLS/`concat` script makes ffmpeg fetch remote URLs or read `file:///…` during probe/extract. A passive "media" file is the product's explicit input — this is the one to fix first. Fix: `-protocol_whitelist file` (probe) / `file,pipe` (extract) + `-safe 1`; add `fixtures/hostile/` sample asserting no outbound connection. | **HIGH — pull forward** | probe.rs:117, extract.rs:270 |
| S-2 | ffprobe takes the path as a **bare trailing positional** (no `-i`, no `--`), so a file named `-show_data_hex` is parsed as a flag. Extract is safe (path is `-i`'s value). Fix in the same change as S-1: pass probe input via `-i` too. | MED | probe.rs:117 |
| S-3 | FCPXML escaper covers the 5 injection chars correctly (no breakout possible) but passes **XML-illegal control chars** (`0x00–0x1F`) through raw → one bell/NUL in a filename yields a non-well-formed doc Resolve rejects wholesale (silent-wrongness, §7.5). Fix: strip/replace illegal control chars; extend `resolve-verify.py` with the adversarial-name case. | MED | fcpxml.rs:299 |
| S-4 | `"csp": null` — no Content-Security-Policy. No injection sink exists *today* (React escapes, no `dangerouslySetInnerHTML`), but CSP is the defense-in-depth that contains a future XSS, which would otherwise reach the whole IPC command surface. Fix: strict local-only CSP (`default-src 'self'`, no remote origins). | MED | tauri.conf.json:23 |
| S-6 | `export_diagnostics` is **not** media-free as its doc claims — it embeds absolute paths (→ macOS username), device/folder labels and every filename. Contradicts the E7 rule "never filenames/paths/labels", and users are told it's safe to send to support. Fix: scrub to basenames, drop the absolute ffmpeg path, correct the wording. | MED | lib.rs:359 |
| S-5 | Every path-taking command trusts frontend-supplied paths; `export_*` do `fs::write` on an arbitrary path (arbitrary overwrite). Bounded today by dialogs, but the dialog isn't an enforced guard. Mostly contained once S-4 lands. | MED | lib.rs:331 |
| S-8 | Scan walk: **unbounded width** (millions of entries → memory/time) and `read_dir`/`metadata` on a **hostile/dead network mount blocks uninterruptibly** — Cancel and §7.4's 2 s don't cover a wedged FS call. Fix: file-count ceiling + honest "too many files"; check cancel inside the entry loop; document the mount hang. (Overlaps E4.) | LOW-MED | scan.rs:285 |
| S-9 | Supply chain: `cargo audit` is in CI ✅ but **no `cargo deny`**, **no `npm audit`**, and Actions are floating-tag-pinned while CI holds `contents: write`. Fix: add `cargo deny` + `npm audit --audit-level=high`; SHA-pin all Actions. | LOW | ci/release.yml |
| S-7 | `clear_cache` correctly spares foreign files (verified), but `dir` is caller-chosen, so it can delete a user's unrelated `.tmp`/`.f32` in any named dir. Fix: require a SundaySync-cache marker before clearing a non-default dir. | LOW | cache.rs:167 |

### E4 — Engine stability

- Adversarial media suite: truncated mid-atom MP4s, zero-length streams, 8-hour WAV
  headers with 2 s of data, wrong-extension files, exotic sample rates (8 k/96 k/192 k),
  mono/5.1/7.1 channel layouts. Every one must land in a §5 bucket, never panic, never
  hang past its timeout.
- §7.7 proven, not promised: a 20 h / 200-file synthetic day generated by fixturegen,
  run under RSS measurement; gate at < 4 GB. (Generation is cheap: fixturegen writes
  WAV fast; use mostly-WAV for the bulk.)
- Cancellation storm test: cancel fired at random points ×100 runs — no leaks, no
  cache corruption (tmp-file census after each), §7.4's 2 s bound asserted.
- Two-instance concurrency: two engines sharing one cache dir simultaneously — the
  write-then-rename design should make this safe; prove it.
- proptest expansion: device-override maps as a generated input against the §7.3
  invariant; hostile path strings through the scan collect/dedup logic.

**E2 stability backlog (ranked). The explorer verified the shell/CLI panic surface is
tiny, the D-010 pipe fix is intact, write-then-rename is solid, and the reducer has no
reachable impossible phase — so this is targeted:**

| # | Finding | Sev | Where |
| --- | --- | --- | --- |
| F10 | **§7.7's 4 GB memory ceiling is untested AND exceeded on long references.** `place.rs` loads the *entire* reference into a `Vec<f32>` (a 20 h reference ≈ 3.46 GB resident before clips/FFT), `load()` transiently double-allocates (bytes + f32), and pass 2 **re-loads each anchor from disk on every (clip, anchor) pair**. The 20 h/200-file day E4 already plans to generate would break the shipped promise. **Confirmed independently by the backend explorer (Finding 3).** This is E4's headline gate. Fix: RSS assertion in the harness; single-alloc `load()`; per-run anchor cache; revisit the D-011 memmap deferral. | **HIGH** | place.rs:120,212; extract.rs:64 |
| F16 | The whole Tauri shell is excluded from CI (D-023) → 0 tests, clippy never ran on push for the 9 commands, the lock handling, the throttle. **Closed in E1** (new `shell` CI job). Remaining: actual unit tests for the poison helper + scan-cancel identity check land with F1/F3. | HIGH (structural) | Cargo.toml:11 → **fixed E1** |
| F1 | Poison handling is inconsistent — `cancel_sync` silently no-ops on a poisoned `AppState` mutex (the one safety control does nothing, no banner) while `export_*` surface an error. Fix: one helper, `into_inner()`-recover the cancel/scan slots, error on `last`. | MED | lib.rs:322 vs :340 |
| F11 | `runnable()` runs `<bin> -version` with **no timeout** (unlike `run()`), and no `invoke` in the frontend has a timeout. A bundled ffmpeg that hangs on `-version` (quarantine limbo, bad FUSE mount) wedges `check_sidecar`/onboarding forever, uncancellably. Fix: bound `runnable` with the `run()` poll loop. | MED | sidecar.rs:102; App.tsx:48 |
| F3 | `scan_inputs` "clear only our own token" checks `is_cancelled()` *outside* the lock (TOCTOU) → a late scan can clear a newer scan's slot, leaving the newer run **uncancellable**. Narrow window, breaks only cancellation. Fix: `Arc::ptr_eq` identity check under the lock. | MED-LOW | lib.rs:272 |
| F9 | `std::fs::rename` is **not atomic-overwrite on Windows** — two cold instances decoding the same file → second rename errors → spurious `decode_error`. Fix: on `AlreadyExists`, treat as a cache hit and drop the temp. Fold into the two-instance test (run it on Windows). | MED-LOW | extract.rs:321 |
| F7 | Cache key hashes `to_string_lossy()` → two non-UTF-8 paths differing only in invalid bytes both map to `U+FFFD` and **collide → the second file served the first's audio** (silent wrongness). Fix: hash `abs.as_os_str()` bytes. | LOW | cache.rs:49 |
| F14 | No `invoke` timeout anywhere; only sync/scan are cancel-recoverable, so any no-cancel command (notably `check_sidecar` via F11) has no UI recovery from a hung backend. Fix: a client-side invoke timeout wrapper. | MED | App.tsx |
| F6 | Export staleness is UI-gated only (`disabled={phase.stale}`); the backend `export_timeline` has no inputs guard, so a bypassing caller exports the previous run. Fix: stamp `LastRun` with an inputs hash, refuse on mismatch. | LOW | lib.rs:332 |

### E5 — Performance at real scale

- **Correlation scaling** (the known §10 risk): decimated coarse search (e.g. 1.5 kHz)
  over the full reference → narrow full-rate refine window. Gate: synthetic 3 h
  reference, 20 clips, correlation phase under a measured budget on this machine —
  AND bit-identical placements vs. the exhaustive path on the whole accuracy suite
  (determinism §13.4 makes this checkable). If exact equality proves impossible,
  equal-within-±1-sample plus D-entry; never silently different.
- Parallel probing on the extract worker pool (Phase 1 leftover).
- Progress completeness: `Placing` ticks per candidate, pass-2 `Correlating` ticks,
  `MeasuringDrift` actually emitted; scan walk emits per-directory. The CLI's verbose
  output and the UI both benefit; `Progress` is not §5-frozen.
- **Cache eviction (D-013 closes here).** Proposal to owner at stage start:
  age-based sweep (delete entries untouched > 90 days) on app start + a size cap
  setting (default off) in Settings; "Tøm buffer" stays. Numbers shown honestly.
- Re-run §10 gates and publish the measured table in STATUS.

**E2 backend/performance backlog (ranked). The explorer verified against code — several
plan estimates are optimistic and one plan invariant is unimplemented:**

| # | Finding | Sev | Where |
| --- | --- | --- | --- |
| P-1 | **The reference FFT is recomputed per segment — §4.3's "computed once and cached" is NOT implemented.** `Correlator` holds only an `FftPlanner`; every `find()` re-runs the whole overlap-save loop over the reference. A 3 h service (30 clips × 5 segments) = ~48,000 FFTs of 2²⁰ ≈ **~8 min of pass-1 correlation alone**, blowing §10's 6-min cold target and invalidating the plan's "decode-bound" framing. Fix (E5): (a) cache the ~160 reference block spectra once per run; (b) decimated coarse search (÷8 → ~1.5 kHz) to localise each offset, then full-rate refine over a narrow window; (c) parallelise pass 1 (independent clips, shared read-only reference — reuse the extract pool). **Determinism constraints:** fixed FIR/FFT sizes, deterministic refine window, indexed-slot parallelism, and **PSR must stay comparable to the Phase-3-calibrated `MIN_PSR`** — take refine PSR from the full-rate window or re-calibrate as part of E5 (D-014 shows how sensitive this path is). | **CRITICAL** | correlate.rs:135; place.rs:155,214 |
| P-2 | Probe is fully **serial** while extract is parallel `min(4,cores)`. Normal case fine (~30 ms/probe), but every 30 s-timeout file adds 30 s serially with 3 idle cores. Fix: reuse the extract worker pool for probing (preserve the deterministic post-sort). | MED | scan.rs:89 |
| P-3 | Memory (= stability F10): double-allocating `load()` + fully-resident long reference. §7.7 20 h target exceeds 4 GB via `load()` alone. Fix in E4/E5: single-alloc read, anchor cache, revisit memmap (D-011). | HIGH | extract.rs:64; place.rs:120 |
| P-4 | Cache growth: 46.9 KB/s = ~169 MB/audio-hour, no eviction (D-013). Age-based sweep + optional size cap. | MED | cache.rs |
| P-5 | Progress gaps (= stability F17, confirmed): **scan walk emits nothing** (10 000-file folder shows "0/1" the whole walk), **Placing** ticks once at 0, **pass-2 correlation** silent, **MeasuringDrift** never emitted at all (yet has UI strings). Cheapest wins in the backlog — missing `progress.report` calls; `Progress` can gain a `current_file` field (not §5-frozen). | LOW each, HIGH cumulative UX | lib.rs:159; place.rs:198; progress.rs:18; scan.rs:83 |
| P-6 | Pass-2 hot paths: anchor audio re-loaded from disk every inner iteration (repeated I/O + decode); `duration_of` linear scan inside a sort comparator and inside overlap eviction → O(n²); `candidates.find()` and `lib.rs` probed lookup O(n²); clone-heavy anchor handling. Fix: one `HashMap<path → (duration, AnalysisAudio)>` built once; pass indices/refs. | LOW-MED | place.rs:189,209,212,328; lib.rs:135 |
| P-7 | `bench` measures accuracy + one wall-clock only — no cold/warm split (doesn't clear/prime cache), no per-stage timing, no peak RSS. Without this, E5's fixes and the §10/§7.7 targets can't be measured or regression-gated. Fix: cold+warm passes (drive `Cache::clear`), a timing `ProgressSink` decorator, RSS sampling; report in the corpus summary. | MED (blocks validating P-1/P-3) | bench.rs:173 |

**Two stale-doc cleanups noted by the explorers (do in E5 or opportunistically):**
`crates/core/src/lib.rs` module docstring still says correlation is an unimplemented
"Phase 2" stub; `crates/core/src/extract.rs:17` cites "D-012" for the memmap deferral
where DECISIONS.md has it as **D-011** (D-012 is cancellation).

### E6 — Drift correction (the v2 headline, pulled into v0.2)

Resolves D-016. Design question first, implementation second — Opus runs a
spike against real DaVinci Resolve before any engine code:

- **Spike:** can Resolve's FCPXML importer honour a per-clip rate conform/timeMap
  such that a drifting clip stays aligned end-to-end? Extend `scripts/resolve-verify.py`
  to measure alignment at clip START and END (import → read both edges). Three
  candidate mechanisms, in preference order:
  1. FCPXML `conform-rate`/timeMap on the asset-clip (no media touched — best fit for
     the product's "never render" stance),
  2. start-aligned placement + documented residual (fallback; a §4.3 plan change),
  3. optional rendered corrected-audio sidecar per clip (§12's PluralEyes model —
     only if 1 fails; breaks "no rendered media" so needs explicit owner sign-off).
- Implementation per spike outcome; **toggleable** (§12: "toggleable like
  PluralEyes 4.1"), default ON when drift > half a frame is measured.
- Gates: the full-tier drift suite gains END-of-clip assertions — a 40 ppm / 400 s
  clip must land within ±10 ms at BOTH ends, which v0.1 mathematically cannot do.
  Sign convention D-019 (resample by `1/(1+ppm·1e-6)`) pinned by a test.
- D-016 gets its closing entry; KNOWN_LIMITATIONS drops its biggest caveat.
- **Owner decision in this stage:** mechanism sign-off after the spike report
  (especially if outcome 3 is the only one that works).

### E7 — Consent + telemetry client

Mirror of SundayRec E3, adapted:

- Consent card at first launch (new onboarding step 4) + Settings toggle; consent is
  `Option<ConsentRecord>` with a **versioned** consent text from day one (SundayRec's
  v2 lesson: bumping the version re-asks everyone; "no" on v1 can never become "yes"
  on v2 silently).
- Anonymous random install-id; deletion by id; NEVER filenames, paths, device labels
  or anything derived from media content in any payload.
- Crash capture: Rust panic-hook writing a scrubbed ring (à la SundayRec's 20-crash
  ring, paths scrubbed), plus frontend `window.onerror`/unhandledrejection capture
  into the same outbox. Free-text limits get the both-repos truncation test.
- Quality/usage payload (all classified, all anonymous): app+engine version, OS/arch,
  synced-shoot shape (file count, device count, total duration BUCKETED, codec set),
  outcome (placed/unsynced histogram by reason), PSR distribution buckets, cache
  hit-rate, run duration buckets, drift-correction engaged y/n, error/crash class.
- Outbox: 50 entries, drop-oldest, send on launch + post-sync; a 400 response is
  logged locally with reason (not silently dropped — learn from the ellipsis bug).
- **Owner decision in this stage:** consent text approval (written so later
  aggregates are already covered — SundayRec rule) + behandlingsansvarlig line.

### E8 — Telemetry Worker side (sunday-telemetry repo)

- App dimension in the Worker: sundaysync validator + D1 tables (columns, not JSON —
  the SundayRec E4 choice), shared purge job extended, deletion-by-id covers both apps.
- **Deploy order enforced:** Worker accepts the new app/fields as OPTIONAL first,
  deployed and live-verified; only then does the E7 client release reference it.
- Cross-repo test suite: sundaysync payload fixtures validated against the real
  Worker validator in `sunday-telemetry/test/` (the boundary-crossing tests that were
  missing when the ellipsis bug shipped).
- Admin queries (`queries.sql`) extended with sundaysync views.

### E9 — Updater + beta ring

- `tauri-plugin-updater` in the app; updater signing keypair generated
  (`tauri signer generate`), private key → `gh secret set` on the repo, pubkey into
  tauri.conf. (Independent of Apple signing — works today; Apple
  notarization remains a separate owner item as on SundayRec.)
- Endpoints: `plugins.updater.endpoints = ["https://updates.sundaysuite.app/v1/update/sundaysync/stable"]`;
  beta toggle in Settings → System swaps to `/beta` (and is the natural place the
  E7 consent-ask can be re-surfaced, mirroring SundayRec).
- Worker: app-scoped ring tables + migration in sunday-telemetry repo; 204=paused,
  404=unknown ring, no GitHub fallback (kill-switch stays meaningful). Promotion
  flow reused.
- release.yml: `createUpdaterArtifacts`, **`uploadUpdaterJson`** (the input
  tauri-action actually has), **NSIS-only bundling on `-beta.` tags** (MSI cannot
  express prerelease versions — learned 08-08 the hard way), updater env secrets.
- **Kill-switch drill** against the real published manifest before the stage closes
  (SundayRec's 08-07 exercise, repeated for the new app id): promote → byte-identical
  200, pause → 204 within 60 s, resume → same bytes, other app's rings untouched.
- No version/OS leakage on update checks (no `{{current_version}}` in the URL —
  SundayRec's privacy stance).

### E10 — QA foundation + real corpus

- Playwright harness on SundayRec's E5 pattern (`__TAURI_INTERNALS__` shim; ~20–30
  specs): onboarding flow, drop→scan→sources, override + stale marking, sync
  progress + cancel-as-notice, export flow, settings persistence, consent toggle.
- Visual click-through with computer-use if the owner has granted screen recording
  by then; otherwise the Playwright layer carries it.
- **Corpus onboarding** (owner delivers 1–3 services): freeze truth via
  `resolve-verify.py`-assisted manual check (§8.3 ritual), run `sundaysync bench`,
  then: MIN_PSR re-validation on real rooms (D-015's open caveat), performance
  numbers on a real 1.5–3 h reference (validates E5), drift correction on real
  camera clocks (validates E6), GoPro `.LRV` decision with real files (D-009).
- Gates: §8.2 on the corpus with zero false placements — release blocker per §8.3.

### E11 — v0.2.0-beta.1 → stable

- Version bump (three files), CHANGELOG, `v0.2.0-beta.1` tag → prerelease → promote
  to the sundaysync **beta** ring; owner runs it for real on his machine (the ring's
  only member initially, like SundayRec).
- Owner test checklist (written in the stage): fresh-download install with NO
  ffmpeg present, full sync of a real shoot, drift-corrected export into Resolve,
  updater self-update beta→beta, consent flows, cache clear.
- Findings → patch releases on the beta ring until clean → promote `v0.2.0` to
  stable ring. STATUS/KNOWN_LIMITATIONS rewritten to match reality.

### E12 — Continuous operations

Joins SundayRec's E11 monthly cadence (one shared session covers both apps):
dependency + advisory review, telemetry/crash triage → backlog, ring health,
cache/telemetry retention verification, UNVERIFIED-list burn-down.

---

## Stage status

- [x] Program planned, owner choices locked — 2026-08-08
- [x] **E1 Self-contained install — 2026-08-08.** Bundled ffmpeg 8.1.2 (SHA-pinned
      fetch ported from SundayRec) as Tauri `externalBin`; engine `Sidecar` resolves
      **bundled → PATH → GUI-fallback dirs** (`/opt/homebrew/bin` etc.), the shell hands
      the bundled pair down through `SyncRequest.sidecar` so the engine stays Tauri-free
      (D-031). The GUI-PATH hotfix alone fixes the v0.1.0 "ffmpeg not found" bug the owner
      hit. Onboarding step 3 is now a green self-test (bundled / system + path), not an
      install instruction; `check_sidecar` returns `{source, path}`. Also closed E2's
      F16: **the Tauri shell is now under CI** (fmt+clippy+test job, stub sidecars for
      tauri-build's existence check). Verified: both bundled binaries run under a stripped
      `PATH`, and a full CLI sync works with `PATH` = bundle dir + `/usr/bin:/bin` only.
      DMG **3.8 MB → 60.3 MB** (131 MB is the ffmpeg pair; §10's <40 MB budget explicitly
      superseded, honest number recorded in KNOWN_LIMITATIONS). 162 root + 27 vitest green.
- [x] **E2 Mapping — 2026-08-08.** Three explorers (security / stability / backend-perf),
      ~30 findings, backlog written into E3–E5 below. Convergent findings (flagged by two
      independent explorers) carry the highest confidence.
- [x] **E3 Security hardening — 2026-08-08.** S-1/S-2 ffmpeg/ffprobe protocol whitelist
      (`-protocol_whitelist file` + `-i` guard) — proven to block the SSRF/local-file
      vector via a test that forces `-f hls` and asserts ffprobe refuses `http`; S-3 FCPXML
      control-char stripping; S-5 export path validation; S-6 diagnostics scrub
      (basenames, labels→id, no username/absolute paths); S-7 cache marker; S-8 scan
      MAX_FILES ceiling + in-loop cancel; S-4 strict local-only CSP (D-033); S-9 cargo-deny
      (both workspaces) + npm-audit (shipped-deps gate, D-033) + all Actions SHA-pinned;
      SECURITY.md; fuzz/ workspace (3 targets); hostile fixtures; resolve-verify.py
      injection mode. Interrupted by an owner reboot mid-stage, resumed cleanly. 180 root +
      5 shell + 27 vitest green; cargo-deny clean both workspaces; CSP builds + embeds.
      One follow-up: vitest v4 bump to clear dev-tree audit noise.
- [ ] E4 Engine stability
- [ ] E5 Performance at scale (+ D-013 eviction decision)
- [ ] E6 Drift correction (+ D-016 closure; owner sign-off on mechanism)
- [ ] E7 Consent + telemetry client (+ owner: consent text)
- [ ] E8 Telemetry Worker side
- [ ] E9 Updater + beta ring (+ kill-switch drill)
- [ ] E10 QA foundation + real corpus (owner delivers footage)
- [ ] E11 v0.2.0-beta.1 → stable (owner test checklist)
- [ ] E12 Continuous operations (recurring)

## Standing owner items (asked at the marked stages, never silently)

E5: cache-eviction shape · E6: correction mechanism after spike · E7: consent text +
behandlingsansvarlig · E10: corpus delivery + truth sign-off · E11: beta validation
on real hardware. Apple signing/notarization stays a separate suite-level item
(team 784GN847G4) — v0.2 ships with the same right-click-to-open caveat unless that
lands in the meantime.
