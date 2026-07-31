/**
 * `MemoryStore` for the browser.
 *
 * The interface this satisfies was written with exactly this swap in mind —
 * see the note in `memory-store.ts` about backends "for a runtime that cannot
 * load native addons". Everything above the seam (the engine, the prediction
 * maths, the UI) is untouched; only what sits underneath changed, from a
 * native vector engine writing files to a plain array and IndexedDB.
 *
 * Three things are deliberately absent, and each one was in an earlier draft:
 *
 *   - **No model.** `feature-embed` reads the context codes directly, so there
 *     is nothing to download. The transformer this replaced was 86MB, had to
 *     be split across five files to clear a hosting limit, and cost ~317ms per
 *     round; this costs about 0.01ms.
 *   - **No web worker.** One existed to keep the model load off the main
 *     thread. With no model to load and encoding this cheap, it was pure
 *     message-passing overhead.
 *   - **No stored vectors.** Only metadata is persisted, and the matrix is
 *     rebuilt by re-encoding on load. That is sound because encoding is
 *     deterministic — the same reason the export format has always been
 *     metadata-only — and it removes a whole class of bug where the vector
 *     blob and the episode list drift out of step.
 */

import { FEATURE_DIMENSIONS, FEATURE_MODEL_ID, embedContext } from "./feature-embed";
import type { ExportedEpisodes, MemoryStore, StoreInfo } from "./memory-store";
import { EMPTY_TALLY, type MoveTally, observeMove, tallyOf } from "./prior";
import type { EpisodeMeta, Recalled } from "./types";

const DB_NAME = "rps-memory";
const DB_VERSION = 1;
const STORE = "episodes";

/**
 * Ceiling on retained episodes. Not a space concern — 5000 rows is about a
 * megabyte — it just bounds the cosine pass so ancient history cannot slow
 * every future round. Oldest are dropped first.
 */
const MAX_EPISODES = 5000;

interface StoredEpisode {
  id: string;
  meta: EpisodeMeta;
}

export class BrowserMemoryStore implements MemoryStore {
  private db: IDBDatabase | null = null;
  private ready: Promise<void> | null = null;

  /** Row-major [episode][dimension], the working set for search. */
  private matrix = new Float32Array(0);
  private rows = 0;
  private episodes: StoredEpisode[] = [];
  private seq = 0;
  private tally: MoveTally = EMPTY_TALLY;
  private initMs: number | null = null;

  /* ------------------------------------------------------------ lifecycle */

