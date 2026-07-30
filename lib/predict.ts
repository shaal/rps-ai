/**
 * Pure prediction math: turn a set of recalled episodes into a move.
 *
 * Kept free of I/O so the whole decision procedure can be reasoned about and
 * tested on synthetic episode lists.
 */

import { MOVES, counter, randomMove, trailingMatchScore } from "./rps";
import type { Difficulty, Move, Recalled, Reasoning } from "./types";

/**
 * Softening constant in the inverse-distance weight `1 / (EPS + d^2)`.
 *
 * Without it an exact context match (d ~ 1e-14) would take effectively infinite
 * weight and drown out every other memory. At 0.01 a d=0.02 neighbour weighs
 * roughly 3x a d=0.15 one, which is a usable spread for this embedding space.
 */
const EPS = 0.01;

/** Recency half-life in episodes. Older habits fade so a strategy switch lands. */
const DECAY_TAU = 150;

/** Extra weight for an episode whose recent moves literally match the present. */
const MATCH_BONUS = 1.0;

/** Effective neighbour count at which evidence counts as fully supported. */
const SUPPORT_TARGET = 5;

/** Memory size at which the cold-start penalty on confidence fully lifts. */
const COLD_START_EPISODES = 25;

/** Below this confidence the AI loosens up rather than committing to a read. */
const LOW_CONFIDENCE_GATE = 0.35;

/** How much the temperature is inflated when confidence is below the gate. */
const GATE_TEMP_MULTIPLIER = 1.6;

export interface DifficultyProfile {
  /** Softmax temperature. <1 sharpens toward the top prediction, >1 flattens. */
  temperature: number;
  /** Probability of ignoring memory entirely and throwing at random. */
  explore: number;
  label: string;
  blurb: string;
}

export const DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = {
  casual: {
    temperature: 1.8,
    explore: 0.35,
    label: "Casual",
    blurb: "Reads you loosely and throws often enough to keep it friendly.",
  },
  rival: {
    temperature: 0.9,
    explore: 0.1,
    label: "Rival",
    blurb: "Plays its read, but never becomes fully predictable.",
  },
  ruthless: {
    temperature: 0.35,
    explore: 0.05,
    label: "Ruthless",
    blurb: "Commits hard to the strongest pattern it can find.",
  },
};

const ZERO_DISTRIBUTION: Record<Move, number> = { rock: 0, paper: 0, scissors: 0 };

export interface AggregateResult {
  distribution: Record<Move, number>;
  predictedHuman: Move | null;
  confidence: number;
  meanDistance: number;
  effectiveN: number;
  /** How decisively the winner beat the runner-up, in [0,1]. */
  margin: number;
  /** Input episodes annotated with the share of the vote each one carried. */
  weighted: Recalled[];
}

const EMPTY_AGGREGATE: AggregateResult = {
  distribution: { rock: 0, paper: 0, scissors: 0 },
  predictedHuman: null,
  confidence: 0,
  meanDistance: 0,
  effectiveN: 0,
  margin: 0,
  weighted: [],
};

/**
 * Distance-weighted vote over what the human played next in similar situations.
 *
 * Each episode's weight combines three independent signals:
 *   - inverse squared cosine distance (how similar the situation was),
 *   - exponential recency decay (how current that habit still is),
 *   - a trailing-move match bonus (a hybrid re-rank against exact recent moves,
 *     which is more reliable than the embedding alone in this tight space).
 */
