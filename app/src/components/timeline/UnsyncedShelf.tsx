import type { Strings } from "../../i18n";
import { basename } from "../../types";
import type { Unsynced, UnsyncedReason } from "../../types";

/**
 * The red shelf (§9.4): what the engine refused to place, in plain language,
 * each row carrying the one fix that actually helps — move the file to the right
 * device and sync again (D-027).
 *
 * Extracted verbatim from `ResultView.tsx` when the interactive timeline replaced
 * it (D-051). It sits below the timeline rather than inside it on purpose: an
 * unplaced clip has no position, so it has no business having an x coordinate.
 *
 * v0.4 (D-062) adds the second fix: the row can also be taken out of the run. "Move it to
 * the right device" is the answer when the file belongs in the edit; when it does not,
 * removing it is, and every other list in the app now offers that.
 *
 * v0.6 (V06-R2a, D-079): the shelf's MARKUP is untouched and its home moved. It is rendered
 * inside the strip's problem popover now, beside the scan's own refusals, because "the engine
 * would not place this" and "the scan could not read this" are one question from where the
 * operator stands — and because a room with a fixed timeline has no row under the timeline to
 * put a red box in. The one concession is `heading`: the popover says «Ikke synkronisert» at
 * the top of the panel already, and the shelf must not say it a second time.
 */
export function UnsyncedShelf({
  t,
  unsynced,
  deviceIds,
  heading = true,
  onOverride,
  onExclude,
}: {
  t: Strings;
  unsynced: Unsynced[];
  deviceIds: string[];
  /** Draw the shelf's own title. False when the container already carries it (D-079). */
  heading?: boolean;
  onOverride: (file: string, device: string) => void;
  onExclude: (file: string) => void;
}) {
  const reasonText: Record<UnsyncedReason, string> = {
    low_confidence: t.reasonLowConfidence,
    no_audio: t.reasonNoAudio,
    decode_error: t.reasonDecodeError,
    device_overlap: t.reasonDeviceOverlap,
  };

  return (
    <div className="shelf">
      {heading && <h2 className="shelf__title">{t.unsyncedTitle}</h2>}
      {unsynced.map((u) => (
        <div key={u.file} className="shelf__row">
          <span>{basename(u.file)}</span>
          <span className="shelf__reason">— {reasonText[u.reason]}</span>
          {/* The device_overlap fix path: move the clip and re-sync (D-027). */}
          <label>
            <span className="visually-hidden">
              {t.moveToDevice}: {basename(u.file)}
            </span>
            <select value="" onChange={(e) => e.target.value && onOverride(u.file, e.target.value)}>
              <option value="">{t.moveToDevice}</option>
              {deviceIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="iconbtn removebtn"
            onClick={() => onExclude(u.file)}
            aria-label={`${t.removeFile}: ${basename(u.file)}`}
            title={t.removeFile}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