  init(): Promise<void> {
    // Memoised so concurrent callers share one open rather than racing.
    this.ready ??= this.open().catch((error: unknown) => {
      // Drop the memo so a transient failure can be retried instead of
      // poisoning the store for the life of the page.
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private async open(): Promise<void> {
    const started = performance.now();

    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
    });

    const stored = await this.tx<StoredEpisode[]>("readonly", (s) => s.getAll());
    this.episodes = (stored ?? []).sort((a, b) => a.meta.seq - b.meta.seq);
    this.seq = this.episodes.length
      ? this.episodes[this.episodes.length - 1].meta.seq + 1
      : 0;

    this.matrix = new Float32Array(this.episodes.length * FEATURE_DIMENSIONS);
    this.episodes.forEach((episode, i) => {
      this.matrix.set(embedContext(episode.meta.context), i * FEATURE_DIMENSIONS);
    });
    this.rows = this.episodes.length;

    // Replayed in order rather than persisted, for the same reason the matrix
    // is: it is a pure function of the episode list, so recomputing it removes
    // any way for a stored summary to drift out of step with the episodes it
    // claims to summarise.
    this.tally = tallyOf(this.episodes.map((episode) => episode.meta.nextHumanMove));

    this.initMs = Math.round(performance.now() - started);
  }

  private tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
      if (!this.db) return reject(new Error("store not open"));
      const request = run(this.db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
    });
  }

  /* ---------------------------------------------------------------- write */

  async remember(context: string, meta: EpisodeMeta): Promise<string> {
    await this.init();
    const stamped: EpisodeMeta = { ...meta, seq: this.seq++ };
    const id = `ep-${stamped.seq}-${stamped.ts}`;

    this.ensureCapacity(this.rows + 1);
    this.matrix.set(embedContext(context), this.rows * FEATURE_DIMENSIONS);
    this.rows++;
    this.episodes.push({ id, meta: stamped });
    // No matching adjustment in `trim()`: the tally decays exponentially, so an
    // episode old enough to be evicted has already decayed to nothing.
    this.tally = observeMove(this.tally, stamped.nextHumanMove);

    // One small write per episode. An earlier version rewrote the entire
    // vector matrix here, which is quadratic disk traffic over a session.
    await this.tx("readwrite", (s) => s.put({ id, meta: stamped }));

    if (this.rows > MAX_EPISODES) await this.trim();
    return id;
  }

  private ensureCapacity(needed: number) {
    const required = needed * FEATURE_DIMENSIONS;
    if (this.matrix.length >= required) return;
    // Grow by doubling so appending stays amortised constant.
    const grown = new Float32Array(Math.max(required, this.matrix.length * 2 || required));
    grown.set(this.matrix);
    this.matrix = grown;
  }

  private async trim() {
    const drop = this.rows - MAX_EPISODES;
    this.matrix = this.matrix.slice(drop * FEATURE_DIMENSIONS);
    this.rows -= drop;
    const removed = this.episodes.splice(0, drop);
    // Delete only the evicted keys; the survivors are not rewritten.
    for (const gone of removed) {
      await this.tx("readwrite", (s) => s.delete(gone.id)).catch(() => undefined);
    }
  }

  /* ----------------------------------------------------------------- read */

  async recall(context: string, k: number): Promise<Omit<Recalled, "influence">[]> {
    await this.init();
    if (this.rows === 0) return [];

    const query = embedContext(context);
    const scored: { index: number; distance: number }[] = [];

    // Exact, not approximate. The server used an HNSW index; at the scale one
    // player reaches, scanning every row is well under a millisecond and
    // returns the true nearest neighbours rather than an estimate of them.
    // Vectors are L2-normalised, so the dot product is the cosine directly.
    for (let row = 0; row < this.rows; row++) {
      const base = row * FEATURE_DIMENSIONS;
      let dot = 0;
      for (let d = 0; d < FEATURE_DIMENSIONS; d++) dot += query[d] * this.matrix[base + d];
      scored.push({ index: row, distance: 1 - dot });
    }

    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, k).map(({ index, distance }) => ({
      id: this.episodes[index].id,
      distance,
      meta: this.episodes[index].meta,
    }));
  }

  async size(): Promise<number> {
    await this.init();
    return this.rows;
  }

  async currentSeq(): Promise<number> {
    await this.init();
    return this.seq;
  }

  async moveTally(): Promise<MoveTally> {
    await this.init();
    return this.tally;
  }

  async reset(): Promise<void> {
    await this.init();
    this.matrix = new Float32Array(0);
    this.rows = 0;
    this.episodes = [];
    this.seq = 0;
    this.tally = EMPTY_TALLY;
    await this.tx("readwrite", (s) => s.clear());
  }

  async exportEpisodes(): Promise<ExportedEpisodes> {
    await this.init();
    const jsonl = this.episodes.map((e) => JSON.stringify(e.meta)).join("\n");
    return {
      jsonl,
      count: this.episodes.length,
      storeSize: this.rows,
      // Every episode is enumerable here, unlike the vector index this
      // replaced, so an export is never short.
      partial: false,
    };
  }

  /** Nothing is file-backed in a browser. */
  filePath(): string | null {
    return null;
  }

  info(): StoreInfo {
    return {
      implementation: "browser",
      dimensions: FEATURE_DIMENSIONS,
      model: FEATURE_MODEL_ID,
      storagePath: `IndexedDB · ${DB_NAME}`,
      initMs: this.initMs,
    };
  }
}
