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
import { ConsentCard } from "./components/ConsentCard";
import { DropZone } from "./components/DropZone";
import { EmptyState } from "./components/EmptyState";
import { Onboarding } from "./components/Onboarding";
import { ProgressBar } from "./components/ProgressBar";
import { TimelineView } from "./components/timeline/TimelineView";
import { SettingsPanel } from "./components/SettingsPanel";
import { SourcesPanel } from "./components/SourcesPanel";
import { GearIcon } from "./components/icons";

import { mapEngineError } from "./errors";
import { invokeWithTimeout } from "./invoke";
import { detectLang, dictionaries, type Lang } from "./i18n";
import { getSettings, saveSettings } from "./settings";
import { initialState, reducer } from "./state";
import { getTelemetryStatus, reportFrontendError } from "./telemetry";
import { checkForUpdate } from "./update";
import { gateErrorReport, initialErrorGateState, shapeErrorPayload } from "./telemetryErrors";
import type { ProgressEvent, ScanManifest, SidecarStatus, SyncOutcome } from "./types";

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [lang, setLang] = useState<Lang>(() => getSettings().lang ?? detectLang());
  const [showSettings, setShowSettings] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(() => !getSettings().onboardingDone);
  const [showConsent, setShowConsent] = useState(false);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("SundaySync");
  const t = dictionaries[lang];

  // Screen readers pronounce by the document language — a hardcoded lang="nb" reads
  // English UI in a Norwegian voice.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // ffmpeg check up front, so the warning shows before the user drops 40 GB in. Bounded by
  // a timeout (F11/F14): a bundled ffmpeg that hangs on `-version` must not wedge onboarding
  // forever — on expiry we fall back to the "not found" warning and surface a retry notice.
  useEffect(() => {
    invokeWithTimeout<SidecarStatus>("check_sidecar", undefined, 10_000)
      .then(() => dispatch({ type: "sidecar/checked", ok: true }))
      .catch((e) => {
        dispatch({ type: "sidecar/checked", ok: false });
        const mapped = mapEngineError(String(e), t);
        if (mapped.kind === "notice") {
          dispatch({ type: "banner/set", banner: { kind: "info", text: mapped.text } });
        }
      });
    // `t` is intentionally not a dependency: this self-test runs once at startup, and a
    // language toggle during the probe should not re-spawn ffmpeg -version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // E7 CONSENT-UX: prompt for telemetry consent once, whenever this install hasn't
  // answered yet (`consentVersion === null`) — true both for a brand-new install (after
  // onboarding closes, see the render below) and for an existing install upgrading into
  // this version, whose `onboardingDone` is already `true` and would otherwise never see
  // this dialog. Fails soft: if the core command isn't there yet, `getTelemetryStatus`
  // resolves `null` and the prompt simply never shows.
  useEffect(() => {
    let cancelled = false;
    getTelemetryStatus().then((status) => {
      if (!cancelled && status && status.consentVersion === null) setShowConsent(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // E9: a quiet on-launch update check. If the chosen ring has a newer release, surface a
  // calm info banner pointing at Settings → System, where the actual download/install lives
  // — the launch check never downloads anything on its own. Fully silent otherwise: a
  // failed or unreachable check is a non-event (dev builds short-circuit to upToDate in the
  // backend), never a startup error in the user's face. Runs once.
  useEffect(() => {
    let cancelled = false;
    checkForUpdate(getSettings().betaChannel).then((status) => {
      if (cancelled || status.phase !== "available") return;
      dispatch({
        type: "banner/set",
        banner: { kind: "info", text: t.updateBannerAvailable(status.version) },
      });
    });
    return () => {
      cancelled = true;
    };
    // Once at startup; `t` intentionally omitted so a language toggle doesn't re-check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global error capture (E7 CONSENT-UX frontend half): forward uncaught errors and
  // unhandled promise rejections to the anonymous telemetry queue. `report_frontend_error`
  // is itself best-effort (telemetry.ts), and `gateErrorReport` dedupes/rate-limits so a
  // tight failure loop can't flood it — see telemetryErrors.ts for the pure logic.
  useEffect(() => {
    let gate = initialErrorGateState;
    const submit = (kind: string, rawMessage: string) => {
      try {
        const shaped = shapeErrorPayload(kind, rawMessage);
        const gated = gateErrorReport(gate, shaped.kind, shaped.message, Date.now());
        gate = gated.state;
        if (!gated.allow) return;
        void reportFrontendError(shaped.kind, shaped.message);
      } catch {
        // An error handler must never itself throw.
      }
    };

    const onWindowError = (event: ErrorEvent) => {
      submit("error", event.message || String(event.error ?? "unknown error"));
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as unknown;
      const message =
        reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
      submit("unhandledrejection", message);
    };

    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
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

  // Progress events for the pre-sync scan/probe (`scan_inputs`'s own `EventSink`,
  // channel `scan:progress` — lib.rs). Previously emitted and silently dropped: the
  // scanning phase showed nothing but a static spinner even while the backend was
  // already reporting real stage + completed/total ticks for a large card dump.
  useEffect(() => {
    const unlisten = listen<ProgressEvent>("scan:progress", (e) =>
      dispatch({ type: "scan/progress", progress: e.payload }),
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
          correctDrift: settings.correctDrift,
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
      // F6: pass the current sources so the backend can refuse if they no longer match the
      // stored run — defense in depth behind the `disabled={phase.stale}` UI gate.
      const clips = await invoke<number>("export_timeline", {
        path,
        project: projectName,
        inputs: state.phase.name === "result" ? state.phase.inputs : [],
        reference: state.reference,
        deviceOverrides:
          Object.keys(state.overrides).length > 0 ? state.overrides : null,
      });
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
  }, [projectName, t, state.phase, state.reference, state.overrides]);

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
  // The timeline is the main view (v0.4, D-061): it appears the moment a scan has told us
  // what was dropped, and stays MOUNTED across sources → syncing → result. Nothing below
  // may unmount it on a phase change — the continuity is the feature.
  const timelinePhase =
    phase.name === "sources" || phase.name === "syncing" || phase.name === "result"
      ? phase.name
      : null;

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
        <div className="run">
          <ProgressBar t={t} progress={phase.progress} idleLabel={t.scanningInputs} />
        </div>
      )}

      {/* The run bar sits ABOVE the timeline, so pressing Sync and watching the progress
          happen never moves the material the operator is looking at. */}
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

      {phase.name === "result" && phase.stale && (
        <p className="banner banner--warn">
          <span>{t.staleResult}</span>
        </p>
      )}

      {timelinePhase && manifest && (
        <TimelineView
          t={t}
          phase={timelinePhase}
          manifest={manifest}
          overrides={state.overrides}
          reference={state.reference}
          outcome={phase.name === "result" ? phase.outcome : null}
          stale={phase.name === "result" && phase.stale}
          deviceIds={deviceIds}
          onOverride={(file, device) => dispatch({ type: "override/set", file, device })}
        />
      )}

      {phase.name === "result" && (
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
      )}

      {timelinePhase && manifest && (
        <SourcesPanel
          t={t}
          manifest={manifest}
          inputs={phase.name === "empty" || phase.name === "scanning" ? [] : phase.inputs}
          overrides={state.overrides}
          reference={state.reference}
          busy={phase.name === "syncing"}
          onRemoveRoot={(path) => dispatch({ type: "inputs/removeRoot", path })}
          onClearAll={() => dispatch({ type: "inputs/clear" })}
          onOverride={(file, device) => dispatch({ type: "override/set", file, device })}
          onReference={(file) => dispatch({ type: "reference/set", file })}
        />
      )}

      {showSettings && (
        <SettingsPanel
          t={t}
          onClose={() => setShowSettings(false)}
          onLangChange={(next) => setLang(next ?? detectLang())}
          onShowOnboarding={() => setShowOnboarding(true)}
          onShowConsent={() => setShowConsent(true)}
          onNotice={notice}
        />
      )}

      {showOnboarding && <Onboarding t={t} onDone={() => setShowOnboarding(false)} />}

      {/* Deferred until onboarding is out of the way so the two dialogs never stack. */}
      {!showOnboarding && showConsent && (
        <ConsentCard
          t={t}
          onDecided={() => setShowConsent(false)}
          onDismiss={() => setShowConsent(false)}
        />
      )}
    </main>
  );
}
