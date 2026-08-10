/**
 * When was this recorded, and how do we know? (V05-W3, D-067.)
 *
 * The pre-sync timeline positions clips by the only clock the app has before it has
 * listened to anything. Until now that clock was a single field — the container's
 * `creation_time` — and a file without one went to zero. On the owner's real 386-file
 * wedding that put **174 files at position zero**, in one indistinguishable pile, and the
 * app said only "N files have no recording time" about all of them at once.
 *
 * Measured on that drop (`/Volumes/Delt Fossland/LINNEA&SIGURD/`, read-only), what the
 * files actually carry is not one field but a ladder:
 *
 * | Device | What ffprobe reports | Rung |
 * |---|---|---|
 * | Fujifilm X-H2, 246 `.MOV` | `creation_time=2026-07-25T20:41:12Z` | `container` |
 * | Zoom F6, 16 `.WAV` | `date=2026-07-25` **and** `creation_time=16:12:29` | `bwf` |
 * | Mixer, 11 `.wav` | no tags at all; `uirec-20260725_125533.wav` | `filename` |
 * | AVCHD camera, 136 `.MTS` | **no container tags whatsoever**; mtime | `modified` |
 * | Zoom F2, 5 `.WAV` | `date=2020-01-01` — the clock was never set | `none`, via the gate |
 *
 * Each rung is a weaker kind of evidence than the one above it, and the whole point of
 * this module is that the app says which rung it used rather than presenting all five as
 * the same fact. `sourceLayout.ts` turns that into a class and a sentence; files that come
 * out `none` are laid out in filename order instead (D-068), and files whose stamp the
 * session gate rejected are named with the date they claimed (D-071).
 *
 * ## Local wall time versus UTC — the one thing that is easy to get silently wrong
 *
 * A container `creation_time` is **UTC**: the Fuji writes `2026-07-25T20:41:12Z` for a clip
 * shot at 22:41 in Norwegian summer time. A BWF's `date` + `creation_time` and a timestamp
 * in a filename are **local wall time**: the Zoom's `16:12:29` is 16:12 on the wall, which
 * is 14:12 UTC. Combining them naively — `Date.parse("2026-07-25T16:12:29")` happens to
 * mean local, `Date.parse("2026-07-25T16:12:29Z")` means UTC, and the difference is a
 * trailing letter — puts the Zoom two hours away from the camera that was pointed at the
 * same bride. So the two families are converted through deliberately different doors:
 * `Date.UTC` for the absolute ones, the `new Date(y, m, d, …)` local constructor for the
 * wall-clock ones, each at its own call site with a comment saying which it is. An mtime is
 * absolute (the engine formats it as ISO UTC), so it goes through the UTC door.
 *
 * The unit tests pin `TZ` so this is asserted rather than inherited from the machine.
 */

import { compareNatural } from "./naturalSort";
import type { FileEntry } from "../types";

/** Which rung of the ladder produced a file's start — `"none"` means no rung did. */
export type TimeSource = "container" | "bwf" | "filename" | "modified" | "none";

export interface RecordingTime {
  /** Absolute ms since the epoch, or null when nothing usable was found or the session
   *  gate rejected what was. A null start is the caller's cue to lay the file out by
   *  filename order instead (D-068). */
  startMs: number | null;
  source: TimeSource;
  /**
   * Set **only** when a rung did produce a stamp and the session gate then rejected it
   * (D-071): the rejected stamp itself.
   *
   * It rides along rather than being recomputed by the caller because the gate runs here,
   * and because the UI's whole job with these files is to *name the date they claim* —
   * «14 filer er tidsstemplet 13.06.2023, utenfor denne økta». A caller that had only
   * "outside" would have to re-derive the stamp through the same ladder to say it, and two
   * derivations of one number is how they come to disagree.
   */
  outsideWindowMs?: number;
}

/**
 * The widest spread of recording times this app will lay out as one session (V04-U5,
 * carried over from `sourceLayout.ts` when the gate moved to sit over the whole ladder).
 *
 * A stamp that parses is not the same thing as a stamp that means something. A camera
 * whose battery went flat comes back reading 1970-01-01 (or its firmware's build date),
 * writes that into every container it records, and reports it as confidently as a camera
 * with a GPS lock. Before this gate, one such file in a drop set the origin decades before
 * the rest: `contentBounds` returned a span of ~1.8 × 10¹² ms, `fitPxPerMs` clamped to
 * `MIN_PX_PER_MS`, and the operator got a timeline showing twelve hours of empty grid with
 * the dud clip at the far left and every real file fifty-six years off the right edge —
 * with nothing on screen saying why.
 *
 * A day is the honest bound: SundaySync exists to line up sources that were **recording at
 * the same time**, so anything the correlator could ever match is inside one session.
 */
