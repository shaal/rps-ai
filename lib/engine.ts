/**
 * Orchestration layer: owns the process-wide memory store and runs one round
 * of the adaptive loop. Server-only.
 */

import "server-only";

import path from "node:path";

import {
  BOOTSTRAP_ROUNDS,
  MIN_MEMORY_FOR_ADAPTIVE,
  NEIGHBORS_RETURNED,
  RECALL_K,
} from "./config";
import { RuVectorStore } from "./ruvector-store";
import type { MemoryStore } from "./memory-store";
import { aggregate, decide, moveFor } from "./predict";
import {
  buildContext,
  historyTail,
  invertOutcome,
  isMove,
  judge,
  randomMove,
} from "./rps";
import type {
  Difficulty,
  Move,
  Outcome,
  Reasoning,
  RoundResponse,
  StatusResponse,
} from "./types";

/** Hard cap on client-supplied history, so a bad request cannot blow up memory. */
const MAX_HISTORY = 32;

/** Persistent memory lives inside the project so it survives server restarts. */
export const DATA_DIR = path.join(process.cwd(), "data");
export const DB_FILENAME = "rps-memory.db";

/** One entry of the recent history the client replays to the server each round. */
export interface HistoryEntry {
  humanMove: Move;
  aiMove: Move;
  /** From the human's perspective. */
  outcome: Outcome;
}

export interface PlayRequest {
  humanMove: Move;
  difficulty: Difficulty;
  /** Chronological, oldest first, NOT including the move being played now. */
  history: HistoryEntry[];
  round: number;
}

/**
 * Hot-reload-safe singleton.
 *
 * Next.js dev re-evaluates modules on edit; without pinning to globalThis each
 * reload would build another embedder (3s and ~100MB) and open a second handle
 * on the same database file.
 */
const globalForStore = globalThis as unknown as {
  __rpsStore?: MemoryStore;
  __rpsWarmup?: Promise<void>;
  __rpsError?: string | null;
};

export function getStore(): MemoryStore {
  globalForStore.__rpsStore ??= new RuVectorStore({
    dataDir: DATA_DIR,
    fileName: DB_FILENAME,
  });
  return globalForStore.__rpsStore;
}

/** Absolute path of the database file currently backing the store. */
export function memoryFilePath(): string | null {
  return getStore().filePath();
}

/**
 * Begin initialisation without blocking the caller.
 *
 * Every consumer awaits this same promise, so concurrent first requests cannot
 * race into two embedders. Failures are captured rather than thrown so an
 * unhandled rejection cannot take down the process.
 */
export function warmup(): Promise<void> {
  // `next build` evaluates route and page modules to collect page data. Warming
  // up there would load the ONNX model into every build worker and touch the
  // data directory while a dev server may be holding it.
  if (process.env.NEXT_PHASE === "phase-production-build") return Promise.resolve();

  globalForStore.__rpsWarmup ??= getStore()
    .init()
    .then(() => {
      globalForStore.__rpsError = null;
    })
    .catch((error: unknown) => {
      globalForStore.__rpsError = error instanceof Error ? error.message : String(error);
    });
  return globalForStore.__rpsWarmup;
}

export function warmupError(): string | null {
  return globalForStore.__rpsError ?? null;
}

export function isWarm(): boolean {
  return globalForStore.__rpsWarmup !== undefined && getStore().info().initMs !== null;
}

export async function getStatus(): Promise<StatusResponse> {
  const store = getStore();
  warmup();

  const error = warmupError();
  const info = store.info();
  const ready = info.initMs !== null && !error;

  let memorySize = 0;
  if (ready) {
    try {
      memorySize = await store.size();
    } catch {
      memorySize = 0;
    }
  }

  return {
    ready,
    warming: !ready && !error,
    error,
    memorySize,
    implementation: info.implementation,
    dimensions: info.dimensions,
    model: info.model,
    storagePath: info.storagePath,
    initMs: info.initMs,
  };
}

