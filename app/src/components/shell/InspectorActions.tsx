import type { Strings } from "../../i18n";
import { basename } from "../../types";
import { StarIcon } from "../icons";

/**
 * The three things the operator may decide about ONE clip (V06-R2a, D-077 #9/#10/#11).
 *
 * Star it as the reference, move it to another device, take it out of the run. All three used
 * to be on every row of the sources list — 386 stars, 386 selects, 386 ✕s for a wedding —
 * which is the shape that makes a list of files unreadable and a mis-click cheap. They belong
 * to the clip the operator is *looking at*, so they belong in the column that shows it.
 *
 * The controls themselves are unchanged: same classes, same accessible names, same
 * `aria-pressed` on a star that toggles off, and the device `<select>` keeps BOTH its visible
 * label and the `aria-label` that names the file (D-076). What is new is that there is exactly
 * one of each on screen, between what the file IS and what the engine made of it.
 *
 * `busy` disables them individually rather than dimming a block: the inspector is three
 * different things stacked in one column, and greying the whole column mid-sync would say the
 * picture and the facts had become unavailable too, which they have not.
 */
export function InspectorActions({
  t,
  file,
  device,
  deviceIds,
  isReference,
  busy,
  onReference,
  onOverride,
  onExclude,
}: {
  t: Strings;
  file: string;
  /** The device this file belongs to right now — the three-layer overlay, resolved by App. */
  device: string;
  deviceIds: string[];
  isReference: boolean;
  /** A sync is running: looking is still allowed, deciding is not (D-061). */
  busy: boolean;
  onReference: (file: string | null) => void;
  onOverride: (file: string, device: string) => void;
  onExclude: (file: string) => void;
}) {
  const name = basename(file);
  return (
    <div className="inspector__actions">
      <button
        type="button"
        className={`ghost refbtn${isReference ? " refbtn--active" : ""}`}
        onClick={() => onReference(isReference ? null : file)}
        aria-pressed={isReference}
        aria-label={`${t.makeReference}: ${name}`}
        title={t.makeReference}
        disabled={busy}
      >
        <StarIcon filled={isReference} />
      </button>
      <label className="field field--inline">
        <span>{t.moveToDevice}</span>
        <select
          value={device}
          disabled={busy}
          aria-label={`${t.moveToDevice}: ${name}`}
          onChange={(e) => onOverride(file, e.target.value)}
        >
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
        onClick={() => onExclude(file)}
        aria-label={`${t.removeFile}: ${name}`}
        title={t.removeFile}
        disabled={busy}
      >
        ✕
      </button>
    </div>
  );
}
