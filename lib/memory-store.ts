/**
 * The storage seam.
 *
 * Everything above this interface — the game, the prediction math, the API
 * routes — is unaware of RuVector. `RuVectorStore` is the real implementation
 * (native N-API vector engine + local ONNX embeddings, persisted to a file on
 * disk). Swapping in a different backend, for a runtime that cannot load native
 * addons, means writing one more class against this interface and changing the
 * single factory call in `lib/engine.ts`.
 */

import type { EpisodeMeta, Recalled } from "./types";

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

  /** Absolute path to the persisted database file, or null if not file-backed. */
  filePath(): string | null;

  info(): StoreInfo;
}