/** Trim and validate history arriving from the client. */
export function sanitizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is HistoryEntry => {
      if (!entry || typeof entry !== "object") return false;
      const value = entry as Record<string, unknown>;
      return (
        isMove(value.humanMove) &&
        isMove(value.aiMove) &&
        (value.outcome === "win" || value.outcome === "loss" || value.outcome === "draw")
      );
    })
    .slice(-MAX_HISTORY);
}

/**
 * Play one round: predict, resolve, then record the episode.
 *
 * Prediction runs against the history ending BEFORE `humanMove`, which is the
 * whole point — embedding the move we are trying to predict would leak the
 * answer into the query and make the AI look clairvoyant for the wrong reason.
 */
export async function playRound(request: PlayRequest): Promise<RoundResponse> {
  await warmup();
  const error = warmupError();
  if (error) throw new Error(error);

  const store = getStore();
  const { humanMove, difficulty, history, round } = request;

  const humanMoves = history.map((entry) => entry.humanMove);
  const aiMoves = history.map((entry) => entry.aiMove);
  const outcomes = history.map((entry) => entry.outcome);

  const context = buildContext({ humanMoves, aiMoves, outcomes });
  const tail = historyTail(humanMoves);
  const memorySize = await store.size();

  const reasoning = await think({
    store,
    context,
    tail,
    memorySize,
    historyLength: history.length,
    difficulty,
  });

  const aiMove = moveFor(reasoning);
  const outcome = judge(humanMove, aiMove);

  // Learn only from what actually happened. `seq` is the pre-insert store size,
  // giving every episode a monotonic age for recency decay.
  await store.remember(context, {
    context,
    nextHumanMove: humanMove,
    aiMove,
    aiOutcome: invertOutcome(outcome),
    historyTail: tail,
    seq: memorySize,
    round,
    ts: Date.now(),
  });

  return {
    humanMove,
    aiMove,
    outcome,
    reasoning,
    memorySize: memorySize + 1,
    round,
  };
}

interface ThinkArgs {
  store: MemoryStore;
  context: string;
  tail: string;
  memorySize: number;
  historyLength: number;
  difficulty: Difficulty;
}

/** Decide how the AI plays this round — bootstrap throw or memory-driven read. */
async function think({
  store,
  context,
  tail,
  memorySize,
  historyLength,
  difficulty,
}: ThinkArgs): Promise<Reasoning> {
  const bootstrapping =
    historyLength < BOOTSTRAP_ROUNDS || memorySize < MIN_MEMORY_FOR_ADAPTIVE;

  if (bootstrapping) return bootstrapReasoning(context);

  // Asking for more neighbours than exist just wastes work, and early on it
  // would also hand the same few episodes back repeatedly as if independent.
  const k = Math.max(1, Math.min(RECALL_K, memorySize));
  const recalled = await store.recall(context, k);

  if (recalled.length === 0) return bootstrapReasoning(context);

  const aggregated = aggregate(
    recalled.map((episode) => ({ ...episode, influence: 0 })),
    memorySize,
    tail,
    memorySize,
  );

  return decide(aggregated, difficulty, context, NEIGHBORS_RETURNED);
}

function bootstrapReasoning(context: string): Reasoning {
  return {
    mode: "bootstrap",
    context,
    predictedHuman: null,
    playedAgainst: null,
    distribution: { rock: 0, paper: 0, scissors: 0 },
    confidence: 0,
    neighbors: 0,
    meanDistance: 0,
    effectiveN: 0,
    margin: 0,
    explored: true,
    topNeighbors: [],
  };
}

/** Exposed for the bootstrap path and for tests. */
export function bootstrapMove(): Move {
  return randomMove();
}

export async function resetMemory(): Promise<void> {
  await warmup();
  const error = warmupError();
  if (error) throw new Error(error);
  await getStore().reset();
}
