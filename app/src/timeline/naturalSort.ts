/**
 * The order a human reads a card in (V05-W3, D-068).
 *
 * When nothing in a file says when it was recorded, the app has exactly one honest fact
 * left about it: where it sits in its own device's sequence. The camera numbered it, and
 * the numbering is the shooting order. `sourceLayout.ts` lays those files end to end in
 * this order — so this comparison IS the claim the timeline makes about them, and it has
 * to be the order the operator would have written down.
 *
 * `localeCompare` is not that order and neither is `<`. Both compare digits as text, so
 * `DSCF10000` sorts before `DSCF6408` (because `1` < `6`) and a card whose numbering
 * rolled past 9999 comes out shuffled. `Intl.Collator(..., { numeric: true })` gets the
 * digits right but brings a locale with it: the same drop would order differently under a
 * different system language, and a layout that changes with the operator's locale is not a
 * layout anyone can reason about. So this is hand-written, locale-free and deterministic.
 *
 * Two rules, both measured against the owner's four real filename families:
 *
 *   - **Digit runs compare as numbers.** `DSCF640 < DSCF6408 < DSCF10000`, `02106 < 02118`.
 *     Compared by length-then-lexicographically after stripping leading zeros rather than
 *     by `Number()`, so a 25-digit run in some future camera's naming cannot silently
 *     collapse into a float that equals its neighbour.
 *   - **Directory segments compare before the basename.** The Zoom F6 writes one folder per
 *     take — `260725_001.TAKE/…_Tr1.WAV`, `260725_007.TAKE/…` — and every take's files are
 *     named alike inside it. Comparing whole paths as strings would work here by accident
 *     (`/` sorts low) but breaks the moment one folder name is a prefix of another, so the
 *     segments are compared as segments, and a path that runs out of segments first sorts
 *     before the deeper one it is a prefix of.
 *
 * Pure and React-free like its neighbours, because "which order did the app decide these
 * were in?" is exactly the arithmetic that is easy to get quietly wrong.
 */

/** Splits a path on both separators — a Windows manifest carries backslashes. */
function segments(path: string): string[] {
  return path.split(/[/\\]/).filter((s) => s.length > 0);
}

/** `"DSCF6408"` → `["DSCF", "6408"]`; maximal runs, alternating kind. */
function chunks(text: string): string[] {
  return text.match(/\d+|\D+/g) ?? [];
}

/** Two digit runs as numbers, without ever building a number. */
function compareDigits(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  if (x.length !== y.length) return x.length - y.length;
  if (x < y) return -1;
  if (x > y) return 1;
  // Same value: the one written with fewer leading zeros first, so `01` and `1` have a
  // stable order instead of depending on which the sort happened to see first.
  return a.length - b.length;
}

/** One path segment, chunk by chunk. */
function compareSegment(a: string, b: string): number {
  const left = chunks(a);
  const right = chunks(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const l = left[i];
    const r = right[i];
    const lDigits = /^\d/.test(l);
    const rDigits = /^\d/.test(r);
    if (lDigits && rDigits) {
      const byValue = compareDigits(l, r);
      if (byValue !== 0) return byValue;
      continue;
    }
    if (lDigits !== rDigits) {
      // A digit run and a letter run at the same position: digits first, so `2.MOV` sorts
      // before `A.MOV` the way a file listing shows them.
      return lDigits ? -1 : 1;
    }
    // Case-insensitively first — `IMG` and `img` are one camera's two moods, not two
    // sequences — then case-sensitively, so the order is still total and stable.
    const lLower = l.toLowerCase();
    const rLower = r.toLowerCase();
    if (lLower !== rLower) return lLower < rLower ? -1 : 1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return left.length - right.length;
}

/**
 * Natural path order: `-1`, `0` or `1`, total and locale-free.
 *
 * Equal only for identical strings modulo separator spelling — which matters, because a
 * comparator that returns 0 for two different files would let the sort's stability decide
 * their layout order, and that is not a decision anyone made.
 */
export function compareNatural(a: string, b: string): number {
  const left = segments(a);
  const right = segments(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const byName = compareSegment(left[i], right[i]);
    if (byName !== 0) return byName;
  }
  // Every shared segment matched: the shallower path is nearer the root and reads first,
  // the way `a/b` comes before `a/b/c.wav` in any file listing.
  return left.length - right.length;
}

/** The same order, as a copy. Never sorts in place — the caller's array is the manifest's. */
export function sortNatural(paths: readonly string[]): string[] {
  return [...paths].sort(compareNatural);
}
