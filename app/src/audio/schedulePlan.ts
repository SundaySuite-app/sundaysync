/**
 * The playback schedule — pure arithmetic, no Web Audio, no React (V03-S5, D-055).
 *
 * This is where playback's correctness lives. The Web Audio graph in `scheduler.ts` does
 * nothing clever: it takes what this module computes and calls
 * `AudioBufferSourceNode.start(base + whenOffsetSec, sourceOffsetSec, sourceDurationSec)`
 * on each entry. Every source is scheduled against **one captured `base`**, so the
 * relative timing of two clips is decided here, in numbers a test can read, and then
 * realised by the audio hardware's own sample clock. That is what makes the result
 * sample-accurate by construction rather than by luck: nothing is ever started "now".
 *
 * ## The two traps, and how they are avoided
 *
 * **1. Accumulating float error across chunks.** A clip is played as a chain of 15-second
 * chunks. The obvious implementation walks the chain adding chunk lengths, and each
 * addition rounds; over a two-hour service the chain slides. Instead every chunk's
 * position is derived *directly from its index* in SOURCE sample space
 * (`chunk k starts at source sample k·CHUNK_SAMPLES`) and mapped once into timeline time.
 * Chunk 400 is computed from 400, not from chunk 399.
 *
 * **2. The drift sign.** See {@link clipTransport}. Getting it backwards does not sound
 * like nothing — it doubles the error, which is the single most expensive mistake this
 * file could make, so it is pinned by a test that mirrors the engine's own.
 */

/** The analysis (and therefore playback) sample rate — `SyncResult.parameters.analysis_rate`. */
export const ANALYSIS_RATE = 12_000;

/** One chunk: 15 s at the analysis rate = 180 000 samples = 720 KB of f32. */
export const CHUNK_SAMPLES = 180_000;

/** Bytes one resident chunk costs. Used by `pcmPlan.ts`'s budget. */
export const CHUNK_BYTES = CHUNK_SAMPLES * 4;

/**
 * D-045's credibility bound, mirrored on the playback side.
 *
 * The engine already refuses to *place* a clip whose drift is not credible, so nothing
 * arriving here should exceed it — but §5 carries `drift_ppm` as a bare number with
 * nothing attached saying it was examined, and the exporter re-checks for exactly that
 * reason. A −587 484 ppm "drift" (E10's edited-mix corpus) applied as a playback rate
 * would be silence or a chipmunk, and the operator would blame the sync.
 */
export const MAX_CREDIBLE_DRIFT_PPM = 500;

/** One clip as playback sees it: timeline placement plus the engine's drift measurement. */
export interface PlacedClip {
  file: string;
  device: string;
  /**
   * Timeline start in seconds, already origin-shifted the way `TimelineView` shifts it,
   * and **before** any drift correction — i.e. §5's `offset_seconds` minus the timeline
   * origin. This is where the clip is *drawn*.
   */
  startSec: number;
  /** The clip's true recorded length in seconds (its source span). */
  durationSec: number;
  /** §5 `drift_ppm` — `null` when the engine did not measure drift for this clip. */
  driftPpm: number | null;
  /** §5 `projected_end_error_ms` — `null` alongside a null `driftPpm`. */
  projectedEndErrorMs: number | null;
}

export interface ScheduleOptions {
  /** Whether to apply drift correction at all (Settings → `playbackDriftCorrected`). */
  driftCorrected: boolean;
  /**
   * Sequence frame rate, for the exporter's half-frame gate. Omit (or 0) to correct every
   * credible drift. Passing the real fps makes playback correct exactly the clips the
   * export will correct — which is the point of listening before exporting.
   */
  fps?: number;
  /** How far ahead of the playhead to schedule, seconds. */
  horizonAheadSec?: number;
}

/** A clip resolved into the two numbers playback needs: where it starts, and how fast. */
export interface ClipTransport {
  file: string;
  device: string;
  /** Timeline second at which this clip's source sample 0 is heard. */
  startSec: number;
  /**
   * `AudioBufferSourceNode.playbackRate` — source seconds consumed per timeline second.
   * `1` for an uncorrected clip.
   */
  rate: number;
  /** The clip's length in source samples. */
  sourceSamples: number;
  /** Timeline second at which the clip ends (`startSec + sourceSamples/rate/RATE`). */
  endSec: number;
  /** Whether drift correction was actually applied (for the UI and the test hook). */
  corrected: boolean;
}

