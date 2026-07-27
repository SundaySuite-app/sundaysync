/**
 * SundaySync — docs/PLAN.md §9.
 *
 * Simple mode is the default and takes no configuration: drop media in, press Sync, get a
 * timeline out. Advanced mode is a toggle, and nothing in it changes what simple mode does.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { DropZone } from "./components/DropZone";
import { DeviceSummary } from "./components/DeviceSummary";
import { ProgressBar } from "./components/ProgressBar";
import { ResultView } from "./components/ResultView";
import { AdvancedPanel } from "./components/AdvancedPanel";
import { dictionaries, detectLang, type Lang } from "./i18n";
import type { ProgressEvent, SyncResult } from "./types";

export function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const t = dictionaries[lang];

  const [inputs, setInputs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [minPsr, setMinPsr] = useState<number | null>(null);
  const [cacheDir, setCacheDir] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [sidecarMissing, setSidecarMissing] = useState(false);

  // Tell the user ffmpeg is missing before they drop 40 GB of media in, not after.
  useEffect(() => {
    invoke<string>("check_sidecar").catch(() => setSidecarMissing(true));
  }, []);

  useEffect(() => {
    const unlisten = listen<ProgressEvent>("sync:progress", (e) => setProgress(e.payload));
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const addPaths = useCallback((paths: string[]) => {
    setInputs((prev) => Array.from(new Set([...prev, ...paths])));
    setResult(null);
    setError(null);
  }, []);

  const chooseFiles = useCallback(async () => {
    const picked = await open({ multiple: true });
    if (picked) addPaths(Array.isArray(picked) ? picked : [picked]);
  }, [addPaths]);

  const chooseFolder = useCallback(async () => {
    const picked = await open({ directory: true, multiple: true });
    if (picked) addPaths(Array.isArray(picked) ? picked : [picked]);
  }, [addPaths]);

  const runSync = useCallback(async () => {
    setRunning(true);
    setCancelling(false);
    setError(null);
    setNotice(null);
    setProgress(null);
    try {
      const outcome = await invoke<{ result: SyncResult }>("run_sync", {
        inputs,
        minPsr,
        cacheDir,
        reference,
      });
      setResult(outcome.result);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      setCancelling(false);
      setProgress(null);
    }
  }, [inputs, minPsr, cacheDir, reference]);

  const cancel = useCallback(async () => {
    setCancelling(true);
    await invoke("cancel_sync");
  }, []);

  const exportTimeline = useCallback(async () => {
    const path = await save({
      defaultPath: "sundaysync.fcpxml",
      filters: [{ name: "FCPXML", extensions: ["fcpxml"] }],
    });
    if (!path) return;
    try {
      const clips = await invoke<number>("export_timeline", { path, project: "SundaySync" });
      setNotice(`${t.exported(clips)}. ${t.exportHint}`);
    } catch (e) {
      setError(String(e));
    }
  }, [t]);

  const exportDiagnostics = useCallback(async () => {
    const path = await save({
      defaultPath: "sundaysync-diagnostics.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      await invoke("export_diagnostics", { path });
      setNotice(t.diagnostics);
    } catch (e) {
      setError(String(e));
    }
  }, [t]);

  const canSync = inputs.length > 0 && !running;
  const placedFiles = useMemo(
    () => (result ? result.placements.map((p) => p.file) : []),
    [result],
  );

  return (
    <main className="app">
      <header className="app__header">
        <h1>{t.appName}</h1>
        <div className="app__header-actions">
          <button
            type="button"
            className="linklike"
            onClick={() => setLang(lang === "nb" ? "en" : "nb")}
            aria-label={t.language}
          >
            {lang === "nb" ? "English" : "Norsk"}
          </button>
          <button
            type="button"
            className="linklike"
            onClick={() => setAdvanced((a) => !a)}
            aria-pressed={advanced}
          >
            {advanced ? t.simple : t.advanced}
          </button>
        </div>
      </header>

      {sidecarMissing && <p className="banner banner--error">{t.noFfmpeg}</p>}

      <DropZone t={t} onFiles={chooseFiles} onFolder={chooseFolder} onDropPaths={addPaths} />

      {inputs.length > 0 && !result && (
        <p className="muted">
          {inputs.length} {t.files}
        </p>
      )}

      {result && <DeviceSummary t={t} result={result} />}

      {advanced && (
        <AdvancedPanel
          t={t}
          minPsr={minPsr}
          onMinPsr={setMinPsr}
          cacheDir={cacheDir}
          onCacheDir={setCacheDir}
          reference={reference}
          onReference={setReference}
          candidates={placedFiles}
          onDiagnostics={exportDiagnostics}
        />
      )}

      {running ? (
        <div className="run">
          <ProgressBar t={t} progress={progress} />
          <button type="button" className="secondary" onClick={cancel} disabled={cancelling}>
            {cancelling ? t.cancelling : t.cancel}
          </button>
        </div>
      ) : (
        <button type="button" className="primary" onClick={runSync} disabled={!canSync}>
          {t.syncButton}
        </button>
      )}

      {error && <p className="banner banner--error">{error}</p>}
      {notice && <p className="banner banner--ok">{notice}</p>}

      {result && (
        <>
          <ResultView t={t} result={result} />
          <button type="button" className="primary" onClick={exportTimeline}>
            {t.exportButton}
          </button>
        </>
      )}
    </main>
  );
}
