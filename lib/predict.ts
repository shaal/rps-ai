/**
 * Pure prediction math: turn a set of recalled episodes into a move.
 *
 * Kept free of I/O so the whole decision procedure can be reasoned about and
 * tested on synthetic episode lists.
 */

import { BEATS, MOVES, counter, randomMove, trailingMatchScore } from "./rps";
import type { Intent, Mode, Move, Reasoning, Recalled } from "./types";

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

/**
 * Sampling temperature for picking which move to play against.
 *
 * The prediction runs at full strength in every mode — this is not a difficulty
 * dial. It exists because always countering the argmax makes the AI a fixed
 * function of the history, which a human detects in about ten rounds and then
 * counter-counters. A little sampling is stronger play, not weaker.
 */
const TEMPERATURE = 0.5;

/** Rate of outright random throws, for the same anti-exploitation reason. */
const EXPLORE_RATE = 0.05;

export interface ModeProfile {
  label: string;
  blurb: string;
}

export const MODE_PROFILES: Record<Mode, ModeProfile> = {
  dominate: {
    label: "Dominate",
    blurb: "Plays every read it gets. No handicap, no mercy.",
  },
  level: {
    label: "Level",
    blurb: "Steers the score toward a tie, dropping rounds when it gets ahead.",
  },
  yield: {
    label: "Yield",
    blurb: "Throws rounds on purpose. The better it reads you, the harder you win.",
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
  const margin =
    shares[0] + shares[1] > 0 ? (shares[0] - shares[1]) / (shares[0] + shares[1]) : 0;

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
 * Assemble the AI's reasoning for a round.
 *
 * `intent` comes from the score controller and decides what the AI does with
 * its read; this function decides which move that read lands on.
 */
export function decide(
  aggregateResult: AggregateResult,
  intent: Intent,
  context: string,
  topN: number,
  control: Reasoning["control"],
): Reasoning {
  const { distribution, predictedHuman, confidence, meanDistance, effectiveN, margin, weighted } =
    aggregateResult;

  const base: Omit<Reasoning, "explored" | "playedAgainst"> = {
    mode: "adaptive",
    context,
    predictedHuman,
    intent,
    distribution,
    confidence,
    neighbors: weighted.length,
    meanDistance,
    effectiveN,
    margin,
    topNeighbors: weighted.slice(0, topN),
    control,
  };

  // Exploring is pointless when the AI is trying to lose: a random throw will
  // not reliably concede, it just adds noise to a deliberate act.
  const mayExplore = intent !== "lose";

  if (!predictedHuman || (mayExplore && Math.random() < EXPLORE_RATE)) {
    return { ...base, explored: true, playedAgainst: null };
  }

  return {
    ...base,
    explored: false,
    playedAgainst: sampleWithTemperature(distribution, TEMPERATURE),
  };
}

/**
 * The move the AI should actually throw.
 *
 * With a predicted human move X the AI can aim at any of the three outcomes:
 * `counter(X)` beats it, `X` draws with it, and `BEATS[X]` — the move X
 * defeats — loses to it. Which one it picks is the score controller's call.
 */
export function moveFor(reasoning: Reasoning): Move {
  const target = reasoning.playedAgainst;
  if (!target) return randomMove();

  switch (reasoning.intent) {
    case "win":
      return counter(target);
    case "draw":
      return target;
    case "lose":
      return BEATS[target];
  }
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
  const adjusted = MOVES.map((move) =>
    Math.pow(Math.max(distribution[move], 0), 1 / safeTemperature),
  );
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
