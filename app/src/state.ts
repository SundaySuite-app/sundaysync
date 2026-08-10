/**
 * The app's phase machine.
 *
 * The first build held twelve independent `useState`s, which is how it managed to show
 * a previous run's result — export button included — while a new sync was running. A
 * reducer over an explicit `Phase` union makes that unrepresentable: `sync/start`
 * *moves* to the syncing phase, and the old outcome is simply gone.
 *
 * Cross-phase state (overrides, chosen reference, banner) lives beside the phase, and
 * the reducer is a pure function so the transitions are unit-testable (vitest).
 */

import type { MappedError } from "./errors";
import type { ProgressEvent, ScanManifest, SyncOutcome } from "./types";

export type Phase =
  | { name: "empty" }
  | {
      name: "scanning";
      inputs: string[];
      previous: ScanManifest | null;
      /** Live `scan:progress` ticks from the backend probe — null until the first event
       *  arrives, so the UI falls back to an indeterminate "reading sources" label. */
      progress: ProgressEvent | null;
    }
  | { name: "sources"; inputs: string[]; manifest: ScanManifest }
  | {
      name: "syncing";
      inputs: string[];
      manifest: ScanManifest;
      progress: ProgressEvent | null;
    }
  | {
      name: "result";
      inputs: string[];
      manifest: ScanManifest;
      outcome: SyncOutcome;
      /** True once inputs/overrides/reference changed after this run — the lanes dim
       *  and the primary action becomes "Synkroniser på nytt" (D-027). */
      stale: boolean;
    };

export interface Banner {
  kind: "ok" | "warn" | "error" | "info";
  text: string;
}

/**
 * Where one file is in the background pre-analysis pass (V04-U4, D-062).
 *
 * `pending` is the only value that means "wait" — it is what puts the «analyserer …»
 * placeholder in a clip's waveform slot instead of the regenerate control, because
 * regenerating during a prewarm can only earn the D-046 busy refusal and the bytes are
 * about to arrive anyway.
 *
 * `ready` is the only value that means "there is something new to read", and it is the
 * *transition* into it that makes a clip re-read its waveform (`WaveformCanvas`).
 *
 * `failed` means "stop waiting, nothing was written for this file" — a file that would
 * not decode (`prewarm:file` with `ok: false`) and a pass that FINISHED before reaching it
 * (`prewarm/settled` with `reason: "done"`) are the same thing to every consumer: no
 * analysis arrived, and the ordinary regenerate affordance is the right offer.
 *
 * **A pass that was CANCELLED says none of that (V05-W1, D-064).** It was preempted or
 * superseded, so it never got as far as an opinion about the files it had not reached —
 * and the app has none either. Those files leave the map entirely rather than being
 * declared `failed`: an absent entry is "no opinion", which is the only true thing to say.
 */
export type PrewarmStatus = "pending" | "ready" | "failed";

/**
 * Why a pre-analysis pass stopped (V05-W1, D-064).
 *
 * - `done` — it ran to its own end (resolved), or died of something that is genuinely a
 *   failure. Nothing more is coming for the files it never wrote, and the regenerate
 *   control is the right offer for them.
 * - `cancelled` — it was preempted by a sync, superseded by a newer drop, or refused the
 *   activity slot outright (`busy:`, D-046). Whoever took the slot is doing the same
 *   extraction; the pass has no verdict to hand down.
 */
export type PrewarmEndReason = "done" | "cancelled";

