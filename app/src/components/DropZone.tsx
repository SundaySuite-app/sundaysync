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
        <p className="dropzone__title">{compact ? t.dropMore : t.dropTitle}</p>
        {!compact && <p className="dropzone__hint">{t.dropHint}</p>}
      </div>
      <div className="dropzone__actions">
        <button type="button" className="secondary" onClick={onFiles}>
          {t.dropAction}
        </button>
        <button type="button" className="secondary" onClick={onFolder}>
          {t.dropFolder}
        </button>
      </div>
    </section>
  );
}
