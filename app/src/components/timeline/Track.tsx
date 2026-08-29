import { memo, useMemo } from "react";
import type { Strings } from "../../i18n";
import { formatDuration } from "../../i18n";
import { visibleClips, type TimelineView } from "../../timeline/geometry";
import { roomBeforeNext } from "../../timeline/hop";
import type { ClipSpan } from "../../timeline/laneLayout";
import type { PrewarmStatus } from "../../state";
import type { TimeSource } from "../../timeline/recordingTime";
import type { Device, Placement } from "../../types";
import { CameraIcon, MicIcon } from "../icons";
import { Clip } from "./Clip";

/**
 * One device: a fixed gutter naming it, and to its right the stacked sub-track
 * lanes holding its clips.
 *
 * Usually there is exactly one lane — §4.4's same-device eviction (D-050) means
 * one camera's clips do not overlap. The multitrack-board exemption and near-miss
 * overlaps can still produce two or more, and `stackClips` has already packed
 * them; here they simply become extra rows, so nothing hides behind anything.
 *
 * A device with nothing placed still renders, with its lane empty and saying so
 * — §7.5's rule that a camera which synced nothing must be visible, not absent.
 *
 * Only the clips inside the visible window get DOM nodes (`visibleClips`, plus
 * its overscan buffer), which is what keeps a hundreds-of-clips result smooth
 * while panning.
 *
 * The gutter also carries this device's mute and solo (v0.3, D-055). They are
 * here rather than in the transport because "which of these two is the one
 * that's late?" is a per-device question, and answering it means soloing a
 * device while looking at its lane. Solo is hidden when there is only one
 * device: soloing the only thing playing is a control with no effect, and a
 * control with no effect is worse than no control. By the same rule the whole
 * mix block is hidden before a sync (`showMix`, v0.4 D-061): there is no
 * schedule to play yet, so there is nothing to mute.
 *
 * `placements` is null before a sync — the clips are drawn from the scan's own
 * creation timestamps and there is no engine detail behind them yet.
 *
 * ## Two lines (V06-R2b, D-083)
 *
 * The gutter is the DEVICE'S HOME, not a label. Line one is who it is — icon, name, the
 * reference badge, the mix buttons. Line two is what it brought and where it stands: how
 * many files, how much material, and one dot for the state the whole row is in. Those three
 * facts used to be somewhere else entirely (a list under the timeline, a legend above it, a
 * colour on 3 px clips), and the row is where they are actually asked about — "how far has
 * Camera B got" is a question about a row, answered by looking at that row.
 *
 * Everything on line two is computed HERE, from props the component already had: the file
 * count and the total length come out of `rows` (the spans it is about to draw anyway) and
 * the dot's state out of `prewarm` plus whether there are placements at all. No new props,
 * because a count App computed and Track drew would be a second place that can disagree
 * with the lane beside it.
 */