export interface AppState {
  phase: Phase;
  /** file → device id. Survives re-scans; applied for real by the engine at sync time. */
  overrides: Record<string, string>;
  /** Chosen from the sources view, pre-sync — any syncable file, not just placed ones. */
  reference: string | null;
  /**
   * Files the operator took out of the run (V04-U4, D-062). A *frontend* set: the engine
   * is told about it through `run_sync`/`export_timeline`'s `excludeFiles` (D-060) and
   * enforces it after its own re-walk. Everything the UI counts, draws or sends filters
   * through this, and `scan/done` prunes it back to what the scan actually found.
   */
  excluded: string[];
  /** file → analysis status, for files the app currently believes are being analysed: the
   *  ones this scan handed to `prewarm_analysis`, and (V05-W1, D-064) the ones a running
   *  `run_sync` is extracting, which is the same work under a different caller. Empty
   *  between runs — an absent entry means "no opinion", not "failed". */
  prewarm: Record<string, PrewarmStatus>;
  /** The aggregate `prewarm:progress` tick, or null when no pass is running. */
  prewarmProgress: { completed: number; total: number } | null;
  banner: Banner | null;
  cancelling: boolean;
  /** null = not checked yet. */
  sidecarOk: boolean | null;
  /** Monotonic scan sequence — a superseded scan's result must not clobber a newer one. */
  scanSeq: number;
}

export const initialState: AppState = {
  phase: { name: "empty" },
  overrides: {},
  reference: null,
  excluded: [],
  prewarm: {},
  prewarmProgress: null,
  banner: null,
  cancelling: false,
  sidecarOk: null,
  scanSeq: 0,
};

export type Action =
  | { type: "inputs/add"; paths: string[] }
  | { type: "inputs/removeRoot"; path: string }
  | { type: "inputs/clear" }
  | { type: "scan/start" }
  | { type: "scan/progress"; progress: ProgressEvent }
  | { type: "scan/done"; seq: number; manifest: ScanManifest }
  | { type: "scan/failed"; seq: number; error: MappedError }
  | { type: "override/set"; file: string; device: string }
  | { type: "reference/set"; file: string | null }
  | { type: "files/exclude"; file: string }
  | { type: "files/restore"; file: string }
  | { type: "prewarm/file"; file: string; ok: boolean }
  | { type: "prewarm/progress"; completed: number; total: number }
  | { type: "prewarm/settled"; seq: number; reason: PrewarmEndReason }
  | { type: "sync/start" }
  | { type: "sync/progress"; progress: ProgressEvent }
  | { type: "sync/done"; outcome: SyncOutcome }
  | { type: "sync/failed"; error: MappedError }
  | { type: "cancel/requested" }
  | { type: "banner/set"; banner: Banner }
  | { type: "banner/clear" }
  | { type: "sidecar/checked"; ok: boolean };

function currentInputs(phase: Phase): string[] {
  return phase.name === "empty" ? [] : phase.inputs;
}

