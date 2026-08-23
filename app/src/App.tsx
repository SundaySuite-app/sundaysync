/**
 * SundaySync — docs/PLAN.md §9.
 *
 * Composition and effects only: the phase machine lives in `state.ts`, strings in
 * `i18n/`, persistence in `settings.ts`, error mapping in `errors.ts`. Simple mode is
 * the whole surface until the user opens settings, and nothing in settings changes what
 * simple mode does with an untouched configuration.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
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
import { PreviewPanel } from "./components/timeline/PreviewPanel";
import { TimelineView } from "./components/timeline/TimelineView";
import { HOP_SAFETY_MS, motionAllowed } from "./components/timeline/useHop";
import { SettingsPanel } from "./components/SettingsPanel";
import { SourcesPanel } from "./components/SourcesPanel";
import { Band } from "./components/shell/Band";
import { BottomSlot } from "./components/shell/BottomSlot";
import { Inspector } from "./components/shell/Inspector";
import { TopStrip } from "./components/shell/TopStrip";

import { mapEngineError } from "./errors";
import { invokeWithTimeout } from "./invoke";
import { detectLang, dictionaries, formatDuration, type Lang, type Strings } from "./i18n";
import { getSettings } from "./settings";
import { initialState, reducer, type PrewarmEndReason } from "./state";
import {
  BUSY_PREFIX,
  invalidate as invalidateWaveform,
  invalidateAll as invalidateAllWaveforms,
} from "./timeline/waveformStore";
import { recordingTimes } from "./timeline/recordingTime";
import { getTelemetryStatus, reportFrontendError } from "./telemetry";
import { checkForUpdate } from "./update";
import { gateErrorReport, initialErrorGateState, shapeErrorPayload } from "./telemetryErrors";
import type { ProgressEvent, ScanManifest, SidecarStatus, SyncOutcome } from "./types";

/** `prewarm:file` (lib.rs `PrewarmFileEvent`) — one file finished pre-analysing. */
interface PrewarmFileEvent {
  file: string;
  ok: boolean;
}

/**
 * Why the pre-analysis promise settled the way it did (V05-W1, D-064).
 *
 * Every rejection here is swallowed — a prewarm is an optimisation, and none of the ways
 * it can end is worth a word on screen. But they are not the same *kind* of ending, and
 * the reducer needs to know which one it got: a pass that was preempted or refused has no
 * verdict about the files it never reached, while one that broke on its own does.
 *
 * Classified through the prefixes the app already relies on, never a fresh string match:
 * `errors.ts`'s `cancelled` → `notice` mapping (D-030, and `run_sync`'s preemption and
 * `prewarm_analysis`'s supersession both answer exactly that), and `waveformStore.ts`'s
 * `BUSY_PREFIX` for the D-046 activity-guard refusal.
 */