export const Track = memo(function Track({
  t,
  device,
  rows,
  placements,
  view,
  visStart,
  visEnd,
  isReference,
  unknownDurations,
  timeSource,
  outsideWindow,
  prewarm,
  laneHeight,
  onSelect,
  muted,
  soloed,
  showSolo,
  showMix,
  onToggleMute,
  onToggleSolo,
}: {
  t: Strings;
  device: Device;
  rows: ClipSpan[][];
  /** Placement per file — the engine detail behind each drawn box. Null before a sync. */
  placements: Map<string, Placement> | null;
  view: TimelineView;
  visStart: number;
  visEnd: number;
  isReference: boolean;
  /** Files the outcome carries no duration for — drawn as a stated unknown rather than
   *  as a silent zero-length sliver (V03-S6, finding 15). */
  unknownDurations: ReadonlySet<string>;
  /** Pre-sync: which rung of the recording-time ladder positioned each file (D-067).
   *  Empty after a sync — the engine's answer has replaced every rung of it. */
  timeSource: ReadonlyMap<string, TimeSource>;
  /** Pre-sync: files whose timestamp belongs to another day (D-071). */
  outsideWindow: ReadonlySet<string>;
  /** file -> background pre-analysis status (v0.4, D-062); a file the pass is not
   *  tracking is simply absent. */
  prewarm: Record<string, PrewarmStatus>;
  /** The row pitch for THIS render, from `laneHeightFor` (D-091). The same number
   *  `clipBoxes` sums for the hop's y-arithmetic — one computation, two consumers, which is
   *  what D-083's constant was protecting and what a divergence here would break silently. */
  laneHeight: number;
  /** Mark a clip — by FILE since D-070, so a pre-sync clip can be marked too. */
  onSelect: (file: string) => void;
  muted: boolean;
  soloed: boolean;
  /** False when this result has a single device — see the note above. */
  showSolo: boolean;
  /** False before a sync: nothing is playable yet. */
  showMix: boolean;
  onToggleMute: (device: string) => void;
  onToggleSolo: (device: string) => void;
}) {
  const name = t.deviceLabel(device.id, device.label);
  const height = Math.max(1, rows.length) * laneHeight;
  const meta = useTrackMeta(rows, placements, prewarm);
  const dotLabel =
    meta.state === "placed"
      ? t.trackPlaced
      : meta.state === "ready"
        ? t.trackAnalysed
        : meta.state === "failed"
          ? t.trackAnalysisFailed
          : t.trackAnalysing;

  return (
    <div className="track" role="group" aria-label={t.trackAria(name)} style={{ height: `${height}px` }}>
      <div className="track__gutter">
        <span className="track__ident">
          {device.kind === "video" ? <CameraIcon /> : <MicIcon />}
          <span className="track__name" title={name}>
            {name}
          </span>
          {isReference && <span className="badge badge--ref">{t.reference}</span>}
          {showMix && (
            <span className="track__mix">
              <button
                type="button"
                className={`mixbtn${muted ? " mixbtn--on mixbtn--mute" : ""}`}
                aria-label={muted ? t.unmuteDevice(name) : t.muteDevice(name)}
                aria-pressed={muted}
                onClick={() => onToggleMute(device.id)}
              >
                {t.muteShort}
              </button>
              {showSolo && (
                <button
                  type="button"
                  className={`mixbtn${soloed ? " mixbtn--on mixbtn--solo" : ""}`}
                  aria-label={soloed ? t.unsoloDevice(name) : t.soloDevice(name)}
                  aria-pressed={soloed}
                  onClick={() => onToggleSolo(device.id)}
                >
                  {t.soloShort}
                </button>
              )}
            </span>
          )}
        </span>
        {/* Line two: what the device brought, and where it stands. The dot is the only
            colour in the gutter, and it is deliberately NOT gold — see D-083: gold already
            means «referanse» on the badge ten pixels to the left. */}
        <span className="track__meta">
          <span>{t.fileCount(meta.files)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatDuration(meta.lengthMs / 1000)}</span>
          {/* No dot on a row with nothing drawn on it. §7.5 keeps a device that placed
              nothing visible, and its lane already says «Ingen klipp plassert» — a green
              «plassert av synken» ten pixels away would be the app contradicting itself in
              one glance. An absent dot is not a fourth state; it is the row having nothing
              to be in a state ABOUT. */}
          {meta.files > 0 && (
            <span
              className={`track__dot track__dot--${meta.state}`}
              role="img"
              aria-label={dotLabel}
              title={dotLabel}
            />
          )}
        </span>
      </div>
      <div className="track__lanes">
        {rows.length === 0 ? (
          <div className="track__lane track__lane--empty" style={{ height: `${laneHeight}px` }}>
            <span className="lane__empty">{t.emptyLane}</span>
          </div>
        ) : (
          rows.map((row, i) => (
            <div
              key={i}
              className="track__lane"
              role="group"
              aria-label={t.subTrackAria(i + 1)}
              style={{ height: `${laneHeight}px` }}
            >
              {visibleClips(row, visStart, visEnd).map(({ item, index }) => {
                // With an outcome in hand, a span whose file has no placement is a hole
                // in the outcome and is not drawn. Before a sync there are no placements
                // at all, and every span is drawn — that is the whole point (D-061).
                const placement = placements ? placements.get(item.file) : null;
                if (placements && !placement) return null;
                return (
                  <Clip
                    key={item.file}
                    t={t}
                    span={item}
                    // The neighbour is looked up in the WHOLE row, not in the visible
                    // window (D-091): the clip at the right edge of the viewport has a
                    // successor whether or not that successor has a DOM node yet, and a
                    // width computed against `Infinity` there would widen — and overlap —
                    // one clip per pan frame, at the one edge nobody is looking at.
                    roomPx={roomBeforeNext(item, row[index + 1], view.pxPerMs)}
                    placement={placement ?? null}
                    view={view}
                    durationUnknown={unknownDurations.has(item.file)}
                    timeSource={timeSource.get(item.file) ?? null}
                    offSession={outsideWindow.has(item.file)}
                    analysisStatus={prewarm[item.file] ?? null}
                    onSelect={onSelect}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
});

/** What the gutter's second line says (V06-R2b, D-083). */
interface TrackMeta {
  /** How many of this device's files are DRAWN on this row. */
  files: number;
  /** Their spans' total length, in ms. Zero-length spans (an outcome that carries no
   *  duration for a file) contribute nothing rather than a guess. */
  lengthMs: number;
  /** Grey / blue / green — see below. `failed` is grey too; it is a different SENTENCE, not
   *  a fourth colour. */
  state: "pending" | "failed" | "ready" | "placed";
}

/**
 * The two-line gutter's second line, from what `Track` already has.
 *
 * The three dot states are the owner's own clip vocabulary, one level up: a clip is grey
 * while its audio is unanalysed, blue once it is, green once the sync has placed it
 * (D-080), and the device's dot says the same thing about the whole row at once. That is
 * the point of putting it in the gutter — at a four-hundred-file wedding a clip is three
 * pixels wide and the row is the only thing with enough area to read from across a room.
 *
 * `placed` beats everything: with an outcome in hand the analysis is over and «hvor står
 * denne enheten» has one answer. Before that, `ready` needs EVERY drawn file to be `ready`
 * — one file still pending is a row still working, and a dot that turned blue at 90 % would
 * be claiming the row was done. `failed` counts as not-ready for the same reason: the row
 * is not analysed, and the file that failed says so for itself on its own clip.
 *
 * **What `failed` must NOT do is go on saying «Analyserer lyden» (V06-R3).** D-083 folded it
 * into `pending` — right about the colour, wrong about the words: a card the pass finished
 * with and could not read is a row that will never turn blue, and a dot that claims to still
 * be working on it is the app waiting for something that already happened. So a row where
 * nothing is still pending and something failed keeps the same grey — the vocabulary is
 * three colours and stays three colours — and says «Lyden er ikke analysert» instead — the register the clip itself already uses for the
 * same state («Bølgeform utilgjengelig»): a statement about what the app has, not a verdict
 * on the card. Found
 * in the V06-R3 sweep, on the case that produces it: a whole card of unreadable files.
 *
 * A row with nothing drawn on it is `pending` rather than vacuously `ready` — and `Track`
 * draws no dot at all for it, because «ferdig analysert» (or «plassert») over «Ingen klipp
 * plassert» is two claims that cannot both be true.
 */
function useTrackMeta(
  rows: ClipSpan[][],
  placements: Map<string, Placement> | null,
  prewarm: Record<string, PrewarmStatus>,
): TrackMeta {
  return useMemo(() => {
    let files = 0;
    let lengthMs = 0;
    let allReady = true;
    /** Nothing on this row is still being worked on — every drawn file has an answer. */
    let allSettled = true;
    let anyFailed = false;
    for (const row of rows) {
      for (const span of row) {
        // The same filter the lane applies below: with an outcome, a span whose file has no
        // placement is a hole in the outcome and is not drawn, so it is not counted either.
        if (placements && !placements.get(span.file)) continue;
        files += 1;
        lengthMs += Math.max(0, span.endMs - span.startMs);
        const status = prewarm[span.file];
        if (status !== "ready") allReady = false;
        if (status === "failed") anyFailed = true;
        // A file the pass is not tracking at all is absent from the map, which is not the
        // same as finished: it is a row the pass has not reached (or one nobody started).
        else if (status !== "ready") allSettled = false;
      }
    }
    const state: TrackMeta["state"] =
      placements !== null
        ? "placed"
        : files > 0 && allReady
          ? "ready"
          : files > 0 && allSettled && anyFailed
            ? "failed"
            : "pending";
    return { files, lengthMs, state };
  }, [rows, placements, prewarm]);
}
