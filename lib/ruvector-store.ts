/**
 * RuVector implementation of `MemoryStore`.
 *
 * Server-only. Pulls in a native N-API addon and a WASM ONNX runtime, so this
 * module must never be reachable from a client component, and `ruvector` must
 * stay in `serverExternalPackages` (see `next.config.ts`) or the bundler will
 * try to inline the binaries.
 */

import "server-only";

import fs from "node:fs";
import path from "node:path";
import { OnnxEmbedder, VectorDB, getImplementationType } from "ruvector";

import type { MemoryStore, StoreInfo } from "./memory-store";
import type { EpisodeMeta, Move, Recalled } from "./types";
import { isMove } from "./rps";

const EMBEDDING_DIMENSIONS = 384;
const MODEL_ID = "all-MiniLM-L6-v2";

/** Records which database file is currently live across restarts. */
const POINTER_FILE = "memory-pointer.json";

/** Matches the rotated generations produced by `reset()`. */
const GENERATION_PATTERN = /^rps-memory-\d+\.db$/;

/**
 * `VectorDB` is exported as a const rather than a class declaration, so its
 * instance type has to be recovered rather than named directly.
 */
type VectorDatabase = InstanceType<typeof VectorDB>;

/** Minimal structural types — the package ships its own, these pin what we use. */
interface SearchHit {
  id: string;
  /** Cosine DISTANCE from the query vector. Lower is more similar. */
  score: number;
  metadata?: Record<string, unknown> | null;
}

export interface RuVectorStoreOptions {
  /** Directory holding the database and its pointer file. */
  dataDir: string;
  /** Canonical database filename used whenever nothing has been rotated. */
  fileName: string;
  /** Optional override for the ONNX model cache directory. */
  cacheDir?: string;
}

export class RuVectorStore implements MemoryStore {
  private readonly dataDir: string;
  private readonly canonicalName: string;
  private readonly cacheDir?: string;

  /** Filename currently backing the store. Changes on reset, not on restart. */
  private activeName: string;

  private embedder: OnnxEmbedder | null = null;
  private db: VectorDatabase | null = null;

  /**
   * Shared initialisation promise. Every caller awaits this same instance, so
   * concurrent first requests cannot race into two embedders or two open
   * handles on the same database file.
   */
  private initPromise: Promise<void> | null = null;
  /** In-flight reset, so concurrent callers share one rotation. */
  private resetPromise: Promise<void> | null = null;
  private initMs: number | null = null;

  constructor(options: RuVectorStoreOptions) {
    this.dataDir = options.dataDir;
    this.canonicalName = options.fileName;
    this.activeName = options.fileName;
    this.cacheDir = options.cacheDir;
  }

  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const startedAt = Date.now();

    // The native binding falls back to a silent no-op stub on an unsupported
    // platform: insert() returns fake ids and search() always returns []. The
    // AI would look like it was learning while being permanently blind, so
    // refuse to start rather than serve a convincing fake.
    const implementation = safeImplementationType();
    if (implementation !== "native") {
      throw new Error(
        `RuVector loaded its "${implementation}" implementation instead of the native engine. ` +
          `Vector search would silently return no results. ` +
          `Check that the ruvector-core package for this platform installed correctly.`,
      );
    }

    // The native store will not create intermediate directories itself.
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.activeName = this.resolveActiveName();

    const embedder = new OnnxEmbedder({
      modelId: MODEL_ID,
      normalize: true,
      ...(this.cacheDir ? { cacheDir: this.cacheDir } : {}),
    });

    // First ever run downloads ~23MB from HuggingFace; later runs still pay
    // ~1-3s to load and parse the model into this process.
    await embedder.init();

