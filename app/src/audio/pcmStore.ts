/**
 * Resident PCM — the sparse, budgeted cache the scheduler plays out of (V03-S5, D-055).
 *
 * `pcmPlan.ts` says which chunks should be here; this executes that: one
 * `read_audio_window` invoke per missing chunk, de-duplicated, with the budget enforced
 * on arrival. Nothing here decides policy, and nothing here touches Web Audio — it holds
 * `Float32Array`s and answers `has`.
 *
 * Three states a file can be in, and they are deliberately distinct:
 *   - **absent** — not fetched yet. The scheduler simply does not schedule it, and the
 *     1 Hz top-up tries again.
 *   - **ended** — a window came back empty, so the cache entry is shorter than the
 *     probed duration said. Every chunk from there on is skipped for good, silently:
 *     ffprobe's duration and the extracted sample count disagreeing by a frame is
 *     normal, not an error worth a banner.
 *   - **dead** — the cache entry is gone (`cache_missing:`). The clip cannot play this
 *     session; `onDead` fires once so the UI can say so, and nothing retries. Retrying
 *     would be a fetch per chunk per second, forever, for a file that needs a
 *     regenerate — the failure mode that turns one missing entry into a hung app.
 */

import { invoke } from "@tauri-apps/api/core";
import { CACHE_MISSING } from "../errors";
import {
  chunkKey,
  chooseEvictions,
  BUDGET_BYTES,
  type ChunkRef,
  type ResidentChunk,
} from "./pcmPlan";
import { CHUNK_SAMPLES } from "./schedulePlan";

/** The one IPC call playback makes. Injectable so tests need no Tauri. */
export type ReadWindow = (
  file: string,
  startSample: number,
  lenSamples: number,
) => Promise<ArrayBuffer>;

const defaultRead: ReadWindow = (file, startSample, lenSamples) =>
  invoke<ArrayBuffer>("read_audio_window", { file, startSample, lenSamples });

export type DeadReason = "cacheMissing";

export interface PcmStoreOptions {
  read?: ReadWindow;
  budgetBytes?: number;
  /** Fired once per file, the first time it is found unplayable. */
  onDead?: (file: string, reason: DeadReason) => void;
  /** Fired whenever residency changes, so the scheduler can schedule what just landed. */
  onArrived?: () => void;
}

interface Held {
  /** Backed by a plain ArrayBuffer, which is what `copyToChannel` requires. */
  samples: Float32Array<ArrayBuffer>;
  /** Timeline span, for eviction's distance ordering. Filled in by `ensure`'s caller. */
  startSec: number;
  endSec: number;
  lastUsedSeq: number;
}

/** A planned chunk plus where it will sound — eviction needs the second half. */
export interface PlannedChunk extends ChunkRef {
  startSec: number;
  endSec: number;
}

export class PcmStore {
  private readonly chunks = new Map<string, Held>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly dead = new Set<string>();
  private readonly endedAt = new Map<string, number>();
  private readonly read: ReadWindow;
  private readonly budgetBytes: number;
  private readonly onDead: (file: string, reason: DeadReason) => void;
  private readonly onArrived: () => void;
  private seq = 0;
  private bytes = 0;

  constructor(opts: PcmStoreOptions = {}) {
    this.read = opts.read ?? defaultRead;
    this.budgetBytes = opts.budgetBytes ?? BUDGET_BYTES;
    this.onDead = opts.onDead ?? (() => {});
    this.onArrived = opts.onArrived ?? (() => {});
  }

  /** Is this chunk playable right now? (`ResidentLookup` for `computeSchedule`.) */
  has(file: string, chunkIndex: number): boolean {
    return this.chunks.has(chunkKey(file, chunkIndex));
  }

  /** The samples, marking the chunk as used (which is what LRU tie-breaks on). */
  get(file: string, chunkIndex: number): Float32Array<ArrayBuffer> | undefined {
    const held = this.chunks.get(chunkKey(file, chunkIndex));
    if (!held) return undefined;
    held.lastUsedSeq = this.seq += 1;
    return held.samples;
  }

  /** Whether this file has been written off for the session. */
  isDead(file: string): boolean {
    return this.dead.has(file);
  }