export const PLAUSIBLE_SPREAD_MS = 24 * 60 * 60 * 1000;

/** A backwards jump larger than this, inside one device, is midnight — not a clock error. */
const ROLLOVER_THRESHOLD_MS = 12 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The rungs, most trustworthy first. This array IS the ladder's order. */
const TIERS = ["container", "bwf", "filename", "modified"] as const;
type StampedTier = (typeof TIERS)[number];

// ── Rung 1: a full ISO datetime in the container ────────────────────────────────────────

/** `YYYY-MM-DD` followed by a time — the shape a *date* must have to be a datetime. */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/;
/** A trailing `Z` or `±HH:MM` / `±HHMM`. */
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A container stamp, in absolute ms, or null.
 *
 * The date part is required explicitly rather than left to `Date.parse`, and that guard is
 * the whole reason this function exists: `Date.parse("16:12:29")` is NaN in every engine,
 * but the Zoom F6's `creation_time` really is `16:12:29`, and a guard written as "does it
 * parse?" would have let a *time of day* through as a datetime on some future engine that
 * was more forgiving. Requiring the date is a check of what the string IS, not of what a
 * particular parser makes of it.
 *
 * A stamp with no zone designator is read as **UTC**, not as local: ffprobe writes
 * container times in UTC and simply omits the `Z` on some containers, and `Date.parse`'s
 * own rule for a zoneless datetime (local) would silently shift such a file by the
 * operator's offset.
 */
function containerMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!ISO_DATE_TIME.test(trimmed)) return null;
  const ms = Date.parse(HAS_ZONE.test(trimmed) ? trimmed : `${trimmed}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// ── Rung 2 and 3: dates and times spelled out in tags, filenames and folders ────────────

/** A bare time of day — what a BWF puts in `creation_time` when `date` holds the rest. */
const TIME_ONLY = /^(\d{1,2}):(\d{2}):(\d{2})$/;
/** `YYYY-MM-DD`, the shape of a BWF `date` tag. */
const DATE_TAG = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** Is this a real day, rather than merely three numbers in range? (2026-02-30 is not.) */
function isRealDate({ year, month, day }: CivilDate): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(year, month - 1, day);
  return (
    probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
  );
}

/**
 * A local wall-clock date + time as absolute ms.
 *
 * `new Date(y, m, d, …)` is the LOCAL constructor, and that is the point — see the module
 * note. Every caller of this function is holding a time somebody read off a recorder's
 * front panel, not a time in UTC.
 */
function localMs(date: CivilDate, hours: number, minutes: number, seconds: number): number {
  return new Date(date.year, date.month - 1, date.day, hours, minutes, seconds, 0).getTime();
}

/** Maximal runs of digits in a string, with the text between them. */
function digitRuns(text: string): { digits: string; gapAfter: string }[] {
  const out: { digits: string; gapAfter: string }[] = [];
  const pattern = /\d+/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const next = pattern.exec(text);
    out.push({
      digits: match[0],
      gapAfter: text.slice(match.index + match[0].length, next?.index ?? text.length),
    });
    match = next;
  }
  return out;
}

/**
 * Six digits are a date twice over: `260725` is 2026-07-25 read `YYMMDD` and 2025-07-26
 * read `DDMMYY`, and both are dates somebody's camera really writes.
 *
 * **Measured, not assumed.** On the owner's drop the Zoom F6's folder token `260725` sits
 * beside that same recorder's own `date=2026-07-25` tag and beside the Fuji's ISO
 * `2026-07-25` — `YYMMDD` reproduces both, `DDMMYY` would read 2025-07-26 and matches
 * nothing in the drop. So `YYMMDD` is the default. It is a *default* rather than a
 * hardcoding because the reading is decidable at runtime whenever there is anything to
 * decide it against: when both readings are real days, the one nearer the day the
 * timestamped files agree on wins.
 *
 * `referenceDay` is local midnight of the median container stamp, or null when the drop
 * has none — in which case there is nothing to disambiguate against and the measured
 * default stands.
 */
function readSixDigitDate(token: string, referenceDay: number | null): CivilDate | null {
  const n = (from: number) => Number(token.slice(from, from + 2));
  const yymmdd: CivilDate = { year: 2000 + n(0), month: n(2), day: n(4) };
  const ddmmyy: CivilDate = { year: 2000 + n(4), month: n(2), day: n(0) };
  const yyOk = isRealDate(yymmdd);
  const ddOk = isRealDate(ddmmyy);
  if (!yyOk) return ddOk ? ddmmyy : null;
  if (!ddOk) return yymmdd;
  if (referenceDay === null) return yymmdd;
  const distance = (d: CivilDate) => Math.abs(localMs(d, 0, 0, 0) - referenceDay);
  // Ties keep the measured reading — the two candidates are the same day, or equally far
  // from it, and there is no evidence to overturn the default with.
  return distance(ddmmyy) < distance(yymmdd) ? ddmmyy : yymmdd;
}

/** Eight digits are only ever `YYYYMMDD`; nothing writes `DDMMYYYY` into a filename. */
function readEightDigitDate(token: string): CivilDate | null {
  const date: CivilDate = {
    year: Number(token.slice(0, 4)),
    month: Number(token.slice(4, 6)),
    day: Number(token.slice(6, 8)),
  };
  return isRealDate(date) ? date : null;
}

/** A date token standing alone in one path segment, if there is one. */
function dateInSegment(segment: string, referenceDay: number | null): CivilDate | null {
  for (const { digits } of digitRuns(segment)) {
    if (digits.length === 8) {
      const eight = readEightDigitDate(digits);
      if (eight) return eight;
    }
    if (digits.length === 6) {
      const six = readSixDigitDate(digits, referenceDay);
      if (six) return six;
    }
  }
  return null;
}

function pathSegments(path: string): string[] {
  return path.split(/[/\\]/).filter((s) => s.length > 0);
}

/**
 * A `YYYYMMDD_HHMMSS` or `YYMMDD_HHMMSS` stamp in a basename — the mixer's
 * `uirec-20260725_125533.wav`.
 *
 * Found by walking adjacent digit RUNS rather than by a regex over the whole name, so a
 * longer run can never be sliced into a false match: `123456789_012345` has a 9-digit run
 * and is correctly not a date, where `/(\d{8})[_-](\d{6})/` would have taken its last
 * eight digits. The separator must be exactly one `_` or `-`; anything else is two
 * unrelated numbers that happen to be neighbours.
 */
function filenameStamp(basename: string, referenceDay: number | null): number | null {
  const runs = digitRuns(basename);
  for (let i = 0; i + 1 < runs.length; i++) {
    const left = runs[i];
    const right = runs[i + 1];
    if (left.gapAfter !== "_" && left.gapAfter !== "-") continue;
    if (right.digits.length !== 6) continue;
    const date =
      left.digits.length === 8
        ? readEightDigitDate(left.digits)
        : left.digits.length === 6
          ? readSixDigitDate(left.digits, referenceDay)
          : null;
    if (!date) continue;
    const hours = Number(right.digits.slice(0, 2));
    const minutes = Number(right.digits.slice(2, 4));
    const seconds = Number(right.digits.slice(4, 6));
    if (hours > 23 || minutes > 59 || seconds > 59) continue;
    // LOCAL: a recorder names its files off its own front-panel clock.
    return localMs(date, hours, minutes, seconds);
  }
  return null;
}

// ── The gate ────────────────────────────────────────────────────────────────────────────

/**
 * The largest run of `stamps` that fits inside {@link PLAUSIBLE_SPREAD_MS}, as `[lo, hi]`.
 *
 * Found by a sliding window over the sorted times. Ties go to the LATER window on purpose:
 * a clock that is wrong is almost always wrong *early* (an epoch, a factory date, a
 * battery-pull default), because a camera with no time to restore falls back to a fixed
 * past, never to a fixed future.
 */
function plausibleWindow(stamps: readonly number[]): [number, number] | null {
  if (stamps.length === 0) return null;
  const sorted = [...stamps].sort((a, b) => a - b);
  let best: [number, number] | null = null;
  let bestCount = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] > PLAUSIBLE_SPREAD_MS) lo++;
    const count = hi - lo + 1;
    // `>=` rather than `>`: scanning left to right, a later window of equal size replaces
    // an earlier one, which is the tie-break described above.
    if (count >= bestCount) {
      bestCount = count;
      best = [sorted[lo], sorted[hi]];
    }
  }
  return best;
}

// ── The ladder ──────────────────────────────────────────────────────────────────────────

interface Rung {
  file: string;
  device: string;
  tier: StampedTier;
  ms: number;
}

/**
 * Every file's recording time, with the rung that produced it.
 *
 * Files with no usable evidence — and files whose evidence the session gate rejected —
 * come back `{ startMs: null, source: "none" }`. Nothing is invented: a recorder that
 * wrote nothing has told us nothing, and D-068's sequential layout is the caller's answer
 * to that, not this module's.
 */
export function recordingTimes(files: readonly FileEntry[]): Map<string, RecordingTime> {
  const out = new Map<string, RecordingTime>();
  const rungs: Rung[] = [];

  // ---- Tier 1 first and on its own, because tiers 2 and 3 are measured against it ------
  //
  // A six-digit date token is ambiguous and a BWF may carry a time with no date at all;
  // both are decided by "which day was this drop shot on?", and the container stamps are
  // the only rung that answers that without needing an answer itself. Computing tier 1
  // first is what keeps that from being circular.
  const containerStamps: number[] = [];
  const containerFiles = new Set<string>();
  for (const entry of files) {
    const ms = containerMs(entry.creation_time);
    if (ms === null) continue;
    containerStamps.push(ms);
    containerFiles.add(entry.file);
    rungs.push({ file: entry.file, device: entry.device, tier: "container", ms });
  }

  /** Local midnight of the median container stamp — the drop's "session day". */
  const referenceDay = medianDayLocal(containerStamps);

  // ---- Tiers 2–4 -----------------------------------------------------------------------
  for (const entry of files) {
    if (containerFiles.has(entry.file)) continue;
    const rung = lowerRung(entry, referenceDay);
    if (rung !== null) rungs.push({ file: entry.file, device: entry.device, ...rung });
  }

  // ---- Midnight rollover, per device, in filename order --------------------------------
  applyMidnightRollover(rungs);

  // ---- The session gate, over the LADDER's output rather than over `creation_time` ------
  const admitted = admissible(rungs);

  for (const entry of files) out.set(entry.file, { startMs: null, source: "none" });
  for (const rung of rungs) {
    out.set(
      rung.file,
      admitted.has(rung.file)
        ? { startMs: rung.ms, source: rung.tier }
        : // Demoted: no position, but the stamp is kept so the UI can name the date
          // (D-071). A file the gate rejected is NOT retried on a lower rung — the
          // evidence it gave was read, and it said somewhere else.
          { startMs: null, source: "none", outsideWindowMs: rung.ms },
    );
  }
  return out;
}

/** Tier 2, 3 or 4 for one file, in that order. Null when no rung answers. */
function lowerRung(
  entry: FileEntry,
  referenceDay: number | null,
): { tier: StampedTier; ms: number } | null {
  const segments = pathSegments(entry.file);
  const basename = segments[segments.length - 1] ?? entry.file;

  // Rung 2 — BWF: a time of day in `creation_time`, and the date sought elsewhere.
  const timeOfDay = TIME_ONLY.exec((entry.creation_time ?? "").trim());
  if (timeOfDay) {
    const date = bwfDate(entry, segments, referenceDay);
    if (date !== null) {
      // LOCAL: the recorder's own front-panel clock, in both halves.
      const ms = localMs(
        date,
        Number(timeOfDay[1]),
        Number(timeOfDay[2]),
        Number(timeOfDay[3]),
      );
      return { tier: "bwf", ms };
    }
  }

  // Rung 3 — a full stamp spelled into the filename.
  const fromName = filenameStamp(basename, referenceDay);
  if (fromName !== null) return { tier: "filename", ms: fromName };

  // Rung 4 — the mtime, which is the END of the write.
  //
  // Measured on the owner's 136 `.MTS` files and consistent to the second across the
  // series: `02106` mtime 14:12:08 for a 30.7 s clip, `02107` mtime 14:12:58 for an 11 s
  // one — 50 s apart for a 30.7 s clip and its gap. So the start is the mtime minus the
  // duration. Birth time is deliberately NOT used: on those same files it is the date they
  // were copied off the card (2026-07-27), which is a confident wrong answer, and a
  // confident wrong answer is worse here than no answer at all.
  const modified = containerMs(entry.modified_time); // absolute UTC, written by the engine
  if (modified !== null) {
    const duration = Number.isFinite(entry.duration_seconds) ? entry.duration_seconds : 0;
    return { tier: "modified", ms: modified - Math.max(0, duration) * 1000 };
  }

  return null;
}

/** A BWF's date: the `date` tag, then a token in the name or a parent folder, then the day
 *  the timestamped files agree on. In that order — each is weaker than the one before. */
function bwfDate(
  entry: FileEntry,
  segments: readonly string[],
  referenceDay: number | null,
): CivilDate | null {
  const tag = DATE_TAG.exec((entry.date_tag ?? "").trim());
  if (tag) {
    const date = {
      year: Number(tag[1]),
      month: Number(tag[2]),
      day: Number(tag[3]),
    };
    if (isRealDate(date)) return date;
  }
  // Basename first, then parent folders nearest-first: the Zoom F6 writes the take date
  // into both (`260725_001.TAKE/260725_001_Tr1.WAV`), and a name is more specific than the
  // folder it happens to be sitting in.
  for (let i = segments.length - 1; i >= 0; i--) {
    const found = dateInSegment(segments[i], referenceDay);
    if (found) return found;
  }
  if (referenceDay !== null) {
    const day = new Date(referenceDay);
    return { year: day.getFullYear(), month: day.getMonth() + 1, day: day.getDate() };
  }
  return null;
}

/** Local midnight of the median of `stamps`, or null when there are none. */
function medianDayLocal(stamps: readonly number[]): number | null {
  if (stamps.length === 0) return null;
  const sorted = [...stamps].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  const day = new Date(middle);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}

/**
 * A date token that stood still while the recorder crossed midnight.
 *
 * The evidence in rungs 2 and 3 is a *date* and a *time of day* that were written down
 * separately, and a recorder that starts a take at 23:50 and another at 00:10 may keep
 * writing yesterday's date into the folder name — so the second take reads as 23 h 40 min
 * EARLIER than the first. Inside one device, in the order the camera numbered the files, a
 * backwards jump of more than twelve hours is that, and not a clock that ran backwards.
 * The correction is cumulative: everything from the crossing onward is a day later.
 *
 * Only rungs 2 and 3 are corrected. A container stamp and an mtime both carry their own
 * date, so a backwards jump there is a genuine disagreement the session gate should judge,
 * not a rollover to paper over.
 */
function applyMidnightRollover(rungs: Rung[]): void {
  const byDevice = new Map<string, Rung[]>();
  for (const rung of rungs) {
    if (rung.tier !== "bwf" && rung.tier !== "filename") continue;
    const list = byDevice.get(rung.device) ?? [];
    list.push(rung);
    byDevice.set(rung.device, list);
  }
  for (const list of byDevice.values()) {
    list.sort((a, b) => compareNatural(a.file, b.file));
    let offset = 0;
    let previous: number | null = null;
    for (const rung of list) {
      const raw = rung.ms;
      if (previous !== null && raw + offset < previous - ROLLOVER_THRESHOLD_MS) {
        offset += DAY_MS;
      }
      rung.ms = raw + offset;
      previous = rung.ms;
    }
  }
}

/**
 * Which stamps can be read as one session.
 *
 * The **reference tier** is the highest-confidence tier that produced at least two stamps —
 * two being the least that can corroborate anything. When no tier managed two, the single
 * most trustworthy stamp there is anchors instead: one clock cannot contradict itself, and
 * a lone file's stamp positions nothing anyway.
 *
 * That tier's own {@link plausibleWindow} is the seed. Every other stamp is then offered to
 * the window in order of distance from its centre, and admitted only if the whole admitted
 * set still fits inside {@link PLAUSIBLE_SPREAD_MS}. Growing the window rather than testing
 * against a fixed hull is what lets the lower rungs be aggressive without being reckless: on
 * the owner's drop the AVCHD camera's first mtime lands an hour *before* the earliest
 * container stamp, which a hull test would have thrown away, while the June drone folder
 * and the F2's 2020 clock are still refused because admitting either would stretch the set
 * past a day.
 *
 * Deterministic: candidates are ordered by distance and then by value, never by input
 * order, so the same drop admits the same set however the manifest was walked.
 */
function admissible(rungs: readonly Rung[]): Set<string> {
  const admitted = new Set<string>();
  if (rungs.length === 0) return admitted;

  const referenceTier =
    TIERS.find((tier) => rungs.filter((r) => r.tier === tier).length >= 2) ??
    TIERS.find((tier) => rungs.some((r) => r.tier === tier));
  if (referenceTier === undefined) return admitted;

  const seed = plausibleWindow(
    rungs.filter((r) => r.tier === referenceTier).map((r) => r.ms),
  );
  if (seed === null) return admitted;

  let [lo, hi] = seed;
  const centre = (lo + hi) / 2;
  const candidates = [...rungs].sort(
    (a, b) => Math.abs(a.ms - centre) - Math.abs(b.ms - centre) || a.ms - b.ms,
  );
  for (const rung of candidates) {
    const nextLo = Math.min(lo, rung.ms);
    const nextHi = Math.max(hi, rung.ms);
    if (nextHi - nextLo > PLAUSIBLE_SPREAD_MS) continue;
    lo = nextLo;
    hi = nextHi;
    admitted.add(rung.file);
  }
  return admitted;
}
