/**
 * SundaySync — docs/PLAN.md §9.
 *
 * Composition and effects only: the phase machine lives in `state.ts`, strings in
 * `i18n/`, persistence in `settings.ts`, error mapping in `errors.ts`. Simple mode is
 * the whole surface until the user opens settings, and nothing in settings changes what
 * simple mode does with an untouched configuration.
 */

import { useCallback, useEffect, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { BannerRegion } from "./components/Banner";
import { DropZone } from "./components/DropZone";
import { EmptyState } from "./components/EmptyState";
import { Onboarding } from "./components/Onboarding";
import { ProgressBar } from "./components/ProgressBar";
import { ResultView } from "./components/ResultView";
import { SettingsPanel } from "./components/SettingsPanel";
import { SourcesView } from "./components/SourcesView";
import { GearIcon } from "./components/icons";

import { mapEngineError } from "./errors";
import { detectLang, dictionaries, type Lang } from "./i18n";
import { getSettings, saveSettings } from "./settings";
import { initialState, reducer } from "./state";
import type { ProgressEvent, ScanManifest, SidecarStatus, SyncOutcome } from "./types";

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [lang, setLang] = useState<Lang>(() => getSettings().lang ?? detectLang());
  const [showSettings, setShowSettings] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(() => !getSettings().onboardingDone);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("SundaySync");
  const t = dictionaries[lang];

  // Screen readers pronounce by the document language — a hardcoded lang="nb" reads
  // English UI in a Norwegian voice.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // ffmpeg check up front, so the warning shows before the user drops 40 GB in.
  useEffect(() => {
    invoke<SidecarStatus>("check_sidecar")
      .then(() => dispatch({ type: "sidecar/checked", ok: true }))
      .catch(() => dispatch({ type: "sidecar/checked", ok: false }));
  }, []);

  // Progress events for the running sync.
  useEffect(() => {
    const unlisten = listen<ProgressEvent>("sync:progress", (e) =>
      dispatch({ type: "sync/progress", progress: e.payload }),
    );
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // The scan effect: whenever the phase enters `scanning`, run scan_inputs for the
  // current sequence number. A superseded scan's result is dropped by the reducer.
  const phase = state.phase;
  const scanSeq = state.scanSeq;
  useEffect(() => {
    if (phase.name !== "scanning") return;
    const seq = scanSeq;
    const inputs = phase.inputs;
    invoke<ScanManifest>("scan_inputs", { inputs, cacheDir: getSettings().cacheDir })
      .then((manifest) => dispatch({ type: "scan/done", seq, manifest }))
      .catch((e) =>
        dispatch({ type: "scan/failed", seq, error: mapEngineError(String(e), t) }),
      );
    // `t` is deliberately not a dependency: an error banner in yesterday's language is
    // better than re-scanning the whole card dump because the user toggled languages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.name === "scanning" ? scanSeq : -1]);

  const addPaths = useCallback((paths: string[]) => {
    setExportedPath(null);
    dispatch({ type: "inputs/add", paths });
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
    setExportedPath(null);
    dispatch({ type: "sync/start" });
    const settings = getSettings();
    try {
      const outcome = await invoke<SyncOutcome>("run_sync", {
        args: {
          inputs: state.phase.name === "empty" ? [] : state.phase.inputs,
          minPsr: settings.minPsr,
          cacheDir: settings.cacheDir,
          reference: state.reference,
          deviceOverrides:
            Object.keys(state.overrides).length > 0 ? state.overrides : null,
          segmentCount: settings.segmentCount,
        },
      });
      dispatch({ type: "sync/done", outcome });
    } catch (e) {
      dispatch({ type: "sync/failed", error: mapEngineError(String(e), t) });
    }
  }, [state.phase, state.reference, state.overrides, t]);

  const cancelSync = useCallback(async () => {
    dispatch({ type: "cancel/requested" });
    await invoke("cancel_sync");
  }, []);

  const exportTimeline = useCallback(async () => {
    const path = await save({
      defaultPath: `${projectName.replace(/[/\\:]/g, "-") || "sundaysync"}.fcpxml`,
      filters: [{ name: "FCPXML", extensions: ["fcpxml"] }],
    });
    if (!path) return;
    try {
      const clips = await invoke<number>("export_timeline", { path, project: projectName });
      setExportedPath(path);
      dispatch({
        type: "banner/set",
        banner: { kind: "ok", text: `${t.exported(clips)}. ${t.exportHint}` },
      });
    } catch (e) {
      dispatch({
        type: "banner/set",
        banner: { kind: "error", text: mapEngineError(String(e), t).text },
      });
    }
  }, [projectName, t]);

  const notice = useCallback((kind: "ok" | "error", text: string) => {
    dispatch({ type: "banner/set", banner: { kind, text } });
  }, []);

  const manifest =
    phase.name === "sources" || phase.name === "syncing" || phase.name === "result"
      ? phase.manifest
      : phase.name === "scanning"
        ? phase.previous
        : null;
  const deviceIds = manifest ? manifest.devices.map((d) => d.id) : [];
  const overridesDirty = Object.keys(state.overrides).length > 0;

  return (
    <main className="app">
      <header className="app__header">
        <h1>
          Sunday<span className="accent">Sync</span>
        </h1>
        <div className="app__header-actions">
          <button
            type="button"
            className="ghost"
            onClick={() => {
              const next: Lang = lang === "nb" ? "en" : "nb";
              setLang(next);
              saveSettings({ lang: next });
            }}
          >
            {lang === "nb" ? "English" : "Norsk"}
          </button>
          <button
            type="button"
            className="iconbtn"
            onClick={() => setShowSettings(true)}
            aria-label={t.settings}
          >
            <GearIcon />
          </button>
        </div>
      </header>

      {state.sidecarOk === false && !showOnboarding && (
        <p className="banner banner--error" role="alert">
          <span>{t.errSidecar}</span>
        </p>
      )}

      <BannerRegion t={t} banner={state.banner} onDismiss={() => dispatch({ type: "banner/clear" })} />

      {phase.name === "empty" && (
        <EmptyState t={t} onFiles={chooseFiles} onFolder={chooseFolder} onDropPaths={addPaths} />
      )}

      {phase.name !== "empty" && phase.name !== "syncing" && (
        <DropZone t={t} compact onFiles={chooseFiles} onFolder={chooseFolder} onDropPaths={addPaths} />
      )}

      {phase.name === "scanning" && (
        <p className="scanline">
          <span className="scanline__spinner" aria-hidden="true" />
          {t.scanningInputs}
        </p>
      )}

      {(phase.name === "sources" || phase.name === "result") && manifest && (
        <SourcesView
          t={t}
          manifest={manifest}
          inputs={phase.inputs}
          overrides={state.overrides}
          reference={state.reference}
          onRemoveRoot={(path) => dispatch({ type: "inputs/removeRoot", path })}
          onClearAll={() => dispatch({ type: "inputs/clear" })}
          onOverride={(file, device) => dispatch({ type: "override/set", file, device })}
          onReference={(file) => dispatch({ type: "reference/set", file })}
        />
      )}

      {phase.name === "syncing" ? (
        <div className="run">
          <ProgressBar t={t} progress={phase.progress} />
          <button type="button" className="secondary" onClick={cancelSync} disabled={state.cancelling}>
            {state.cancelling ? t.cancelling : t.cancel}
          </button>
        </div>
      ) : (
        phase.name !== "empty" &&
        phase.name !== "scanning" && (
          <div className="actions">
            <button type="button" className="primary" onClick={runSync}>
              {phase.name === "result" ? t.resyncButton : t.syncButton}
              {(phase.name === "result" || overridesDirty) && <small>{t.resyncHint}</small>}
            </button>
          </div>
        )
      )}

      {phase.name === "result" && (
        <>
          {phase.stale && (
            <p className="banner banner--warn">
              <span>{t.staleResult}</span>
            </p>
          )}
          <ResultView
            t={t}
            outcome={phase.outcome}
            stale={phase.stale}
            deviceIds={deviceIds}
            onOverride={(file, device) => dispatch({ type: "override/set", file, device })}
          />
          <div className="exportbar">
            <label>
              <span className="visually-hidden">{t.projectName}</span>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                aria-label={t.projectName}
              />
            </label>
            <button type="button" className="primary" onClick={exportTimeline} disabled={phase.stale}>
              {t.exportButton}
            </button>
            {exportedPath && (
              <button type="button" className="secondary" onClick={() => revealItemInDir(exportedPath)}>
                {t.revealInFinder}
              </button>
            )}
          </div>
        </>
      )}

      {showSettings && (
        <SettingsPanel
          t={t}
          onClose={() => setShowSettings(false)}
          onLangChange={(next) => setLang(next ?? detectLang())}
          onShowOnboarding={() => setShowOnboarding(true)}
          onNotice={notice}
        />
      )}

      {showOnboarding && <Onboarding t={t} onDone={() => setShowOnboarding(false)} />}
    </main>
  );
}
