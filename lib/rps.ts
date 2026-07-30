/**
 * Pure Rock-Paper-Scissors logic. No I/O, no vector store, no React — every
 * function here is deterministic and independently testable.
 */

import type { Move, Outcome } from "./types";

export const MOVES: readonly Move[] = ["rock", "paper", "scissors"] as const;

/** `BEATS[a]` is the move that `a` defeats. */
export const BEATS: Record<Move, Move> = {
  rock: "scissors",
  paper: "rock",
  scissors: "paper",
};

/** Single-letter codes keep the embedded context string dense and contrastive. */
export const MOVE_CODE: Record<Move, string> = {
  rock: "R",
  paper: "P",
  scissors: "S",
};

const CODE_TO_MOVE: Record<string, Move> = {
  R: "rock",
  P: "paper",
  S: "scissors",
};

const OUTCOME_CODE: Record<Outcome, string> = {
  win: "W",
  loss: "L",
  draw: "D",
};

/** How many recent human moves feed the context string. */
export const CONTEXT_WINDOW = 6;
/** How many recent AI moves feed the context string. */
export const AI_CONTEXT_WINDOW = 4;
/** Length of the compact tail code used for hybrid re-ranking. */
export const TAIL_LENGTH = 4;

export function isMove(value: unknown): value is Move {
  return typeof value === "string" && (MOVES as readonly string[]).includes(value);
}

export function codeToMove(code: string): Move | null {
  return CODE_TO_MOVE[code] ?? null;
}

/** The move that defeats `move` — i.e. what the AI should play to counter it. */
export function counter(move: Move): Move {
  const found = MOVES.find((candidate) => BEATS[candidate] === move);
  // Every move is beaten by exactly one other, so this is total.
  return found as Move;
}

/** Judge a round from the HUMAN's perspective. */
export function judge(humanMove: Move, aiMove: Move): Outcome {
  if (humanMove === aiMove) return "draw";
  return BEATS[humanMove] === aiMove ? "win" : "loss";
}

/** Flip an outcome to the opposing perspective. Draws are symmetric. */
export function invertOutcome(outcome: Outcome): Outcome {
  if (outcome === "draw") return "draw";
  return outcome === "win" ? "loss" : "win";
}

export function randomMove(): Move {
  return MOVES[Math.floor(Math.random() * MOVES.length)];
}

/** Trailing run of identical moves, e.g. [R,P,P,P] -> { move: paper, length: 3 }. */
export function detectStreak(moves: Move[]): { move: Move; length: number } | null {
  if (moves.length === 0) return null;
  const move = moves[moves.length - 1];
  let length = 1;
  for (let i = moves.length - 2; i >= 0 && moves[i] === move; i--) length++;
  return { move, length };
}

/** Compact code of the last `n` human moves, oldest first, e.g. "PRPS". */
export function historyTail(humanMoves: Move[], n: number = TAIL_LENGTH): string {
  return humanMoves
    .slice(-n)
    .map((move) => MOVE_CODE[move])
    .join("");
}

/**
 * How strongly two tails agree on their most recent moves, in [0,1].
 *
 * Compared from the right (most recent) backwards and stopped at the first
 * mismatch, so "PRPS" vs "SRPS" scores 0.75 while "PRPS" vs "PRPR" scores 0 —
 * what happened last round matters far more than what happened four ago.
 */
export function trailingMatchScore(a: string, b: string): number {
  const span = Math.min(a.length, b.length, TAIL_LENGTH);
  if (span === 0) return 0;
  let matched = 0;
  for (let i = 1; i <= span; i++) {
    if (a[a.length - i] !== b[b.length - i]) break;
    matched++;
  }
  return matched / TAIL_LENGTH;
}

export interface ContextInput {
  /** Chronological, oldest first. */
  humanMoves: Move[];
  /** Chronological, oldest first. */
  aiMoves: Move[];
  /** Chronological, oldest first, from the HUMAN's perspective. */
  outcomes: Outcome[];
}

/**
 * Turn recent history into the string that gets embedded.
 *
 * Deliberately NOT natural prose. A sentence-transformer maps near-identical
 * English templates into a very tight cosine ball, which flattens the distance
 * signal until inverse-distance weighting is weighting noise. Dense coded slots
 * maximise lexical contrast between differing situations, so the retrieved
 * neighbours actually rank by strategic similarity. It also happens to read
 * well in a monospace panel, which is why the UI shows it raw.
 *
 * Shape: `H:R>P>P>S A:S>S>P>R st:S1 out:L,W,D bg:RP,PP,PS fq:R1P2S1`
 *
 * Note the round number is intentionally absent: it is unique per episode and
 * would inject pure noise into the similarity space.
 */
export function buildContext({ humanMoves, aiMoves, outcomes }: ContextInput): string {
  const human = humanMoves.slice(-CONTEXT_WINDOW);
  const ai = aiMoves.slice(-AI_CONTEXT_WINDOW);
  const recentOutcomes = outcomes.slice(-3);

  const humanPart = human.length ? human.map((m) => MOVE_CODE[m]).join(">") : "-";
  const aiPart = ai.length ? ai.map((m) => MOVE_CODE[m]).join(">") : "-";

  const streak = detectStreak(human);
  const streakPart = streak ? `${MOVE_CODE[streak.move]}${streak.length}` : "-";

  const outcomePart = recentOutcomes.length
    ? recentOutcomes.map((o) => OUTCOME_CODE[o]).join(",")
    : "-";

  // Last three human transitions — captures order, which raw frequencies lose.
  const bigrams: string[] = [];
  for (let i = Math.max(1, human.length - 3); i < human.length; i++) {
    bigrams.push(`${MOVE_CODE[human[i - 1]]}${MOVE_CODE[human[i]]}`);
  }
  const bigramPart = bigrams.length ? bigrams.join(",") : "-";

  const tally: Record<Move, number> = { rock: 0, paper: 0, scissors: 0 };
  for (const move of human) tally[move]++;
  const freqPart = `R${tally.rock}P${tally.paper}S${tally.scissors}`;

  return `H:${humanPart} A:${aiPart} st:${streakPart} out:${outcomePart} bg:${bigramPart} fq:${freqPart}`;
}

/** Human-readable gloss of a context string, for tooltips in the UI. */
export function describeContext(context: string): string {
  const human = /H:([^\s]+)/.exec(context)?.[1] ?? "-";
  const streak = /st:([^\s]+)/.exec(context)?.[1] ?? "-";
  if (human === "-") return "No history yet";
  const moves = human
    .split(">")
    .map((code) => codeToMove(code))
    .filter((move): move is Move => move !== null)
    .map((move) => move[0].toUpperCase() + move.slice(1));
  const streakNote =
    streak === "-" ? "" : ` · streak of ${streak.slice(1)} ${codeToMove(streak[0]) ?? ""}`;
  return `${moves.join(" → ")}${streakNote}`;
}