    this.embedder = embedder;
    this.db = this.openDatabase(this.activeName);
    this.initMs = Date.now() - startedAt;
  }

  /**
   * Work out which database file to open.
   *
   * The pointer file is authoritative. Deliberately no renaming: an earlier
   * version folded a rotated generation back to the canonical name on startup,
   * which renamed the live database out from under an already-running server
   * the moment a second process initialised (`next build` collecting page data
   * was enough to trigger it). A file another process may hold open is never
   * moved — the pointer is followed as found.
   */
  private resolveActiveName(): string {
    const pointerPath = path.join(this.dataDir, POINTER_FILE);
    let pointed = this.canonicalName;

    try {
      const raw = JSON.parse(fs.readFileSync(pointerPath, "utf8")) as { file?: unknown };
      if (typeof raw.file === "string" && isSafeName(raw.file)) pointed = raw.file;
    } catch {
      // No pointer yet, or it is unreadable — the canonical name is correct.
    }

    // A pointer aimed at a file that no longer exists would silently start an
    // empty store under a strange name; fall back to the canonical one.
    if (pointed !== this.canonicalName && !fs.existsSync(path.join(this.dataDir, pointed))) {
      pointed = this.canonicalName;
    }

    this.writePointer(pointed);
    this.cleanupGenerations(pointed);
    return pointed;
  }

  /** Remove rotated files that are no longer the live database. */
  private cleanupGenerations(keep: string): void {
    try {
      for (const entry of fs.readdirSync(this.dataDir)) {
        if (entry !== keep && GENERATION_PATTERN.test(entry)) {
          fs.rmSync(path.join(this.dataDir, entry), { force: true });
        }
      }
    } catch {
      // Cleanup is best-effort; a stale file costs disk, not correctness.
    }
  }

  /**
   * Write the pointer atomically.
   *
   * A torn pointer read back as unparseable JSON would send the next start to
   * the canonical name and appear to lose every episode, so the replacement is
   * staged and renamed into place.
   */
  private writePointer(file: string): void {
    const target = path.join(this.dataDir, POINTER_FILE);
    const staging = `${target}.tmp`;
    try {
      fs.writeFileSync(staging, `${JSON.stringify({ file }, null, 2)}\n`);
      fs.renameSync(staging, target);
    } catch {
      // Losing the pointer only means the next start falls back to canonical.
      fs.rmSync(staging, { force: true });
    }
  }

  private openDatabase(fileName: string): VectorDatabase {
    return new VectorDB({
      dimensions: EMBEDDING_DIMENSIONS,
      storagePath: path.join(this.dataDir, fileName),
      distanceMetric: "cosine",
    });
  }

  private async ready(): Promise<{ embedder: OnnxEmbedder; db: VectorDatabase }> {
    await this.init();
    if (!this.embedder || !this.db) {
      throw new Error("RuVector store is not initialised");
    }
    return { embedder: this.embedder, db: this.db };
  }

  async remember(context: string, meta: EpisodeMeta): Promise<string> {
    const { embedder, db } = await this.ready();
    const vector = await embedder.embed(context);
    return db.insert({
      vector,
      metadata: { ...meta } as Record<string, unknown>,
    });
  }

  async recall(context: string, k: number): Promise<Omit<Recalled, "influence">[]> {
    const { embedder, db } = await this.ready();
    if (k <= 0) return [];

    const vector = await embedder.embed(context);
    const hits = (await db.search({ vector, k })) as unknown as SearchHit[];

    return hits
      .map((hit) => {
        const meta = parseEpisodeMeta(hit.metadata);
        if (!meta) return null;
        return {
          id: hit.id,
          // `score` from the native engine is a cosine distance, not a
          // similarity — everything downstream depends on lower being closer.
          distance: Number.isFinite(hit.score) ? Math.max(hit.score, 0) : 1,
          meta,
        };
      })
      .filter((hit): hit is Omit<Recalled, "influence"> => hit !== null);
  }

  async size(): Promise<number> {
    const { db } = await this.ready();
    return db.len();
  }

  /**
   * Wipe all learned memory by rotating to a brand-new database file.
   *
   * Two simpler approaches were measured and rejected:
   *
   *  - Deleting the file and reopening the same path does nothing. The native
   *    engine keeps process-global state keyed by storage path, so the fresh
   *    handle still reports every old entry.
   *  - Enumerating ids and deleting them individually works on well-spread
   *    vectors but not on real game data: these embeddings sit within ~0.003
   *    cosine of each other, HNSW recall collapses, and the sweep stalls with
   *    episodes still in the index.
   *
   * Rotating to a path this process has never opened is O(1) and cannot fail
   * on recall. `resolveActiveName` folds the generation back to the canonical
   * filename on the next start.
   */
  reset(): Promise<void> {
    // Single-flight. Two concurrent resets would each mint a generation and
    // race on the pointer, orphaning one file and leaving in-flight rounds
    // writing through a handle nobody points at any more.
    this.resetPromise ??= this.doReset().finally(() => {
      this.resetPromise = null;
    });
    return this.resetPromise;
  }

  private async doReset(): Promise<void> {
    await this.ready();

    const previousName = this.activeName;
    const nextName = `rps-memory-${Date.now()}.db`;

    // Order matters. Open and verify the replacement first, commit the pointer
    // second, and only then unlink the old file: a crash at any point leaves
    // either the old store or the new one intact, never a pointer aimed at
    // nothing.
    const next = this.openDatabase(nextName);
    const remaining = await next.len();
    if (remaining > 0) {
      throw new Error(`Reset failed: the new store opened with ${remaining} episodes.`);
    }

    this.db = next;
    this.activeName = nextName;
    this.writePointer(nextName);

    if (previousName !== nextName) {
      fs.rmSync(path.join(this.dataDir, previousName), { force: true });
    }
    this.cleanupGenerations(nextName);
  }

  filePath(): string {
    return path.join(this.dataDir, this.activeName);
  }

  info(): StoreInfo {
    return {
      implementation: safeImplementationType(),
      dimensions: EMBEDDING_DIMENSIONS,
      model: MODEL_ID,
      storagePath: this.filePath(),
      initMs: this.initMs,
    };
  }
}

/** Guard against a tampered pointer file escaping the data directory. */
function isSafeName(name: string): boolean {
  return name.endsWith(".db") && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

function safeImplementationType(): string {
  try {
    return getImplementationType?.() ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Validate metadata coming back out of the store before trusting it. */
function parseEpisodeMeta(raw: unknown): EpisodeMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const nextHumanMove = value.nextHumanMove;
  const aiMove = value.aiMove;
  if (!isMove(nextHumanMove) || !isMove(aiMove)) return null;

  const aiOutcome = value.aiOutcome;
  if (aiOutcome !== "win" && aiOutcome !== "loss" && aiOutcome !== "draw") return null;

  return {
    context: typeof value.context === "string" ? value.context : "",
    nextHumanMove: nextHumanMove as Move,
    aiMove: aiMove as Move,
    aiOutcome,
    historyTail: typeof value.historyTail === "string" ? value.historyTail : "",
    seq: toFiniteNumber(value.seq),
    round: toFiniteNumber(value.round),
    ts: toFiniteNumber(value.ts),
  };
}

function toFiniteNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