/**
 * Resolve one clip's start and playback rate, applying drift correction exactly as the
 * FCPXML exporter does.
 *
 * ## The sign — the one thing in this file that must not be guessed
 *
 * `crates/core/src/drift.rs` defines `ppm` as `d(offset)/d(position in clip)`: **positive
 * means the clip needs a progressively later offset**, i.e. its own clock ran fast. From
 * that, `Drift::timeline_stretch` is `1 + ppm·1e-6` — a source span of length `L` must
 * occupy `L·(1 + ppm·1e-6)` of *timeline* for its far end to land where the reference
 * puts it (D-042). The source therefore has to be *played back* at the reciprocal,
 * `1 / (1 + ppm·1e-6)` — which is precisely D-019's resample factor, written from the
 * other side. Using `1 + ppm·1e-6` as the rate instead would move the end the wrong way
 * and **double** the error.
 *
 * The exact reciprocal is used rather than the linearisation `1 − ppm·1e-6`; at 500 ppm
 * they differ by 0.25 ppm, which is free to get right and pointless to approximate.
 *
 * ## Why the start moves too
 *
 * §4.3 estimates a clip's offset at its **midpoint** (it takes the median of the segment
 * matches), so the stored `offset_seconds` is half a clip's drift away from where the
 * clip's *first* sample belongs. Playback pivots the stretch on the clip start, so — like
 * the exporter — the start is first re-referenced by `projected_end_error_ms / 2000`
 * seconds. Skipping this would leave both ends half a drift out: for a 500 ppm, 1000 s
 * clip that is 250 ms at the start, which is not a subtlety, it is an echo.
 */
export function clipTransport(clip: PlacedClip, opts: ScheduleOptions): ClipTransport {
  const sourceSamples = Math.max(0, Math.round(clip.durationSec * ANALYSIS_RATE));
  const ppm = clip.driftPpm;
  const endErrorMs = clip.projectedEndErrorMs;

  const correctable =
    opts.driftCorrected &&
    ppm !== null &&
    endErrorMs !== null &&
    Number.isFinite(ppm) &&
    Number.isFinite(endErrorMs) &&
    Math.abs(ppm) <= MAX_CREDIBLE_DRIFT_PPM &&
    // Mirrors `Drift::exceeds_half_frame`: below half a frame the export leaves the clip
    // exactly as v1, so playback must too or the two would disagree about a clip nobody
    // is going to correct.
    (!opts.fps || opts.fps <= 0 || Math.abs(endErrorMs) > 1000 / opts.fps / 2);

  if (!correctable) {
    const startSec = clip.startSec;
    return {
      file: clip.file,
      device: clip.device,
      startSec,
      rate: 1,
      sourceSamples,
      endSec: startSec + sourceSamples / ANALYSIS_RATE,
      corrected: false,
    };
  }

  const stretch = 1 + (ppm as number) * 1e-6;
  const rate = 1 / stretch;
  const startSec = clip.startSec - (endErrorMs as number) / 2000;
  return {
    file: clip.file,
    device: clip.device,
    startSec,
    rate,
    sourceSamples,
    // Timeline span = source span × stretch, which is source samples ÷ rate.
    endSec: startSec + sourceSamples / ANALYSIS_RATE / rate,
    corrected: true,
  };
}

/** How many chunks a clip of `sourceSamples` samples is made of. */
export function chunkCount(sourceSamples: number): number {
  return Math.max(0, Math.ceil(sourceSamples / CHUNK_SAMPLES));
}

/** The source-sample half-open range chunk `k` of a clip covers. */
export function chunkRange(
  chunkIndex: number,
  sourceSamples: number,
): { from: number; to: number } {
  const from = chunkIndex * CHUNK_SAMPLES;
  return { from, to: Math.min(from + CHUNK_SAMPLES, sourceSamples) };
}

/**
 * The timeline seconds chunk `k` of `t` occupies.
 *
 * Derived from the chunk index, never from the previous chunk — trap 2 in this file's
 * header. `startSec + (k·CHUNK_SAMPLES/RATE)/rate` is exact for every k.
 */
export function chunkTimelineSpan(
  t: ClipTransport,
  chunkIndex: number,
): { startSec: number; endSec: number } {
  const { from, to } = chunkRange(chunkIndex, t.sourceSamples);
  return {
    startSec: t.startSec + from / ANALYSIS_RATE / t.rate,
    endSec: t.startSec + to / ANALYSIS_RATE / t.rate,
  };
}

/** Whether a chunk is resident and playable. `pcmStore` implements this. */
export interface ResidentLookup {
  has(file: string, chunkIndex: number): boolean;
}

/**
 * One `AudioBufferSourceNode` to create and start.
 *
 * `sourceOffsetSec` and `sourceDurationSec` are in the **buffer's** time domain (Web
 * Audio's `start(when, offset, duration)` measures both there, not in output time), so
 * they are unaffected by `rate`; only `whenOffsetSec` lives on the timeline.
 */
