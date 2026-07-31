/**
 * Orchestration layer: owns the process-wide memory store and drives the two
 * halves of a round — commit, then resolve. Server-only.
 */

import "server-only";

import path from "node:path";

import {
  BOOTSTRAP_ROUNDS,
  MIN_MEMORY_FOR_ADAPTIVE,
  NEIGHBORS_RETURNED,
  RECALL_K,
} from "./config";
import {
  commitmentHash,
  expiryFrom,
  getSessionState,
  newId,
  newNonce,
  putCommit,
  setSessionIntegral,
  takeCommit,
} from "./commit";
import { RuVectorStore } from "./ruvector-store";
import type { MemoryStore } from "./memory-store";
import { aggregate, decide, moveFor } from "./predict";
import { decideIntent } from "./score-control";
import {
  buildContext,
  historyTail,
  invertOutcome,
  isMove,
  judge,
  randomMove,
} from "./rps";
import type {
  CommitResponse,
  Intent,
  Mode,
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

export interface CommitRequest {
  sessionId: string;
  mode: Mode;
  /** True when the player has the reveal panel open. */
  revealed: boolean;
  /** Chronological, oldest first. */
  history: HistoryEntry[];
  round: number;
}

export interface ResolveRequest {
  sessionId: string;
  commitId: string;
  humanMove: Move;
}

export class CommitmentError extends Error {
  constructor(readonly code: "unknown" | "expired" | "superseded" | "stale-memory") {
    super(
      code === "stale-memory"
        ? "The AI's memory was reset after it locked in this move."
        : "That committed move is no longer valid.",
    );
    this.name = "CommitmentError";
  }
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
 * Identifies the current database generation. Changes on reset, which lets a
 * commitment made against the old memory be rejected rather than silently
 * recorded into the new one.
 */
export function memoryGeneration(): string {
  return path.basename(getStore().filePath() ?? DB_FILENAME);
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
 * Lock in the AI's move for the next round, before the human throws.
 *
 * This is the whole point of the two-phase design: the prediction never had
 * access to the human's move anyway, and now it demonstrably could not have.
 */
export async function commitRound(request: CommitRequest): Promise<CommitResponse> {
  await warmup();
  const error = warmupError();
  if (error) throw new Error(error);

  const store = getStore();
  const { sessionId, mode, revealed, history, round } = request;

  const humanMoves = history.map((entry) => entry.humanMove);
  const aiMoves = history.map((entry) => entry.aiMove);
  const outcomes = history.map((entry) => entry.outcome);

  const context = buildContext({ humanMoves, aiMoves, outcomes });
  const tail = historyTail(humanMoves);
  const memorySize = await store.size();

  const { reasoning, aiMove, nextIntegral } = await think({
    store,
    context,
    tail,
    memorySize,
    historyLength: history.length,
    mode,
    revealed,
    sessionId,
    history,
  });

  const now = Date.now();
  const nonce = newNonce();
  const commitId = newId();
  const hash = commitmentHash(aiMove, nonce);

  putCommit({
    commitId,
    sessionId,
    nonce,
    hash,
    aiMove,
    intent: reasoning.intent,
    reasoning,
    context,
    tail,
    seq: memorySize,
    round,
    memoryGen: memoryGeneration(),
    integral: nextIntegral,
    createdAt: now,
    expiresAt: expiryFrom(now),
  });

  return {
    commitId,
    hash,
    expiresAt: expiryFrom(now),
    round,
    memorySize,
    mode,
    // Only disclosed when the player has asked to see it, so an ordinary game
    // cannot be spoiled by glancing at the network tab.
    reveal: revealed ? { aiMove, reasoning } : null,
  };
}

/**
 * Open a commitment against the human's throw: resolve, record, and hand back
 * the nonce so the client can verify the hash it was shown earlier.
 */
export async function resolveRound(request: ResolveRequest): Promise<RoundResponse> {
  await warmup();
  const error = warmupError();
  if (error) throw new Error(error);

  const { sessionId, commitId, humanMove } = request;
  const taken = takeCommit(commitId, sessionId);
  if (!taken.ok) throw new CommitmentError(taken.reason);

  const commit = taken.commit;
  if (commit.memoryGen !== memoryGeneration()) {
    throw new CommitmentError("stale-memory");
  }

  const store = getStore();
  const outcome = judge(humanMove, commit.aiMove);

  // Learn only from what actually happened. `seq` is the store size at commit
  // time, giving every episode a monotonic age for recency decay.
  await store.remember(commit.context, {
    context: commit.context,
    nextHumanMove: humanMove,
    aiMove: commit.aiMove,
    aiOutcome: invertOutcome(outcome),
    historyTail: commit.tail,
    seq: commit.seq,
    round: commit.round,
    ts: Date.now(),
  });

  setSessionIntegral(sessionId, commit.integral);

  return {
    humanMove,
    aiMove: commit.aiMove,
    outcome,
    reasoning: commit.reasoning,
    memorySize: commit.seq + 1,
    round: commit.round,
    commitId,
    hash: commit.hash,
    nonce: commit.nonce,
  };
}

interface ThinkArgs {
  store: MemoryStore;
  context: string;
  tail: string;
  memorySize: number;
  historyLength: number;
  mode: Mode;
  revealed: boolean;
  sessionId: string;
  history: HistoryEntry[];
}

interface ThinkResult {
  reasoning: Reasoning;
  aiMove: Move;
  nextIntegral: number;
}

/** Decide how the AI plays this round — bootstrap throw or memory-driven read. */
async function think({
  store,
  context,
  tail,
  memorySize,
  historyLength,
  mode,
  revealed,
  sessionId,
  history,
}: ThinkArgs): Promise<ThinkResult> {
  const bootstrapping =
    historyLength < BOOTSTRAP_ROUNDS || memorySize < MIN_MEMORY_FOR_ADAPTIVE;

  if (bootstrapping) {
    const reasoning = bootstrapReasoning(context);
    return { reasoning, aiMove: randomMove(), nextIntegral: 0 };
  }

  // Asking for more neighbours than exist just wastes work, and early on it
  // would also hand the same few episodes back repeatedly as if independent.
  const k = Math.max(1, Math.min(RECALL_K, memorySize));
  const recalled = await store.recall(context, k);

  if (recalled.length === 0) {
    const reasoning = bootstrapReasoning(context);
    return { reasoning, aiMove: randomMove(), nextIntegral: 0 };
  }

  const aggregated = aggregate(
    recalled.map((episode) => ({ ...episode, influence: 0 })),
    memorySize,
    tail,
    memorySize,
  );

  const { error, humanWinStreak } = scoreFrom(history);
  const decision = decideIntent({
    mode,
    error,
    integral: getSessionState(sessionId).integral,
    confidence: aggregated.confidence,
    revealed,
    humanWinStreak,
    roll: Math.random(),
  });

  const reasoning = decide(
    aggregated,
    decision.intent,
    context,
    NEIGHBORS_RETURNED,
    decision.control,
  );

  return {
    reasoning,
    aiMove: moveFor(reasoning),
    nextIntegral: decision.nextIntegral,
  };
}

/** Score error from the AI's perspective, plus the human's current win run. */
function scoreFrom(history: HistoryEntry[]): { error: number; humanWinStreak: number } {
  let human = 0;
  let ai = 0;
  for (const entry of history) {
    if (entry.outcome === "win") human++;
    else if (entry.outcome === "loss") ai++;
  }

  let humanWinStreak = 0;
  for (let i = history.length - 1; i >= 0 && history[i].outcome === "win"; i--) {
    humanWinStreak++;
  }

  return { error: ai - human, humanWinStreak };
}

function bootstrapReasoning(context: string): Reasoning {
  return {
    mode: "bootstrap",
    context,
    predictedHuman: null,
    playedAgainst: null,
    intent: "win" as Intent,
    distribution: { rock: 0, paper: 0, scissors: 0 },
    confidence: 0,
    neighbors: 0,
    meanDistance: 0,
    effectiveN: 0,
    margin: 0,
    explored: true,
    topNeighbors: [],
    control: null,
  };
}

export async function resetMemory(): Promise<void> {
  await warmup();
  const error = warmupError();
  if (error) throw new Error(error);
  await getStore().reset();
}