function prewarmEndReason(e: unknown, t: Strings): PrewarmEndReason {
  const raw = e instanceof Error ? e.message : String(e);
  if (raw.includes(BUSY_PREFIX)) return "cancelled";
  return mapEngineError(raw, t).kind === "notice" ? "cancelled" : "done";
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [lang, setLang] = useState<Lang>(() => getSettings().lang ?? detectLang());
  const [showSettings, setShowSettings] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(() => !getSettings().onboardingDone);
  const [showConsent, setShowConsent] = useState(false);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("SundaySync");
  /**
   * The marked clip, as a file path — lifted out of `TimelineView` in V06-R1 (D-075).
   *
   * The timeline used to own it because the panel that read it hung underneath the timeline.
   * The inspector is a column of the room now, a sibling of the stage, and two siblings can
   * only share a fact through the parent. `TimelineView` still enforces the rule that a
   * selection must name a clip that is actually drawn — it is the only thing that knows —
   * and reports a stale one back through `onSelect(null)`.
   */
  const [selected, setSelected] = useState<string | null>(null);
  /** The bottom slot's portal target (D-075). A callback ref in state rather than a `useRef`
   *  so the commit that mounts the node re-renders the tree that portals into it. */
  const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null);
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

  // Per-file outcomes from the background pre-analysis (D-059's `prewarm:file`).
  //
  // Two things happen per event, and the ORDER matters: the store's memo for that file is
  // dropped FIRST, so that when the state update below re-renders the clip out of its
  // "analysing" state, the re-read it triggers goes to the shell instead of replaying the
  // `cache_missing` rejection that was cached before the pass got there (D-062).
  useEffect(() => {
    const unlisten = listen<PrewarmFileEvent>("prewarm:file", (e) => {
      invalidateWaveform(e.payload.file);
      dispatch({ type: "prewarm/file", file: e.payload.file, ok: e.payload.ok });
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // The aggregate tick. Its own channel, its own state, and (in the panel) its own element
  // — never the ProgressBar: a prewarm is not something the operator is waiting for, and
  // dressing it as the scan's or the sync's progress would say it is.
  useEffect(() => {
    const unlisten = listen<ProgressEvent>("prewarm:progress", (e) =>
      dispatch({
        type: "prewarm/progress",
        completed: e.payload.completed,
        total: e.payload.total,
      }),
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

  // ---- Background pre-analysis (V04-U4, D-062; backend D-059) ----------------------
  //
  // Fire-and-forget, exactly once per scan. The whole point is that the operator is
  // reading the sources list while the decode the sync would have had to do anyway is
  // already happening, so this must never behave like a step: it reports nothing when it
  // starts, and nothing when it fails.
  //
  // A `busy:` rejection is EXPECTED (a cache sweep, a regenerate, a sync the user started
  // between the scan finishing and this effect running) and is a non-event: the sync does
  // the very same extraction itself. So is "cancelled" — a `run_sync` preempts a running
  // prewarm (D-059), which is precisely what should happen and is not a failure of
  // anything. So is the browser tier's "no backend". Every rejection is therefore
  // swallowed, and the one thing that ALWAYS happens is `prewarm/settled`: whatever
  // ended the pass, nothing more is coming, and no clip may be left waiting on it.
  //
  // Deliberately NOT re-invoked when the exclusion set changes: the extra files a
  // superseded pass already decoded are harmless cache entries, and restarting the pass
  // for every ✕ would throw away the work in flight each time. A new scan does re-invoke,
  // because that is a genuinely different set of files.
  //
  // The exclusion set is therefore read through a ref rather than taken as a
  // dependency.
  const excludedRef = useRef(state.excluded);
  excludedRef.current = state.excluded;
  const prewarmedSeq = useRef<number | null>(null);
  useEffect(() => {
    if (phase.name === "empty") {
      // Back to nothing: stop the pass rather than letting it decode a drop the operator
      // has already cleared. Only worth a call if we ever started one.
      if (prewarmedSeq.current !== null) {
        prewarmedSeq.current = null;
        void invoke("cancel_prewarm").catch(() => {});
      }
      return;
    }
    // V04-U5 QA: a NEW scan supersedes the old drop, and the pass running against the old
    // one has to be told. Two layers were each right on their own and disagreed at the
    // seam: `prewarm_analysis` claims the D-046 activity slot with the ordinary guard, so
    // only a `run_sync` can take it (D-059) — and this effect fires one pass per scan
    // sequence. Drop a second folder while the first is still decoding and the second
    // pass was therefore refused outright with `busy: analysis in progress`, silently
    // (every rejection here is swallowed, by design). The new drop then got NO background
    // analysis at all, while the abandoned pass kept reading the old folder off the NAS
    // and kept ticking `prewarm:progress` against a file list that was no longer on
    // screen. Cancelling here is the same sentence the empty case above already says —
    // speculative work on a drop that no longer exists — and it lets the slot go before
    // the (much slower) probe pass finishes and asks for it.
    if (phase.name === "scanning") {
      if (prewarmedSeq.current !== null && prewarmedSeq.current !== scanSeq) {
        void invoke("cancel_prewarm").catch(() => {});
      }
      return;
    }
    if (phase.name !== "sources" || prewarmedSeq.current === scanSeq) return;
    prewarmedSeq.current = scanSeq;
    // Which drop this pass belongs to. A superseded pass can settle long after the next
    // scan has landed, and `prewarm/settled` rewrites every still-pending entry to
    // `failed` — so it has to be able to tell whose pass just ended.
    const seq = scanSeq;

    const excludedNow = new Set(excludedRef.current);
    const files = phase.manifest.files
      .map((f) => f.file)
      .filter((file) => !excludedNow.has(file));
    if (files.length === 0) {
      dispatch({ type: "prewarm/settled", seq, reason: "done" });
      return;
    }
    // V05-W1 (D-064): the rejection is still swallowed — nothing about it reaches the
    // screen — but it is READ first. `.catch(() => {}).then(…)` threw the one piece of
    // information the reducer needed away before asking it a question, and answered
    // "finished" for a pass that had been shoved aside. That is what wrote `failed` across
    // every clip the moment the operator pressed Sync.
    void invoke("prewarm_analysis", { files, cacheDir: getSettings().cacheDir }).then(
      () => dispatch({ type: "prewarm/settled", seq, reason: "done" }),
      (e: unknown) => dispatch({ type: "prewarm/settled", seq, reason: prewarmEndReason(e, t) }),
    );
    // `excludedRef` is read but intentionally not a dependency: see the note above — an
    // exclusion must not restart the pass. The scan sequence is what re-runs this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.name, phase.name === "sources" ? scanSeq : -1]);

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
          // D-060/D-062: the engine re-walks every folder it is given, so the shell cannot
          // enforce a removal by trimming `inputs` — the filter has to travel with the
          // request. Null when nothing is excluded, which the backend treats identically
          // to an empty list (`#[serde(default)]`).
          excludeFiles: state.excluded.length > 0 ? state.excluded : null,
          segmentCount: settings.segmentCount,
          correctDrift: settings.correctDrift,
        },
      });
      // V05-W1 (D-064): the run rewrote the analysis cache for every file in it, so every
      // memo this session holds — a `cache_missing` rejection from before the run, bins
      // from an entry the run replaced — is now a claim about a cache that is gone. Dropped
      // BEFORE the phase change, so the same render that empties the prewarm map is the one
      // that sends each canvas back to the shell to look again. Without this the waveforms
      // the sync had just built never appeared: the map was cleared, the clips stopped
      // saying «analyserer …», and every one of them replayed the rejection it had cached
      // half an hour earlier.
      invalidateAllWaveforms();
      dispatch({ type: "sync/done", outcome });
    } catch (e) {
      // Cancelled or broken, the run still wrote analysis for the files it got through —
      // and wrote nothing for the rest. Same wholesale re-read, same reason.
      invalidateAllWaveforms();
      dispatch({ type: "sync/failed", error: mapEngineError(String(e), t) });
    }
  }, [state.phase, state.reference, state.overrides, state.excluded, t]);

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
        // Part of the F6 fingerprint on the backend (D-060): without it, removing a file
        // after a sync would leave the fingerprint unchanged and the export would happily
        // write a timeline containing the clip the operator had just taken out.
        excludeFiles: state.excluded.length > 0 ? state.excluded : null,
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
  }, [projectName, t, state.phase, state.reference, state.overrides, state.excluded]);

  const notice = useCallback((kind: "ok" | "error", text: string) => {
    dispatch({ type: "banner/set", banner: { kind, text } });
  }, []);

  // ---- The progress band's hold across the hop (V06-R1, D-082) -----------------------
  //
  // `syncing` → `result` removes the band, which is 34 px of the room, in the SAME frame the
  // clips start hopping to their solved positions. Two movements at once, one of them the
  // whole point of the moment and the other an accident of layout: the timeline appears to
  // jump upwards under the very animation the operator is meant to read. So the band stays,
  // showing the run it just finished at 100 %, until the hop has come to rest.
  //
  // **A LAYOUT effect, and that is the whole of it.** `useEffect` runs after the browser has
  // painted, while `useHop`'s own layout effect sets `data-hop` during the commit — so an
  // ordinary effect paints one frame with the band already gone and the hop already running,
  // and then puts the band back. That is a flicker, which is worse than no hold at all, and
  // it is not theoretical: `ett-rom.spec.ts` samples every frame of the hop and caught it
  // (one dropped frame at 1280×800, ten at 1024×600). A layout effect's state update is
  // flushed synchronously before paint, so the band never leaves the screen. Setting the
  // state during render would do the same thing, and was tried — React drops a render-phase
  // update when the same commit is re-rendered for another reason, which here it is.
  //
  // Under reduced motion there is no hop to wait for and the band goes at once; a hold there
  // would be 750 ms of a bar that has finished.
  const [bandHeld, setBandHeld] = useState(false);
  const previousPhaseName = useRef(phase.name);
  useLayoutEffect(() => {
    const previous = previousPhaseName.current;
    previousPhaseName.current = phase.name;
    if (previous === "syncing" && phase.name === "result" && motionAllowed()) setBandHeld(true);
  }, [phase.name]);
  // `onHopSettled` is the ordinary release — `useHop` fires it from both of the ways a hop can
  // end, its own finish and any gesture that cancels it. The timer is the promise that there
  // IS an end: the same safety net `useHop` sizes its own from, plus a frame.
  useEffect(() => {
    if (!bandHeld) return;
    const timer = setTimeout(() => setBandHeld(false), HOP_SAFETY_MS + 100);
    return () => clearTimeout(timer);
  }, [bandHeld]);
  const onHopSettled = useCallback(() => setBandHeld(false), []);
  /** The last tick of the run that is finishing, so the held band shows that run's own stage
   *  filled rather than an indeterminate bar it has no reason to draw. */
  const lastSyncProgress = useRef<ProgressEvent | null>(null);
  if (phase.name === "syncing") lastSyncProgress.current = phase.progress;

  const manifest =
    phase.name === "sources" || phase.name === "syncing" || phase.name === "result"
      ? phase.manifest
      : phase.name === "scanning"
        ? phase.previous
        : null;
  const deviceIds = manifest ? manifest.devices.map((d) => d.id) : [];
  const overridesDirty = Object.keys(state.overrides).length > 0;
  // Built once per change rather than per consumer: the timeline and the panel ask the
  // same membership question, and rebuilding a `Set` inside a `memo`ised subtree would
  // defeat the memo on every render.
  const excludedSet = useMemo(() => new Set(state.excluded), [state.excluded]);
  // The timeline is the main view (v0.4, D-061): it appears the moment a scan has told us
  // what was dropped, and stays MOUNTED across sources → syncing → result. Nothing below
  // may unmount it on a phase change — the continuity is the feature.
  const timelinePhase =
    phase.name === "sources" || phase.name === "syncing" || phase.name === "result"
      ? phase.name
      : null;
  const outcome = phase.name === "result" ? phase.outcome : null;

  // ---- What the inspector column is looking at (V06-R1, D-075/D-076) -------------------
  //
  // Verbatim in intent from what `TimelineView` used to derive for the panel it hung under
  // (D-070): one stored fact — the marked file's path — and every other view of it computed.
  // `recordingTimes` is the same ladder `sourceLayout` runs (D-067), memoised on the manifest
  // alone, so it costs one pass per scan and nothing per selection; it answers in the RESULT
  // phase too, where the pre-sync `timeSource` map is empty but the file's own clock is still
  // a fact worth showing beside the engine's answer.
  const selectedPlacement = useMemo(
    () =>
      outcome !== null && selected !== null
        ? (outcome.result.placements.find((p) => p.file === selected) ?? null)
        : null,
    [outcome, selected],
  );
  const selectedEntry =
    selected !== null ? (manifest?.files.find((f) => f.file === selected) ?? null) : null;
  const recorded = useMemo(() => (manifest ? recordingTimes(manifest.files) : null), [manifest]);
  // Nothing is dropped, so nothing can be marked. The timeline's own pruning effect cannot
  // say this: by the empty phase it is unmounted.
  useEffect(() => {
    if (phase.name === "empty") setSelected(null);
  }, [phase.name]);

  /**
   * The strip's one sentence (V06-R1, D-081).
   *
   * The same two numbers the bridge panel below puts in its chips, counted the same way —
   * after the exclusion filter and under the override overlay — because a strip that
   * disagreed with the panel about how many files are in the run would be the loudest
   * possible bug in a 44 px line. Result adds what the run produced: frame rate and length.
   */
  const stripSummary = useMemo(() => {
    if (manifest === null || phase.name === "empty" || phase.name === "scanning") return null;
    const gone = new Set(state.excluded);
    const devices = new Set<string>();
    let files = 0;
    for (const entry of manifest.files) {
      if (gone.has(entry.file)) continue;
      files += 1;
      devices.add(state.overrides[entry.file] ?? entry.device);
    }
    const counts = `${t.fileCount(files)} · ${t.deviceCount(devices.size)}`;
    if (outcome === null) return counts;
    const { fps, duration_seconds } = outcome.result.sequence;
    return `${counts} · ${t.sequenceMeta(fps, formatDuration(duration_seconds))}`;
  }, [manifest, phase.name, state.excluded, state.overrides, outcome, t]);

  // ---- The strip's single primary action, per phase --------------------------------------
  const stripActions =
    phase.name === "sources" ? (
      <button
        type="button"
        className="primary"
        onClick={runSync}
        // The cached-analysis promise (D-027) used to be a `<small>` under the button label,
        // which is a second line the strip does not have. Same sentence, on the control it
        // is about.
        title={overridesDirty ? t.resyncHint : undefined}
      >
        {t.syncButton}
      </button>
    ) : phase.name === "result" ? (
      <>
        {/* The project name travels with the export, so it sits beside it. */}
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
        <button type="button" className="secondary" onClick={runSync} title={t.resyncHint}>
          {t.resyncButton}
        </button>
        {exportedPath && (
          <button
            type="button"
            className="secondary"
            onClick={() => revealItemInDir(exportedPath)}
          >
            {t.revealInFinder}
          </button>
        )}
      </>
    ) : null;

  return (
    <main className="app">
      <TopStrip
        t={t}
        // Exactly one `DropZone` may be mounted at a time — its drag-drop listener is
        // webview-global (DropZone.tsx). In the empty phase the stage's own full-size zone is
        // the one; from `scanning` onwards the strip carries it.
        add={
          phase.name === "empty" ? null : (
            <DropZone
              t={t}
              compact
              onFiles={chooseFiles}
              onFolder={chooseFolder}
              onDropPaths={addPaths}
            />
          )
        }
        summary={stripSummary}
        actions={stripActions}
        onSettings={() => setShowSettings(true)}
      />

      {/* The band (D-082) — the one thing that is allowed to move the timeline, and only
          while the app is genuinely working. */}
      {phase.name === "scanning" && (
        <Band>
          <ProgressBar t={t} progress={phase.progress} idleLabel={t.scanningInputs} />
        </Band>
      )}
      {phase.name === "syncing" && (
        <Band>
          <ProgressBar t={t} progress={phase.progress} />
          <button
            type="button"
            className="secondary"
            onClick={cancelSync}
            disabled={state.cancelling}
          >
            {state.cancelling ? t.cancelling : t.cancel}
          </button>
        </Band>
      )}
      {phase.name === "result" && bandHeld && (
        <Band>
          <ProgressBar
            t={t}
            progress={
              lastSyncProgress.current === null
                ? null
                : { ...lastSyncProgress.current, completed: lastSyncProgress.current.total }
            }
          />
        </Band>
      )}

      <section className="stage">
        {/* Banners float over the stage instead of taking a row of their own (D-082). A
            message the app has to say is not a reason for everything under it to move — and
            an error banner arriving mid-sync used to do exactly that. */}
        <div className="toasts">
          {state.sidecarOk === false && !showOnboarding && (
            <p className="banner banner--error" role="alert">
              <span>{t.errSidecar}</span>
            </p>
          )}
          <BannerRegion
            t={t}
            banner={state.banner}
            onDismiss={() => dispatch({ type: "banner/clear" })}
          />
        </div>

        {phase.name === "empty" && (
          <EmptyState t={t} onFiles={chooseFiles} onFolder={chooseFolder} onDropPaths={addPaths} />
        )}

        {/* `scanning` deliberately renders NOTHING here. The band above says what is
            happening; the empty state flashing back under it for the length of a probe would
            say the opposite. */}

        {timelinePhase && manifest && (
          <TimelineView
            t={t}
            phase={timelinePhase}
            manifest={manifest}
            overrides={state.overrides}
            reference={state.reference}
            excluded={excludedSet}
            prewarm={state.prewarm}
            outcome={outcome}
            stale={phase.name === "result" && phase.stale}
            deviceIds={deviceIds}
            selected={selected}
            onSelect={setSelected}
            slotEl={slotEl}
            onHopSettled={onHopSettled}
            onOverride={(file, device) => dispatch({ type: "override/set", file, device })}
            onExclude={(file) => dispatch({ type: "files/exclude", file })}
          />
        )}

        {/* THE BRIDGE (V06-R1, D-087). The sources panel is unchanged and still mounted,
            under the timeline, inside its own scroller — so every journey that goes through
            it keeps working while the room is rebuilt around it. R2a is what takes it out;
            nothing in R1 ships on its own. */}
        {timelinePhase && manifest && (
          <div className="stage__legacy">
            <SourcesPanel
              t={t}
              manifest={manifest}
              inputs={phase.name === "empty" || phase.name === "scanning" ? [] : phase.inputs}
              overrides={state.overrides}
              reference={state.reference}
              excluded={excludedSet}
              prewarmProgress={state.prewarmProgress}
              busy={phase.name === "syncing"}
              onRemoveRoot={(path) => dispatch({ type: "inputs/removeRoot", path })}
              onClearAll={() => dispatch({ type: "inputs/clear" })}
              onOverride={(file, device) => dispatch({ type: "override/set", file, device })}
              onReference={(file) => dispatch({ type: "reference/set", file })}
              onExclude={(file) => dispatch({ type: "files/exclude", file })}
              onRestore={(file) => dispatch({ type: "files/restore", file })}
            />
          </div>
        )}
      </section>

      <Inspector>
        <PreviewPanel
          t={t}
          file={selected}
          entry={selectedEntry}
          placement={selectedPlacement}
          minPsr={outcome?.result.parameters.min_psr ?? null}
          recorded={selected !== null ? (recorded?.get(selected) ?? null) : null}
          // The same three-layer overlay `SourcesPanel` and `sourceSpans` apply
          // (D-027/D-028): the operator's override wins, then the engine's placement, then
          // the scan's own grouping. Post-sync the placement is deliberately NOT rewritten by
          // an override — that is what makes the result stale — so without the overlay here
          // the `<select>` would snap back the instant it was used.
          device={
            selected !== null
              ? (state.overrides[selected] ??
                selectedPlacement?.device ??
                selectedEntry?.device ??
                "")
              : ""
          }
          deviceIds={deviceIds}
          busy={phase.name === "syncing"}
          onOverride={(file, device) => dispatch({ type: "override/set", file, device })}
        />
      </Inspector>

      <BottomSlot transportRef={setSlotEl}>
        {/* The stale notice is a fact about the result, not an alarm about it — one quiet
            line at the bottom of the room rather than a banner between the operator and the
            timeline (D-082). Same words, same warn colour. */}
        {phase.name === "result" && phase.stale && (
          <p className="slot__stale">{t.staleResult}</p>
        )}
      </BottomSlot>

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