  /** Every file written off so far — the UI names them. */
  deadFiles(): string[] {
    return [...this.dead];
  }

  get residentBytes(): number {
    return this.bytes;
  }

  get residentCount(): number {
    return this.chunks.size;
  }

  /**
   * Fetch whatever in `planned` is missing, then trim to the budget.
   *
   * Resolves when every fetch it started has settled. Callers who cannot wait (the 1 Hz
   * top-up) simply do not await it — an in-flight chunk is just an absent one until it
   * lands, and `onArrived` tells the scheduler when that is.
   */
  async ensure(planned: PlannedChunk[], tSec: number): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const ref of planned) {
      const key = chunkKey(ref.file, ref.chunkIndex);
      if (this.chunks.has(key)) continue;
      if (this.dead.has(ref.file)) continue;
      const ended = this.endedAt.get(ref.file);
      if (ended !== undefined && ref.chunkIndex >= ended) continue;

      const existing = this.inFlight.get(key);
      if (existing) {
        waits.push(existing);
        continue;
      }
      const p = this.fetch(ref).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, p);
      waits.push(p);
    }

    await Promise.all(waits);
    this.trim(planned, tSec);
  }

  private async fetch(ref: PlannedChunk): Promise<void> {
    let buffer: ArrayBuffer;
    try {
      buffer = await this.read(ref.file, ref.chunkIndex * CHUNK_SAMPLES, CHUNK_SAMPLES);
    } catch (e) {
      const raw = typeof e === "string" ? e : String((e as Error)?.message ?? e);
      if (raw.includes(CACHE_MISSING)) {
        this.markDead(ref.file);
      }
      // Anything else — a transient IO error, a timeout — is left absent so the next
      // top-up retries it. A single failed read must not silence a clip for the session.
      return;
    }

    // Byte length rather than sample count: the shell already guarantees whole samples.
    const samples = new Float32Array(buffer);
    if (samples.length === 0) {
      // Past the end of the cache entry. Everything from here on is silence that does
      // not exist; stop asking.
      const known = this.endedAt.get(ref.file);
      if (known === undefined || ref.chunkIndex < known) {
        this.endedAt.set(ref.file, ref.chunkIndex);
      }
      return;
    }

    this.chunks.set(chunkKey(ref.file, ref.chunkIndex), {
      samples,
      startSec: ref.startSec,
      endSec: ref.endSec,
      lastUsedSeq: (this.seq += 1),
    });
    this.bytes += samples.byteLength;
    // A short read is the clip's last chunk: there is nothing after it.
    if (samples.length < CHUNK_SAMPLES) {
      this.endedAt.set(ref.file, ref.chunkIndex + 1);
    }
    this.onArrived();
  }

  private markDead(file: string): void {
    if (this.dead.has(file)) return;
    this.dead.add(file);
    for (const [key, held] of [...this.chunks]) {
      if (key.startsWith(`${file}#`)) {
        this.bytes -= held.samples.byteLength;
        this.chunks.delete(key);
      }
    }
    this.onDead(file, "cacheMissing");
  }

  private trim(planned: PlannedChunk[], tSec: number): void {
    if (this.bytes <= this.budgetBytes) return;
    const resident: ResidentChunk[] = [];
    for (const [key, held] of this.chunks) {
      const hash = key.lastIndexOf("#");
      resident.push({
        file: key.slice(0, hash),
        chunkIndex: Number(key.slice(hash + 1)),
        startSec: held.startSec,
        endSec: held.endSec,
        lastUsedSeq: held.lastUsedSeq,
        bytes: held.samples.byteLength,
      });
    }
    for (const ref of chooseEvictions(resident, planned, tSec, this.budgetBytes)) {
      const key = chunkKey(ref.file, ref.chunkIndex);
      const held = this.chunks.get(key);
      if (!held) continue;
      this.bytes -= held.samples.byteLength;
      this.chunks.delete(key);
    }
  }

  /** Drop everything — a new sync result is a new set of files. */
  clear(): void {
    this.chunks.clear();
    this.inFlight.clear();
    this.dead.clear();
    this.endedAt.clear();
    this.bytes = 0;
  }
}
