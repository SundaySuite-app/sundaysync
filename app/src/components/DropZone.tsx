import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Strings } from "../i18n";

/**
 * §9.1 — the drop target.
 *
 * Real file paths come from the Tauri 2 webview drag-drop event, not from HTML5
 * `dataTransfer`. The first build read `dataTransfer.files[].path` — a Tauri 1 pattern;
 * in Tauri 2 the webview `File` object has no `path`, so drops silently did nothing at
 * all. `dragDropEnabled: true` in tauri.conf.json routes the OS drop to this event.
 *
 * The listener is webview-global, so exactly one instance of this component should be
 * mounted at a time (App keeps the full-size and compact variants exclusive).
 */
export function DropZone({
  t,
  compact = false,
  onFiles,
  onFolder,
  onDropPaths,
}: {
  t: Strings;
  compact?: boolean;
  onFiles: () => void;
  onFolder: () => void;
  onDropPaths: (paths: string[]) => void;
}) {
  const [over, setOver] = useState(false);

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      switch (event.payload.type) {
        case "over":
          setOver(true);
          break;
        case "drop":
          setOver(false);
          if (event.payload.paths.length > 0) onDropPaths(event.payload.paths);
          break;
        default: // "leave"
          setOver(false);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [onDropPaths]);

  return (
    <section
      className={`dropzone${compact ? " dropzone--compact" : ""}${over ? " dropzone--over" : ""}`}
    >
      <div>
        <p className="dropzone__title">{compact ? t.addSources : t.dropTitle}</p>
        {!compact && <p className="dropzone__hint">{t.dropHint}</p>}
      </div>
      {/* V06-R1 (D-086): compact is a STRIP control now, so the two choosers are icons with
          their names on `aria-label` rather than two word-buttons. Same buttons, same
          accessible names — `Velg filer` / `Velg mappe` still address them — rationed to the
          44 px the strip has. The full-size zone in the empty state keeps its words: there
          the buttons are the whole invitation, not a corner of a toolbar. */}
      <div className="dropzone__actions">
        <button
          type="button"
          className={compact ? "iconbtn" : "secondary"}
          onClick={onFolder}
          aria-label={compact ? t.dropFolder : undefined}
          title={compact ? t.dropFolder : undefined}
        >
          {compact ? <FolderIcon /> : t.dropFolder}
        </button>
        <button
          type="button"
          className={compact ? "iconbtn" : "secondary"}
          onClick={onFiles}
          aria-label={compact ? t.dropAction : undefined}
          title={compact ? t.dropAction : undefined}
        >
          {compact ? <FilesIcon /> : t.dropAction}
        </button>
      </div>
    </section>
  );
}

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M1.5 3.5h4l1.2 1.6h7.8v7.4H1.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M4.5 1.8h4.2l3 3v9.4h-7.2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8.6 1.8v3.1h3.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
