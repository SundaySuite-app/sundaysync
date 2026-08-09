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
  laneHeight,
  onSelect,
}: {
  t: Strings;
  device: Device;
  rows: ClipSpan[][];
  /** Placement per file — the engine detail behind each drawn box. */
  placements: Map<string, Placement>;
  view: TimelineView;
  visStart: number;
  visEnd: number;
  isReference: boolean;
  laneHeight: number;
  onSelect: (placement: Placement) => void;
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
                const placement = placements.get(item.file);
                if (!placement) return null;
                return (
                  <Clip
                    key={item.file}
                    t={t}
                    span={item}
                    placement={placement}
                    view={view}
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
