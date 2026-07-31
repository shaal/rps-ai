/**
 * Core domain types shared between the pure game logic, the memory layer,
 * the API routes and the client UI.
 */

export type Move = "rock" | "paper" | "scissors";

/** A round result. Always documented from an explicitly named perspective. */
export type Outcome = "win" | "loss" | "draw";

/**
 * What the AI is steering the SCORE toward. This is not a difficulty dial —
 * the prediction runs at full strength in every mode. Only what the AI does
 * with a correct read changes.
 */
export type Mode = "dominate" | "level" | "yield";

/** What the AI is trying to make happen this round, given its read. */
export type Intent = "win" | "draw" | "lose";

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

/** Why the score controller chose the intent it did. */
export interface ControlState {
  /** Current AI score minus human score. */
  error: number;
  /** Accumulated error, so a persistent deficit eventually forces a correction. */
  integral: number;
  /**
   * True when the controller has deliberately stopped steering — either the
   * read is too weak to act on, or the player can see the AI's hand and
   * steering would just escalate pointlessly.
   */
  frozen: boolean;
  /** Short human-readable reason, shown in the UI. */
  note: string;
}

/** Everything the AI worked out for one round, surfaced to the UI verbatim. */
export interface Reasoning {
  mode: AiMode;
  /** The context string the AI actually embedded. Shown in the memory panel. */
  context: string;
  /** Which human move the AI expected. Null while bootstrapping. */
  predictedHuman: Move | null;
  /**
   * The move the AI actually played against, sampled from the distribution.
   * Differs from `predictedHuman` when sampling picked an underdog, and is
   * null when the AI threw at random.
   */
  playedAgainst: Move | null;
  /** What the AI was trying to make happen, given its read. */
  intent: Intent;
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
  /**
   * Share of the distribution taken from this player's base rate rather than
   * from recalled episodes. Rises as confidence in the neighbourhood falls; at
   * 1 the AI is playing the odds rather than a read. See `lib/prior.ts`.
   *
   * Describes the memory expert's own vote, before the committee weighs in.
   */
  priorWeight: number;
  /**
   * Each predictor's share of the final vote, keyed by expert name and summing
   * to 1. Empty while bootstrapping. See `lib/experts.ts`.
   */
  contributions: Record<string, number>;
  /** True when the AI deliberately threw a random move instead of acting on its read. */
  explored: boolean;
  /** The closest episodes, for the "what the AI remembered" panel. */
  topNeighbors: Recalled[];
  /** Present only for the score-steering modes. */
  control: ControlState | null;
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
  intent: Intent;
  /** Whether the client recomputed the commitment hash and it matched. */
  verified: boolean;
  ts: number;
}

/** What the AI committed to, disclosed early because the player asked to see it. */
export interface RevealPayload {
  /** The move the AI has already locked in for this round. */
  aiMove: Move;
  reasoning: Reasoning;
}

/**
 * What `commitRound` hands back. Hash-only, deliberately.
 *
 * Disclosure goes through `peekRound`, which reads the same sealed commitment
 * rather than minting a new one — so switching to Foresight can never re-roll
 * the AI's move or invalidate a hash already on screen. These were HTTP
 * response bodies when the engine ran on a server; they are plain return types
 * now, and the shapes were worth keeping intact.
 */
export interface CommitResponse {
  commitId: string;
  /** `sha256(aiMove + ":" + nonce)`. Verifiable after the round resolves. */
  hash: string;
  expiresAt: number;
  round: number;
  memorySize: number;
  mode: Mode;
}

/** What `peekRound` hands back. */
export interface PeekResponse extends RevealPayload {
  /** Echoed so the client can tell which commitment this disclosure describes. */
  commitId: string;
  round: number;
}

/** What `resolveRound` hands back. */
export interface RoundResponse {
  humanMove: Move;
  aiMove: Move;
  /** From the human's perspective. */
  outcome: Outcome;
  reasoning: Reasoning;
  /** Total episodes held in memory after this round was recorded. */
  memorySize: number;
  round: number;
  /** The commitment being opened, so the client can verify it itself. */
  commitId: string;
  hash: string;
  nonce: string;
}

/** What `getStatus` hands back. */
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
