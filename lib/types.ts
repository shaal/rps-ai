/**
 * Core domain types shared between the pure game logic, the memory layer,
 * the API routes and the client UI.
 */

export type Move = "rock" | "paper" | "scissors";

/** A round result. Always documented from an explicitly named perspective. */
export type Outcome = "win" | "loss" | "draw";

/** How aggressively the AI exploits what it has learned. */
export type Difficulty = "casual" | "rival" | "ruthless";

/** `bootstrap` = still cold-starting, `adaptive` = predicting from memory. */
export type AiMode = "bootstrap" | "adaptive";

/**
 * One episode as persisted in the vector store.
 *
 * The embedded vector is derived from `context` alone; everything in here is
 * metadata carried alongside it. `nextHumanMove` is the label we are learning:
 * "in a situation that looked like `context`, the human went on to play this".
 */
export interface EpisodeMeta {
  /** High-contrast context string that was embedded (history BEFORE the move). */
  context: string;
  /** What the human actually played next. The supervised label. */
  nextHumanMove: Move;
  /** What the AI played that round. */
  aiMove: Move;
  /** Outcome from the AI's perspective. */
  aiOutcome: Outcome;
  /** Last N human moves as a compact code (e.g. "PRPS"), for hybrid re-ranking. */
  historyTail: string;
  /** Monotonic index across every episode ever stored. Drives recency decay. */
  seq: number;
  /** Round number within the session that produced it. Display only. */
  round: number;
  /** Epoch milliseconds. */
  ts: number;
}

/** A single episode returned from a similarity search. */
export interface Recalled {
  id: string;
  /** Cosine DISTANCE — lower means more similar. Never a similarity score. */
  distance: number;
  meta: EpisodeMeta;
  /** Post-hoc share of the total vote this episode contributed, in [0,1]. */
  influence: number;
}

/** Everything the AI worked out for one round, surfaced to the UI verbatim. */
export interface Reasoning {
  mode: AiMode;
  /** The context string the AI actually embedded. Shown in the memory panel. */
  context: string;
  /**
   * The AI's actual best read — the highest-weighted human move. Null while
   * bootstrapping. This is what "read rate" is scored against, whether or not
   * the AI chose to act on it.
   */
  predictedHuman: Move | null;
  /**
   * The move the AI actually countered, sampled from the distribution. Differs
   * from `predictedHuman` when sampling picked an underdog, and is null when
   * the AI threw at random instead.
   */
  playedAgainst: Move | null;
  /** Normalised probability the AI assigned to each human move. */
  distribution: Record<Move, number>;
  /** Composite honest confidence in [0,1]. See `lib/predict.ts` for the formula. */
  confidence: number;
  /** How many similar episodes came back from the vector search. */
  neighbors: number;
  /** Weighted mean cosine distance of the episodes backing the winning move. */
  meanDistance: number;
  /** Effective sample size of the weighted vote — guards against one-memory flukes. */
  effectiveN: number;
  /** How decisively the winning move beat the runner-up, in [0,1]. */
  margin: number;
  /** True when the AI deliberately threw a random move instead of exploiting. */
  explored: boolean;
  /** The closest episodes, for the "what the AI remembered" panel. */
  topNeighbors: Recalled[];
}

/** One completed round, as tracked by the client for history and stats. */
export interface RoundRecord {
  round: number;
  humanMove: Move;
  aiMove: Move;
  /** Outcome from the HUMAN's perspective — this is what the UI shows. */
  outcome: Outcome;
  predictedHuman: Move | null;
  /** Null while bootstrapping, otherwise whether the prediction was right. */
  predictionCorrect: boolean | null;
  confidence: number;
  neighbors: number;
  mode: AiMode;
  ts: number;
}

/** Response body of `POST /api/round`. */
export interface RoundResponse {
  humanMove: Move;
  aiMove: Move;
  /** From the human's perspective. */
  outcome: Outcome;
  reasoning: Reasoning;
  /** Total episodes held in the vector store after this round was recorded. */
  memorySize: number;
  round: number;
}

/** Response body of `GET /api/status`. */
export interface StatusResponse {
  ready: boolean;
  warming: boolean;
  error: string | null;
  memorySize: number;
  /** `native` when the real vector engine is live. Anything else is degraded. */
  implementation: string;
  dimensions: number;
  model: string;
  storagePath: string;
  /** Milliseconds the embedder took to initialise, once known. */
  initMs: number | null;
}
