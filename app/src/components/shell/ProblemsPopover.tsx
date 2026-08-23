import { useRef } from "react";
import type { Strings } from "../../i18n";
import { basename } from "../../types";
import type { Unsynced, UnsyncedReason } from "../../types";
import { UnsyncedShelf } from "../timeline/UnsyncedShelf";
import { usePopoverDismiss } from "./usePopoverDismiss";

/**
 * Everything that did not work, behind one red chip on the strip (V06-R2a, D-077 #5/#12,
 * D-079).
 *
 * Two lists live in here, and they are genuinely different claims:
 *
 *   - **`scanned`** — `ScanManifest.unsynced`: files the *scan* could not use at all. Known
 *     before any sync, listed with the reason and a ✕ each.
 *   - **`shelved`** — `SyncResult.unsynced`: files the *engine* would not place. Only exists
 *     after a run, and carries the one fix that helps (move it to the right device and sync
 *     again, D-027) as well as the ✕. That is `UnsyncedShelf`, verbatim — same markup, same
 *     classes, same controls; it simply hangs here now instead of under the timeline (D-079).
 *
 * The chip counts both, because from where the operator stands they are one question — "is
 * anything wrong?" — and a chip that answered it only for the pre-sync half would go quiet at
 * the exact moment a run produced something to say.
 *
 * Shut by default, as the `<details>` under the timeline was (D-061): on a good drop this is
 * empty and on a bad one it is a footnote with its count already visible on the chip. What
 * changed is that a footnote no longer costs a row of the room.
 */
export function ProblemsPopover({
  t,
  scanned,
  shelved,
  deviceIds,
  onOverride,
  onExclude,
}: {
  t: Strings;
  /** The scan's own refusals, already filtered by the exclusion set. */
  scanned: Unsynced[];
  /** The engine's, likewise — empty in every phase but `result`. */
  shelved: Unsynced[];
  deviceIds: string[];
  onOverride: (file: string, device: string) => void;
  onExclude: (file: string) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  usePopoverDismiss(ref);

  const reasonText: Record<UnsyncedReason, string> = {
    low_confidence: t.reasonLowConfidence,
    no_audio: t.reasonNoAudio,
    decode_error: t.reasonDecodeError,
    device_overlap: t.reasonDeviceOverlap,
  };

  const total = scanned.length + shelved.length;
  if (total === 0) return null;

  return (
    <details className="popover popover--problems" ref={ref}>
      <summary className="chip badge--problem" title={t.problemCount(total)}>
        <span className="chip__text">{t.problemCount(total)}</span>
      </summary>
      <div className="popover__panel" role="group" aria-label={t.unsyncedTitle}>
        {/* Said once. `UnsyncedShelf` carries the same words in its own `.shelf__title`, and
            two identical headings six rows apart is a screen reader saying "Ikke
            synkronisert" twice about one list — so the shelf's is suppressed here and this
            one, at the top of the panel, covers both halves. */}
        <h2 className="popover__title">{t.unsyncedTitle}</h2>
        {scanned.map((u) => (
          <div key={u.file} className="filerow filerow--problem">
            <span className="filerow__name" title={u.file}>
              {basename(u.file)}
            </span>
            <span className="badge badge--problem">{reasonText[u.reason]}</span>
            <span />
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
        {shelved.length > 0 && (
          <UnsyncedShelf
            t={t}
            heading={false}
            unsynced={shelved}
            deviceIds={deviceIds}
            onOverride={onOverride}
            onExclude={onExclude}
          />
        )}
      </div>
    </details>
  );
}