function currentManifest(phase: Phase): ScanManifest | null {
  switch (phase.name) {
    case "sources":
    case "syncing":
    case "result":
      return phase.manifest;
    case "scanning":
      return phase.previous;
    case "empty":
      return null;
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "inputs/add": {
      const inputs = Array.from(new Set([...currentInputs(state.phase), ...action.paths]));
      // Any input change invalidates a shown result (stale) and triggers a re-scan.
      return {
        ...state,
        banner: null,
        phase: { name: "scanning", inputs, previous: currentManifest(state.phase), progress: null },
        scanSeq: state.scanSeq + 1,
      };
    }

    case "inputs/removeRoot": {
      const inputs = currentInputs(state.phase).filter((p) => p !== action.path);
      if (inputs.length === 0) {
        return { ...state, banner: null, ...clearedSources, phase: { name: "empty" } };
      }
      return {
        ...state,
        banner: null,
        phase: { name: "scanning", inputs, previous: currentManifest(state.phase), progress: null },
        scanSeq: state.scanSeq + 1,
      };
    }

    case "inputs/clear":
      return {
        ...state,
        banner: null,
        ...clearedSources,
        phase: { name: "empty" },
      };

    case "scan/start":
      // inputs/add and inputs/removeRoot already moved us to `scanning`; this action
      // exists for the App effect to acknowledge, and is a no-op on state.
      return state;

    case "scan/progress":
      if (state.phase.name !== "scanning") return state;
      return { ...state, phase: { ...state.phase, progress: action.progress } };

    case "scan/done": {
      if (action.seq !== state.scanSeq || state.phase.name !== "scanning") {
        return state; // a superseded scan finished late — ignore it
      }
      // Prune overrides and reference that no longer point at a scanned file: stale
      // entries would silently vanish into the engine's ignore path, and the UI should
      // not pretend they still apply.
      const files = new Set(action.manifest.files.map((f) => f.file));
      const overrides = Object.fromEntries(
        Object.entries(state.overrides).filter(([file]) => files.has(file)),
      );
      const reference =
        state.reference !== null && files.has(state.reference) ? state.reference : null;
      // Exclusions are pruned by the same philosophy, against a WIDER set: a file can be
      // removed from the problem group too, and that removal is about a path the scan
      // reported as unusable, not as a source. Keeping an exclusion for a path this scan
      // no longer knows about would send the engine a filter nothing matches, and would
      // keep a row in the "removed" group that the operator can no longer relate to
      // anything on screen.
      const known = new Set([...files, ...action.manifest.unsynced.map((u) => u.file)]);
      const excluded = state.excluded.filter((file) => known.has(file));
      // Every file this scan found is about to be handed to `prewarm_analysis` (App.tsx),
      // so they all start out pending. An excluded file is not prewarmed — it is not part
      // of the run, and decoding it would be work nobody asked for.
      const stillExcluded = new Set(excluded);
      const prewarm: Record<string, PrewarmStatus> = {};
      for (const file of files) {
        if (!stillExcluded.has(file)) prewarm[file] = "pending";
      }
      return {
        ...state,
        overrides,
        reference,
        excluded,
        prewarm,
        prewarmProgress: null,
        phase: { name: "sources", inputs: state.phase.inputs, manifest: action.manifest },
      };
    }

    case "scan/failed": {
      if (action.seq !== state.scanSeq || state.phase.name !== "scanning") {
        return state;
      }
      // A cancelled scan was superseded by a newer one — nothing to report.
      if (action.error.kind === "notice") {
        return state;
      }
      const inputs = state.phase.inputs;
      const previous = state.phase.previous;
      return {
        ...state,
        banner: { kind: "error", text: action.error.text },
        phase: previous
          ? { name: "sources", inputs, manifest: previous }
          : { name: "empty" },
      };
    }

    case "override/set": {
      const overrides = { ...state.overrides, [action.file]: action.device };
      return { ...state, overrides, phase: markStale(state.phase) };
    }

    case "reference/set":
      return { ...state, reference: action.file, phase: markStale(state.phase) };

    case "files/exclude": {
      if (state.excluded.includes(action.file)) return state;
      // Three things go with the file, and each one is a lie if it stays behind:
      //   - its override, which would name a device for a file nobody is syncing (and
      //     would come back the moment the file is restored, silently);
      //   - the reference star, if it pointed here — the run would then claim a reference
      //     the engine was told to skip, and the engine would pick its own instead;
      //   - the freshness of a shown result, which no longer describes this set of files.
      const { [action.file]: _removed, ...overrides } = state.overrides;
      return {
        ...state,
        excluded: [...state.excluded, action.file],
        overrides,
        reference: state.reference === action.file ? null : state.reference,
        // The file is out of the run, so it is out of the prewarm bookkeeping too — a
        // clip that is not drawn cannot be waiting for anything.
        prewarm: without(state.prewarm, action.file),
        phase: markStale(state.phase),
      };
    }

    case "files/restore": {
      if (!state.excluded.includes(action.file)) return state;
      // The mirror image, and stale for the same reason: putting a file back changes the
      // set of sources the stored run was made from. Its prewarm status is deliberately
      // NOT restored to `pending` — no pass is going to report on it (App.tsx does not
      // re-invoke `prewarm_analysis` on an exclusion change, D-062), so `pending` would
      // be a wait that never ends. Missing means "not waiting", and the clip falls back
      // to the ordinary cache-missing affordance, which is exactly the right offer.
      return {
        ...state,
        excluded: state.excluded.filter((f) => f !== action.file),
        phase: markStale(state.phase),
      };
    }

    case "prewarm/file":
      // Only files this scan actually put in the map are tracked. A late event from a
      // superseded pass names a file the current scan may not have (the operator dropped
      // a different folder meanwhile), and inventing an entry for it would leave a
      // `ready`/`failed` status behind for a clip that does not exist.
      if (!(action.file in state.prewarm)) return state;
      return {
        ...state,
        prewarm: { ...state.prewarm, [action.file]: action.ok ? "ready" : "failed" },
      };

    case "prewarm/progress":
      // V04-U5 QA: only a pass belonging to the drop that is ON SCREEN may move this line.
      // The `prewarm:progress` channel carries no sequence number of its own, and a pass
      // that has been superseded (a second folder dropped) or preempted (Sync pressed)
      // goes on emitting for as long as it takes to notice — so an unguarded tick showed
      // the OLD drop's counts under the NEW drop's file list, which is a progress bar for
      // work nobody is waiting for against a list it does not describe. `sources` is the
      // only phase a live pass belongs to.
      if (state.phase.name !== "sources") return state;
      return {
        ...state,
        prewarmProgress: { completed: action.completed, total: action.total },
      };

    case "prewarm/settled": {
      // V04-U5 QA: whose pass ended? A superseded pass settles LATE — after the next scan
      // has already put its own files in the map as `pending` — and the rewrite below
      // would then declare every file of the new drop `failed` on the strength of the old
      // drop's promise resolving. The launching sequence travels with the action so a late
      // settlement can only ever settle its own pass.
      if (action.seq !== state.scanSeq) return state;
      // V05-W1 (D-064): and is there still a pass to settle? `sources` is the only phase a
      // live pre-analysis belongs to — the same rule `prewarm/progress` above already
      // follows, and for the same reason. A `run_sync` preempts the prewarm, so the
      // preempted pass's rejection lands just AFTER `sync/start` has (truthfully) marked
      // every unanalysed file `pending` for the sync's own extraction. Letting the dying
      // pass rewrite that map is how 386 clips ended up wearing a rebuild button while the
      // sync that was rebuilding them ran.
      if (state.phase.name !== "sources") return state;
      // The pass ended. What that means for the files it never reached depends entirely on
      // WHY, and the first build had only one answer for both.
      //
      // `done` — it finished, or it broke. Nothing more is coming, so nothing may still be
      // `pending`: a clip left waiting on an event that will never arrive would show the
      // «analyserer …» placeholder forever, with no way back to the regenerate control.
      // `pending → failed`, NOT a wholesale clear. React batches state updates within one
      // task, and the last file's `prewarm:file` can land in the same batch as the
      // promise's resolution; wiping the map here would erase that file's `ready` before
      // any component saw it, and the waveform it had just written would never be read.
      // Rewriting only the pending entries is order-insensitive.
      //
      // `cancelled` — it was preempted, superseded or refused the slot. It never formed an
      // opinion about the files it had not reached, and neither has the app: those entries
      // are DELETED. `failed` would be an invention (§7.5), and an invention with a
      // consequence — it is exactly what put a rebuild control on every clip.
      const settled: Record<string, PrewarmStatus> = {};
      let changed = false;
      for (const [file, status] of Object.entries(state.prewarm)) {
        if (status === "pending") {
          changed = true;
          if (action.reason === "done") settled[file] = "failed";
          continue; // cancelled: no entry at all — the app has no opinion about this file
        }
        settled[file] = status;
      }
      if (!changed && state.prewarmProgress === null) return state;
      return { ...state, prewarm: settled, prewarmProgress: null };
    }

    case "sync/start": {
      const manifest = currentManifest(state.phase);
      if (!manifest) return state;
      // V05-W1 (D-064): a sync IS the analysis. `run_sync` extracts the analysis audio for
      // every file in the run, so while it is running an unanalysed file genuinely is
      // being analysed — and `pending` is the word for that. Saying so here is not a
      // workaround for the settled-storm below; it is the fact that makes the storm
      // impossible by construction, because there is nothing left for a dying prewarm to
      // turn into a rebuild button.
      //
      // Built from the MANIFEST rather than from the old map on purpose: a cancelled pass
      // deletes its pending entries, so by the time Sync is pressed the map may hold
      // nothing at all — and every file in the run is about to be analysed whether or not
      // the prewarm ever had an entry for it. `ready` is the one status that survives: its
      // analysis is already written, and the sync will find it there.
      const stillExcluded = new Set(state.excluded);
      const prewarm: Record<string, PrewarmStatus> = {};
      for (const { file } of manifest.files) {
        if (stillExcluded.has(file)) continue;
        prewarm[file] = state.prewarm[file] === "ready" ? "ready" : "pending";
      }
      return {
        ...state,
        banner: null,
        cancelling: false,
        prewarm,
        // No pass of its own is running any more — the sync took the slot (D-059).
        prewarmProgress: null,
        phase: {
          name: "syncing",
          inputs: currentInputs(state.phase),
          manifest,
          progress: null,
        },
      };
    }

    case "sync/progress":
      if (state.phase.name !== "syncing") return state;
      return { ...state, phase: { ...state.phase, progress: action.progress } };

    case "sync/done":
      if (state.phase.name !== "syncing") return state;
      return {
        ...state,
        cancelling: false,
        // V05-W1 (D-064): the run is over and it wrote whatever it wrote. Every entry here
        // described the run's own extraction, and holding on to it would leave clips
        // «analyserer …» forever. Emptying the map hands each clip back to the truth in the
        // cache — `App.tsx` drops the store's memos on the same event
        // (`waveformStore.invalidateAll`), so each canvas re-reads once and shows a
        // waveform where there is one and the rebuild control where there is not.
        prewarm: {},
        prewarmProgress: null,
        phase: {
          name: "result",
          inputs: state.phase.inputs,
          manifest: state.phase.manifest,
          outcome: action.outcome,
          stale: false,
        },
      };

    case "sync/failed": {
      if (state.phase.name !== "syncing") return state;
      // Cancel is the user's own action: a neutral notice back on the sources view,
      // never a red banner (§7.4's "you stopped this" vs "this broke").
      return {
        ...state,
        cancelling: false,
        // Same reasoning as `sync/done`, and it matters more here: a cancelled run has
        // written analysis for the files it got through and nothing for the rest, and the
        // only honest way to say that is to stop claiming anything and let each clip read
        // the cache again.
        prewarm: {},
        prewarmProgress: null,
        banner: {
          kind: action.error.kind === "notice" ? "info" : "error",
          text: action.error.text,
        },
        phase: {
          name: "sources",
          inputs: state.phase.inputs,
          manifest: state.phase.manifest,
        },
      };
    }

    case "cancel/requested":
      return { ...state, cancelling: true };

    case "banner/set":
      return { ...state, banner: action.banner };

    case "banner/clear":
      return { ...state, banner: null };

    case "sidecar/checked":
      return { ...state, sidecarOk: action.ok };
  }
}

function markStale(phase: Phase): Phase {
  return phase.name === "result" ? { ...phase, stale: true } : phase;
}

/** Everything that describes a set of sources, back to nothing. Shared by the two ways of
 *  reaching the empty phase so they can never drift apart — an `excluded` list surviving
 *  a "clear all" would silently filter the NEXT drop. */
const clearedSources = {
  overrides: {} as Record<string, string>,
  reference: null,
  excluded: [] as string[],
  prewarm: {} as Record<string, PrewarmStatus>,
  prewarmProgress: null,
};

/** `{ ...map }` minus one key, without the `delete`/rest-destructuring dance at each of
 *  the call sites that need it. */
function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}
