/**
 * The storage seam.
 *
 * Everything above this interface — the game, the prediction maths, the UI — is
 * unaware of where memory lives. `BrowserMemoryStore` is the implementation:
 * a feature encoder, an in-memory matrix and IndexedDB.
 *
 * It was written for a native N-API vector engine writing files on a server,
 * and the note here said that swapping in a backend "for a runtime that cannot
 * load native addons" would mean one new class and one changed factory call.
 * That turned out to be exactly true — the whole port to the browser touched
 * this file not at all.
 */

import type { EpisodeMeta, Recalled } from "./types";

export interface ExportedEpisodes {
  /** Newline-delimited JSON, one `EpisodeMeta` per line. */
  jsonl: string;
  /** Lines actually written out. */
  count: number;
  /** Episodes the vector store reports holding. */
  storeSize: number;
  /**
   * True when `count` is short of `storeSize` — episodes recorded before the
   * log existed cannot be recovered, because this index cannot be reliably
   * enumerated once its vectors cluster tightly.
   */
  partial: boolean;
}

export interface StoreInfo {
  /** `native` when the real vector engine is live. Anything else is degraded. */
  implementation: string;
  dimensions: number;
  model: string;
  storagePath: string;
  initMs: number | null;
}

export interface MemoryStore {
  /**
   * Bring the store up. Safe to call concurrently and repeatedly — every caller
   * awaits the same underlying initialisation.
   */
  init(): Promise<void>;

  /** Persist one episode. Returns the episode id. */
  remember(context: string, meta: EpisodeMeta): Promise<string>;

  /**
   * Find the `k` most similar past situations.
   * `distance` on each result is a cosine distance: lower means more similar.
   */
  recall(context: string, k: number): Promise<Omit<Recalled, "influence">[]>;

  /** Total episodes currently held. */
  size(): Promise<number>;

  /** Wipe all learned memory and start from an empty store. */
  reset(): Promise<void>;

  /**
   * Every episode as newline-delimited JSON, oldest first.
   *
   * This is the portable form of the memory. The vectors are deliberately
   * absent: they are deterministic re-embeddings of `context`, so the metadata
   * alone is enough to rebuild the store on any backend — which is also why it
   * is about 150x smaller than the raw database file.
   */
  exportEpisodes(): Promise<ExportedEpisodes>;

  /** Absolute path to the persisted database file, or null if not file-backed. */
  filePath(): string | null;

  info(): StoreInfo;
}
