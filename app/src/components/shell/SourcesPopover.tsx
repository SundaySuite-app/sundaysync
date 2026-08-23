import { useRef } from "react";
import type { Strings } from "../../i18n";
import { formatDuration } from "../../i18n";
import { basename } from "../../types";
import type { ScanManifest } from "../../types";
import { CameraIcon, MicIcon } from "../icons";
import {
  groupDuration,
  groupFiles,
  isVideoGroup,
} from "./sourcesModel";
import { usePopoverDismiss } from "./usePopoverDismiss";

/**
 * «Kilder» — the strip's summary line, and everything behind it (V06-R2a, D-077/D-078).
 *
 * The summary IS the disclosure: «3 filer · 2 enheter» was already the one sentence the strip
 * says about the drop (D-081), and the list it summarises now hangs off it instead of taking
 * 40 % of the stage underneath the timeline. One line of chrome, and the whole drop one click
 * behind it.
 *
 * ## Why the file list survived at all
 *
 * The obvious reading of «Ett rom» is that the timeline already draws every file, so a list of
 * the same files is duplication. It is not, for one measured reason: on the owner's 386-clip
 * drop a clip is three pixels wide, and **finding one file by name** — the take somebody
 * mentioned, the card that looks wrong — is something a row of 3 px boxes cannot do at all.
 * The list is the app's only alphabetical index of what was dropped. So it stays, and it gains
 * the thing it never had: a row is a **button** that marks the clip, which puts the file in the
 * inspector and closes the popover, so «find it by name» and «look at it» are one gesture.
 *
 * What did NOT survive is the per-row control cluster. The star, the device `<select>` and the
 * ✕ were on every one of 386 rows; they are on the ONE selected clip in the inspector now
 * (D-077 #9/#10/#11), which is the same three decisions about the same file with 385 fewer
 * copies of each control on screen.
 */
export function SourcesPopover({
  t,
  manifest,
  inputs,
  overrides,
  excluded,
  summary,
  onSelect,
  onRemoveRoot,
  onClearAll,
}: {
  t: Strings;
  manifest: ScanManifest;
  /** The roots the operator dropped — the chips at the top of the panel. */
  inputs: string[];
  overrides: Record<string, string>;
  excluded: ReadonlySet<string>;
  /** The already-composed strip sentence. App owns it: only the phase knows what fits. */
  summary: string;
  onSelect: (file: string) => void;
  onRemoveRoot: (path: string) => void;
  onClearAll: () => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  usePopoverDismiss(ref);
  const grouped = groupFiles(manifest, overrides, excluded);

  const pick = (file: string) => {
    onSelect(file);
    // Marking a clip is the end of the errand this popover exists for; leaving it open would
    // cover the inspector column the operator just filled.
    if (ref.current) ref.current.open = false;
  };

  return (
    <details className="popover popover--sources" ref={ref}>
      <summary className="strip__summary">{summary}</summary>
      <div className="popover__panel" role="group" aria-label={t.sourcesTitle}>
        <div className="roots">
          {inputs.map((root) => (
            <span key={root} className="root" title={root}>
              <span className="root__path">{basename(root)}</span>
              <button
                type="button"
                className="iconbtn"
                onClick={() => onRemoveRoot(root)}
                aria-label={`${t.removeRoot}: ${basename(root)}`}
              >
                ✕
              </button>
            </span>
          ))}
          {inputs.length > 1 && (
            <button type="button" className="ghost" onClick={onClearAll}>
              {t.clearAll}
            </button>
          )}
        </div>

        {grouped.map((group) => (
          <section key={group.device.id} className="device-group">
            <div className="device-group__head">
              {isVideoGroup(group) ? <CameraIcon /> : <MicIcon />}
              <span className="device-group__name">
                {t.deviceLabel(group.device.id, group.device.label)}
              </span>
              <span className="device-group__meta">
                {t.fileCount(group.files.length)} · {formatDuration(groupDuration(group))}
              </span>
            </div>
            {group.files.map((entry) => (
              <button
                key={entry.file}
                type="button"
                className="filerow filerow--pick"
                title={entry.file}
                onClick={() => pick(entry.file)}
              >
                <span className="filerow__name">{basename(entry.file)}</span>
                <span className="filerow__badges">
                  <span className="badge">{formatDuration(entry.duration_seconds)}</span>
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </details>
  );
}