export interface ScheduledSource {
  file: string;
  device: string;
  chunkIndex: number;
  /** Seconds after the captured `base` at which to start this source. Never negative. */
  whenOffsetSec: number;
  /** Where in the chunk's buffer to start, seconds. */
  sourceOffsetSec: number;
  /** How much of the chunk's buffer to play, seconds. */
  sourceDurationSec: number;
  /** `playbackRate` for this source — the clip's drift correction. */
  rate: number;
}

/** Sub-sample noise; anything shorter than this is not worth a source node. */
const EPSILON_SEC = 1 / ANALYSIS_RATE / 2;

/**
 * Everything that should be sounding, or about to sound, if playback starts at `tSec`.
 *
 * Only *resident* chunks are returned: a chunk still in flight is simply absent, and the
 * scheduler's 1 Hz top-up picks it up (through {@link catchUp}) once it lands. That is
 * the whole buffering strategy — no blocking, no silence-filling, no guessing.
 *
 * The partially-elapsed chunk (the one the playhead is standing in) gets
 * `whenOffsetSec = 0` and a `sourceOffsetSec` computed from the playhead in source sample
 * space: `(tSec − startSec)·rate` source seconds into the clip, minus where the chunk
 * begins.
 */
export function computeSchedule(
  clips: PlacedClip[],
  tSec: number,
  resident: ResidentLookup,
  opts: ScheduleOptions,
): ScheduledSource[] {
  const horizon = opts.horizonAheadSec ?? 30;
  const out: ScheduledSource[] = [];

  for (const clip of clips) {
    const t = clipTransport(clip, opts);
    if (t.sourceSamples <= 0) continue;
    if (t.endSec <= tSec) continue;
    if (t.startSec >= tSec + horizon) continue;

    const total = chunkCount(t.sourceSamples);
    // Elapsed source seconds into the clip at the playhead. Negative before it starts.
    const elapsedSourceSec = (tSec - t.startSec) * t.rate;

    for (let k = 0; k < total; k += 1) {
      const { from, to } = chunkRange(k, t.sourceSamples);
      const chunkFromSec = from / ANALYSIS_RATE;
      const chunkToSec = to / ANALYSIS_RATE;
      const span = chunkTimelineSpan(t, k);

      if (span.endSec <= tSec) continue; // wholly in the past
      if (span.startSec >= tSec + horizon) break; // and so is every later chunk
      if (!resident.has(clip.file, k)) continue; // not here yet; the top-up will catch it

      const partial = span.startSec < tSec;
      const sourceOffsetSec = partial ? elapsedSourceSec - chunkFromSec : 0;
      const sourceDurationSec = chunkToSec - chunkFromSec - sourceOffsetSec;
      if (sourceDurationSec <= EPSILON_SEC) continue;

      out.push({
        file: clip.file,
        device: clip.device,
        chunkIndex: k,
        whenOffsetSec: partial ? 0 : span.startSec - tSec,
        sourceOffsetSec: Math.max(0, sourceOffsetSec),
        sourceDurationSec,
        rate: t.rate,
      });
    }
  }

  // Deterministic order so the test hook (and a diff of two runs) is stable.
  out.sort(
    (a, b) =>
      a.whenOffsetSec - b.whenOffsetSec ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.chunkIndex - b.chunkIndex,
  );
  return out;
}

/**
 * Re-aim an entry whose moment has already passed, because its chunk arrived late.
 *
 * A slow NAS can hand back a chunk after the instant it was supposed to start. Starting
 * it anyway at "now" would play it `lateSec` too late — an echo, the exact artefact this
 * whole stage exists to make audible. Skipping it would be a silent gap. Neither: skip
 * *the part that has already passed* and start the remainder at its correct sample.
 * Returns `null` when the whole chunk is behind us.
 */
export function catchUp(entry: ScheduledSource, lateSec: number): ScheduledSource | null {
  if (lateSec <= 0) return entry;
  const skipped = lateSec * entry.rate; // source seconds consumed while we waited
  const sourceDurationSec = entry.sourceDurationSec - skipped;
  if (sourceDurationSec <= EPSILON_SEC) return null;
  return {
    ...entry,
    whenOffsetSec: entry.whenOffsetSec + lateSec,
    sourceOffsetSec: entry.sourceOffsetSec + skipped,
    sourceDurationSec,
  };
}

/** The timeline length playback should stop at: the last clip's end. */
export function timelineDurationSec(clips: PlacedClip[], opts: ScheduleOptions): number {
  let end = 0;
  for (const clip of clips) {
    const t = clipTransport(clip, opts);
    if (t.endSec > end) end = t.endSec;
  }
  return end;
}
