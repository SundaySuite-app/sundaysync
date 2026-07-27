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
  | { name: "scanning"; inputs: string[]; previous: ScanManifest | null }
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

export interface AppState {
  phase: Phase;
  /** file → device id. Survives re-scans; applied for real by the engine at sync time. */
  overrides: Record<string, string>;
  /** Chosen from the sources view, pre-sync — any syncable file, not just placed ones. */
  reference: string | null;
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
  | { type: "scan/done"; seq: number; manifest: ScanManifest }
  | { type: "scan/failed"; seq: number; error: MappedError }
  | { type: "override/set"; file: string; device: string }
  | { type: "reference/set"; file: string | null }
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
        phase: { name: "scanning", inputs, previous: currentManifest(state.phase) },
        scanSeq: state.scanSeq + 1,
      };
    }

    case "inputs/removeRoot": {
      const inputs = currentInputs(state.phase).filter((p) => p !== action.path);
      if (inputs.length === 0) {
        return { ...state, banner: null, overrides: {}, reference: null, phase: { name: "empty" } };
      }
      return {
        ...state,
        banner: null,
        phase: { name: "scanning", inputs, previous: currentManifest(state.phase) },
        scanSeq: state.scanSeq + 1,
      };
    }

    case "inputs/clear":
      return {
        ...state,
        banner: null,
        overrides: {},
        reference: null,
        phase: { name: "empty" },
      };

    case "scan/start":
      // inputs/add and inputs/removeRoot already moved us to `scanning`; this action
      // exists for the App effect to acknowledge, and is a no-op on state.
      return state;

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
      return {
        ...state,
        overrides,
        reference,
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

    case "sync/start": {
      const manifest = currentManifest(state.phase);
      if (!manifest) return state;
      return {
        ...state,
        banner: null,
        cancelling: false,
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