export function aggregate(
  recalled: Recalled[],
  currentSeq: number,
  currentTail: string,
  memorySize: number,
): AggregateResult {
  if (recalled.length === 0) {
    return { ...EMPTY_AGGREGATE, distribution: { ...ZERO_DISTRIBUTION } };
  }

  const weights = recalled.map((episode) => {
    const proximity = 1 / (EPS + episode.distance * episode.distance);
    const age = Math.max(0, currentSeq - episode.meta.seq);
    const recency = Math.exp(-age / DECAY_TAU);
    const match = trailingMatchScore(currentTail, episode.meta.historyTail);
    return proximity * recency * (1 + MATCH_BONUS * match);
  });

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) {
    return { ...EMPTY_AGGREGATE, distribution: { ...ZERO_DISTRIBUTION } };
  }

  const distribution: Record<Move, number> = { ...ZERO_DISTRIBUTION };
  recalled.forEach((episode, i) => {
    distribution[episode.meta.nextHumanMove] += weights[i] / totalWeight;
  });

  const predictedHuman = MOVES.reduce((best, move) =>
    distribution[move] > distribution[best] ? move : best,
  );

  // Effective sample size: near 1 when a single memory dominates the vote,
  // near N when many memories contribute evenly.
  const sumSquares = weights.reduce((sum, w) => sum + w * w, 0);
  const effectiveN = (totalWeight * totalWeight) / sumSquares;

  // Mean distance across only the episodes backing the winning move — the
  // distance of contradicting memories says nothing about this prediction.
  let backingWeight = 0;
  let backingDistance = 0;
  recalled.forEach((episode, i) => {
    if (episode.meta.nextHumanMove !== predictedHuman) return;
    backingWeight += weights[i];
    backingDistance += weights[i] * episode.distance;
  });
  const meanDistance = backingWeight > 0 ? backingDistance / backingWeight : 0;

  // How decisively the winner beat the runner-up. Zero when two moves tie, near
  // one when the vote is lopsided.
  const shares = MOVES.map((move) => distribution[move]).sort((a, b) => b - a);
  const margin = shares[0] + shares[1] > 0
    ? (shares[0] - shares[1]) / (shares[0] + shares[1])
    : 0;

  // Honest confidence: how decisively the winning move beat the alternative,
  // how many memories effectively contributed, and how much the AI has seen.
  // Any one being weak caps the number.
  //
  // `margin` rather than `topShare` carries the concentration term — both
  // measure the same lopsidedness, so multiplying them double-counts it and
  // understates a read that is genuinely working. Margin is also the sharper
  // discriminator: a topShare of 0.4 can mean a clear winner or a three-way
  // tie, whereas margin goes to zero on the tie.
  //
  // There is deliberately no absolute-distance term. These embeddings sit
  // within ~0.001-0.09 cosine of each other, so anything of the form
  // `1 - d/reference` stays pinned near 1.0 and never rejects a bad
  // neighbourhood — it would look like a signal while measuring nothing.
  const support = clamp(effectiveN / SUPPORT_TARGET, 0, 1);
  const maturity = clamp(memorySize / COLD_START_EPISODES, 0, 1);
  const confidence = margin * support * maturity;

  const weighted = recalled
    .map((episode, i) => ({ ...episode, influence: weights[i] / totalWeight }))
    .sort((a, b) => b.influence - a.influence);

  return {
    distribution,
    predictedHuman,
    confidence,
    meanDistance,
    effectiveN,
    margin,
    weighted,
  };
}

/**
 * Choose the AI's move from an aggregate, honouring the difficulty profile.
 *
 * The AI samples the human's predicted move from a temperature-adjusted
 * distribution and plays its counter, rather than always countering the argmax.
 * Pure argmax is detectable in about ten rounds and invites counter-countering;
 * sampling keeps it beatable while still visibly exploiting real patterns.
 */
export function decide(
  aggregateResult: AggregateResult,
  difficulty: Difficulty,
  context: string,
  topN: number,
): Reasoning {
  const profile = DIFFICULTY_PROFILES[difficulty];
  const { distribution, predictedHuman, confidence, meanDistance, effectiveN, margin, weighted } =
    aggregateResult;

  const topNeighbors = weighted.slice(0, topN);

  // `predictedHuman` stays the argmax regardless of what the AI decides to do
  // with it: it is the honest statement of the read, and scoring it against the
  // human's actual move is what makes the read-rate metric meaningful.
  const base: Omit<Reasoning, "explored" | "playedAgainst"> = {
    mode: "adaptive",
    context,
    predictedHuman,
    distribution,
    confidence,
    neighbors: weighted.length,
    meanDistance,
    effectiveN,
    margin,
    topNeighbors,
  };

  // No usable memory, or a deliberate exploration throw.
  if (!predictedHuman || Math.random() < profile.explore) {
    return { ...base, explored: true, playedAgainst: null };
  }

  // A weak read should not be played as though it were a strong one.
  const temperature =
    confidence < LOW_CONFIDENCE_GATE
      ? profile.temperature * GATE_TEMP_MULTIPLIER
      : profile.temperature;

  return {
    ...base,
    explored: false,
    playedAgainst: sampleWithTemperature(distribution, temperature),
  };
}

/** The move the AI should actually throw for a given reasoning result. */
export function moveFor(reasoning: Reasoning): Move {
  if (!reasoning.playedAgainst) return randomMove();
  return counter(reasoning.playedAgainst);
}

/**
 * Sample a move from `distribution` after raising it to the power `1/temperature`.
 * Low temperature concentrates on the favourite; high temperature flattens toward
 * uniform.
 */
export function sampleWithTemperature(
  distribution: Record<Move, number>,
  temperature: number,
): Move {
  const safeTemperature = Math.max(temperature, 0.05);
  const adjusted = MOVES.map((move) => Math.pow(Math.max(distribution[move], 0), 1 / safeTemperature));
  const total = adjusted.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || !Number.isFinite(total)) return randomMove();

  let ticket = Math.random() * total;
  for (let i = 0; i < MOVES.length; i++) {
    ticket -= adjusted[i];
    if (ticket <= 0) return MOVES[i];
  }
  return MOVES[MOVES.length - 1];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
