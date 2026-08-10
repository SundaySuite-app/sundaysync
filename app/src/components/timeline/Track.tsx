import { memo } from "react";
import type { Strings } from "../../i18n";
import { visibleClips, type TimelineView } from "../../timeline/geometry";
import type { ClipSpan } from "../../timeline/laneLayout";
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
  unknownStart,
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
  /** Pre-sync: files with no creation timestamp, sitting at zero (v0.4, D-061). */
  unknownStart: ReadonlySet<string>;
  laneHeight: number;
  onSelect: (placement: Placement) => void;
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

  return (
    <div className="track" role="group" aria-label={t.trackAria(name)} style={{ height: `${height}px` }}>
      <div className="track__gutter">
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
              {visibleClips(row, visStart, visEnd).map(({ item }) => {
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
                    placement={placement ?? null}
                    view={view}
                    durationUnknown={unknownDurations.has(item.file)}
                    startUnknown={unknownStart.has(item.file)}
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
