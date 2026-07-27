import { useCallback, useState } from "react";
import type { Strings } from "../i18n";

/** §9.1 — the one thing on screen when the app opens. */
export function DropZone({
  t,
  onFiles,
  onFolder,
  onDropPaths,
}: {
  t: Strings;
  onFiles: () => void;
  onFolder: () => void;
  onDropPaths: (paths: string[]) => void;
}) {
  const [over, setOver] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      // Tauri surfaces real filesystem paths on the drop event; browsers do not, which is
      // why the file pickers below remain the reliable route in a dev browser.
      const paths = Array.from(e.dataTransfer.files)
        .map((f) => (f as File & { path?: string }).path)
        .filter((p): p is string => typeof p === "string");
      if (paths.length > 0) onDropPaths(paths);
    },
    [onDropPaths],
  );

  return (
    <section
      className={`dropzone${over ? " dropzone--over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
    >
      <p className="dropzone__title">{t.dropTitle}</p>
      <p className="dropzone__hint">{t.dropHint}</p>
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
